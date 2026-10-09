package com.simproxy.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.net.TrafficStats;
import android.net.VpnService;
import android.os.Build;
import android.os.ParcelFileDescriptor;
import android.os.PowerManager;
import android.os.Process;
import android.util.Log;
import androidx.annotation.Keep;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.concurrent.atomic.AtomicBoolean;
import com.simproxy.core.SocketProtector;
import com.simproxy.core.Tunnel;

@Keep
public class VpnServiceImpl extends VpnService {
    private static final String TAG = "SimProxyVPN";
    private static final String CHANNEL_ID = "sim_vpn_stable";
    private static final int NOTIFICATION_ID = 1;
    private static final String PREFS_NAME = "sim_last_vpn";

    // Глобальная блокировка для всех операций с Xray/Libxray (старт, стоп, пинг).
    // Позволяет избежать "io: read/write on closed pipe" при наложении событий.
    public static final Object CORE_LOCK = new Object();

    private static volatile VpnServiceImpl instance = null;
    // true = VPN остановлен намеренно (кнопка «Отключить» в шторке, стоп из
    // приложения или onRevoke), а не упал. Нужен, чтобы UI не показывал ложную
    // ошибку «Соединение прервано» при отключении из шторки. Статический —
    // переживает уничтожение инстанса (после stopSelf instance == null).
    private static volatile boolean userStopped = false;
    public static boolean wasUserStopped() { return userStopped; }
    // Сбрасываем флаг в момент запроса старта (из моста), чтобы при переподключении
    // getStats не успел вернуть устаревший "stopped" до обработки onStartCommand.
    public static void markStarting() { userStopped = false; }
    // Адрес прокси-сервера текущего подключения (addr:port). Используется для
    // сравнения при пинге: live-SOCKS замер валиден только для подключённого сервера.
    private static volatile String activeProxyEndpoint = null;
    public static String getActiveProxyEndpoint() { return activeProxyEndpoint; }
    public static void clearActiveProxyEndpoint() { activeProxyEndpoint = null; }
    private static volatile String activeConfigJson = null;
    public static java.util.List<String> getBypassEndpoints() {
        String cfg = activeConfigJson;
        if (cfg == null) return java.util.Collections.emptyList();
        try {
            org.json.JSONObject root = new org.json.JSONObject(cfg);
            org.json.JSONObject routing = root.optJSONObject("routing");
            if (routing == null) return java.util.Collections.emptyList();
            org.json.JSONArray balancers = routing.optJSONArray("balancers");
            if (balancers == null || balancers.length() == 0) return java.util.Collections.emptyList();
            java.util.Set<String> bypassTags = new java.util.HashSet<>();
            for (int i = 0; i < balancers.length(); i++) {
                org.json.JSONObject bal = balancers.optJSONObject(i);
                if (bal == null) continue;
                org.json.JSONArray sel = bal.optJSONArray("selector");
                if (sel != null) for (int k = 0; k < sel.length(); k++) bypassTags.add(sel.optString(k));
            }
            org.json.JSONArray outbounds = root.optJSONArray("outbounds");
            if (outbounds == null) return java.util.Collections.emptyList();
            java.util.List<String> eps = new java.util.ArrayList<>();
            for (int i = 0; i < outbounds.length(); i++) {
                org.json.JSONObject ob = outbounds.optJSONObject(i);
                if (ob == null || !bypassTags.contains(ob.optString("tag"))) continue;
                org.json.JSONObject settings = ob.optJSONObject("settings");
                if (settings == null) continue;
                org.json.JSONArray vnext = settings.optJSONArray("vnext");
                if (vnext != null && vnext.length() > 0) {
                    org.json.JSONObject v = vnext.optJSONObject(0);
                    if (v != null) { String a = v.optString("address",""); int p = v.optInt("port",0); if (!a.isEmpty() && p > 0) eps.add(a + ":" + p); }
                }
                org.json.JSONArray servers = settings.optJSONArray("servers");
                if (servers != null && servers.length() > 0) {
                    org.json.JSONObject s = servers.optJSONObject(0);
                    if (s != null) { String a = s.optString("address",""); int p = s.optInt("port",0); if (!a.isEmpty() && p > 0) eps.add(a + ":" + p); }
                }
            }
            return eps;
        } catch (Throwable t) { return java.util.Collections.emptyList(); }
    }
    private ParcelFileDescriptor tunFd = null;
    private final XrayManager xrayManager = new XrayManager();
    private final MihomoManager mihomoManager = new MihomoManager();
    private volatile String activeCore = "xray"; // 'xray' | 'mihomo'
    private final AtomicBoolean isStarting = new AtomicBoolean(false);
    private long startTime = 0;
    private NotificationManager notificationManager;
    private volatile String serverName = "";
    // Режим «Иммунитет» (фильтр): туннель поднят, но весь трафик идёт direct —
    // узла нет, failover/пробы узла не применяются, уведомление другое.
    // Флаг переживает рестарт процесса (prefs), читается в onStartCommand.
    private volatile boolean shieldMode = false;
    private volatile String lastConfig = null;
    private volatile String lastSettings = "{}";
    private volatile NetworkMonitor.NetworkType connectedNetworkType = NetworkMonitor.NetworkType.NONE;
    private volatile long lastConnectTimeMs = 0;
    /** Момент, когда isStarting был выставлен в true. Нужен для защиты от залипшего флага. */
    private volatile long isStartingSinceMs = 0;
    private static final long RECONNECT_COOLDOWN_MS = 5000;
    /** Старт висит дольше этого — считаем флаг залипшим и разрешаем новую попытку. */
    private static final long STARTING_STUCK_MS = 90_000;

    // ── Проверка живости туннеля ────────────────────────────────────────
    // Watchdog ниже ловит только СМЕРТЬ ядра. Обратный случай — ядро живо, но его
    // TCP-сессия с прокси-сервером разорвана (сменился оператор/сеть, новый маршрут и
    // локальный IP) — не ловил никто: UI показывал «подключено», а трафика не было.
    // Раз в TUNNEL_PROBE_EVERY_TICKS тиков прогоняем реальный запрос через SOCKS-порт
    // ядра. Он идёт по тому же пути, что и трафик пользователя, поэтому честно отвечает
    // на вопрос «туннель живой?».
    private static final int TUNNEL_PROBE_EVERY_TICKS = 15;              // тик = 2 с → 30 с в покое
    private static final int TUNNEL_PROBE_EVERY_TICKS_FAST = 5;          // 10 с сразу после смены сети
    private static final long TUNNEL_PROBE_FAST_WINDOW_MS = 120_000;     // окно частых проверок
    private static final int TUNNEL_PROBE_FAILS_TO_REBUILD = 2;          // 2 отказа подряд
    private static final long TUNNEL_PROBE_MIN_AGE_MS = 12_000;          // не проверять в первые 12 с
    private static final int TUNNEL_PROBE_TIMEOUT_MS = 6000;
    // Пауза после принудительной пересборки: без неё недоступный прокси-сервер давал бы
    // бесконечный цикл «проверка → пересборка → проверка». Растёт с каждой попыткой.
    private static final long TUNNEL_REBUILD_SUPPRESS_BASE_MS = 60_000;
    private static final long TUNNEL_REBUILD_SUPPRESS_MAX_MS = 300_000;

    // ── Лечение мёртвого туннеля ─────────────────────────────────────────
    // Убийство процесса — не безразличное лекарство. Оно чинит «зависшее ядро», но
    // бессмысленно (и вредно), когда просто лежит прокси-сервер или сеть: свежее ядро
    // упирается в тот же сервер, каждый цикл — секунды без интернета, а число циклов
    // не ограничено. Перед убийством проверяем сервер прямым TCP-соединением (наш uid
    // и так вне VPN) и держим предохранитель: не более MAX_PROCESS_KILLS_PER_WINDOW
    // убийств за PROCESS_KILL_WINDOW_MS. История живёт в prefs, т.к. убийство процесса
    // обязано её пережить. (06.10.2026: сервер перестал отвечать → 4 убийства подряд →
    // зацикленные падения и много минут без интернета.)
    private static final int UPSTREAM_CHECK_TIMEOUT_MS = 4000;
    private static final int MAX_PROCESS_KILLS_PER_WINDOW = 3;
    private static final long PROCESS_KILL_WINDOW_MS = 10 * 60_000L;

    // ── Фоновый failover ────────────────────────────────────────────────
    // JS при подключении отдаёт список запасных серверов (src/native/failover.ts);
    // он лежит в prefs под ключом "fallbacks" и переживает смерть процесса.
    // Переключения тоже ограничены окном — иначе при альтернирующе-мёртвых серверах
    // процесс убивался бы бесконечно. Счётчик в prefs по той же причине, что и
    // история убийств: сбрасываться вместе с процессом он не имеет права.
    private static final String PREF_FAILOVER_HISTORY = "failover_times";
    private static final int MAX_FAILOVERS_PER_WINDOW = 4;
    private static final long FAILOVER_WINDOW_MS = 30 * 60_000L;
    private static final String PREF_KILL_HISTORY = "process_kill_times";

    // Богатая история фоновых автопереключений для «Петрович-агента»: JSON-массив
    // {ts, from, to, name} — когда и с какого узла на какой ушёл фоновый failover.
    // Хранится в prefs, переживает смерть WebView/процесса (переключение и есть убийство).
    private static final String PREF_FAILOVER_JOURNAL = "failover_journal";
    private static final int FAILOVER_JOURNAL_MAX = 50;

    // Детект «SOCKS отвечает, но TUN никто не читает» — исходный баг «подключено, но не
    // грузит». Проба ходит по 127.0.0.1, а uid приложения исключён из маршрутов tun
    // (ip rule: uid не попадает в таблицу интерфейса), поэтому сама по себе она мёртвый
    // интерфейс не видит. Смотрим счётчики интерфейса: пока в tun льются пакеты (tx
    // растёт), а обратных байт нет (rx) — их никто не читает, трафик дропается.
    private static final long TUN_DEAD_TX_MIN_BYTES = 16 * 1024;
    private static final long TUN_SAMPLE_MAX_AGE_MS = 90_000;
    private static final int TUN_DEAD_FAILS_TO_TREAT = 2;
    private volatile int tunnelProbeFailStreak = 0;
    /** Время последней смены сети — включает режим частых проверок. */
    private volatile long lastNetworkChangeMs = 0;
    /** До этого момента проверки не запускаем (пауза после принудительной пересборки). */
    private volatile long tunnelProbeSuppressUntilMs = 0;
    /** Сколько раз подряд пересобирали по требованию проверки — задаёт паузу. */
    private volatile int forcedRebuildCount = 0;
    // Счётчики tun-интерфейса для детекта «в tun льются пакеты, ответов нет».
    private volatile long lastTunTxBytes = -1;
    private volatile long lastTunRxBytes = -1;
    private volatile long lastTunSampleMs = 0;
    private volatile String tunIfaceName = null;
    private volatile int tunDeadStreak = 0;
    /**
     * Реконнект вызван сменой сети, а не сменой сервера/ручным действием.
     * Для такого случая предпочтительна только перепривязка: полный перезапуск ядра
     * пересоздаёт TUN, и чтение нового интерфейса не поднимается — трафик входит в
     * туннель и дропается (проверено на устройстве: +43 дропа, ноль ответных байт).
     */
    private volatile boolean reconnectFromNetworkChange = false;
    private final java.util.concurrent.atomic.AtomicReference<Thread> tun2socksThread = new java.util.concurrent.atomic.AtomicReference<>(null);
    // safeStartTun2Socks() ВОЗВРАЩАЕТСЯ сразу после доставки TUN fd ядру —
    // сам туннель живёт в native-потоке внутри .so, не блокируя t2sThread.
    // Поэтому t2sThread.isAlive() гаснет через ~1с после успешного коннекта,
    // хотя туннель работает. isRunning() должен опираться на этот флаг, а не
    // на живость потока-запускателя.
    private volatile boolean mihomoTunnelReady = false;
    private volatile boolean networkWasLost = false; // сеть пропала → нужно переподключиться при восстановлении
    private PowerManager.WakeLock wakeLock;
    private NetworkMonitor networkMonitor;
    private final NetworkMonitor.NetworkChangeListener networkChangeListener = new NetworkMonitor.NetworkChangeListener() {
        @Override
        public void onNetworkChanged(NetworkMonitor.NetworkType oldType, NetworkMonitor.NetworkType newType) {
            Log.i(TAG, "Network changed: " + oldType + " -> " + newType + "; reconnecting VPN");
            networkWasLost = false;
            lastNetworkChangeMs = System.currentTimeMillis();
            reconnectFromNetworkChange = true;
            reconnectOnNetworkChange(2000);
        }
        @Override
        public void onNetworkLost() {
            Log.i(TAG, "Network lost; will reconnect on recovery");
            networkWasLost = true;
        }
        @Override
        public void onNetworkAvailable(NetworkMonitor.NetworkType type) {
            Log.i(TAG, "Network available: " + type + " (wasLost=" + networkWasLost + ")");
            boolean wasLost = networkWasLost;
            networkWasLost = false;
            lastNetworkChangeMs = System.currentTimeMillis();
            if (lastConfig != null && !userStopped && !isStarting()) {
                // Переподключаемся если: сеть была потеряна (туннель гарантированно сломан)
                // ИЛИ ядро уже не работает (упало пока не было сети).
                if (wasLost || !isRunning()) {
                    reconnectFromNetworkChange = true;
                    reconnectOnNetworkChange(1500);
                }
            }
        }
    };

    // ── Учёт трафика по UID процесса ────────────────────────────────────
    // Xray работает в нашем процессе, поэтому реальный трафик до VPN-сервера
    // учитывается на наш UID (TrafficStats.getUidRx/TxBytes) — это даёт точные
    // скорость и объём для шторки и для UI.
    private volatile Thread statsThread = null;
    private volatile boolean statsRunning = false;
    // Момент последнего успешного прохода цикла статистики. Супервизор следит,
    // чтобы нить не могла молча зависнуть (binder/сеть) или умереть — иначе пробы
    // туннеля прекращаются навсегда: это и был баг «мёртвый туннель 29 минут,
    // приложение не переподключается» (логи 10:03:36 → тишина).
    private volatile long statsLoopLastTickMs = 0;
    private Thread statsSupervisorThread = null;
    private volatile long sessRxStart = 0, sessTxStart = 0; // байты на старте сессии
    private volatile long lastRx = 0, lastTx = 0, lastTs = 0;
    private volatile long curDown = 0, curUp = 0;           // текущая скорость, байт/с
    private volatile long totalDown = 0, totalUp = 0;       // объём за сессию, байт

    public static VpnServiceImpl getInstance() { return instance; }

    // Извлекает "addr:port" первого proxy-outbound из конфига VPN.
    // Используется для сравнения при пинге: live-SOCKS замер отражает только
    // качество текущего подключённого сервера, не произвольного.
    static String extractProxyEndpoint(String configJson) {
        if (configJson == null || configJson.isEmpty()) return null;
        try {
            org.json.JSONArray obs = new org.json.JSONObject(configJson).optJSONArray("outbounds");
            if (obs == null) return null;
            for (int i = 0; i < obs.length(); i++) {
                org.json.JSONObject ob = obs.optJSONObject(i);
                if (ob == null) continue;
                org.json.JSONObject s = ob.optJSONObject("settings");
                if (s == null) continue;
                org.json.JSONArray vnext = s.optJSONArray("vnext");
                if (vnext != null && vnext.length() > 0) {
                    org.json.JSONObject srv = vnext.optJSONObject(0);
                    if (srv != null) return srv.optString("address") + ":" + srv.optInt("port");
                }
                org.json.JSONArray servers = s.optJSONArray("servers");
                if (servers != null && servers.length() > 0) {
                    org.json.JSONObject srv = servers.optJSONObject(0);
                    if (srv != null) return srv.optString("address") + ":" + srv.optInt("port");
                }
            }
        } catch (Throwable ignored) {}
        return null;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        SocketProtector.attach(this);
        notificationManager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        createNotificationChannel();
        networkMonitor = NetworkMonitor.getInstance(this);
        networkMonitor.addListener(networkChangeListener);
        networkMonitor.startMonitoring();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // STOP: не вызываем startForeground — сервис уже в foreground с момента connect.
        // Повторный startForeground на STOP-пути получает DENIED на Android 12+ (background
        // start restriction), и уведомление остаётся после stopForeground(true).
        if (intent != null && "STOP".equals(intent.getAction())) {
            Log.i(TAG, "STOP intent received in onStartCommand");
            userStopped = true;   // намеренный стоп (кнопка «Отключить» в шторке)
            // Передаём startId: stopSelf(startId) не уничтожит сервис, если JS уже
            // прислал новый START (startForegroundService) — иначе сервис убивают,
            // пока obligation нового foreground-сервиса не выполнена →
            // ForegroundServiceDidNotStartInTimeException (краш при быстром
            // «стоп → повторное подключение», auto-bypass после ошибки).
            final int stopStartId = startId;
            new Thread(() -> stopVpnGraceful(stopStartId), "VpnStopThread").start();
            return START_NOT_STICKY;
        }

        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(NOTIFICATION_ID, buildNotification("Подключение...", false),
                ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        } else {
            startForeground(NOTIFICATION_ID, buildNotification("Подключение...", false));
        }

        String config = intent != null ? intent.getStringExtra("config") : null;
        String settings = intent != null ? intent.getStringExtra("settings") : "{}";
        // Запасные серверы фонового failover приходят только при старте из JS.
        // Восстановление процесса (START_STICKY/START_LAST/бут) идёт без extra —
        // сохранённый в prefs список остаётся нетронутым, чтобы переключение работало
        // и после рестарта процесса. Явная пустая строка — сигнал «запасных нет».
        if (intent != null && intent.hasExtra("fallbacks")) {
            String fb = intent.getStringExtra("fallbacks");
            SharedPreferences.Editor ed = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).edit();
            if (fb != null && !fb.trim().isEmpty() && !"[]".equals(fb.trim())) {
                ed.putString("fallbacks", fb.trim());
            } else {
                ed.remove("fallbacks");
            }
            ed.apply();
        }
        // Режим «Иммунитет» (фильтр): приходит только при старте из JS. START_STICKY/бут
        // идут без extra — флаг остаётся в prefs и переживает рестарт процесса.
        if (intent != null && intent.hasExtra("shield")) {
            SharedPreferences.Editor edShield = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).edit();
            if (intent.getBooleanExtra("shield", false)) edShield.putBoolean("shield_mode", true);
            else edShield.remove("shield_mode");
            edShield.apply();
        }
        shieldMode = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).getBoolean("shield_mode", false);
        // START_STICKY restart (null intent) или BootReceiver без конфига:
        // пробуем восстановить последний конфиг из SharedPreferences.
        if (config == null || config.trim().isEmpty()) {
            SharedPreferences prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            config = prefs.getString("config", null);
            settings = prefs.getString("settings", "{}");
        }
        if (config == null || config.trim().isEmpty()) {
            stopVpn();
            return START_NOT_STICKY;
        }

        userStopped = false;   // начинаем новое подключение — сбрасываем флаг стопа
        if (isStarting.getAndSet(true)) {
            // Уже есть активный поток startVpn (reconnect или предыдущий onStartCommand).
            // Не запускаем второй — он создаст гонку двух ядер на одном порту.
            Log.i(TAG, "onStartCommand: already starting, skipping duplicate start");
            return START_STICKY;
        }
        isStartingSinceMs = System.currentTimeMillis();
        // Сохраняем адрес прокси и конфиг для ping-сравнения.
        activeProxyEndpoint = extractProxyEndpoint(config);
        activeConfigJson = config;
        final String cfg = config;
        final String set = settings;
        new Thread(() -> startVpn(cfg, set), "VPN-Start-Thread").start();

        return START_STICKY;
    }

    private void startVpn(String config, String settingsJson) {
        // Короткий wake lock ТОЛЬКО на время самого реконнекта (TUN builder → Xray/mihomo
        // старт → waitForReady, может занимать несколько секунд) — не постоянный, как
        // убранный ранее PARTIAL_WAKE_LOCK (тот жёг батарею 24/7, см. acquireWakeLock()).
        // Цель: не дать CPU уснуть посреди критичного окна реконнекта, если он стартовал
        // из фонового потока (watchdog/network-change) при выключенном экране — именно
        // тогда 300мс-паузы и synchronized-ожидания внутри этого метода рискуют не
        // получить CPU вовремя под Doze. Таймаут 30с — защита на случай, если finally
        // почему-то не сработает (не должен, но лучше не держать лок вечно).
        acquireWakeLock();
        try {
            if (tunFd != null) {
                // stopVpnInternal joins the tun2socks thread (up to 3s + 1.2s sleep),
                // so Go has already closed its SCM_RIGHTS fd copy by the time we return.
                // forceReleaseVpnSession() is NOT called here: it creates a dummy TUN fd
                // and immediately destroys it, causing a VPN-icon flicker on every reconnect.
                stopVpnInternal();
            }
            // stopVpnInternal() above resets activeProxyEndpoint to null — re-derive it from
            // the config we're about to start with here (single source of truth for both the
            // onStartCommand path and the network-change-triggered reconnectWithDelay path,
            // which previously set it BEFORE calling startVpn() only for it to be wiped out
            // by the stopVpnInternal() cleanup above, leaving pingProxyServer's "VPN up,
            // active=null" forever after any native auto-reconnect).
            activeProxyEndpoint = extractProxyEndpoint(config);

            JSONObject settings = new JSONObject(settingsJson);
            serverName = settings.optString("nodeName", "");
            activeCore = settings.optString("core", "xray");
            String torMode = settings.optString("torMode", "off");

            // MTU из настроек (тот же, что у Xray tun-инбаунда). Клампим в разумный
            // диапазон, чтобы кривое значение не сломало туннель.
            int mtu = 1400;
            try { mtu = Integer.parseInt(settings.optString("mtu", "1400").trim()); } catch (Exception ignored) {}
            if (mtu < 576) mtu = 576;
            if (mtu > 9000) mtu = 9000; // jumbo frames поддерживаются Android VPN API

            VpnService.Builder builder = new VpnService.Builder();
            builder.setSession("Квадрат Петровича")
                   .setMtu(mtu)
                   .addAddress("172.19.0.1", 24)
                   .addRoute("0.0.0.0", 0);
            // НЕ исключаем SimProxy по умолчанию — это будет обработано в режимах split tunnel

            // Перехватываем и IPv6, чтобы он не утекал в обход туннеля. Ядро ходит по
            // IPv4 (queryStrategy UseIPv4): IPv6-пакеты глохнут в туннеле, а приложения
            // откатываются на IPv4 (который идёт через прокси). Раньше здесь был
            // allowFamily(AF_INET) — он, наоборот, ВЫПУСКАЛ IPv6 мимо VPN, из-за чего
            // на мобильном (где IPv6 часто в приоритете) интернет залипал.
            try {
                builder.addAddress("fd00::1", 128);
                builder.addRoute("::", 0);
            } catch (Throwable ignored) {}

            // Reliable DNS for mobile networks
            builder.addDnsServer("8.8.8.8");
            builder.addDnsServer("1.1.1.1");

            SplitTunnelManager stm = SplitTunnelManager.getInstance(this);
            try {
                // Получаем приложения для whitelist (always) и blacklist (never)
                String proxyAppsJson = stm.getProxyApps();        // "always" — ТОЛЬКО через VPN
                String bypassAppsJson = stm.getBypassApps();      // "never"  — мимо VPN
                JSONArray proxyAppsArr = new JSONArray(proxyAppsJson);
                JSONArray bypassAppsArr = new JSONArray(bypassAppsJson);

                boolean hasWhitelist = proxyAppsArr.length() > 0;
                boolean hasBlacklist = bypassAppsArr.length() > 0;

                if (hasWhitelist) {
                    Log.i(TAG, "Using WHITELIST mode with " + proxyAppsArr.length() + " apps through VPN");
                    try {
                        builder.addAllowedApplication(getPackageName());
                        Log.d(TAG, "Whitelist: allowing SimProxy itself");
                    } catch (PackageManager.NameNotFoundException ignored) {}
                    for (int i = 0; i < proxyAppsArr.length(); i++) {
                        String pkg = proxyAppsArr.getString(i);
                        if (!pkg.isEmpty() && !pkg.equals(getPackageName())) {
                            try {
                                builder.addAllowedApplication(pkg);
                                Log.d(TAG, "Whitelist: allowing " + pkg);
                            } catch (PackageManager.NameNotFoundException e) {
                                Log.w(TAG, "App not found for whitelist: " + pkg);
                            }
                        }
                    }
                    Log.i(TAG, "WHITELIST mode applied");
                } else if (hasBlacklist) {
                    // Режим BLACKLIST: указанные приложения идут мимо VPN, остальные — через туннель.
                    // SimProxy ОБЯЗАН быть в списке bypass: иначе Xray гонит свой исходящий трафик
                    // через собственный TUN-интерфейс → петля → VPN подключён, но ничего не работает.
                    Log.i(TAG, "Using BLACKLIST mode with " + bypassAppsArr.length() + " apps bypassing VPN");
                    try {
                        builder.addDisallowedApplication(getPackageName());
                    } catch (PackageManager.NameNotFoundException ignored) {}
                    for (int i = 0; i < bypassAppsArr.length(); i++) {
                        String pkg = bypassAppsArr.getString(i);
                        if (!pkg.isEmpty() && !pkg.equals(getPackageName())) {
                            try {
                                builder.addDisallowedApplication(pkg);
                                Log.d(TAG, "Blacklist: bypassing " + pkg);
                            } catch (PackageManager.NameNotFoundException ignored) {}
                        }
                    }
                    Log.i(TAG, "BLACKLIST mode applied");
                } else {
                    Log.i(TAG, "Using DEFAULT mode: all apps through VPN (except SimProxy)");
                    try {
                        builder.addDisallowedApplication(getPackageName());
                    } catch (PackageManager.NameNotFoundException ignored) {}
                    // Orbot must bypass VPN so it can reach Tor relays directly when Tor mode is on.
                    if (!"off".equals(torMode)) {
                        try {
                            builder.addDisallowedApplication("org.torproject.android");
                            Log.i(TAG, "Tor mode: excluding Orbot from VPN");
                        } catch (PackageManager.NameNotFoundException ignored) {}
                    }
                }
            } catch (Exception e) {
                Log.e(TAG, "Error processing split tunnel apps", e);
            }

            String datPath = getFilesDir().getAbsolutePath();

            // Mihomo: start core + warm up Hysteria QUIC BEFORE establishing the TUN device.
            // Android routes app traffic through TUN the moment establish() returns — if QUIC
            // isn't ready the first DNS/TCP packets from apps stall waiting for the handshake.
            if ("mihomo".equals(activeCore)) {
                Log.i(TAG, "Starting Mihomo core (SOCKS5 mode) — pre-TUN warmup");
                config = injectSystemDns(config);
                mihomoManager.start(this, datPath, config, 0); // 0 = dummy fd; config has no __SIM_TUN_FD__
                try {
                    org.json.JSONObject miCfg = new org.json.JSONObject(config);
                    org.json.JSONArray proxies = miCfg.optJSONArray("proxies");
                    if (proxies != null && proxies.length() > 0) {
                        org.json.JSONObject px = proxies.optJSONObject(0);
                        if (px != null) activeProxyEndpoint = px.optString("server") + ":" + px.optInt("port");
                    }
                } catch (Throwable ignored) {}
                Log.i(TAG, "Mihomo ready: port=" + mihomoManager.getSocksPort() + " proxy=" + activeProxyEndpoint);
                updateNotification(shieldMode ? "🛡 Иммунитет • запуск фильтра..." : (serverName.isEmpty() ? "Туннель..." : ("Туннель • " + serverName)), false);
                warmupProxyConnection(mihomoManager.getSocksPort());
            }

            // Используем локальную переменную — для Xray-пути this.tunFd присваивается
            // только внутри CORE_LOCK, иначе stopVpnGraceful закрывает новый fd через
            // stopVpnInternal() пока мы ещё ждём лока.
            final ParcelFileDescriptor newTunFd = builder.establish();
            if (newTunFd == null) throw new Exception("TUN interface failed");

            int rawFd = newTunFd.getFd();
            if (rawFd < 0) throw new Exception("Invalid TUN fd");

            if ("mihomo".equals(activeCore)) {
                tunFd = newTunFd;  // mihomo: нет CORE_LOCK гонки, присваиваем сразу
                final int miSocksPort = mihomoManager.getSocksPort();
                // Bridge TUN fd → mihomo SOCKS5 proxy via tun2socks.
                SocketProtector.attach(this);
                final ParcelFileDescriptor t2sPfd = tunFd;
                final int t2sMtu = mtu;
                final android.content.Context t2sCtx = this;
                Thread t2sThread = new Thread(() -> {
                    int result = Tunnel.start(
                        t2sCtx, t2sPfd, "127.0.0.1", miSocksPort, t2sMtu);
                    Log.i(TAG, "tun2socks setup finished: result=" + result);
                    // result==0 значит fd доставлен и туннель поднят — native-поток
                    // дальше живёт сам. Ненулевой результат — реальная неудача запуска.
                    mihomoTunnelReady = (result == 0);
                    tun2socksThread.set(null);
                }, "Tun2Socks-Mihomo");
                tun2socksThread.set(t2sThread);
                t2sThread.start();
                // Give tun2socks time to receive the TUN fd and start its read loop.
                // join() would wait until the thread *exits* (i.e. tun2socks crashes),
                // not until it is ready — so we sleep briefly instead.
                try { Thread.sleep(300); } catch (InterruptedException ignored) {}
                Log.i(TAG, "tun2socks TUN fd delivery confirmed");
            } else {
                // Нативный TUN: coreRunLoopWithTun
                Log.i(TAG, "Starting Xray Core (NATIVE TUN), fd=" + rawFd);
                // Присваиваем tunFd под CORE_LOCK — stopVpnGraceful тоже под CORE_LOCK
                // проверяет isStarting/isRunning перед закрытием tunFd.
                synchronized (CORE_LOCK) {
                    tunFd = newTunFd;
                }
                // start() и waitForReady() ВНЕ CORE_LOCK — иначе CORE_LOCK держится
                // 9с (waitForPortClosed) + 12с (waitForReady), блокируя stopVpnGraceful.
                // Защита от убийства нового Xray обеспечивается epoch-механизмом
                // (xrayManager.stopIfEpoch) в stopVpnGraceful.
                int socksPort = xrayManager.start(this, datPath, config, rawFd, false);
                if (!xrayManager.waitForReady(socksPort)) {
                    throw new Exception("Xray SOCKS-порт не открылся за 12с");
                }
            }

            startTime = System.currentTimeMillis();
            lastConfig = config;
            lastSettings = settingsJson;
            connectedNetworkType = networkMonitor != null ? networkMonitor.getCurrentNetwork() : NetworkMonitor.NetworkType.NONE;
            saveLastConfig(config, settingsJson);
            // Фоновый failover: сказать пользователю, что сервер сменился не по его воле.
            // Флаг ставит tryFailoverToFallback и здесь же потребляется — одноразово.
            String failoverSuffix = "";
            try {
                SharedPreferences prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
                String pendingFailover = prefs.getString("pending_failover", "");
                if (!pendingFailover.isEmpty()) {
                    prefs.edit().remove("pending_failover").apply();
                    failoverSuffix = " (автопереключение)";
                    Log.w(TAG, "Failover: connected via " + pendingFailover + " after automatic switch");
                }
            } catch (Throwable ignored) {}
            updateNotification(shieldMode ? "🛡 Иммунитет • фильтр активен"
                    : (serverName.isEmpty() ? "🔒 Подключено" : "🔒 Подключено • " + serverName) + failoverSuffix,
                    !shieldMode);
            startStatsLoop();
            lastConnectTimeMs = System.currentTimeMillis();
            // Новый TUN — базовая линия счётчиков интерфейса заново.
            lastTunTxBytes = -1; lastTunRxBytes = -1; lastTunSampleMs = 0; tunDeadStreak = 0;
            // Tell Android which underlying network carries VPN traffic. Required after
            // WiFi↔mobile switches so the system routes protected sockets correctly and
            // traffic accounting (battery, metering) reflects the real interface.
            updateUnderlyingNetwork();

        } catch (Throwable e) {
            Log.e(TAG, "VPN fail", e);
            updateNotification("Ошибка: " + e.getMessage(), false);
            stopVpnInternal();
        } finally {
            isStarting.set(false);
            releaseWakeLock();
        }
    }

    public void updateNotification(String text, boolean connected) {
        // Не постить уведомление после стопа — иначе поток статистики запостит
        // регулярное уведомление (не foreground) после stopForeground(true),
        // и иконка замка зависнет в статус-баре навсегда.
        if (userStopped) return;
        if (notificationManager != null) {
            try {
                notificationManager.notify(NOTIFICATION_ID, buildNotification(text, connected));
            } catch (Exception ignored) {}
        }
    }

    private Notification buildNotification(String text, boolean connected) {
        Intent openIntent = new Intent(this, MainActivity.class);
        PendingIntent openPending = PendingIntent.getActivity(this, 0, openIntent, PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder nb = new Notification.Builder(this, CHANNEL_ID)
            .setContentTitle("Квадрат Петровича")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.ic_lock_lock)
            .setContentIntent(openPending)
            .setOngoing(true)          // нельзя смахнуть, пока VPN включён — «закреплено»
            .setOnlyAlertOnce(true)    // обновления статуса без повторных звуков/всплытий
            .setShowWhen(false);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            nb.setCategory(Notification.CATEGORY_SERVICE);
            nb.setVisibility(Notification.VISIBILITY_PUBLIC); // видно на экране блокировки
        }
        if (connected) {
            Intent stopIntent = new Intent(this, VpnServiceImpl.class).setAction("STOP");
            PendingIntent stopPending = PendingIntent.getService(this, 1, stopIntent, PendingIntent.FLAG_IMMUTABLE);
            nb.addAction(android.R.drawable.ic_menu_close_clear_cancel, "Отключить", stopPending);
        }
        return nb.build();
    }

    public void stopVpn() {
        Log.i(TAG, "stopVpn (direct) called");
        userStopped = true;   // стоп из приложения / onRevoke — тоже намеренный
        clearSavedConfig();   // не восстанавливать при следующем буте
        isStarting.set(false);
        stopForeground(true);
        if (notificationManager != null) notificationManager.cancel(NOTIFICATION_ID);
        stopVpnInternal();
        forceReleaseVpnSession();
        stopSelf();
    }

    private String injectSystemDns(String config) {
        // Prepend the device's active DNS servers (typically the router, e.g. 192.168.1.1)
        // to mihomo's nameserver list. Mihomo queries all resolvers in parallel and uses
        // the fastest response. On Russian networks, 1.1.1.1/8.8.8.8 UDP is often blocked
        // or throttled, forcing a 1+ second DoH fallback. The router responds in <1ms.
        try {
            android.net.ConnectivityManager cm =
                (android.net.ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
            android.net.Network activeNet = cm != null ? cm.getActiveNetwork() : null;
            android.net.LinkProperties lp = activeNet != null ? cm.getLinkProperties(activeNet) : null;
            if (lp == null) return config;
            java.util.List<String> sysDns = new java.util.ArrayList<>();
            for (java.net.InetAddress addr : lp.getDnsServers()) {
                if (addr instanceof java.net.Inet4Address) {
                    String ip = addr.getHostAddress();
                    if (ip != null && !ip.isEmpty()) sysDns.add(ip);
                }
            }
            if (sysDns.isEmpty()) return config;
            org.json.JSONObject cfg = new org.json.JSONObject(config);
            org.json.JSONObject dns = cfg.optJSONObject("dns");
            if (dns == null) return config;
            for (String key : new String[]{"nameserver", "default-nameserver"}) {
                org.json.JSONArray orig = dns.optJSONArray(key);
                if (orig == null) continue;
                org.json.JSONArray updated = new org.json.JSONArray();
                for (String ip : sysDns) updated.put(ip);
                for (int i = 0; i < orig.length(); i++) updated.put(orig.get(i));
                dns.put(key, updated);
            }
            Log.i(TAG, "injectSystemDns: prepended " + sysDns);
            // org.json escapes '/' as '\/' — valid JSON but YAML rejects unknown escape '\/'
            return cfg.toString().replace("\\/", "/");
        } catch (Exception e) {
            Log.w(TAG, "injectSystemDns: " + e.getMessage());
            return config;
        }
    }

    private void warmupProxyConnection(int socksPort) {
        // Use HTTP proxy GET (not SOCKS5 CONNECT) — mihomo must fully forward the request
        // through Hysteria and receive the upstream HTTP response before replying.
        // SOCKS5 CONNECT is useless: mihomo replies 0 instantly before Hysteria is up.
        Log.i(TAG, "warmupProxyConnection: start port=" + socksPort);
        try (java.net.Socket sock = new java.net.Socket()) {
            sock.setSoTimeout(2500);
            sock.connect(new java.net.InetSocketAddress("127.0.0.1", socksPort), 1000);
            java.io.OutputStream out = sock.getOutputStream();
            java.io.BufferedReader in = new java.io.BufferedReader(
                    new java.io.InputStreamReader(sock.getInputStream(), "UTF-8"));
            String req = "GET http://1.1.1.1/cdn-cgi/trace HTTP/1.0\r\nHost: 1.1.1.1\r\n\r\n";
            out.write(req.getBytes("UTF-8")); out.flush();
            Log.i(TAG, "warmupProxyConnection: HTTP GET sent, waiting for Hysteria...");
            String statusLine = in.readLine();
            Log.i(TAG, "warmupProxyConnection: response=" + statusLine);
        } catch (java.net.SocketTimeoutException e) {
            Log.w(TAG, "warmupProxyConnection: timeout after 2.5s — Hysteria slow/unreachable");
        } catch (Exception e) {
            Log.w(TAG, "warmupProxyConnection: " + e.getMessage());
        }
    }

    private void forceReleaseVpnSession() {
        // Go tun2socks goroutines may still hold the old TUN fd via SCM_RIGHTS.
        // Re-establishing and immediately closing a new VPN session forces Android
        // to invalidate the old session and release the VPN system binding.
        try {
            ParcelFileDescriptor dummy = new VpnService.Builder()
                .setSession("Квадрат Петровича")
                .addAddress("10.0.0.2", 32)
                .setMtu(1500)
                .establish();
            if (dummy != null) try { dummy.close(); } catch (Exception ignored) {}
            Log.i(TAG, "forceReleaseVpnSession: done");
        } catch (Exception e) {
            Log.w(TAG, "forceReleaseVpnSession: " + e.getMessage());
        }
    }

    // Запрашиваем исключение из оптимизации батареи при первом успешном подключении.
    // Без этого Android (Doze) может убить VPN-процесс в фоне через несколько минут.
    private void requestBatteryOptimizationExemptionIfNeeded() {
        try {
            PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
            String pkg = getPackageName();
            if (pm == null || pm.isIgnoringBatteryOptimizations(pkg)) return;
            android.content.SharedPreferences prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            // Показываем диалог только один раз — не навязываем при каждом reconnect.
            if (prefs.getBoolean("battery_perm_requested", false)) return;
            prefs.edit().putBoolean("battery_perm_requested", true).apply();
            Intent i = new Intent(android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
            i.setData(android.net.Uri.parse("package:" + pkg));
            i.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(i);
            Log.i(TAG, "Requested battery optimization exemption");
        } catch (Throwable t) {
            Log.w(TAG, "Battery exemption request failed: " + t.getMessage());
        }
    }

    private void acquireWakeLock() {
        // Foreground Service с уведомлением уже защищает процесс от убийства.
        // ВАЖНО: раньше здесь держался PARTIAL_WAKE_LOCK постоянно (все время работы VPN) —
        // это жгло CPU 24/7 даже без трафика → нагрев + 32% батареи за 4ч. Убрали совсем.
        // TUN fd обрабатывается ядром: CPU просыпается только при приходе пакетов, пока
        // туннель уже установлен — держать лок в это время не нужно.
        // Но короткое окно САМОГО реконнекта (TUN builder → Xray/mihomo старт →
        // waitForReady, до ~12с) — другое дело: если это стартовало из фонового потока
        // (watchdog/network-change) при выключенном экране, Doze может не дать CPU
        // вовремя добежать до конца этой синхронной цепочки. Поэтому короткий, строго
        // таймаутированный лок только на это окно (снимается в startVpn()'s finally).
        try {
            if (wakeLock != null && wakeLock.isHeld()) return;
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            if (pm == null) return;
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "SimProxyVPN:reconnect");
            wakeLock.acquire(30_000); // safety-net таймаут — finally должен снять раньше
            Log.d(TAG, "WakeLock acquired (reconnect window)");
        } catch (Exception e) {
            Log.w(TAG, "Failed to acquire WakeLock: " + e.getMessage());
        }
    }

    private void releaseWakeLock() {
        try {
            if (wakeLock != null && wakeLock.isHeld()) {
                wakeLock.release();
                Log.d(TAG, "WakeLock released");
            }
        } catch (Exception e) {
            Log.w(TAG, "Failed to release WakeLock: " + e.getMessage());
        }
        wakeLock = null;
    }

    private void stopVpnGraceful(int startId) {
        Log.i(TAG, "stopVpnGraceful: begin");
        mihomoTunnelReady = false;
        int mihomoEpochAtStart = mihomoManager.getStartEpoch();
        // Снимаем epoch ДО любых операций — если startVpn ещё не вызвал xrayManager.start(),
        // epoch совпадёт и stopIfEpoch остановит старый Xray. Если start() уже вызван —
        // epoch сменился, stopIfEpoch пропустит (не убьёт новый Xray).
        int xrayEpochAtStart = xrayManager.getXrayEpoch();
        clearSavedConfig();
        Log.i(TAG, "stopVpnGraceful: calling stopForeground");
        stopForeground(true);
        if (notificationManager != null) notificationManager.cancel(NOTIFICATION_ID);
        // Останавливаем tun2socks, Xray, mihomo БЕЗ CORE_LOCK — иначе deadlock:
        // startVpn держит CORE_LOCK на время xrayManager.start() (9с waitForPortClosed
        // + 12с waitForReady), а мы пытаемся войти в тот же лок.
        releaseWakeLock();
        activeProxyEndpoint = null;
        activeConfigJson = null;
        stopStatsLoop();
        long t0 = System.currentTimeMillis();
        Tunnel.stop();
        long t2sDur = System.currentTimeMillis() - t0;
        Log.i(TAG, "stopVpnGraceful: Tunnel.stop took " + t2sDur + "ms");
        Thread t2s = tun2socksThread.getAndSet(null);
        if (t2s != null) {
            try { t2s.join(3000); } catch (InterruptedException ignored) {}
        }
        // Epoch-safe: останавливаем Xray только если новый start() ещё не запущен
        xrayManager.stopIfEpoch(xrayEpochAtStart);
        if (mihomoManager.getStartEpoch() == mihomoEpochAtStart) {
            mihomoManager.stop();
        } else {
            Log.i(TAG, "stopVpnGraceful: skipping mihomoManager.stop() — new session (epoch "
                    + mihomoEpochAtStart + " -> " + mihomoManager.getStartEpoch() + ")");
        }
        startTime = 0;
        // tunFd закрываем под CORE_LOCK с проверкой: если новый startVpn уже присвоил
        // новый tunFd или уже работает — не трогаем. Не закрываем и vpn-сессию в этом случае.
        synchronized (CORE_LOCK) {
            if (!isStarting.get() && !isRunning()) {
                if (tunFd != null) {
                    try { tunFd.close(); } catch (Exception ignored) {}
                    tunFd = null;
                }
                if (mihomoManager.getStartEpoch() == mihomoEpochAtStart) {
                    forceReleaseVpnSession();
                } else {
                    Log.i(TAG, "stopVpnGraceful: skipping forceReleaseVpnSession — new session");
                }
            } else {
                Log.i(TAG, "stopVpnGraceful: skipping tunFd close — new start in progress");
            }
        }
        if (isStarting.get() || isRunning()) {
            Log.i(TAG, "stopVpnGraceful: skipping stopSelf — new connection in progress");
        } else {
            // stopSelf(startId), а не stopSelf(): guard выше проигрывает гонке —
            // новый START приходит через startForegroundService, но его
            // onStartCommand (isStarting=true) выполняется асинхронно. Старый
            // безусловный stopSelf() в этом окне убивал сервис до вызова
            // startForeground новым сеансом →
            // ForegroundServiceDidNotStartInTimeException. stopSelf(startId)
            // системно no-op, если после этого STOP уже пришёл новый старт.
            Log.i(TAG, "stopVpnGraceful: calling stopSelf(startId=" + startId + ")");
            stopSelf(startId);
        }
        Log.i(TAG, "stopVpnGraceful: done");
    }

    private void stopVpnInternal() {
        Log.i(TAG, "stopVpnInternal: begin, tunFd=" + (tunFd != null ? tunFd.getFd() : "null"));
        mihomoTunnelReady = false;
        releaseWakeLock();
        activeProxyEndpoint = null;
        activeConfigJson = null;
        stopStatsLoop();
        // Snapshot epoch BEFORE the sleep so we can detect if a new mihomo session
        // was started concurrently (e.g. STOP + START intents arriving in quick succession).
        int epochBeforeSleep = mihomoManager.getStartEpoch();
        long t0 = System.currentTimeMillis();
        Tunnel.stop();
        long t2sDur = System.currentTimeMillis() - t0;
        Log.i(TAG, "stopVpnInternal: Tunnel.stop took " + t2sDur + "ms");
        Thread t2s = tun2socksThread.getAndSet(null);
        if (t2s != null) {
            try { t2s.join(3000); } catch (InterruptedException ignored) {}
        }
        xrayManager.stop();
        // Skip if a concurrent startVpn already launched a new mihomo during our sleep.
        // That new start() incremented startEpoch; killing it here would break the new session.
        if (mihomoManager.getStartEpoch() == epochBeforeSleep) {
            mihomoManager.stop();
        } else {
            Log.i(TAG, "stopVpnInternal: skipping mihomoManager.stop() — new session started (epoch " + epochBeforeSleep + " -> " + mihomoManager.getStartEpoch() + ")");
        }
        if (tunFd != null) {
            try { tunFd.close(); } catch (Exception ignored) {}
            tunFd = null;
        }
        startTime = 0;
        Log.i(TAG, "stopVpnInternal: done");
    }

    // ── Учёт трафика ────────────────────────────────────────────────────
    private long safeRx(int uid) {
        long v = TrafficStats.getUidRxBytes(uid);
        if (v < 0) v = TrafficStats.getTotalRxBytes();
        return v < 0 ? 0 : v;
    }
    private long safeTx(int uid) {
        long v = TrafficStats.getUidTxBytes(uid);
        if (v < 0) v = TrafficStats.getTotalTxBytes();
        return v < 0 ? 0 : v;
    }

    private synchronized void startStatsLoop() {
        if (statsRunning) return;
        statsRunning = true;
        statsLoopLastTickMs = System.currentTimeMillis();
        final int uid = Process.myUid();
        sessRxStart = safeRx(uid);
        sessTxStart = safeTx(uid);
        lastRx = sessRxStart;
        lastTx = sessTxStart;
        lastTs = System.currentTimeMillis();
        curDown = 0; curUp = 0; totalDown = 0; totalUp = 0;

        statsThread = new Thread(() -> {
            final Thread self = Thread.currentThread();
            int watchdogTick = 0;
            while (statsRunning) {
                try { Thread.sleep(2000); } catch (InterruptedException e) { break; }
                if (!statsRunning) break;
                // Нить могла быть заменена супервизором после stall — старая выходит,
                // чтобы два цикла проб не жили параллельно.
                if (statsThread != self) {
                    Log.w(TAG, "StatsLoop: replaced by supervisor — old thread exits");
                    break;
                }
                statsLoopLastTickMs = System.currentTimeMillis();
                try {
                long now = System.currentTimeMillis();
                long rx = safeRx(uid);
                long tx = safeTx(uid);
                long dt = Math.max(1, now - lastTs);
                curDown = Math.max(0, (rx - lastRx) * 1000 / dt);
                curUp = Math.max(0, (tx - lastTx) * 1000 / dt);
                totalDown = Math.max(0, rx - sessRxStart);
                totalUp = Math.max(0, tx - sessTxStart);
                lastRx = rx; lastTx = tx; lastTs = now;

                // Watchdog: каждые 10 сек проверяем, жив ли core.
                // Если упал — переподключаемся без участия пользователя.
                // Диагностика для unresolved auto-disconnect-через-1-3с бага (см. память
                // arch-vpn-control-threading): этот путь — единственный реконнект, который
                // ПОЛНОСТЬЮ живёт в Java и никогда не идёт через JS nativeStopVpn(reason),
                // поэтому прошлая инструментация "stopVpn called by JS, reason=" его не ловит.
                // Логируем составляющие isRunning() ПЕРЕД срабатыванием — если сработает
                // ложно (ядро на деле живо), лог сразу покажет, какая именно проверка соврала.
                watchdogTick++;
                if (watchdogTick % 5 == 0 && lastConfig != null && !userStopped && !isStarting() && !isRunning()) {
                    if (isMihomo()) {
                        Log.w(TAG, "Watchdog: core-dead check — mihomoManager.isRunning()=" + mihomoManager.isRunning()
                                + " mihomoTunnelReady=" + mihomoTunnelReady);
                    } else {
                        Log.w(TAG, "Watchdog: core-dead check — xrayManager.isRunning()=" + xrayManager.isRunning());
                    }
                    Log.w(TAG, "Watchdog: VPN core died unexpectedly, reconnecting...");
                    // Сообщаем JS что VPN упал сам по себе (не по воле пользователя).
                    // JS покажет подсказку про оптимизацию батареи если разрешение ещё не выдано.
                    NativeBridge bridge = NativeBridge.getInstance();
                    if (bridge != null) bridge.emitJsEventPublic("vpn-dropped-in-background", "{}");
                    reconnectWithDelay(1000);
                    break; // stats thread завершится; новый запустит startStatsLoop
                }

                // Проверка живости туннеля: ядро живо, но трафик через него не идёт.
                // Единственный путь, который ловит «подключено, а интернета нет» после
                // смены сети/оператора: watchdog выше реагирует только на смерть ядра,
                // а ConnectionValidator в проекте не вызывается вообще.
                // В обычном режиме проверяем раз в 30 с, но сразу после смены сети переходим
                // на 10 с: именно там туннель и ломается, и ждать полминуты до первой
                // проверки — это как раз та задержка восстановления, которую видит юзер.
                boolean probeWindowOpen = now >= tunnelProbeSuppressUntilMs
                        && now - lastConnectTimeMs > TUNNEL_PROBE_MIN_AGE_MS;
                boolean fastMode = now - lastNetworkChangeMs < TUNNEL_PROBE_FAST_WINDOW_MS;
                int probeEvery = fastMode ? TUNNEL_PROBE_EVERY_TICKS_FAST : TUNNEL_PROBE_EVERY_TICKS;
                if (probeWindowOpen && watchdogTick % probeEvery == 0
                        && lastConfig != null && !userStopped && !isStarting() && isRunning()
                        && networkMonitor != null
                        && networkMonitor.getCurrentNetwork() != NetworkMonitor.NetworkType.NONE) {
                    boolean socksOk = probeTunnelOnce();
                    // SOCKS жив ≠ туннель жив: проба идёт по 127.0.0.1 из процесса, чей
                    // uid намеренно выведен из маршрутов tun. Отказом считаем и случай
                    // «SOCKS отвечает, но в интерфейс льются пакеты без ответа».
                    boolean probeOk = socksOk && tunHasTrafficBack();
                    if (probeOk) {
                        if (tunnelProbeFailStreak > 0) {
                            Log.i(TAG, "Tunnel probe: recovered");
                            updateNotification(shieldMode ? "🛡 Иммунитет • фильтр активен" : "Подключено", !shieldMode); // снять «Сервер недоступен…»
                        } else Log.d(TAG, "Tunnel probe: ok");
                        tunnelProbeFailStreak = 0;
                        forcedRebuildCount = 0;
                    } else {
                        tunnelProbeFailStreak++;
                        Log.w(TAG, (socksOk
                                        ? "Tunnel probe: SOCKS ok but TUN not answering"
                                        : "Tunnel probe failed")
                                + " (" + tunnelProbeFailStreak + "/"
                                + TUNNEL_PROBE_FAILS_TO_REBUILD + ")" + (fastMode ? " [fast]" : ""));
                        if (tunnelProbeFailStreak >= TUNNEL_PROBE_FAILS_TO_REBUILD) {
                            tunnelProbeFailStreak = 0;
                            if (tryRecoverTunnel()) return; // процесс будет убит — потоку статистики конец
                            // Лечение отложено (сервер лежит/предохранитель): поток жив,
                            // проба продолжится после паузы и зафиксирует выздоровление.
                        }
                    }
                }
                } catch (Throwable t) {
                    // Тело шага больше не может молча убить нить: раньше исключение здесь
                    // обрывало цикл проб навсегда (симптом — туннель мёртв, в логах тишина).
                    Log.e(TAG, "StatsLoop: step failed: " + t, t);
                }

                // Скорость в шторке не показываем: каждый updateNotification() — IPC к
                // NotificationManager → перерисовка шторки → нагрев + батарея. Статическое
                // уведомление «Подключено» ставится один раз при старте VPN (startVpn).
            }
        }, "VpnStatsLoop");
        statsThread.start();
        startStatsSupervisorLocked();
    }

    private synchronized void stopStatsLoop() {
        statsRunning = false;
        if (statsThread != null) {
            statsThread.interrupt();
            statsThread = null;
        }
        if (statsSupervisorThread != null) {
            statsSupervisorThread.interrupt();
            statsSupervisorThread = null;
        }
        curDown = 0; curUp = 0;
    }

    /**
     * Супервизор цикла статистики: раз в 30 с проверяет, что нить продолжает тикать.
     * Нить можно молча убить исключением или заморозить навсегда (binder-вызов
     * updateNotification, сетевой I/O) — в обоих случаях пробы туннеля прекращаются
     * и «мёртвый туннель без восстановления» гарантирован. Без этого контроля
     * зависание нити было неотличимо от здоровой работы сервиса.
     */
    private void startStatsSupervisorLocked() {
        if (statsSupervisorThread != null && statsSupervisorThread.isAlive()) return;
        statsSupervisorThread = new Thread(() -> {
            while (statsRunning) {
                try { Thread.sleep(30_000); } catch (InterruptedException e) { return; }
                if (!statsRunning) return;
                long last = statsLoopLastTickMs;
                long nowMs = System.currentTimeMillis();
                if (nowMs - last > 90_000) {
                    Log.e(TAG, "StatsSupervisor: stats loop stalled for " + ((nowMs - last) / 1000)
                            + "s — restarting tunnel monitor");
                    restartStatsLoopStalled();
                }
            }
        }, "VpnStatsSupervisor");
        statsSupervisorThread.start();
    }

    private synchronized void restartStatsLoopStalled() {
        if (!statsRunning) return;
        statsRunning = false;
        Thread old = statsThread;
        statsThread = null;
        if (old != null) old.interrupt();
        try {
            startStatsLoop();
        } catch (Throwable t) {
            Log.e(TAG, "StatsSupervisor: restart failed: " + t, t);
        }
    }

    private String fmtBytes(long b) {
        if (b < 1024) return b + " B";
        double kb = b / 1024.0;
        if (kb < 1024) return String.format(java.util.Locale.US, "%.1f KB", kb);
        double mb = kb / 1024.0;
        if (mb < 1024) return String.format(java.util.Locale.US, "%.1f MB", mb);
        return String.format(java.util.Locale.US, "%.2f GB", mb / 1024.0);
    }
    private String fmtSpeed(long bytesPerSec) {
        return fmtBytes(bytesPerSec) + "/s";
    }

    private int parseSocksPort(String config, int fallback) {
        try {
            JSONObject obj = new JSONObject(config);
            JSONArray ins = obj.optJSONArray("inbounds");
            if (ins != null) {
                for (int i = 0; i < ins.length(); i++) {
                    JSONObject in = ins.optJSONObject(i);
                    if (in != null && "socks".equals(in.optString("protocol"))) {
                        int p = in.optInt("port", 0);
                        if (p > 0) return p;
                    }
                }
            }
        } catch (Throwable ignored) {}
        return fallback;
    }

    @Override public void onRevoke() { new Thread(() -> stopVpn(), "VpnRevokeThread").start(); super.onRevoke(); }
    @Override public void onDestroy() {
        Log.i(TAG, "onDestroy called");
        if (networkMonitor != null) networkMonitor.removeListener(networkChangeListener);
        // Guard: if a new session is starting or already running, do NOT call stopVpnInternal —
        // it would kill the new session's mihomo. This happens when Android reuses the service
        // instance (new START arrives before the old service is destroyed) and onDestroy fires
        // after the new session has already begun. In that case cleanup was already done by
        // stopVpnGraceful; we only cancel the notification here.
        if (!isStarting.get() && !isRunning()) {
            stopVpnInternal();
        } else {
            Log.i(TAG, "onDestroy: skipping stopVpnInternal — new session active (isStarting="
                    + isStarting.get() + ", isRunning=" + isRunning() + ")");
            stopStatsLoop();
        }
        // Принудительно снять уведомление — если поток статистики успел запостить
        // регулярное уведомление после stopForeground(true), оно не удаляется само.
        if (notificationManager != null) notificationManager.cancel(NOTIFICATION_ID);
        instance = null;
        super.onDestroy();
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel ch = new NotificationChannel(CHANNEL_ID, "VPN Status", NotificationManager.IMPORTANCE_LOW);
            if (notificationManager != null) notificationManager.createNotificationChannel(ch);
        }
    }

    private boolean isMihomo() { return "mihomo".equals(activeCore); }
    public boolean isRunning() {
        if (isMihomo()) {
            // mihomoTunnelReady — успешно ли tun2socks доставил TUN fd ядру.
            // НЕ проверяем t2sThread.isAlive(): этот поток завершается сразу
            // после доставки fd (см. mihomoTunnelReady), хотя туннель продолжает
            // работать. Падение самого mihomo-процесса всё равно ловит isRunning().
            return mihomoManager.isRunning() && mihomoTunnelReady;
        }
        return xrayManager.isRunning();
    }
    public int getSocksPort() { return isMihomo() ? mihomoManager.getSocksPort() : xrayManager.getSocksPort(); }
    public boolean isStarting() { return isStarting.get(); }
    public String getLogs() { return isMihomo() ? mihomoManager.getLogs() : xrayManager.getLogs(); }

    /**
     * Запускает AntiFilterService для поддержания живого SOCKS-соединения
     * при выключении основного VPN.
     */
    private void startAntiFilterService() {
        try {
            Intent intent = new Intent(this, AntiFilterService.class);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                startForegroundService(intent);
            } else {
                startService(intent);
            }
            Log.i(TAG, "AntiFilterService started");
        } catch (Exception e) {
            Log.e(TAG, "Failed to start AntiFilterService", e);
        }
    }

    /**
     * Останавливает AntiFilterService при выключении VPN.
     * Сервис может продолжить работу самостоятельно для keep-alive пингов.
     */
    private void stopAntiFilterService() {
        try {
            AntiFilterService service = AntiFilterService.getInstance();
            if (service != null) {
                AntiFilterService.markUserStopped();
                stopService(new Intent(this, AntiFilterService.class));
                Log.i(TAG, "AntiFilterService stopped");
            }
        } catch (Exception e) {
            Log.w(TAG, "Error stopping AntiFilterService", e);
        }
    }

    // Network-triggered reconnect: suppressed for RECONNECT_COOLDOWN_MS after a successful
    // connection to avoid a storm caused by VPN routing changes triggering NetworkMonitor events.
    private void reconnectOnNetworkChange(long delayMs) {
        long msSinceLast = System.currentTimeMillis() - lastConnectTimeMs;
        if (msSinceLast < RECONNECT_COOLDOWN_MS) {
            // Раньше здесь стоял return — и реконнект терялся НАВСЕГДА: onNetworkChanged уже
            // успел сбросить networkWasLost, поэтому ни одно будущее событие его бы не подняло.
            // Сценарий: подключился и сразу переключил Wi-Fi → мобильный. Туннель оставался
            // привязан к исчезнувшей сети, UI показывал «подключено», интернета не было.
            // Теперь переносим попытку на остаток кулдауна: защита от шторма сохраняется,
            // но нужный реконнект больше не пропадает.
            long waitMs = RECONNECT_COOLDOWN_MS - msSinceLast;
            Log.d(TAG, "reconnectOnNetworkChange: deferred by " + waitMs + "ms (cooldown)");
            reconnectWithDelay(delayMs + waitMs);
            return;
        }
        reconnectWithDelay(delayMs);
    }

    /**
     * Аварийное восстановление: перезапуск процесса целиком.
     *
     * Почему не перезапуск ядра: при перезапуске в том же процессе создаётся новый TUN,
     * но чтение нового интерфейса не поднимается — пакеты входят в tun и дропаются,
     * хотя SOCKS-порт ядра открыт и отвечает. Из-за этого состояние неотличимо от
     * рабочего по всем внутренним проверкам и лечится только ручным переподключением
     * (подтверждено пользователем). Смерть процесса очищает состояние нативной
     * библиотеки, и свежий старт поднимает TUN корректно.
     *
     * Сервис объявлен START_STICKY, поэтому система поднимет его сама; будильник
     * watchdog — страховка на случай агрессивных прошивок.
     */
    private void restartProcessForFreshCore() {
        Log.w(TAG, "restartProcessForFreshCore: killing process for a clean core");
        try {
            WatchdogReceiver.scheduleImmediate(this, 3000);
        } catch (Throwable t) {
            Log.e(TAG, "restartProcessForFreshCore: не удалось поставить будильник", t);
        }
        try {
            updateNotification("Переподключение…", false);
        } catch (Throwable ignored) {}
        // Небольшая задержка, чтобы будильник успел зарегистрироваться в системе.
        new android.os.Handler(android.os.Looper.getMainLooper()).postDelayed(() -> {
            try {
                android.os.Process.killProcess(android.os.Process.myPid());
            } catch (Throwable ignored) {
                // ignore
            }
            System.exit(0);
        }, 500);
    }

    /**
     * Фоновый failover: текущий сервер мёртв — переключаемся на первый отвечающий запасной.
     *
     * Список запасных JS отдаёт при подключении (src/native/failover.ts) и хранит в prefs —
     * он обязан переживать смерть процесса, ведь переключение и есть убийство процесса.
     * Кандидата проверяем прямым TCP-соединением (наш uid вне tun, мимо VPN): переключаемся
     * только на адрес, который реально отвечает. Если не отвечает ни один — сеть упала
     * целиком или лежат все серверы: возвращаем false и лечим как раньше (ждём), а не
     * сжигаем лимиты впустую.
     *
     * @return true — процесс сейчас убивается с конфигом нового сервера.
     */
    private boolean tryFailoverToFallback() {
        try {
            SharedPreferences prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            String raw = prefs.getString("fallbacks", null);
            if (raw == null || raw.trim().isEmpty()) return false;
            if (countRecentFailovers() >= MAX_FAILOVERS_PER_WINDOW) {
                Log.w(TAG, "Failover: лимит переключений (" + MAX_FAILOVERS_PER_WINDOW + " за "
                        + (FAILOVER_WINDOW_MS / 60_000L) + " мин) — дальше только ждём восстановления");
                return false;
            }
            JSONArray arr = new JSONArray(raw);
            String currentEp = activeProxyEndpoint;
            int chosen = -1;
            JSONObject fb = null;
            String fbEp = null;
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.optJSONObject(i);
                if (o == null) continue;
                String candEp = o.optString("endpoint", "");
                if (candEp.isEmpty()) candEp = extractProxyEndpoint(o.optString("config", ""));
                if (candEp == null || candEp.isEmpty()) continue;
                if (candEp.equals(currentEp)) continue; // это и есть текущий — не запасной
                if (o.optString("config", "").isEmpty() || o.optString("settings", "").isEmpty()) continue;
                Boolean ok = isTcpReachable(candEp, UPSTREAM_CHECK_TIMEOUT_MS);
                if (ok == null || !ok) continue; // мёртв или не разобрали — пробуем следующего
                chosen = i;
                fb = o;
                fbEp = candEp;
                break;
            }
            if (fb == null || fbEp == null) {
                // Ни один кандидат не ответил (или список пуст) — ждём как раньше, но логируем,
                // иначе «почему не переключились?» в фоне не диагностируется.
                Log.i(TAG, "Failover: живого кандидата нет — candidates=" + arr.length()
                        + ", current=" + currentEp + ", history=" + countRecentFailovers());
                return false;
            }

            String oldEp = currentEp;
            String newCfg = fb.optString("config");
            String newSet = fb.optString("settings");
            String newId = fb.optString("id", "");
            String newName = fb.optString("name", "");

            // Очередь запасных: после выбранного — ещё не проверенные, затем отброшенные
            // (могли ожить), в самый конец — старый активный сервер (сейчас мёртв, но когда
            // вернётся, снова станет кандидатом). Длина очереди не растёт.
            JSONArray next = new JSONArray();
            for (int i = chosen + 1; i < arr.length(); i++) if (arr.optJSONObject(i) != null) next.put(arr.optJSONObject(i));
            for (int i = 0; i < chosen; i++) if (arr.optJSONObject(i) != null) next.put(arr.optJSONObject(i));
            if (lastConfig != null && activeProxyEndpoint != null) {
                try {
                    JSONObject old = new JSONObject();
                    old.put("id", prefs.getString("active_node_id", ""));
                    old.put("name", serverName);
                    old.put("endpoint", activeProxyEndpoint);
                    old.put("config", lastConfig);
                    old.put("settings", lastSettings);
                    next.put(old);
                } catch (Throwable ignored) {}
            }

            // Конфиг нового сервера должен подхватить СТАРТ ПОСЛЕ СМЕРТИ ПРОЦЕССА:
            // START_STICKY/START_LAST читают prefs, поэтому персистим ДО убийства.
            prefs.edit()
                    .putString("config", newCfg)
                    .putString("settings", newSet)
                    .putString("active_node_id", newId)
                    .putString("fallbacks", next.toString())
                    .putString("pending_failover", newName)
                    .apply();
            lastConfig = newCfg;
            lastSettings = newSet;
            activeProxyEndpoint = fbEp;
            try { serverName = new JSONObject(newSet).optString("nodeName", serverName); } catch (Throwable ignored) {}
            registerFailoverSwitch();
            appendFailoverJournal(oldEp, fbEp, newName);
            registerProcessKill(); // убийство процесса — в общую статистику предохранителя
            Log.w(TAG, "Failover: сервер " + oldEp + " недоступен — переключаемся на "
                    + newName + " (" + fbEp + ")");
            NativeBridge bridge = NativeBridge.getInstance();
            if (bridge != null) {
                bridge.emitJsEventPublic("vpn-failover",
                        "{\"id\":" + JSONObject.quote(newId) + ",\"name\":" + JSONObject.quote(newName) + "}");
            }
            restartProcessForFreshCore();
            return true;
        } catch (Throwable t) {
            Log.e(TAG, "tryFailoverToFallback failed: " + t, t);
            return false;
        }
    }

    /**
     * Туннель мёртв, ядро «живо». Решает, ЧЕМ лечить, и убивать ли процесс.
     *
     * @return true — процесс сейчас будет убит (поток статистики нужно завершать).
     */
    private boolean tryRecoverTunnel() {
        String endpoint = activeProxyEndpoint;
        // Сервер отвечает? Прямое TCP-соединение идёт мимо VPN (наш uid вне tun) — тем же
        // путём, которым ядро ходит к серверу. Если сервер не отвечает, свежее ядро не
        // поможет: оно упрётся в тот же сервер, а убийство только выключит VPN на
        // секунды и зациклит лечение. В этом случае оставляем ядро живым и ждём: туннель
        // оживёт сам, как только сервер вернётся, без разрыва и пересоздания VPN.
        Boolean reachable = isTcpReachable(endpoint, UPSTREAM_CHECK_TIMEOUT_MS);
        if (reachable != null && !reachable) {
            // Сервер мёртв — сначала пробуем уехать на запасной (фоновый failover: работает
            // и с закрытым приложением). Не получилось (живых нет / лимит окна) — прежнее
            // поведение: ждём выздоровления без разрыва VPN.
            // В режиме «Иммунитет» узла и запасных нет — failover не применим.
            if (!shieldMode && tryFailoverToFallback()) return true;
            Log.w(TAG, "Tunnel dead, but proxy endpoint " + endpoint + " unreachable — server/network is down, keeping process alive");
            updateNotification("Сервер недоступен — ждём восстановления…", false);
            tunnelProbeSuppressUntilMs = System.currentTimeMillis() + 30_000;
            forcedRebuildCount++;
            return false;
        }
        int kills = countRecentProcessKills();
        if (kills >= MAX_PROCESS_KILLS_PER_WINDOW) {
            // Рестарты ядра не помогли — это последний шанс уехать на другой сервер.
            // У failover свой счётчик окна, поэтому предохранитель убийств ему не мешает.
            // В режиме «Иммунитет» узла и запасных нет — failover не применим.
            if (!shieldMode && tryFailoverToFallback()) return true;
            Log.e(TAG, "Tunnel dead, endpoint " + endpoint + " reachable, but process-kill circuit breaker tripped ("
                    + kills + " kills in " + (PROCESS_KILL_WINDOW_MS / 60_000L) + " min) — waiting instead of flapping");
            updateNotification("Не удалось восстановить соединение — повторяем попытки", false);
            tunnelProbeSuppressUntilMs = System.currentTimeMillis() + 60_000;
            forcedRebuildCount++;
            return false;
        }
        registerProcessKill();
        Log.w(TAG, "Tunnel dead while core alive (endpoint " + endpoint + " reachable) — restarting the whole process for a fresh core");
        NativeBridge bridge = NativeBridge.getInstance();
        if (bridge != null) bridge.emitJsEventPublic("vpn-dropped-in-background", "{}");
        restartProcessForFreshCore();
        return true;
    }

    /**
     * Прямая проверка прокси-сервера.
     *
     * @return true/false — результат проверки, null — «неизвестно» (нет адреса/не
     * разобрали): тогда лечим как раньше, не мешая.
     */
    private Boolean isTcpReachable(String endpoint, int timeoutMs) {
        if (endpoint == null || endpoint.isEmpty()) return null;
        String host;
        int port;
        try {
            int idx = endpoint.lastIndexOf(':');
            if (idx <= 0 || idx >= endpoint.length() - 1) return null;
            host = endpoint.substring(0, idx).trim();
            port = Integer.parseInt(endpoint.substring(idx + 1).trim());
        } catch (Throwable parse) {
            return null;
        }
        if (host.isEmpty() || port <= 0 || port > 65535) return null;
        try (java.net.Socket s = new java.net.Socket()) {
            s.connect(new java.net.InetSocketAddress(host, port), timeoutMs);
            return true;
        } catch (Throwable t) {
            return false;
        }
    }

    // История убийств процесса живёт в prefs: сами убийства обязаны её пережить,
    // иначе предохранитель сбрасывался бы вместе с процессом и не защищал ни от чего.
    private java.util.ArrayList<Long> readProcessKillTimes() {
        java.util.ArrayList<Long> out = new java.util.ArrayList<>();
        try {
            String raw = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                    .getString(PREF_KILL_HISTORY, "");
            if (raw == null || raw.isEmpty()) return out;
            long cutoff = System.currentTimeMillis() - PROCESS_KILL_WINDOW_MS;
            for (String s : raw.split(",")) {
                long ts = Long.parseLong(s.trim());
                if (ts >= cutoff) out.add(ts);
            }
        } catch (Throwable ignored) {
        }
        return out;
    }

    private int countRecentProcessKills() {
        return readProcessKillTimes().size();
    }

    private void registerProcessKill() {
        try {
            java.util.ArrayList<Long> list = readProcessKillTimes();
            list.add(System.currentTimeMillis());
            StringBuilder sb = new StringBuilder();
            for (long ts : list) {
                if (sb.length() > 0) sb.append(',');
                sb.append(ts);
            }
            getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).edit()
                    .putString(PREF_KILL_HISTORY, sb.toString()).apply();
        } catch (Throwable ignored) {
        }
    }

    // История автопереключений на запасной сервер — тот же принцип, что и у убийств:
    // живёт в prefs, иначе предохранитель failover сбрасывался бы при каждом рестарте
    // процесса и ничего не ограничивало.
    private java.util.ArrayList<Long> readFailoverTimes() {
        java.util.ArrayList<Long> out = new java.util.ArrayList<>();
        try {
            String raw = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                    .getString(PREF_FAILOVER_HISTORY, "");
            if (raw == null || raw.isEmpty()) return out;
            long cutoff = System.currentTimeMillis() - FAILOVER_WINDOW_MS;
            for (String s : raw.split(",")) {
                long ts = Long.parseLong(s.trim());
                if (ts >= cutoff) out.add(ts);
            }
        } catch (Throwable ignored) {
        }
        return out;
    }

    private int countRecentFailovers() {
        return readFailoverTimes().size();
    }

    private void registerFailoverSwitch() {
        try {
            java.util.ArrayList<Long> list = readFailoverTimes();
            list.add(System.currentTimeMillis());
            StringBuilder sb = new StringBuilder();
            for (long ts : list) {
                if (sb.length() > 0) sb.append(',');
                sb.append(ts);
            }
            getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).edit()
                    .putString(PREF_FAILOVER_HISTORY, sb.toString()).apply();
        } catch (Throwable ignored) {
        }
    }

    // Запись в журнал фоновых переключений («Петрович-агент»): старый адрес → новый адрес.
    // JSON-массив {ts, from, to, name}, новые записи впереди, хвост обрезаем.
    private void appendFailoverJournal(String fromEp, String toEp, String toName) {
        try {
            java.util.ArrayList<JSONObject> list = new java.util.ArrayList<>();
            String raw = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                    .getString(PREF_FAILOVER_JOURNAL, "[]");
            try {
                JSONArray arr = new JSONArray(raw);
                for (int i = 0; i < arr.length(); i++) list.add(arr.getJSONObject(i));
            } catch (Throwable ignored) { /* битое — начинаем с чистого листа */ }
            JSONObject rec = new JSONObject();
            rec.put("ts", System.currentTimeMillis());
            rec.put("from", fromEp == null ? "" : fromEp);
            rec.put("to", toEp == null ? "" : toEp);
            rec.put("name", toName == null ? "" : toName);
            list.add(0, rec);
            while (list.size() > FAILOVER_JOURNAL_MAX) list.remove(list.size() - 1);
            StringBuilder sb = new StringBuilder("[");
            for (int i = 0; i < list.size(); i++) {
                if (i > 0) sb.append(',');
                sb.append(list.get(i).toString());
            }
            sb.append(']');
            getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).edit()
                    .putString(PREF_FAILOVER_JOURNAL, sb.toString()).apply();
        } catch (Throwable ignored) {
        }
    }

    // Чтение журнала для JS: JSON-массив последних переключений (или "[]").
    public String getFailoverJournal() {
        try {
            String raw = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                    .getString(PREF_FAILOVER_JOURNAL, "[]");
            if (raw == null || raw.isEmpty()) return "[]";
            new JSONArray(raw); // валидация — вернём битое как пустое
            return raw;
        } catch (Throwable ignored) {
            return "[]";
        }
    }

    /**
     * Проверка того, что туннель ПРОВОДИТ трафик, а не только отвечает на SOCKS.
     *
     * Берём счётчики /proc/self/net/dev: пока в tun идут пакеты (tx растёт), а обратных
     * байт нет (rx) — интерфейс никто не читает, трафик юзера дропается. Это и есть
     * исходный баг «подключено, но не грузит», который проба через 127.0.0.1 не видит.
     * Считаем отказом только убедительный признак (несколько килобайт без ответа и не
     * первый же замер), чтобы не лечить по ложному сигналу.
     *
     * @return false — есть убедительные признаки мёртвого TUN.
     */
    private boolean tunHasTrafficBack() {
        try {
            long[] counters = readTunCounters();
            if (counters == null) return true; // счётчики недоступны — не мешаем
            long tx = counters[0], rx = counters[1];
            long now = System.currentTimeMillis();
            long prevTx = lastTunTxBytes, prevRx = lastTunRxBytes, prevMs = lastTunSampleMs;
            lastTunTxBytes = tx;
            lastTunRxBytes = rx;
            lastTunSampleMs = now;
            // Первый замер или слишком старый — только базовая линия, сравнить не с чем.
            if (prevTx < 0 || prevMs <= 0 || now - prevMs > TUN_SAMPLE_MAX_AGE_MS) return true;
            long dTx = tx - prevTx, dRx = rx - prevRx;
            if (dTx >= TUN_DEAD_TX_MIN_BYTES && dRx <= 0) {
                tunDeadStreak++;
                Log.w(TAG, "TUN no-reply: +" + dTx + " B into tun, +" + dRx + " B back ("
                        + tunDeadStreak + "/" + TUN_DEAD_FAILS_TO_TREAT + ")");
                if (tunDeadStreak >= TUN_DEAD_FAILS_TO_TREAT) {
                    tunDeadStreak = 0;
                    return false;
                }
            } else {
                tunDeadStreak = 0;
            }
        } catch (Throwable t) {
            Log.d(TAG, "tun counters unavailable: " + t);
        }
        return true;
    }

    /** @return {txBytes, rxBytes} или null, если доступа к счётчикам нет. */
    private long[] readTunCounters() {
        String iface = tunInterfaceName();
        if (iface == null) return null;
        for (String path : new String[]{"/proc/self/net/dev", "/proc/net/dev"}) {
            try (java.io.BufferedReader br = new java.io.BufferedReader(new java.io.FileReader(path))) {
                String line;
                while ((line = br.readLine()) != null) {
                    line = line.trim();
                    if (!line.startsWith(iface + ":")) continue;
                    String[] p = line.split("\\s+");
                    if (p.length < 10) return null;
                    // [0]="tun1:" [1]=rx_bytes ... [9]=tx_bytes
                    return new long[]{Long.parseLong(p[9]), Long.parseLong(p[1])};
                }
            } catch (Throwable ignored) {
                // пробуем следующий путь
            }
        }
        return null;
    }

    /** Имя нашего tun-интерфейса берём у системы: оно меняется при каждом пересоздании VPN. */
    private String tunInterfaceName() {
        try {
            android.net.ConnectivityManager cm =
                    (android.net.ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
            if (cm != null) {
                for (android.net.Network n : cm.getAllNetworks()) {
                    android.net.NetworkCapabilities nc = cm.getNetworkCapabilities(n);
                    if (nc == null || !nc.hasTransport(android.net.NetworkCapabilities.TRANSPORT_VPN)) continue;
                    android.net.LinkProperties lp = cm.getLinkProperties(n);
                    String name = lp != null ? lp.getInterfaceName() : null;
                    if (name != null) {
                        if (!name.equals(tunIfaceName)) {
                            tunIfaceName = name;
                            // Интерфейс новый — базовую линию сбросить, чтобы не
                            // сравнивать счётчики разных устройств.
                            lastTunTxBytes = -1;
                            lastTunRxBytes = -1;
                            lastTunSampleMs = 0;
                        }
                        return name;
                    }
                }
            }
        } catch (Throwable ignored) {
        }
        return tunIfaceName;
    }

    private void reconnectWithDelay(long delayMs) {
        final String cfg;
        final String set;
        synchronized (this) {
            if (lastConfig == null || userStopped) {
                Log.i(TAG, "reconnectWithDelay: skipped — lastConfig=" + (lastConfig != null) + " userStopped=" + userStopped);
                return;
            }
            cfg = lastConfig;
            set = lastSettings;
        }
        // Silent no-op if a previous start/reconnect attempt never completed (e.g. stuck in
        // waitForReady) — isStarting stays true forever and every future network-change
        // reconnect is dropped with no trace. Log it so a stuck-connected-no-internet report
        // can be diagnosed instead of guessed at.
        boolean alreadyStarting = isStarting.getAndSet(true);
        if (alreadyStarting) {
            long held = System.currentTimeMillis() - isStartingSinceMs;
            if (isStartingSinceMs > 0 && held > STARTING_STUCK_MS) {
                // Флаг висит подозрительно долго: поток старта, скорее всего, умер, не дойдя
                // до finally. Без этого все последующие сетевые реконнекты отбрасывались бы
                // НАВСЕГДА, и спас бы только перезапуск приложения вручную.
                Log.w(TAG, "reconnectWithDelay: isStarting stuck for " + held + "ms — forcing a new attempt");
            } else {
                Log.i(TAG, "reconnectWithDelay: skipped — already starting (possibly stuck from a prior attempt)");
                return;
            }
        }
        isStartingSinceMs = System.currentTimeMillis();
        updateNotification("Переподключение...", false);
        new Thread(() -> {
            try {
                try { Thread.sleep(delayMs); } catch (InterruptedException e) { return; }
                if (userStopped) return;
                // Короткие всплески Wi-Fi (роуминг точки доступа, DHCP-обновление) шлют
                // lost/available несколько раз подряд, но за время delayMs сеть часто уже
                // сама восстанавливается на ТОТ ЖЕ тип сети, а ядро всё это время остаётся
                // живым. В этом случае полная пересборка (stop+restart, ~2-4с) не нужна —
                // достаточно перепривязать VPN к актуальной сети через setUnderlyingNetworks.
                // Критично: сравниваем именно ТИП сети (connectedNetworkType, сохранённый на
                // момент последнего успешного старта), а не просто "сеть есть, ядро живо" —
                // при РЕАЛЬНОЙ смене WiFi↔mobile тип отличается, и тогда обязательно нужна
                // полная пересборка (разные DPI/fragment-пресеты), иначе получаем ровно баг
                // "нет интернета после переключения на мобильный" (поймано и исправлено в
                // этой же сессии — первая версия этой правки сравнивала только isRunning()+
                // isNetworkAvailable() без типа сети, что и вызывало эту регрессию).
                NetworkMonitor.NetworkType nowType = networkMonitor != null ? networkMonitor.getCurrentNetwork() : NetworkMonitor.NetworkType.NONE;
                // Смена сети при живом ядре — только перепривязка, без перезапуска ядра.
                // Полный перезапуск пересоздаёт TUN, и чтение нового интерфейса не
                // поднимается: трафик входит в tun и дропается, а SOCKS-порт ядра при этом
                // продолжает отвечать. Снаружи это ровно «подключено, но интернета нет»,
                // и вылечивается лишь ручным переподключением. Проверено на устройстве.
                boolean rebindOnly = isRunning()
                        && nowType != NetworkMonitor.NetworkType.NONE
                        && (nowType == connectedNetworkType || reconnectFromNetworkChange);
                reconnectFromNetworkChange = false;
                if (rebindOnly) {
                    Log.i(TAG, "reconnectWithDelay: rebind only (" + connectedNetworkType + "->" + nowType
                            + "), core kept alive — TUN не пересоздаём");
                    connectedNetworkType = nowType;
                    updateUnderlyingNetwork();
                    return;
                }
                Log.i(TAG, "Reconnecting VPN (delay=" + delayMs + "ms, type " + connectedNetworkType + "->" + nowType + ")...");
                startVpn(cfg, set); // startVpn() itself re-derives activeProxyEndpoint now
            } finally {
                // startVpn сбрасывает isStarting в своём finally, но если поток
                // прервётся до startVpn — сбрасываем здесь чтобы не зависнуть навсегда.
                isStarting.compareAndSet(true, false);
            }
        }, "VPN-Reconnect-Thread").start();
    }

    private void updateUnderlyingNetwork() {
        try {
            android.net.ConnectivityManager cm =
                (android.net.ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
            android.net.Network activeNet = cm != null ? cm.getActiveNetwork() : null;
            if (activeNet != null) {
                setUnderlyingNetworks(new android.net.Network[]{activeNet});
                Log.d(TAG, "setUnderlyingNetworks: " + activeNet);
            }
        } catch (Exception e) {
            Log.d(TAG, "setUnderlyingNetworks skipped: " + e.getMessage());
        }
    }

    /**
     * Один запрос через живой SOCKS-порт ядра. true — туннель реально проводит трафик.
     * Скопировано по образцу проверенного httpGetViaSocks из NativeBridge, чтобы сервис
     * не зависел от него.
     */
    private boolean probeTunnelOnce() {
        int socksPort = getSocksPort();
        if (socksPort <= 0) return false;
        if (httpGetViaSocks(socksPort, "connectivitycheck.gstatic.com", 80, "/generate_204", TUNNEL_PROBE_TIMEOUT_MS) > 0) return true;
        // Запасной адрес: первый может быть недоступен у конкретного оператора.
        return httpGetViaSocks(socksPort, "cp.cloudflare.com", 80, "/generate_204", TUNNEL_PROBE_TIMEOUT_MS) > 0;
    }

    /** @return задержка в мс (>0) при успешном HTTP-ответе, иначе -1. */
    private long httpGetViaSocks(int socksPort, String host, int port, String path, int timeoutMs) {
        long t0 = System.currentTimeMillis();
        try (java.net.Socket s = new java.net.Socket()) {
            s.connect(new java.net.InetSocketAddress("127.0.0.1", socksPort), timeoutMs);
            s.setSoTimeout(timeoutMs);
            java.io.OutputStream os = s.getOutputStream();
            java.io.InputStream is = s.getInputStream();

            os.write(new byte[]{0x05, 0x01, 0x00});
            os.flush();
            byte[] hi = new byte[2];
            readFully(is, hi, 2);
            if (hi[0] != 0x05 || hi[1] != 0x00) return -1;

            byte[] hb = host.getBytes("US-ASCII");
            byte[] req = new byte[7 + hb.length];
            req[0] = 0x05; req[1] = 0x01; req[2] = 0x00; req[3] = 0x03;
            req[4] = (byte) hb.length;
            System.arraycopy(hb, 0, req, 5, hb.length);
            req[5 + hb.length] = (byte) ((port >> 8) & 0xff);
            req[6 + hb.length] = (byte) (port & 0xff);
            os.write(req);
            os.flush();

            byte[] rep = new byte[4];
            readFully(is, rep, 4);
            if (rep[1] != 0x00) return -1;
            int atyp = rep[3] & 0xff;
            int addrLen = (atyp == 0x01) ? 4 : (atyp == 0x04) ? 16 : (atyp == 0x03) ? readByte(is) : 0;
            readFully(is, new byte[addrLen + 2], addrLen + 2);

            String reqLine = "GET " + path + " HTTP/1.1\r\nHost: " + host + "\r\nConnection: close\r\n\r\n";
            os.write(reqLine.getBytes("US-ASCII"));
            os.flush();

            String statusLine = readLine(is);
            long delay = System.currentTimeMillis() - t0;
            if (statusLine == null || !statusLine.startsWith("HTTP")) return -1;
            String[] p = statusLine.split(" ");
            if (p.length >= 2) {
                try {
                    if (Integer.parseInt(p[1]) > 0) return delay;
                } catch (NumberFormatException ignored) { /* ниже вернём -1 */ }
            }
            return -1;
        } catch (Throwable t) {
            Log.d(TAG, "tunnel probe: " + t);
            return -1;
        }
    }

    private static void readFully(java.io.InputStream is, byte[] buf, int len) throws java.io.IOException {
        int off = 0;
        while (off < len) {
            int n = is.read(buf, off, len - off);
            if (n < 0) throw new java.io.EOFException();
            off += n;
        }
    }

    private static int readByte(java.io.InputStream is) throws java.io.IOException {
        int b = is.read();
        if (b < 0) throw new java.io.EOFException();
        return b;
    }

    private static String readLine(java.io.InputStream is) throws java.io.IOException {
        StringBuilder sb = new StringBuilder();
        int c;
        while ((c = is.read()) != -1 && c != '\n' && sb.length() < 256) sb.append((char) c);
        return sb.length() == 0 ? null : sb.toString().trim();
    }

    private void saveLastConfig(String config, String settings) {
        try {
            // id активного узла — UI сверяет по нему выбор после фонового failover
            // (набор полей задаёт JS: nodeId есть и в settings запасных конфигов).
            String nodeId = "";
            try { nodeId = new JSONObject(settings).optString("nodeId", ""); } catch (Throwable ignored) {}
            getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).edit()
                .putString("config", config)
                .putString("settings", settings)
                .putString("active_node_id", nodeId)
                .apply();
            WatchdogReceiver.schedule(this);
        } catch (Exception ignored) {}
    }

    private void clearSavedConfig() {
        try {
            getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).edit()
                .remove("config").remove("settings")
                // Фоновый failover: список запасных, id активного узла и непрочитанное
                // уведомление об автопереключении живут ровно столько, сколько живёт
                // запущенный VPN. Ручной стоп обнуляет всё — свежий запуск пришлёт своё.
                .remove("fallbacks").remove("active_node_id").remove("pending_failover").apply();
            WatchdogReceiver.cancel(this);
        } catch (Exception ignored) {}
    }

    /** Активный узел с точки зрения нативки ('' — нет данных). Для синхронизации UI. */
    static String getActiveNodeId(Context ctx) {
        try {
            return ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                    .getString("active_node_id", "");
        } catch (Throwable t) {
            return "";
        }
    }

    /**
     * Режим «Иммунитет» (фильтр) включён — prefs переживают рестарт процесса.
     * Для JS (NativeBridge.isShieldMode): при запуске приложения отличить
     * работающий фильтр от обычного подключения к узлу.
     */
    static boolean isShieldModeActive(Context ctx) {
        try {
            return ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                    .getBoolean("shield_mode", false);
        } catch (Throwable t) {
            return false;
        }
    }

    public VpnStats getStats() {
        boolean running = isRunning();
        long uptime = running && startTime > 0 ? (System.currentTimeMillis() - startTime) / 1000 : 0;
        // upload/download — объём за сессию, uplink/downlinkSpeed — текущая скорость (байт/с).
        VpnStats stats = running
            ? new VpnStats(totalUp, totalDown, curUp, curDown, uptime)
            : new VpnStats(0, 0, 0, 0, uptime);
        stats.status = running ? "running" : (isStarting() ? "starting" : "not_running");
        stats.startupLogs = getLogs();
        return stats;
    }
}
