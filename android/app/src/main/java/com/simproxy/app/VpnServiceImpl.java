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
import su.happ.proxyutility.service.XRayVpnService;

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
    private volatile String lastConfig = null;
    private volatile String lastSettings = "{}";
    private volatile long lastConnectTimeMs = 0;
    private static final long RECONNECT_COOLDOWN_MS = 5000;
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
            if (lastConfig != null && !userStopped && !isStarting()) {
                // Переподключаемся если: сеть была потеряна (туннель гарантированно сломан)
                // ИЛИ ядро уже не работает (упало пока не было сети).
                if (wasLost || !isRunning()) {
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
            new Thread(this::stopVpnGraceful, "VpnStopThread").start();
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
        // Сохраняем адрес прокси и конфиг для ping-сравнения.
        activeProxyEndpoint = extractProxyEndpoint(config);
        activeConfigJson = config;
        final String cfg = config;
        final String set = settings;
        new Thread(() -> startVpn(cfg, set), "VPN-Start-Thread").start();

        return START_STICKY;
    }

    private void startVpn(String config, String settingsJson) {
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
            builder.setSession("SimProxy VPN")
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
                updateNotification(serverName.isEmpty() ? "Туннель..." : ("Туннель • " + serverName), false);
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
                XRayVpnService.setVpnService(this);
                final ParcelFileDescriptor t2sPfd = tunFd;
                final int t2sMtu = mtu;
                final android.content.Context t2sCtx = this;
                Thread t2sThread = new Thread(() -> {
                    int result = XRayVpnService.safeStartTun2Socks(
                        t2sCtx, t2sPfd, "127.0.0.1:" + miSocksPort, "8.8.8.8", t2sMtu);
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
            saveLastConfig(config, settingsJson);
            updateNotification(serverName.isEmpty() ? "🔒 Подключено" : ("🔒 Подключено • " + serverName), true);
            startStatsLoop();
            lastConnectTimeMs = System.currentTimeMillis();
            acquireWakeLock();
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
            .setContentTitle("SimProxy VPN")
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
                .setSession("SimProxy VPN")
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
        // PARTIAL_WAKE_LOCK держал CPU активным 24/7 даже без трафика → нагрев + 32% батареи за 4ч.
        // TUN fd обрабатывается ядром: CPU просыпается только при приходе пакетов.
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

    private void stopVpnGraceful() {
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
        XRayVpnService.safeStopTun2Socks();
        long t2sDur = System.currentTimeMillis() - t0;
        Log.i(TAG, "stopVpnGraceful: safeStopTun2Socks took " + t2sDur + "ms");
        if (t2sDur > 5 && t2sDur < 500) {
            try { Thread.sleep(1200); } catch (InterruptedException ignored) {}
            Log.i(TAG, "stopVpnGraceful: waited for Go tun2socks cleanup");
        }
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
            Log.i(TAG, "stopVpnGraceful: calling stopSelf");
            stopSelf();
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
        XRayVpnService.safeStopTun2Socks();
        long t2sDur = System.currentTimeMillis() - t0;
        Log.i(TAG, "stopVpnInternal: safeStopTun2Socks took " + t2sDur + "ms");
        // Go tun2socks goroutine holds a SCM_RIGHTS copy of the TUN fd.
        // stopTun2Socks sends a stop signal but returns before Go has closed its copy.
        // Wait only when the call did real work (>5ms) and returned fast (<500ms),
        // meaning it was non-blocking and Go still needs time to close its fd.
        if (t2sDur > 5 && t2sDur < 500) {
            try { Thread.sleep(1200); } catch (InterruptedException ignored) {}
            Log.i(TAG, "stopVpnInternal: waited for Go tun2socks cleanup");
        }
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
        final int uid = Process.myUid();
        sessRxStart = safeRx(uid);
        sessTxStart = safeTx(uid);
        lastRx = sessRxStart;
        lastTx = sessTxStart;
        lastTs = System.currentTimeMillis();
        curDown = 0; curUp = 0; totalDown = 0; totalUp = 0;

        statsThread = new Thread(() -> {
            int watchdogTick = 0;
            while (statsRunning) {
                try { Thread.sleep(2000); } catch (InterruptedException e) { break; }
                if (!statsRunning) break;
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
                watchdogTick++;
                if (watchdogTick % 5 == 0 && lastConfig != null && !userStopped && !isStarting() && !isRunning()) {
                    Log.w(TAG, "Watchdog: VPN core died unexpectedly, reconnecting...");
                    // Сообщаем JS что VPN упал сам по себе (не по воле пользователя).
                    // JS покажет подсказку про оптимизацию батареи если разрешение ещё не выдано.
                    NativeBridge bridge = NativeBridge.getInstance();
                    if (bridge != null) bridge.emitJsEventPublic("vpn-dropped-in-background", "{}");
                    reconnectWithDelay(1000);
                    break; // stats thread завершится; новый запустит startStatsLoop
                }

                // Скорость в шторке не показываем: каждый updateNotification() — IPC к
                // NotificationManager → перерисовка шторки → нагрев + батарея. Статическое
                // уведомление «Подключено» ставится один раз при старте VPN (startVpn).
            }
        }, "VpnStatsLoop");
        statsThread.start();
    }

    private synchronized void stopStatsLoop() {
        statsRunning = false;
        if (statsThread != null) {
            statsThread.interrupt();
            statsThread = null;
        }
        curDown = 0; curUp = 0;
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
            Log.d(TAG, "reconnectOnNetworkChange: suppressed — only " + msSinceLast + "ms since last connect");
            return;
        }
        reconnectWithDelay(delayMs);
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
        if (isStarting.getAndSet(true)) {
            Log.i(TAG, "reconnectWithDelay: skipped — already starting (possibly stuck from a prior attempt)");
            return;
        }
        updateNotification("Переподключение...", false);
        new Thread(() -> {
            try {
                try { Thread.sleep(delayMs); } catch (InterruptedException e) { return; }
                if (userStopped) return;
                Log.i(TAG, "Reconnecting VPN (delay=" + delayMs + "ms)...");
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

    private void saveLastConfig(String config, String settings) {
        try {
            getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).edit()
                .putString("config", config)
                .putString("settings", settings)
                .apply();
            WatchdogReceiver.schedule(this);
        } catch (Exception ignored) {}
    }

    private void clearSavedConfig() {
        try {
            getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).edit()
                .remove("config").remove("settings").apply();
            WatchdogReceiver.cancel(this);
        } catch (Exception ignored) {}
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
