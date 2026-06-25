package com.simproxy.app;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.net.VpnService;
import android.os.Build;
import android.util.Log;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import android.provider.Settings;
import androidx.core.content.FileProvider;
import libxray.Libxray;
import libxray.XRayPoint;
import org.json.JSONArray;
import org.json.JSONObject;
import android.content.SharedPreferences;
import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.URL;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

public class NativeBridge {
    private static final String TAG = "NativeBridge";
    private static final String ERR_PREFIX = "{\"ok\":false,\"error\":";
    private final Activity activity;
    private final WebView webView;
    private static volatile NativeBridge instance;
    public static NativeBridge getInstance() { return instance; }
    private final ExecutorService executor = new ThreadPoolExecutor(2, 8, 60L,
            TimeUnit.SECONDS, new LinkedBlockingQueue<>(64),
            new ThreadPoolExecutor.CallerRunsPolicy());
    private final ExecutorService antiFilterExecutor = Executors.newSingleThreadExecutor();
    // VPN start/stop must never queue behind ping/fetch work on `executor`: ThreadPoolExecutor
    // only grows past corePoolSize=2 once its 128-slot queue is full, so a burst of slow pings
    // (live SOCKS checks can take 5-10s each) can delay startVpnWithResult past the JS-side
    // 30s callNativeAsync timeout, surfacing as "Native call timeout: startVpnWithResult".
    private final ExecutorService vpnControlExecutor = Executors.newSingleThreadExecutor();
    private volatile boolean antiFilterRunning = false;
    private String lastQrTaskId = null;
    private volatile String pendingVpnPermissionTaskId = null;
    // Путь к уже скачанному APK обновления — чтобы после выдачи разрешения
    // «Установка неизвестных приложений» поставить его без повторной загрузки.
    private volatile String pendingApkPath = null;

    public NativeBridge(Activity activity, WebView webView) {
        this.activity = activity;
        this.webView = webView;
        instance = this;
    }

    public void emitJsEventPublic(String name, String detailJson) {
        emitJsEvent(name, detailJson);
    }

    @JavascriptInterface
    public void requestVpnPermission(String taskId) {
        Intent intent = VpnService.prepare(activity);
        if (intent != null) {
            this.pendingVpnPermissionTaskId = taskId;
            activity.runOnUiThread(() -> activity.startActivityForResult(intent, 1001));
        } else {
            sendToJs(taskId, "true");
        }
    }

    @JavascriptInterface
    public void startVpnWithResult(String jsonPayload, String taskId) {
        vpnControlExecutor.execute(() -> {
            try {
                JSONObject payload = new JSONObject(jsonPayload);
                String configJson = payload.optString("config", "");
                String settingsJson = payload.optString("settings", "{}");
                // DEBUG: логируем первые 800 символов конфига для диагностики
                android.util.Log.i(TAG, "CONFIG_PREVIEW: " + configJson.substring(0, Math.min(800, configJson.length())));
                VpnServiceImpl.markStarting();   // сбрасываем флаг "stopped" заранее
                Intent intent = new Intent(activity, VpnServiceImpl.class);
                intent.putExtra("config", configJson);
                intent.putExtra("settings", settingsJson);
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    activity.startForegroundService(intent);
                } else {
                    activity.startService(intent);
                }
                sendToJs(taskId, "{\"ok\":true}");
            } catch (Throwable e) {
                sendToJs(taskId, ERR_PREFIX + JSONObject.quote(e.getMessage()) + "}");
            }
        });
    }

    @JavascriptInterface
    public void minimizeApp() {
        activity.moveTaskToBack(true);
    }

    @JavascriptInterface
    public void clearDnsCache() {
        activity.runOnUiThread(() -> {
            try { webView.clearCache(false); } catch (Exception e) { android.util.Log.w(TAG, "clearDnsCache: " + e.getMessage()); }
        });
    }

    // ── NETWORK MONITORING ──────────────────────────────────────────────
    // Пробрасывает NetworkMonitor в JS и шлёт событие 'network-changed'
    // (detail: {event:'changed'|'lost'|'available', type:'WIFI'|'MOBILE'|…}).
    // На стороне JS используется для авто-реконнекта при смене сети.
    private NetworkMonitor.NetworkChangeListener netListener;

    @JavascriptInterface
    public void startNetworkMonitoring() {
        try {
            NetworkMonitor nm = NetworkMonitor.getInstance(activity);
            if (netListener == null) {
                netListener = new NetworkMonitor.NetworkChangeListener() {
                    @Override public void onNetworkChanged(NetworkMonitor.NetworkType o, NetworkMonitor.NetworkType n) {
                        emitJsEvent("network-changed", "{\"event\":\"changed\",\"from\":\"" + o.name() + "\",\"type\":\"" + n.name() + "\"}");
                    }
                    @Override public void onNetworkLost() {
                        emitJsEvent("network-changed", "{\"event\":\"lost\",\"type\":\"NONE\"}");
                    }
                    @Override public void onNetworkAvailable(NetworkMonitor.NetworkType t) {
                        emitJsEvent("network-changed", "{\"event\":\"available\",\"type\":\"" + t.name() + "\"}");
                    }
                };
                nm.addListener(netListener);
            }
            nm.startMonitoring();
        } catch (Throwable e) { Log.e(TAG, "startNetworkMonitoring", e); }
    }

    @JavascriptInterface
    public void stopNetworkMonitoring() {
        try {
            NetworkMonitor nm = NetworkMonitor.getInstance(activity);
            if (netListener != null) { nm.removeListener(netListener); netListener = null; }
            // НЕ вызываем nm.stopMonitoring(): VpnServiceImpl зависит от того же
            // NetworkMonitor-синглтона и должен получать события даже когда
            // WebView закрыт / приложение не на экране.
        } catch (Throwable e) { Log.e(TAG, "stopNetworkMonitoring", e); }
    }

    @JavascriptInterface
    public String getCurrentNetwork() {
        try { return NetworkMonitor.getInstance(activity).getCurrentNetwork().name(); } catch (Throwable e) { return "NONE"; }
    }

    /** Returns mobile carrier name from TelephonyManager — no network request needed. */
    @JavascriptInterface
    public String getNetworkCarrier() {
        try {
            if (!isCellularActive()) return "";
            android.telephony.TelephonyManager tm = (android.telephony.TelephonyManager)
                    activity.getSystemService(android.content.Context.TELEPHONY_SERVICE);
            if (tm == null) return "";
            String name = getDataOperatorName(tm);
            return name != null ? name : "";
        } catch (Throwable e) {
            return "";
        }
    }

    private boolean isCellularActive() {
        android.net.ConnectivityManager cm = (android.net.ConnectivityManager)
                activity.getSystemService(android.content.Context.CONNECTIVITY_SERVICE);
        if (cm == null) return false;
        android.net.Network net = cm.getActiveNetwork();
        if (net == null) return false;
        android.net.NetworkCapabilities caps = cm.getNetworkCapabilities(net);
        return caps != null && caps.hasTransport(android.net.NetworkCapabilities.TRANSPORT_CELLULAR);
    }

    private String getDataOperatorName(android.telephony.TelephonyManager tm) {
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.N) {
            String name = getDataSubOperatorName(tm);
            if (name != null && !name.isEmpty()) return name;
        }
        return tm.getNetworkOperatorName();
    }

    private String getDataSubOperatorName(android.telephony.TelephonyManager tm) {
        try {
            int dataSubId = android.telephony.SubscriptionManager.getDefaultDataSubscriptionId();
            if (dataSubId == android.telephony.SubscriptionManager.INVALID_SUBSCRIPTION_ID) return null;
            return tm.createForSubscriptionId(dataSubId).getNetworkOperatorName();
        } catch (Throwable e) {
            return null;
        }
    }

    @JavascriptInterface
    public boolean isNetworkAvailable() {
        try { return NetworkMonitor.getInstance(activity).isNetworkAvailable(); } catch (Throwable e) { return false; }
    }

    @JavascriptInterface
    public String getNetworkInfo() {
        try { return NetworkMonitor.getInstance(activity).getNetworkInfo(); } catch (Throwable e) { return "Unknown"; }
    }

    private void emitJsEvent(String name, String detailJson) {
        activity.runOnUiThread(() -> {
            String script = "window.dispatchEvent(new CustomEvent('" + name + "',{detail:" + detailJson + "}));";
            webView.evaluateJavascript(script, null);
        });
    }

    @JavascriptInterface
    public void vibrate(int duration) {
        android.os.Vibrator v = (android.os.Vibrator) activity.getSystemService(Context.VIBRATOR_SERVICE);
        if (v != null) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                v.vibrate(android.os.VibrationEffect.createOneShot(duration, android.os.VibrationEffect.DEFAULT_AMPLITUDE));
            } else {
                v.vibrate(duration);
            }
        }
    }

    @JavascriptInterface
    public void stopVpn(String reason) {
        android.util.Log.i(TAG, "stopVpn called by JS, reason=" + reason);
        Intent intent = new Intent(activity, VpnServiceImpl.class);
        intent.setAction("STOP");
        activity.startService(intent);
    }

    @JavascriptInterface
    public String getVpnStatus() {
        VpnServiceImpl svc = VpnServiceImpl.getInstance();
        if (svc == null) return "disconnected";
        return svc.isRunning() ? "connected" : (svc.isStarting() ? "connecting" : "disconnected");
    }

    // Отдаёт (и очищает) deep link, пришедший при холодном старте через sim://.
    // JS вызывает на монтировании, чтобы не потерять ссылку, пришедшую до того,
    // как навесился слушатель события 'deeplink'.
    @JavascriptInterface
    public void getPendingDeepLink(String taskId) {
        String uri = (activity instanceof MainActivity)
            ? ((MainActivity) activity).consumePendingDeepLink()
            : null;
        sendToJs(taskId, uri == null ? "\"\"" : org.json.JSONObject.quote(uri));
    }

    @JavascriptInterface
    public String getStats() {
        // Намеренный стоп (кнопка «Отключить» в шторке, стоп из приложения,
        // onRevoke) репортим как status:"stopped" — чистое отключение, без
        // ложной ошибки «Соединение прервано». Проверяем ПЕРВЫМ, чтобы поймать
        // и окно завершения сервиса, когда инстанс ещё жив, но ядро уже стоит.
        if (VpnServiceImpl.wasUserStopped()) {
            return "{\"upload\":0,\"download\":0,\"uplinkSpeed\":0,\"downlinkSpeed\":0,"
                 + "\"connectedSec\":0,\"status\":\"stopped\",\"error\":\"\",\"lastError\":\"\"}";
        }
        VpnServiceImpl svc = VpnServiceImpl.getInstance();
        if (svc != null) return svc.getStats().toJson();
        return "{\"upload\":0,\"download\":0,\"uplinkSpeed\":0,\"downlinkSpeed\":0,"
             + "\"connectedSec\":0,\"status\":\"not_running\",\"error\":\"\",\"lastError\":\"\"}";
    }

    @JavascriptInterface
    public String getLogs() {
        VpnServiceImpl svc = VpnServiceImpl.getInstance();
        return svc != null ? svc.getLogs() : "VPN service not running";
    }

    @JavascriptInterface
    public String getCoreVersions() {
        JSONObject obj = new JSONObject();
        try {
            obj.put("xray", Libxray.getCoreVersion());
            obj.put("wrapper", Libxray.getWrapperVersion());
        } catch (Exception ignored) {}
        return obj.toString();
    }

    @JavascriptInterface
    public String getSystemInfo() {
        JSONObject obj = new JSONObject();
        try {
            obj.put("osVersion", Build.VERSION.RELEASE);
            obj.put("apiLevel", Build.VERSION.SDK_INT);
            obj.put("model", Build.MODEL);
            obj.put("manufacturer", Build.MANUFACTURER);
            Runtime rt = Runtime.getRuntime();
            obj.put("totalMemory", rt.totalMemory());
            obj.put("freeMemory", rt.freeMemory());
            obj.put("maxMemory", rt.maxMemory());
        } catch (Exception ignored) {}
        return obj.toString();
    }

    @JavascriptInterface
    public boolean toggleKillSwitch(boolean enabled) {
        if (enabled) KillSwitchManager.getInstance(activity).enable();
        else KillSwitchManager.getInstance(activity).disable();
        return true;
    }

    @JavascriptInterface
    public boolean isKillSwitchEnabled() {
        return KillSwitchManager.getInstance(activity).isEnabled();
    }

    @JavascriptInterface
    public String getSplitTunnelApps() {
        return SplitTunnelManager.getInstance(activity).getInstalledApps();
    }

    @JavascriptInterface
    public String getInstalledApps() {
        return SplitTunnelManager.getInstance(activity).getInstalledApps();
    }

    @JavascriptInterface
    public void setSplitTunnelApp(String appId, String mode) {
        SplitTunnelManager.getInstance(activity).setAppMode(appId, mode);
    }

    @JavascriptInterface
    public void startSpeedTest(String taskId) {
        SpeedTestService.getInstance().startSpeedTestAsync(new SpeedTestService.SpeedTestCallback() {
            @Override public void onResult(String result) { sendToJs(taskId, result); }
            @Override public void onError(String error) {
                sendToJs(taskId, "{\"error\":\"" + error + "\"}");
            }
        });
    }

    @JavascriptInterface
    public void testIpLeak(String taskId) {
        IpLeakDetector.getInstance().testIpLeakAsync(new IpLeakDetector.IpLeakCallback() {
            @Override public void onResult(String result) { sendToJs(taskId, result); }
            @Override public void onError(String error) {
                sendToJs(taskId, "{\"hasLeak\":true,\"error\":\"" + error + "\"}");
            }
        });
    }

    @JavascriptInterface
    public String testDnsLeak() {
        return DnsLeakProtection.getInstance(activity).testDnsLeak();
    }

    @JavascriptInterface
    public void pingServer(String address, int port, int timeout, String taskId) {
        android.util.Log.i("SimProxyBridge", "pingServer: " + address + ":" + port);
        executor.execute(() -> {
            long start = System.currentTimeMillis();
            try {
                // Manual resolution to bypass system DNS issues
                java.net.InetAddress[] addresses = java.net.InetAddress.getAllByName(address);
                if (addresses.length == 0) throw new Exception("No IP found");
                
                // IPv4 первым: на мобильных getAllByName часто отдаёт первым
                // недоступный IPv6 → старый addresses[0] падал. Перебираем все.
                java.util.Arrays.sort(addresses, (a, b) -> {
                    boolean a4 = a instanceof java.net.Inet4Address;
                    boolean b4 = b instanceof java.net.Inet4Address;
                    if (a4 == b4) return 0;
                    return a4 ? -1 : 1;
                });
                Exception last = null;
                for (java.net.InetAddress addr : addresses) {
                    long attemptStart = System.currentTimeMillis();
                    try (Socket socket = new Socket()) {
                        socket.connect(new InetSocketAddress(addr, port), Math.min(timeout, 5000));
                        long duration = System.currentTimeMillis() - attemptStart;
                        android.util.Log.i("SimProxyBridge", "pingServer success: " + address + " (" + addr.getHostAddress() + ") " + duration + "ms");
                        sendToJs(taskId, String.valueOf(duration));
                        return;
                    } catch (Exception ex) {
                        last = ex;
                    }
                }
                throw (last != null ? last : new Exception("connect failed"));
            } catch (Exception e) {
                android.util.Log.e("SimProxyBridge", "pingServer fail: " + address + " " + e.getMessage());
                sendToJs(taskId, "-1");
            }
        });
    }

    // Direct ping without VPN — same logic as pingServer but for direct connection testing
    @JavascriptInterface
    public void pingServerDirect(String address, int port, String taskId) {
        android.util.Log.i("SimProxyBridge", "pingServerDirect (no VPN): " + address + ":" + port);
        executor.execute(() -> {
            long start = System.currentTimeMillis();
            try {
                java.net.InetAddress[] addresses = java.net.InetAddress.getAllByName(address);
                if (addresses.length == 0) throw new Exception("No IP found");
                
                // Prefer IPv4
                java.util.Arrays.sort(addresses, (a, b) -> {
                    boolean a4 = a instanceof java.net.Inet4Address;
                    boolean b4 = b instanceof java.net.Inet4Address;
                    if (a4 == b4) return 0;
                    return a4 ? -1 : 1;
                });
                Exception last = null;
                for (java.net.InetAddress addr : addresses) {
                    try (Socket socket = new Socket()) {
                        socket.connect(new InetSocketAddress(addr, port), 5000);
                        long duration = System.currentTimeMillis() - start;
                        android.util.Log.i("SimProxyBridge", "pingServerDirect success: " + address + " (" + addr.getHostAddress() + ") " + duration + "ms");
                        sendToJs(taskId, String.valueOf(duration));
                        return;
                    } catch (Exception ex) {
                        last = ex;
                    }
                }
                throw (last != null ? last : new Exception("connect failed"));
            } catch (Exception e) {
                android.util.Log.e("SimProxyBridge", "pingServerDirect fail: " + address + " " + e.getMessage());
                sendToJs(taskId, "-1");
            }
        });
    }

    // Пинг как в Happ: measureOutboundDelayWithType из libxray.
    // VPN включён + активный сервер → GET через живой SOCKS (мгновенно, точно).
    // VPN включён + другой сервер  → -1 (нельзя запустить второй libxray-инстанс).
    // VPN выключен → measureOutboundDelayWithType с полным конфигом (включая bypass-цепочку).
    @JavascriptInterface
    public void pingProxyServer(String configJson, String mode, String taskId) {
        executor.execute(() -> {
            long delay = -1;
            try {
                VpnServiceImpl svc = VpnServiceImpl.getInstance();
                if (svc != null && svc.isRunning()) {
                    // VPN включён: только активный сервер получает live-замер через SOCKS.
                    org.json.JSONObject cfg = new org.json.JSONObject(configJson);
                    String activeEndpoint = VpnServiceImpl.getActiveProxyEndpoint();
                    String pingEndpoint   = extractProxyEndpoint(cfg);
                    boolean isSame = activeEndpoint != null && activeEndpoint.equals(pingEndpoint);
                    android.util.Log.i(TAG, "pingProxyServer: VPN up, active=" + activeEndpoint + " ping=" + pingEndpoint + " same=" + isSame);
                    int liveSocks = svc.getSocksPort();
                    if (liveSocks <= 0) liveSocks = LIVE_SOCKS_PORT;
                    if (isSame) {
                        delay = httpGetViaSocks(liveSocks, "connectivitycheck.gstatic.com", 80, "/generate_204", 10000);
                        android.util.Log.i(TAG, "pingProxyServer: live SOCKS -> " + delay + "ms");
                    } else if (pingEndpoint != null) {
                        // Неактивный сервер при включённом VPN: TCP-пинг (без TLS).
                        // REALITY серверы обрывают TLS-соединение без валидного shortId → TLS-пинг всегда -1.
                        // TCP SYN-ACK завершается ДО любой REALITY-проверки → даёт реальный RTT.
                        int col = pingEndpoint.lastIndexOf(':');
                        if (col > 0) {
                            String pHost = pingEndpoint.substring(0, col);
                            int pPort = 443;
                            try { pPort = Integer.parseInt(pingEndpoint.substring(col + 1)); } catch (NumberFormatException ignored) {}
                            long t0 = System.currentTimeMillis();
                            try (java.net.Socket s = new java.net.Socket()) {
                                java.net.InetAddress addr = resolveIPv4First(pHost);
                                s.connect(new java.net.InetSocketAddress(addr, pPort), 4000);
                                delay = System.currentTimeMillis() - t0;
                            } catch (Throwable ignored) { delay = -1; }
                            android.util.Log.i(TAG, "pingProxyServer: direct TCP " + pHost + ":" + pPort + " -> " + delay + "ms");
                        }
                    }
                } else {
                    android.util.Log.i(TAG, "pingProxyServer: vpn=OFF -> measureDelayWithFallback");
                    synchronized (PING_CORE_LOCK) {
                        delay = measureDelayWithFallback(configJson);
                    }
                    android.util.Log.i(TAG, "pingProxyServer: -> " + delay + "ms");
                }
            } catch (Throwable t) {
                android.util.Log.e(TAG, "pingProxyServer error: " + t);
            }
            sendToJs(taskId, String.valueOf(delay));
        });
    }

    // Резолвит домен сервера ЧЕРЕЗ живой SOCKS-прокси (когда VPN поднят). На белом
    // списке РФ прямой DNS/DoH из приложения прижат (приложение исключено из VPN —
    // его трафик идёт мимо туннеля по зарезанной сети), но сам туннель доходит до
    // 1.1.1.1 — поэтому DoH-запрос отправляем СКВОЗЬ SOCKS. Возвращает IPv4-строку
    // или "". JS кэширует IP для TCP-замера при ВЫКЛЮЧЕННОМ VPN (см. bridge.ts).
    @JavascriptInterface
    public void resolveHostViaProxy(String domain, String taskId) {
        executor.execute(() -> {
            String ip = "";
            HttpURLConnection c = null;
            try {
                VpnServiceImpl svc = VpnServiceImpl.getInstance();
                if (svc != null && svc.isRunning() && domain != null && !domain.isEmpty()) {
                    int socks = svc.getSocksPort();
                    if (socks <= 0) socks = LIVE_SOCKS_PORT;
                    java.net.Proxy proxy = new java.net.Proxy(java.net.Proxy.Type.SOCKS,
                        new InetSocketAddress("127.0.0.1", socks));
                    // 1.1.1.1 — IP-литерал (DNS не нужен); сертификат CF содержит его в SAN,
                    // TLS сквозь SOCKS валиден. Туннель достаёт 1.1.1.1 → A-запись приходит.
                    URL u = new URL("https://1.1.1.1/dns-query?name=" + domain + "&type=A&ct=application/dns-json");
                    c = (HttpURLConnection) u.openConnection(proxy);
                    c.setRequestProperty("Accept", "application/dns-json");
                    c.setConnectTimeout(8000);
                    c.setReadTimeout(8000);
                    if (c.getResponseCode() == 200) {
                        BufferedReader in = new BufferedReader(new InputStreamReader(c.getInputStream(), "UTF-8"));
                        StringBuilder sb = new StringBuilder();
                        String ln;
                        while ((ln = in.readLine()) != null) sb.append(ln);
                        in.close();
                        org.json.JSONArray ans = new org.json.JSONObject(sb.toString()).optJSONArray("Answer");
                        if (ans != null) {
                            for (int i = 0; i < ans.length(); i++) {
                                org.json.JSONObject a = ans.getJSONObject(i);
                                if (a.optInt("type") == 1) {
                                    String data = a.optString("data", "");
                                    if (data.matches("^[0-9.]+$")) { ip = data; break; }
                                }
                            }
                        }
                    }
                    android.util.Log.i(TAG, "resolveHostViaProxy: " + domain + " -> '" + ip + "' via socks " + socks);
                }
            } catch (Throwable t) {
                android.util.Log.e(TAG, "resolveHostViaProxy error: " + t);
            } finally {
                if (c != null) { try { c.disconnect(); } catch (Throwable ignored) {} }
            }
            // КРИТИЧНО: sendToJs вставляет result в JS БЕЗ кавычек. Голый IP
            // (193.187.92.21) — невалидный JS (число с двумя точками) → onNativeTaskComplete
            // не вызовется, промис зависнет. Оборачиваем в JSON-строку ("1.2.3.4").
            sendToJs(taskId, org.json.JSONObject.quote(ip));
        });
    }

    // ПИНГ КАК В HAPP: встроенный measureOutboundDelay из libxray. Сама Go-либа
    // поднимает outbound (REALITY+fragment+dialerProxy) и дёргает url через прокси —
    // тем же дайлером, что и боевое соединение, поэтому проходит DPI белого списка
    // ДАЖЕ при выключенном VPN (когда свежее «ручное» временное ядро не бутстрапится,
    // а прямой TCP к серверу дропается фаерволом). Возвращает мс или -1.
    // ВАЖНО: нужен ПОЛНЫЙ конфиг (раньше сюда слали голый массив outbounds →
    // LoadJSONConfig падал). При ПОДНЯТОМ VPN не использовать — глобальный core занят.
    @JavascriptInterface
    public void measureDelay(String configJson, String url, String taskId) {
        executor.execute(() -> {
            long d = -1;
            try {
                // Не вызывать при запущенном VPN — libxray занят coreRunLoopWithTun.
                VpnServiceImpl svc = VpnServiceImpl.getInstance();
                if (svc != null && svc.isRunning()) {
                    sendToJs(taskId, "-1");
                    return;
                }
                File filesDir = activity.getFilesDir();
                XrayManager xm = new XrayManager();
                xm.boot(activity, filesDir.getAbsolutePath());
                String u = (url == null || url.isEmpty()) ? "http://cp.cloudflare.com/" : url;
                // measureOutboundDelay поднимает временный libxray-инстанс. Глобальный
                // core-стейт не терпит ПАРАЛЛЕЛЬНЫХ инстансов → сериализуем тем же локом,
                // что и временное ядро. Остальной off-путь (TCP к кэш-IP) идёт параллельно.
                // Логируем ключевые части конфига для диагностики bypass-цепочки
                try {
                    org.json.JSONObject dbg = new org.json.JSONObject(configJson);
                    org.json.JSONArray obs = dbg.optJSONArray("outbounds");
                    if (obs != null && obs.length() > 0) {
                        org.json.JSONObject first = obs.getJSONObject(0);
                        String firstTag = first.optString("tag", "?");
                        String firstProto = first.optString("protocol", "?");
                        String dialerProxy = "";
                        org.json.JSONObject ss = first.optJSONObject("streamSettings");
                        if (ss != null) { org.json.JSONObject so = ss.optJSONObject("sockopt"); if (so != null) dialerProxy = so.optString("dialerProxy", ""); }
                        android.util.Log.i(TAG, "measureDelay cfg: first_outbound=" + firstTag + "(" + firstProto + ") dialerProxy=" + dialerProxy + " total_outbounds=" + obs.length());
                    }
                    org.json.JSONObject routing = dbg.optJSONObject("routing");
                    if (routing != null) {
                        org.json.JSONArray rules = routing.optJSONArray("rules");
                        android.util.Log.i(TAG, "measureDelay cfg: routing_rules=" + (rules != null ? rules.length() : 0) + " balancers=" + (routing.optJSONArray("balancers") != null));
                    }
                } catch (Throwable ignored) {}
                synchronized (PING_CORE_LOCK) {
                    d = libxray.Libxray.measureOutboundDelay(configJson, u);
                }
                android.util.Log.i(TAG, "measureDelay -> " + d + "ms (url " + u + ")");
            } catch (Throwable t) {
                android.util.Log.e(TAG, "measureDelay error: " + t);
            }
            sendToJs(taskId, String.valueOf(d));
        });
    }

    // Глобальный лок — libxray держит один core-стейт, нельзя запускать два ядра параллельно.
    static final Object PING_CORE_LOCK = new Object();
    private static final int LIVE_SOCKS_PORT = 10808;
    private static final int PING_SOCKS_PORT  = 10899;

    // Измеряет задержку: сначала measureOutboundDelay в потоке с таймаутом 3с.
    // Если Go-поток завис (DPI-таймаут) → TCP-пинг к IP напрямую (быстро, без DNS/Go).
    // Если сервер задан доменом — ждём Go ещё 5с, затем pingViaFullCore.
    // Вызывать только под PING_CORE_LOCK.
    private long measureDelayWithFallback(String configJson) {
        try {
            new XrayManager().boot(activity, activity.getFilesDir().getAbsolutePath());
            boolean hasVision = configJson.contains("xtls-rprx-vision");
            String url = hasVision ? "https://cp.cloudflare.com/" : "http://cp.cloudflare.com/";
            long d = libxray.Libxray.measureOutboundDelay(configJson, url);
            android.util.Log.i(TAG, "measureDelay(fast) vision=" + hasVision + ": " + d + "ms");
            if (d > 0) return d;
        } catch (Throwable t) {
            android.util.Log.i(TAG, "measureDelay(fast) failed: " + t);
        }
        return pingViaFullCore(configJson);
    }

    // TCP-пинг к серверу только по IPv4-адресу (без DNS). Вызывается пока Go-поток ещё работает.
    private long quickIpTcpPing(String configJson) {
        try {
            org.json.JSONArray outbounds = new org.json.JSONObject(configJson).optJSONArray("outbounds");
            if (outbounds == null) return -1;
            for (int i = 0; i < outbounds.length(); i++) {
                org.json.JSONObject ob = outbounds.optJSONObject(i);
                if (ob == null || !"proxy".equals(ob.optString("tag"))) continue;
                org.json.JSONObject settings = ob.optJSONObject("settings");
                if (settings == null) return -1;
                org.json.JSONArray arr = settings.optJSONArray("vnext");
                if (arr == null) arr = settings.optJSONArray("servers");
                if (arr == null || arr.length() == 0) return -1;
                org.json.JSONObject srv = arr.optJSONObject(0);
                if (srv == null) return -1;
                String addr = srv.optString("address", "");
                int port = srv.optInt("port", 443);
                if (!addr.matches("\\d{1,3}(\\.\\d{1,3}){3}")) return -1; // только IPv4, без DNS
                long t0 = System.currentTimeMillis();
                java.net.InetAddress ia = java.net.InetAddress.getByName(addr);
                try (java.net.Socket s = new java.net.Socket()) {
                    s.connect(new java.net.InetSocketAddress(ia, port), 3000);
                    return System.currentTimeMillis() - t0;
                }
            }
        } catch (Throwable ignored) {}
        return -1;
    }

    // TCP-пинг через SOCKS-прокси: подключаемся к целевому хосту через живой VPN-SOCKS.
    // Если сервер RST-ит соединение (REALITY-серверы отказывают plain-TCP) —
    // ConnectException тоже засчитывается: время до отказа = RTT через активный сервер.
    private long tcpPingViaSocks(int socksPort, String targetHost, int targetPort, int timeoutMs) {
        long t0 = System.currentTimeMillis();
        try (java.net.Socket sock = new java.net.Socket(
                new java.net.Proxy(java.net.Proxy.Type.SOCKS,
                    new java.net.InetSocketAddress("127.0.0.1", socksPort)))) {
            sock.setSoTimeout(timeoutMs);
            try {
                sock.connect(new java.net.InetSocketAddress(targetHost, targetPort), timeoutMs);
            } catch (java.net.ConnectException e) {
                // Server refused (RST) — connection reached server, timing is valid
            }
            return System.currentTimeMillis() - t0;
        } catch (Throwable t) {
            Log.e(TAG, "tcpPingViaSocks " + targetHost + ":" + targetPort + " err: " + t);
            return -1;
        }
    }

    // Запускает временное xray-ядро через coreRunLoop (тот же путь что и боевой VPN),
    // добавляет SOCKS inbound на PING_SOCKS_PORT, измеряет задержку через httpGetViaSocks,
    // затем останавливает ядро. Это единственный надёжный способ тестировать DPI-обход
    // (REALITY/fragment/noise) без TUN: measureOutboundDelayWithType не инициализирует
    // dialerProxy-цепочку корректно и даёт "closed pipe" / TLS timeout на DPI-сетях.
    // Вызывать только под PING_CORE_LOCK и только когда VPN выключен.
    private long pingViaFullCore(String configJson) {
        libxray.XRayPoint pingPoint = null;
        try {
            new XrayManager().boot(activity, activity.getFilesDir().getAbsolutePath());

            org.json.JSONObject cfg = new org.json.JSONObject(configJson);

            // Ставим dialTimeout на freedom-outbound (fragment-цепочку): на DPI без таймаута
            // Go ждёт стандартный TCP-таймаут (~75с). 10с даёт рабочим серверам время подключиться,
            // заблокированные падают быстро.
            org.json.JSONArray outbounds = cfg.optJSONArray("outbounds");
            if (outbounds != null) {
                for (int oi = 0; oi < outbounds.length(); oi++) {
                    org.json.JSONObject ob = outbounds.optJSONObject(oi);
                    if (ob == null || !"freedom".equals(ob.optString("protocol"))) continue;
                    org.json.JSONObject ss = ob.optJSONObject("streamSettings");
                    if (ss == null) { ss = new org.json.JSONObject(); ob.put("streamSettings", ss); }
                    org.json.JSONObject sockopt = ss.optJSONObject("sockopt");
                    if (sockopt == null) { sockopt = new org.json.JSONObject(); ss.put("sockopt", sockopt); }
                    sockopt.put("dialTimeout", 10);
                }
            }

            // Диагностика: логируем первый proxy-outbound и его bypass-настройки
            if (outbounds != null && outbounds.length() > 0) {
                org.json.JSONObject first = outbounds.optJSONObject(0);
                if (first != null) {
                    String proto = first.optString("protocol", "?");
                    String tag = first.optString("tag", "?");
                    String dialerProxy = "";
                    String security = "";
                    String sni = "";
                    org.json.JSONObject ss0 = first.optJSONObject("streamSettings");
                    if (ss0 != null) {
                        org.json.JSONObject so = ss0.optJSONObject("sockopt");
                        if (so != null) dialerProxy = so.optString("dialerProxy", "");
                        security = ss0.optString("security", "");
                        org.json.JSONObject rs = ss0.optJSONObject("realitySettings");
                        if (rs != null) sni = rs.optString("serverName", "");
                        if (sni.isEmpty()) { org.json.JSONObject ts = ss0.optJSONObject("tlsSettings"); if (ts != null) sni = ts.optString("serverName", ""); }
                    }
                    String bypass = "";
                    if (outbounds != null) {
                        for (int bi = 0; bi < outbounds.length(); bi++) {
                            org.json.JSONObject bo = outbounds.optJSONObject(bi);
                            if (bo == null || !"freedom".equals(bo.optString("protocol"))) continue;
                            org.json.JSONObject bs = bo.optJSONObject("settings");
                            if (bs != null) {
                                if (bs.has("fragment")) bypass += "fragment ";
                                if (bs.has("noises")) bypass += "noises ";
                            }
                        }
                    }
                    android.util.Log.i(TAG, "pingViaFullCore: first_ob=" + tag + "(" + proto + ") security=" + security + " sni=" + sni + " dialerProxy=" + dialerProxy + " bypass=[" + bypass.trim() + "]");
                }
            }

            // Быстрый TCP-пинг к серверу (без TLS/VLESS/xray).
            // TCP SYN-ACK завершается до REALITY/TLS-проверки → даёт реальный RTT.
            // IPv4-приоритет: исключает NAT64/DNS64-маршрут, который даёт ECONNREFUSED.
            String ep = extractProxyEndpoint(cfg);
            String serverHost = null; int serverPort = 443;
            if (ep != null) {
                int col = ep.lastIndexOf(':');
                if (col > 0) {
                    serverHost = ep.substring(0, col);
                    try { serverPort = Integer.parseInt(ep.substring(col + 1)); } catch (NumberFormatException ignored) {}
                } else { serverHost = ep; }
            }
            if (serverHost != null) {
                long t0 = System.currentTimeMillis();
                try (java.net.Socket s = new java.net.Socket()) {
                    java.net.InetAddress addr = resolveIPv4First(serverHost);
                    s.connect(new java.net.InetSocketAddress(addr, serverPort), 5000);
                    long tcpDelay = System.currentTimeMillis() - t0;
                    android.util.Log.i(TAG, "pingViaFullCore: TCP " + serverHost + ":" + serverPort + " -> " + tcpDelay + "ms");
                    return tcpDelay;
                } catch (Throwable ignored) {
                    android.util.Log.i(TAG, "pingViaFullCore: TCP " + serverHost + ":" + serverPort + " failed, fallback to SOCKS");
                }
            }

            org.json.JSONArray inbounds = new org.json.JSONArray();
            org.json.JSONObject socksIn = new org.json.JSONObject();
            socksIn.put("protocol", "socks");
            socksIn.put("listen",   "127.0.0.1");
            socksIn.put("port",     PING_SOCKS_PORT);
            org.json.JSONObject socksSet = new org.json.JSONObject();
            socksSet.put("udp", false);
            socksIn.put("settings", socksSet);
            inbounds.put(socksIn);
            cfg.put("inbounds", inbounds);
            final String pingCfg = cfg.toString();

            pingPoint = libxray.Libxray.newXRayPoint(SimApplication.staticSupportSet, true);
            final libxray.XRayPoint point = pingPoint;
            new Thread(() -> {
                try { point.coreRunLoop(pingCfg); } catch (Throwable ignored) {}
            }, "PingCore").start();

            // Ждём открытия SOCKS-порта — признак готовности ядра
            boolean ready = false;
            long deadline = System.currentTimeMillis() + 4000;
            while (System.currentTimeMillis() < deadline) {
                try (java.net.Socket s = new java.net.Socket()) {
                    s.connect(new java.net.InetSocketAddress("127.0.0.1", PING_SOCKS_PORT), 300);
                    ready = true; break;
                } catch (Throwable ignored) {}
                try { Thread.sleep(100); } catch (InterruptedException ie) { return -1; }
            }
            if (!ready) {
                android.util.Log.w(TAG, "pingViaFullCore: SOCKS not ready in 4s");
                return -1;
            }
            long delay = httpGetViaSocks(PING_SOCKS_PORT, "connectivitycheck.gstatic.com", 80, "/generate_204", 9000);
            android.util.Log.i(TAG, "pingViaFullCore: gstatic -> " + delay + "ms");
            return delay;
        } catch (Throwable t) {
            android.util.Log.e(TAG, "pingViaFullCore error: " + t);
            return -1;
        } finally {
            if (pingPoint != null) {
                try { pingPoint.coreStopLoop(); } catch (Throwable ignored) {}
            }
            // Ждём закрытия порта перед следующим вызовом (ядро освобождает ресурсы)
            long portDeadline = System.currentTimeMillis() + 1500;
            while (System.currentTimeMillis() < portDeadline) {
                boolean open;
                try (java.net.Socket s = new java.net.Socket()) {
                    s.connect(new java.net.InetSocketAddress("127.0.0.1", PING_SOCKS_PORT), 200);
                    open = true;
                } catch (Throwable ignored) { open = false; }
                if (!open) break;
                try { Thread.sleep(100); } catch (InterruptedException ignored) { break; }
            }
        }
    }

    // Предпочитает IPv4-адрес при резолве, чтобы избежать NAT64/DNS64-маршрута (который даёт
    // ECONNREFUSED для российских серверов через IPv6-only сети).
    private static java.net.InetAddress resolveIPv4First(String host) throws java.net.UnknownHostException {
        java.net.InetAddress[] addrs = java.net.InetAddress.getAllByName(host);
        for (java.net.InetAddress a : addrs) {
            if (a instanceof java.net.Inet4Address) return a;
        }
        return addrs[0];
    }


    // Извлекает "addr:port" первого proxy-outbound из JSONObject конфига пинга.
    private static String extractProxyEndpoint(org.json.JSONObject cfg) {
        if (cfg == null) return null;
        try {
            org.json.JSONArray obs = cfg.optJSONArray("outbounds");
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


    // HTTP GET через SOCKS5 с удалённым разрешением имени (ATYP=0x03, домен).
    // Используем connectivitycheck.gstatic.com/generate_204 — Google, HTTP 204,
    // доступен из любых европейских датацентров (в отличие от msftncsi.com который
    // недоступен с некоторых Czech-хостингов, и cp.cloudflare.com:80 без ответа).
    // Домен идёт через доменные правила xray → proxy, не разрешается системным DNS Android.
    private long httpGetViaSocks(int socksPort, String host, int port, String path, int timeoutMs) {
        long t0 = System.currentTimeMillis();
        try (java.net.Socket s = new java.net.Socket()) {
            s.connect(new java.net.InetSocketAddress("127.0.0.1", socksPort), timeoutMs);
            s.setSoTimeout(timeoutMs);
            java.io.OutputStream os = s.getOutputStream();
            java.io.InputStream  is = s.getInputStream();
            // SOCKS5 greeting
            os.write(new byte[]{0x05, 0x01, 0x00}); os.flush();
            byte[] hi = new byte[2];
            readFully(is, hi, 2);
            if (hi[0] != 0x05 || hi[1] != 0x00) { android.util.Log.e(TAG, "ping/socks: bad greeting hi=" + (hi[0]&0xff) + "," + (hi[1]&0xff)); return -1; }
            android.util.Log.i(TAG, "ping/socks: greeting ok +" + (System.currentTimeMillis()-t0) + "ms");
            // SOCKS5 CONNECT (ATYP=0x03 domain)
            byte[] hb = host.getBytes("US-ASCII");
            byte[] req = new byte[7 + hb.length];
            req[0] = 0x05; req[1] = 0x01; req[2] = 0x00; req[3] = 0x03;
            req[4] = (byte) hb.length;
            System.arraycopy(hb, 0, req, 5, hb.length);
            req[5 + hb.length] = (byte) ((port >> 8) & 0xff);
            req[6 + hb.length] = (byte) (port & 0xff);
            os.write(req); os.flush();
            byte[] rep = new byte[4];
            readFully(is, rep, 4);
            android.util.Log.i(TAG, "ping/socks: CONNECT REP=0x" + Integer.toHexString(rep[1]&0xff) + " +" + (System.currentTimeMillis()-t0) + "ms");
            if (rep[1] != 0x00) { android.util.Log.e(TAG, "ping/socks: CONNECT failed REP=" + (rep[1] & 0xff)); return -1; }
            int atyp = rep[3] & 0xff;
            int addrLen = (atyp == 0x01) ? 4 : (atyp == 0x04) ? 16 : (atyp == 0x03) ? readByte(is) : 0;
            readFully(is, new byte[addrLen + 2], addrLen + 2);
            // HTTP GET
            String reqLine = "GET " + path + " HTTP/1.1\r\nHost: " + host + "\r\nConnection: close\r\n\r\n";
            os.write(reqLine.getBytes("US-ASCII")); os.flush();
            android.util.Log.i(TAG, "ping/socks: GET sent +" + (System.currentTimeMillis()-t0) + "ms");
            String statusLine = readLine(is);
            long delay = System.currentTimeMillis() - t0;
            android.util.Log.i(TAG, "ping/socks: '" + statusLine + "' +" + delay + "ms (port=" + socksPort + ")");
            if (statusLine == null || !statusLine.startsWith("HTTP")) return -1;
            String[] p = statusLine.split(" ");
            if (p.length >= 2) { try { if (Integer.parseInt(p[1]) > 0) return delay; } catch (NumberFormatException ignored) {} }
            return -1;
        } catch (Throwable t) {
            android.util.Log.e(TAG, "ping/socks error +" + (System.currentTimeMillis()-t0) + "ms: " + t);
            return -1;
        }
    }

    // TLS-рукопожатие к host:port через живой SOCKS5.
    // Маршрут: устройство → SOCKS VPN → server.
    // Xray отвечает на SOCKS CONNECT сразу (до TCP к серверу), поэтому мы идём дальше
    // и делаем TLS — сервер ДОЛЖЕН ответить (ServerHello / Alert / RST), и именно
    // это время и есть настоящий RTT. Если сервер вообще не отвечает → SO_TIMEOUT.
    private long tlsPingViaSocks5(int socksPort, String host, int port, String sni, int timeoutMs) {
        long t0 = System.currentTimeMillis();
        java.net.Socket rawSock = null;
        javax.net.ssl.SSLSocket ssl = null;
        try {
            rawSock = new java.net.Socket();
            rawSock.connect(new java.net.InetSocketAddress("127.0.0.1", socksPort), timeoutMs);
            rawSock.setSoTimeout(timeoutMs);
            java.io.OutputStream os = rawSock.getOutputStream();
            java.io.InputStream  is = rawSock.getInputStream();
            // SOCKS5 greeting
            os.write(new byte[]{0x05, 0x01, 0x00}); os.flush();
            byte[] hi = new byte[2];
            readFully(is, hi, 2);
            if (hi[0] != 0x05 || hi[1] != 0x00) return -1;
            // SOCKS5 CONNECT (ATYP=0x03 domain)
            byte[] hb = host.getBytes("US-ASCII");
            byte[] req = new byte[7 + hb.length];
            req[0] = 0x05; req[1] = 0x01; req[2] = 0x00; req[3] = 0x03;
            req[4] = (byte) hb.length;
            System.arraycopy(hb, 0, req, 5, hb.length);
            req[5 + hb.length] = (byte) ((port >> 8) & 0xff);
            req[6 + hb.length] = (byte) (port & 0xff);
            os.write(req); os.flush();
            byte[] rep = new byte[4];
            readFully(is, rep, 4);
            if (rep[1] != 0x00) return -1;
            int atyp = rep[3] & 0xff;
            int addrLen = (atyp == 0x01) ? 4 : (atyp == 0x04) ? 16 : (atyp == 0x03) ? readByte(is) : 0;
            readFully(is, new byte[addrLen + 2], addrLen + 2);
            // TLS handshake поверх SOCKS-туннеля
            javax.net.ssl.TrustManager[] tm = { new javax.net.ssl.X509TrustManager() {
                public java.security.cert.X509Certificate[] getAcceptedIssuers() { return new java.security.cert.X509Certificate[0]; }
                public void checkClientTrusted(java.security.cert.X509Certificate[] c, String a) {}
                public void checkServerTrusted(java.security.cert.X509Certificate[] c, String a) {}
            }};
            javax.net.ssl.SSLContext ctx = javax.net.ssl.SSLContext.getInstance("TLS");
            ctx.init(null, tm, null);
            int remaining = timeoutMs - (int)(System.currentTimeMillis() - t0);
            if (remaining <= 100) return -1;
            String tlsHost = (sni != null && !sni.isEmpty()) ? sni : host;
            ssl = (javax.net.ssl.SSLSocket) ctx.getSocketFactory().createSocket(rawSock, tlsHost, port, false);
            if (sni != null && !sni.isEmpty()) {
                javax.net.ssl.SSLParameters params = ssl.getSSLParameters();
                params.setServerNames(java.util.Collections.singletonList(new javax.net.ssl.SNIHostName(sni)));
                ssl.setSSLParameters(params);
            }
            ssl.setSoTimeout(remaining);
            try {
                ssl.startHandshake();
            } catch (Throwable handshakeEx) {
                long elapsed = System.currentTimeMillis() - t0;
                // Сервер ответил (ServerHello, Alert или RST) — elapsed это реальный RTT.
                // Если висели до таймаута — сервер недоступен.
                android.util.Log.i(TAG, "tlsPingViaSocks5 handshake ex=" + handshakeEx.getClass().getSimpleName() + " elapsed=" + elapsed + "ms");
                return (elapsed < timeoutMs - 200) ? elapsed : -1;
            }
            long result = System.currentTimeMillis() - t0;
            android.util.Log.i(TAG, "tlsPingViaSocks5 " + host + ":" + port + " -> " + result + "ms");
            return result;
        } catch (Throwable t) {
            android.util.Log.e(TAG, "tlsPingViaSocks5 " + host + ":" + port + " err: " + t.getMessage());
            return -1;
        } finally {
            if (ssl != null) { try { ssl.close(); } catch (Throwable ignored) {} }
            if (rawSock != null) { try { rawSock.close(); } catch (Throwable ignored) {} }
        }
    }

    private static void readFully(java.io.InputStream is, byte[] buf, int len) throws java.io.IOException {
        int off = 0;
        while (off < len) {
            int r = is.read(buf, off, len - off);
            if (r < 0) throw new java.io.IOException("EOF");
            off += r;
        }
    }
    private static int readByte(java.io.InputStream is) throws java.io.IOException {
        int b = is.read();
        if (b < 0) throw new java.io.IOException("EOF");
        return b & 0xff;
    }
    private static String readLine(java.io.InputStream is) throws java.io.IOException {
        StringBuilder sb = new StringBuilder();
        int b;
        while ((b = is.read()) >= 0) {
            if (b == '\n') break;
            if (b != '\r') sb.append((char) b);
        }
        return sb.length() == 0 ? null : sb.toString();
    }

    // Прогрев ядра: boot (initXEnv + распаковка geo) идемпотентен и кэшируется на
    // процесс. Вызываем заранее (при открытии списка серверов/профилей), чтобы
    // первый пинг не платил за инициализацию libxray и отвечал сразу.
    @JavascriptInterface
    public void warmupCore(String taskId) {
        executor.execute(() -> {
            try {
                File filesDir = activity.getFilesDir();
                new XrayManager().boot(activity, filesDir.getAbsolutePath());
                sendToJs(taskId, "ok");
            } catch (Throwable t) {
                android.util.Log.e(TAG, "warmupCore failed: " + t.getMessage());
                sendToJs(taskId, "err");
            }
        });
    }

    // Стабильный идентификатор устройства (HWID) для подписок с device-lock
    // (3X-UI / Remnawave HWID limit). Панель отдаёт реальные сервера только клиенту,
    // приславшему X-HWID; иначе — сервера-заглушки («HWID не поддерживается»).
    // ANDROID_ID зависит от подписи приложения, поэтому НЕ совпадёт с HWID Happ —
    // Sim Proxy регистрируется как ОТДЕЛЬНОЕ устройство в подписке пользователя.
    private volatile String cachedHwid = null;
    private String getHwid() {
        if (cachedHwid != null) return cachedHwid;
        String id = null;
        try {
            id = Settings.Secure.getString(activity.getContentResolver(), Settings.Secure.ANDROID_ID);
        } catch (Throwable ignored) {}
        if (id == null || id.isEmpty() || "9774d56d682e549c".equals(id)) {
            // Фоллбэк: стабильный UUID, сохранённый в prefs.
            try {
                android.content.SharedPreferences sp = activity.getSharedPreferences("sim_device", Context.MODE_PRIVATE);
                id = sp.getString("hwid", null);
                if (id == null || id.isEmpty()) {
                    id = java.util.UUID.randomUUID().toString();
                    sp.edit().putString("hwid", id).apply();
                }
            } catch (Throwable t) {
                id = java.util.UUID.randomUUID().toString();
            }
        }
        // Приводим к UUID-подобному виду (детерминированно из ANDROID_ID).
        try {
            java.security.MessageDigest md = java.security.MessageDigest.getInstance("SHA-256");
            byte[] h = md.digest(("simproxy:" + id).getBytes("UTF-8"));
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < 16; i++) sb.append(String.format("%02x", h[i]));
            String hex = sb.toString();
            cachedHwid = hex.substring(0,8)+"-"+hex.substring(8,12)+"-"+hex.substring(12,16)
                       +"-"+hex.substring(16,20)+"-"+hex.substring(20,32);
        } catch (Throwable t) {
            cachedHwid = id;
        }
        return cachedHwid;
    }

    // Заголовки, которые шлёт Happ для разблокировки HWID-locked подписок.
    private void applySubscriptionHeaders(HttpURLConnection conn) {
        try {
            String ver = "1.0";
            try { ver = activity.getPackageManager().getPackageInfo(activity.getPackageName(), 0).versionName; } catch (Throwable ignored) {}
            conn.setRequestProperty("hwid", getHwid());
            conn.setRequestProperty("X-HWID", getHwid());
            conn.setRequestProperty("X-Device-OS", "Android");
            conn.setRequestProperty("X-Ver-OS", Build.VERSION.RELEASE != null ? Build.VERSION.RELEASE : String.valueOf(Build.VERSION.SDK_INT));
            conn.setRequestProperty("X-Device-Model", Build.MANUFACTURER + " " + Build.MODEL);
            conn.setRequestProperty("X-Device-Locale", java.util.Locale.getDefault().toLanguageTag());
            conn.setRequestProperty("X-App-Version", ver);
            conn.setRequestProperty("X-Bundle-ID", activity.getPackageName());
        } catch (Throwable t) {
            Log.w(TAG, "applySubscriptionHeaders failed: " + t.getMessage());
        }
    }

    // Запрос исключения из оптимизации батареи (Doze). Без него Android может
    // усыплять/убивать VPN-сервис в фоне. Открывает системный диалог; если уже
    // исключены — открывает список настроек батареи как индикацию.
    @JavascriptInterface
    public void requestBatteryOptimizationExemption() {
        activity.runOnUiThread(() -> {
            String pkg = activity.getPackageName();
            try {
                android.os.PowerManager pm = (android.os.PowerManager) activity.getSystemService(Context.POWER_SERVICE);
                boolean ignoring = pm != null && pm.isIgnoringBatteryOptimizations(pkg);
                if (!ignoring) {
                    Intent intent = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
                    intent.setData(Uri.parse("package:" + pkg));
                    activity.startActivity(intent);
                } else {
                    // Уже разрешено — показываем системный список как подтверждение.
                    activity.startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
                }
            } catch (Throwable t) {
                Log.w(TAG, "battery exemption request failed: " + t.getMessage());
                // Фоллбэк: общий экран настроек оптимизации батареи.
                try {
                    activity.startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
                } catch (Throwable ignored) {
                    // Последний фоллбэк: детали приложения.
                    try {
                        Intent i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
                        i.setData(Uri.parse("package:" + pkg));
                        activity.startActivity(i);
                    } catch (Throwable ignored2) {}
                }
            }
        });
    }

    // Запрашивает только разрешение на уведомления (Android 13+).
    // Батарейное исключение теперь управляется через getBatteryStatus / requestDozExemption /
    // requestOemBatterySettings — пользователь видит объяснение перед системным диалогом.
    @JavascriptInterface
    public void requestAllPermissions(String taskId) {
        activity.runOnUiThread(() -> {
            if (Build.VERSION.SDK_INT >= 33) {
                try {
                    if (activity.checkSelfPermission("android.permission.POST_NOTIFICATIONS")
                            != android.content.pm.PackageManager.PERMISSION_GRANTED) {
                        activity.requestPermissions(
                            new String[]{"android.permission.POST_NOTIFICATIONS"}, 2001);
                    }
                } catch (Throwable ignored) {}
            }
            sendToJs(taskId, "true");
        });
    }

    // Возвращает статус батарейных разрешений:
    // { doze: bool, manufacturer: string }
    @JavascriptInterface
    public void getBatteryStatus(String taskId) {
        activity.runOnUiThread(() -> {
            String pkg = activity.getPackageName();
            android.os.PowerManager pm =
                (android.os.PowerManager) activity.getSystemService(Context.POWER_SERVICE);
            boolean doze = pm != null && pm.isIgnoringBatteryOptimizations(pkg);
            String mfr = android.os.Build.MANUFACTURER.toLowerCase().replaceAll("[^a-z0-9]", "");
            sendToJs(taskId, "{\"doze\":" + doze + ",\"manufacturer\":\"" + mfr + "\"}");
        });
    }

    // Открывает прямой системный диалог исключения из Doze.
    // Показывается только после того как VPN уже упал в фоне — пользователь
    // уже понял проблему, поэтому диалог воспринимается как решение, а не угроза.
    @JavascriptInterface
    public void requestDozeExemption(String taskId) {
        activity.runOnUiThread(() -> {
            String pkg = activity.getPackageName();
            try {
                android.os.PowerManager pm =
                    (android.os.PowerManager) activity.getSystemService(Context.POWER_SERVICE);
                if (pm != null && !pm.isIgnoringBatteryOptimizations(pkg)) {
                    Intent i = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
                    i.setData(Uri.parse("package:" + pkg));
                    activity.startActivity(i);
                }
            } catch (Throwable t) {
                Log.w(TAG, "doze exemption failed: " + t.getMessage());
                try { activity.startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)); }
                catch (Throwable ignored) {}
            }
            sendToJs(taskId, "true");
        });
    }

    // Открывает OEM-специфичный экран настроек батареи/автозапуска.
    // На Xiaomi, Samsung, Huawei, Vivo, Oppo/Realme/OnePlus у каждого производителя
    // свой агрессивный механизм убийства фоновых приложений помимо стандартного Doze.
    @JavascriptInterface
    public void requestOemBatterySettings(String taskId) {
        activity.runOnUiThread(() -> {
            String pkg = activity.getPackageName();
            String mfr = android.os.Build.MANUFACTURER.toLowerCase();
            boolean opened = false;

            // [производитель, пакет, Activity] — пробуем по очереди
            String[][] intents = {
                {"xiaomi",  "com.miui.powerkeeper",           "com.miui.powerkeeper.ui.HoldApplicationsDetailActivity"},
                {"redmi",   "com.miui.powerkeeper",           "com.miui.powerkeeper.ui.HoldApplicationsDetailActivity"},
                {"poco",    "com.miui.powerkeeper",           "com.miui.powerkeeper.ui.HoldApplicationsDetailActivity"},
                {"samsung", "com.samsung.android.lool",       "com.samsung.android.sm.ui.battery.BatteryActivity"},
                {"huawei",  "com.huawei.systemmanager",       "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity"},
                {"honor",   "com.huawei.systemmanager",       "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity"},
                {"vivo",    "com.vivo.permissionmanager",     "com.vivo.permissionmanager.activity.BgStartUpManagerActivity"},
                {"oppo",    "com.coloros.safecenter",         "com.coloros.privacypermissionsentry.PermissionTopActivity"},
                {"realme",  "com.coloros.safecenter",         "com.coloros.privacypermissionsentry.PermissionTopActivity"},
                {"oneplus", "com.oplus.safecenter",           "com.oplus.safecenter.permission.startup.FakePowerSaveStartupListActivity"},
                {"meizu",   "com.meizu.safe",                 "com.meizu.safe.permission.SmartPermissionActivity"},
            };

            for (String[] entry : intents) {
                if (mfr.contains(entry[0])) {
                    try {
                        Intent i = new Intent();
                        i.setClassName(entry[1], entry[2]);
                        i.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                        activity.startActivity(i);
                        opened = true;
                        break;
                    } catch (Throwable ignored) {}
                }
            }

            if (!opened) {
                // Фоллбэк: детали приложения — пользователь сам найдёт нужное
                try {
                    Intent i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
                    i.setData(Uri.parse("package:" + pkg));
                    activity.startActivity(i);
                } catch (Throwable ignored) {}
            }
            sendToJs(taskId, "true");
        });
    }

    @JavascriptInterface
    public void checkTorPort(String taskId) {
        executor.execute(() -> {
            boolean available = false;
            try (java.net.Socket s = new java.net.Socket()) {
                s.connect(new java.net.InetSocketAddress("127.0.0.1", 9050), 500);
                available = true;
            } catch (Throwable ignored) {}
            sendToJs(taskId, "{\"available\":" + available + "}");
        });
    }

    @JavascriptInterface
    public void openOrbotInstall(String taskId) {
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW,
                android.net.Uri.parse("market://details?id=org.torproject.android"));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            activity.startActivity(intent);
        } catch (Throwable e) {
            try {
                Intent intent = new Intent(Intent.ACTION_VIEW,
                    android.net.Uri.parse("https://play.google.com/store/apps/details?id=org.torproject.android"));
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                activity.startActivity(intent);
            } catch (Throwable ignored) {}
        }
        sendToJs(taskId, "true");
    }

    @JavascriptInterface
    public void fetchUrl(String url, String userAgent, String taskId) {
        android.util.Log.e(TAG, "fetchUrl: " + url);
        executor.execute(() -> {
            HttpURLConnection conn = null;
            String currentUrl = url;
            // Итеративная обработка редиректов: максимум 5 переходов.
            // Рекурсивный вызов fetchUrl() без лимита → StackOverflowError при
            // вредоносной цепочке A→B→A→... или просто длинной redirect-цепи.
            final int MAX_REDIRECTS = 5;
            int redirectCount = 0;
            try {
              while (true) {
                URL urlObj = new URL(currentUrl);
                conn = (HttpURLConnection) urlObj.openConnection();
                conn.setRequestMethod("GET");
                // Используем User-Agent, который часто ожидают провайдеры (v2rayNG или Clash)
                conn.setRequestProperty("User-Agent", userAgent != null ? userAgent : "v2rayNG/1.8.19");
                conn.setRequestProperty("Accept-Encoding", "gzip");
                applySubscriptionHeaders(conn);
                // Отключаем автоматические редиректы — обрабатываем сами с лимитом
                conn.setInstanceFollowRedirects(false);
                conn.setConnectTimeout(20000);
                conn.setReadTimeout(20000);

                int code = conn.getResponseCode();
                Log.i(TAG, "fetchUrl response code: " + code + " url=" + currentUrl);

                if (code == HttpURLConnection.HTTP_MOVED_PERM || code == HttpURLConnection.HTTP_MOVED_TEMP || code == 307 || code == 308) {
                    String newUrl = conn.getHeaderField("Location");
                    conn.disconnect();
                    conn = null;
                    if (newUrl == null || newUrl.equals(currentUrl) || ++redirectCount > MAX_REDIRECTS) {
                        sendToJs(taskId, "{\"ok\":false,\"error\":\"Too many redirects\"}");
                        return;
                    }
                    Log.i(TAG, "Redirecting (" + redirectCount + "/" + MAX_REDIRECTS + "): " + newUrl);
                    currentUrl = newUrl;
                    continue;
                }

                if (code != 200) {
                    sendToJs(taskId, "{\"ok\":false,\"error\":\"HTTP " + code + "\"}");
                    return;
                }

                JSONObject headers = new JSONObject();
                Map<String, List<String>> headerMap = conn.getHeaderFields();
                for (Map.Entry<String, List<String>> entry : headerMap.entrySet()) {
                    String key = entry.getKey();
                    if (key != null) headers.put(key.toLowerCase(), entry.getValue().get(0));
                }

                java.io.InputStream is = conn.getInputStream();
                String encoding = conn.getContentEncoding();
                if (encoding != null && encoding.equalsIgnoreCase("gzip")) {
                    is = new java.util.zip.GZIPInputStream(is);
                }

                BufferedReader in = new BufferedReader(new InputStreamReader(is, "UTF-8"));
                StringBuilder response = new StringBuilder();
                String line;
                while ((line = in.readLine()) != null) response.append(line).append("\n");
                in.close();

                Log.i(TAG, "fetchUrl body length: " + response.length());
                JSONObject res = new JSONObject();
                res.put("ok", true);
                res.put("body", response.toString());
                res.put("headers", headers);
                
                String userInfo = getHeaderSafe(conn, "Subscription-UserInfo");
                if (userInfo != null) res.put("userInfo", userInfo);
                
                String profileTitle = getHeaderSafe(conn, "profile-title");
                if (profileTitle != null) res.put("name", profileTitle);
                
                sendToJs(taskId, res.toString());
                break; // успешный ответ — выходим из while
              } // end while
            } catch (Exception e) {
                Log.e(TAG, "fetchUrl error", e);
                String errorMsg = e.getMessage() != null ? e.getMessage() : e.toString();
                sendToJs(taskId, ERR_PREFIX + JSONObject.quote(errorMsg) + "}");
            } finally {
                if (conn != null) conn.disconnect();
            }
        });
    }

    private String getHeaderSafe(HttpURLConnection conn, String key) {
        String val = conn.getHeaderField(key);
        if (val == null) val = conn.getHeaderField(key.toLowerCase());
        return val;
    }

    @JavascriptInterface
    public void copyToClipboard(String text) {
        activity.runOnUiThread(() -> {
            ClipboardManager cb = (ClipboardManager) activity.getSystemService(Context.CLIPBOARD_SERVICE);
            if (cb != null) cb.setPrimaryClip(ClipData.newPlainText("SimProxy", text));
        });
    }

    @JavascriptInterface
    public String readClipboard() {
        ClipboardManager cb = (ClipboardManager) activity.getSystemService(Context.CLIPBOARD_SERVICE);
        if (cb != null && cb.hasPrimaryClip()) {
            CharSequence text = cb.getPrimaryClip().getItemAt(0).getText();
            return text != null ? text.toString() : "";
        }
        return "";
    }

    @JavascriptInterface
    public void scanQrCode(String taskId) {
        this.lastQrTaskId = taskId;
        activity.runOnUiThread(() -> {
            Intent intent = new Intent(activity, QrScannerActivity.class);
            activity.startActivityForResult(intent, 1002);
        });
    }

    @JavascriptInterface
    public void testProxyDelay(String taskId) {
        executor.execute(() -> {
            VpnServiceImpl svc = VpnServiceImpl.getInstance();
            int socksPort = (svc != null) ? svc.getSocksPort() : 0;
            if (socksPort <= 0) socksPort = LIVE_SOCKS_PORT;
            // Тест идёт через живой SOCKS5 VPN-прокси — измеряет реальное
            // здоровье туннеля, а не прямую сеть. connectivitycheck.gstatic.com
            // хардкодирован в Xray hosts → 142.251.33.67, DNS не нужен.
            long delay = httpGetViaSocks(socksPort, "connectivitycheck.gstatic.com", 80, "/generate_204", 5000);
            sendToJs(taskId, String.valueOf(delay));
        });
    }

    @JavascriptInterface
    public void showNotification(String title, String body) {
        VpnServiceImpl svc = VpnServiceImpl.getInstance();
        if (svc != null) svc.updateNotification(title + ": " + body, svc.isRunning());
    }

    // ── Самообновление (in-app APK update) ─────────────────────────────────
    // Версия установленного приложения — для сравнения с последним релизом.
    @JavascriptInterface
    public String getAppVersion() {
        JSONObject o = new JSONObject();
        try {
            o.put("versionName", BuildConfig.VERSION_NAME);
            o.put("versionCode", BuildConfig.VERSION_CODE);
        } catch (Exception ignored) {}
        return o.toString();
    }

    // Скачивает APK по прямой ссылке (с обработкой 302-редиректов GitHub),
    // шлёт прогресс событием 'update-progress' и запускает системную установку.
    // Результат в JS: {ok, status:"installing"|"need_permission", error?}.
    @JavascriptInterface
    public void downloadAndInstallApk(String url, String taskId) {
        executor.execute(() -> {
            HttpURLConnection conn = null;
            try {
                File dir = new File(activity.getExternalFilesDir(null), "update");
                if (!dir.exists()) dir.mkdirs();
                File apk = new File(dir, "SimProxy-update.apk");
                if (apk.exists()) apk.delete();

                // GitHub отдаёт 302 на objects.githubusercontent.com — следуем вручную,
                // т.к. http→https редирект HttpURLConnection сам не проходит.
                String current = url;
                int redirects = 0;
                for (;;) {
                    conn = (HttpURLConnection) new URL(current).openConnection();
                    conn.setInstanceFollowRedirects(false);
                    conn.setConnectTimeout(20000);
                    conn.setReadTimeout(30000);
                    conn.setRequestProperty("User-Agent", "SimProxy-Updater");
                    int code = conn.getResponseCode();
                    if (code == HttpURLConnection.HTTP_MOVED_PERM || code == HttpURLConnection.HTTP_MOVED_TEMP
                            || code == 307 || code == 308) {
                        String loc = conn.getHeaderField("Location");
                        conn.disconnect();
                        conn = null;
                        if (loc == null || ++redirects > 5) throw new Exception("too many redirects");
                        current = loc;
                        continue;
                    }
                    if (code != 200) throw new Exception("HTTP " + code);
                    break;
                }

                int total = conn.getContentLength();
                try (java.io.InputStream in = conn.getInputStream();
                     java.io.FileOutputStream out = new java.io.FileOutputStream(apk)) {
                    byte[] buf = new byte[64 * 1024];
                    long downloaded = 0;
                    int lastPct = -1, r;
                    while ((r = in.read(buf)) != -1) {
                        out.write(buf, 0, r);
                        downloaded += r;
                        if (total > 0) {
                            int pct = (int) (downloaded * 100 / total);
                            if (pct != lastPct) {
                                lastPct = pct;
                                emitJsEvent("update-progress", "{\"pct\":" + pct + "}");
                            }
                        }
                    }
                    out.flush();
                }
                conn.disconnect();
                conn = null;
                pendingApkPath = apk.getAbsolutePath();

                // Android 8+: установка из стороннего источника требует разрешения
                // «Установка неизвестных приложений» для нашего пакета.
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                        && !activity.getPackageManager().canRequestPackageInstalls()) {
                    openUnknownSourcesSettings();
                    sendToJs(taskId, "{\"ok\":false,\"status\":\"need_permission\"}");
                    return;
                }

                launchInstall(apk);
                sendToJs(taskId, "{\"ok\":true,\"status\":\"installing\"}");
            } catch (Exception e) {
                android.util.Log.e(TAG, "downloadAndInstallApk error", e);
                sendToJs(taskId, ERR_PREFIX + JSONObject.quote(String.valueOf(e.getMessage())) + "}");
            } finally {
                if (conn != null) conn.disconnect();
            }
        });
    }

    // Фоновая докачка APK обновления БЕЗ установки. Качаем заранее (на безлимитной
    // сети), чтобы потом установка прошла в один тап мгновенно, без ожидания загрузки.
    // По завершении шлём событие 'update-ready' и сохраняем путь в pendingApkPath.
    @JavascriptInterface
    public void downloadUpdateApk(String url, String taskId) {
        executor.execute(() -> {
            HttpURLConnection conn = null;
            try {
                File dir = new File(activity.getExternalFilesDir(null), "update");
                if (!dir.exists()) dir.mkdirs();
                File apk = new File(dir, "SimProxy-update.apk");
                if (apk.exists()) apk.delete();

                String current = url;
                int redirects = 0;
                for (;;) {
                    conn = (HttpURLConnection) new URL(current).openConnection();
                    conn.setInstanceFollowRedirects(false);
                    conn.setConnectTimeout(20000);
                    conn.setReadTimeout(30000);
                    conn.setRequestProperty("User-Agent", "SimProxy-Updater");
                    int code = conn.getResponseCode();
                    if (code == HttpURLConnection.HTTP_MOVED_PERM || code == HttpURLConnection.HTTP_MOVED_TEMP
                            || code == 307 || code == 308) {
                        String loc = conn.getHeaderField("Location");
                        conn.disconnect();
                        conn = null;
                        if (loc == null || ++redirects > 5) throw new Exception("too many redirects");
                        current = loc;
                        continue;
                    }
                    if (code != 200) throw new Exception("HTTP " + code);
                    break;
                }

                int total = conn.getContentLength();
                try (java.io.InputStream in = conn.getInputStream();
                     java.io.FileOutputStream out = new java.io.FileOutputStream(apk)) {
                    byte[] buf = new byte[64 * 1024];
                    long downloaded = 0;
                    int lastPct = -1, r;
                    while ((r = in.read(buf)) != -1) {
                        out.write(buf, 0, r);
                        downloaded += r;
                        if (total > 0) {
                            int pct = (int) (downloaded * 100 / total);
                            if (pct != lastPct) {
                                lastPct = pct;
                                emitJsEvent("update-progress", "{\"pct\":" + pct + "}");
                            }
                        }
                    }
                    out.flush();
                }
                conn.disconnect();
                conn = null;
                pendingApkPath = apk.getAbsolutePath();
                // НЕ запускаем установку — это сделает installDownloadedApk по тапу.
                emitJsEvent("update-ready", "{\"ready\":true}");
                sendToJs(taskId, "{\"ok\":true,\"status\":\"downloaded\"}");
            } catch (Exception e) {
                android.util.Log.e(TAG, "downloadUpdateApk error", e);
                sendToJs(taskId, ERR_PREFIX + JSONObject.quote(String.valueOf(e.getMessage())) + "}");
            } finally {
                if (conn != null) conn.disconnect();
            }
        });
    }

    // true, если активная сеть безлимитная (Wi-Fi/Ethernet) — чтобы не качать
    // обновление на мобильном трафике без спроса.
    @JavascriptInterface
    public void isUnmeteredNetwork(String taskId) {
        try {
            android.net.ConnectivityManager cm = (android.net.ConnectivityManager)
                    activity.getSystemService(Context.CONNECTIVITY_SERVICE);
            boolean unmetered = false;
            if (cm != null) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                    android.net.Network n = cm.getActiveNetwork();
                    android.net.NetworkCapabilities caps = n != null ? cm.getNetworkCapabilities(n) : null;
                    unmetered = caps != null
                            && caps.hasCapability(android.net.NetworkCapabilities.NET_CAPABILITY_NOT_METERED);
                } else {
                    unmetered = !cm.isActiveNetworkMetered();
                }
            }
            sendToJs(taskId, unmetered ? "true" : "false");
        } catch (Exception e) {
            sendToJs(taskId, "false");
        }
    }

    // Ставит уже скачанный APK (вызывается после возврата из настроек разрешения,
    // чтобы не качать заново). Если файла нет — сообщает об ошибке.
    @JavascriptInterface
    public void installDownloadedApk(String taskId) {
        try {
            if (pendingApkPath == null) { sendToJs(taskId, "{\"ok\":false,\"error\":\"no apk\"}"); return; }
            File apk = new File(pendingApkPath);
            if (!apk.exists()) { sendToJs(taskId, "{\"ok\":false,\"error\":\"apk missing\"}"); return; }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                    && !activity.getPackageManager().canRequestPackageInstalls()) {
                openUnknownSourcesSettings();
                sendToJs(taskId, "{\"ok\":false,\"status\":\"need_permission\"}");
                return;
            }
            launchInstall(apk);
            sendToJs(taskId, "{\"ok\":true,\"status\":\"installing\"}");
        } catch (Exception e) {
            sendToJs(taskId, ERR_PREFIX + JSONObject.quote(String.valueOf(e.getMessage())) + "}");
        }
    }

    private void openUnknownSourcesSettings() {
        try {
            Intent perm = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:" + activity.getPackageName()));
            perm.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            activity.startActivity(perm);
        } catch (Exception e) {
            android.util.Log.e(TAG, "openUnknownSourcesSettings failed", e);
        }
    }

    private void launchInstall(File apk) {
        Uri uri = FileProvider.getUriForFile(activity, activity.getPackageName() + ".fileprovider", apk);
        Intent intent = new Intent(Intent.ACTION_VIEW);
        intent.setDataAndType(uri, "application/vnd.android.package-archive");
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
        activity.startActivity(intent);
    }

    @JavascriptInterface
    public void openUrl(String url) {
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            activity.startActivity(intent);
        } catch (Exception ignored) {}
    }

    @JavascriptInterface
    public void changeDns(String dns) {
        Log.i(TAG, "changeDns: " + dns);
    }

    public void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == 1001 && pendingVpnPermissionTaskId != null) {
            String id = pendingVpnPermissionTaskId;
            pendingVpnPermissionTaskId = null;
            sendToJs(id, resultCode == Activity.RESULT_OK ? "true" : "false");
        } else if (requestCode == 1002 && lastQrTaskId != null) {
            String result = (resultCode == Activity.RESULT_OK && data != null) ? data.getStringExtra("SCAN_RESULT") : null;
            sendToJs(lastQrTaskId, result != null ? JSONObject.quote(result) : "null");
            lastQrTaskId = null;
        }
    }

    public void onPermissionResult(int requestCode, String[] permissions, int[] grantResults) {
        // Handle generic permissions if needed
    }

    // ── Anti-filter batch: тестирует все серверы через measureOutboundDelay ─────
    // Вызывается из JS (fire-and-forget): JS получает результаты через событие
    // 'antifilter-update'. Работает только когда VPN выключен — при включённом
    // VPN measureOutboundDelay нельзя использовать (глобальный core занят).

    @JavascriptInterface
    public void startAntiFilterBatch(String serversJson) {
        if (antiFilterRunning) {
            Log.i(TAG, "AntiFilter: batch already running, skip");
            return;
        }
        antiFilterRunning = true;
        antiFilterExecutor.execute(() -> {
            try {
                runAntiFilterBatch(serversJson);
            } catch (Throwable t) {
                Log.e(TAG, "AntiFilter batch error: " + t.getMessage(), t);
            } finally {
                antiFilterRunning = false;
            }
        });
    }

    @JavascriptInterface
    public String getAntiFilterPings() {
        try {
            SharedPreferences prefs = activity.getSharedPreferences("antifilter_pings_v1", Context.MODE_PRIVATE);
            JSONObject result = new JSONObject();
            for (Map.Entry<String, ?> e : prefs.getAll().entrySet()) {
                String key = e.getKey();
                if (key.startsWith("af_")) {
                    result.put(key.substring(3), new JSONObject((String) e.getValue()));
                }
            }
            return result.toString();
        } catch (Exception ex) {
            Log.e(TAG, "getAntiFilterPings error: " + ex.getMessage());
            return "{}";
        }
    }

    private void runAntiFilterBatch(String serversJson) throws Exception {
        Log.i(TAG, "AntiFilter: batch started");
        JSONArray servers = new JSONArray(serversJson);
        SharedPreferences.Editor ed = activity.getSharedPreferences("antifilter_pings_v1", Context.MODE_PRIVATE).edit();
        ed.clear(); // Очищаем результаты предыдущего batch — stale данные не показываем
        long ts = System.currentTimeMillis();
        int tested = 0, succeeded = 0;
        for (int i = 0; i < servers.length(); i++) {
            VpnServiceImpl vpn = VpnServiceImpl.getInstance();
            if (vpn != null && vpn.isRunning()) {
                Log.i(TAG, "AntiFilter: VPN started, aborting batch at server " + i);
                break;
            }
            JSONObject entry = servers.getJSONObject(i);
            String nodeId = entry.getString("id");
            String configJson = entry.getString("config");
            long result = -1;
            try {
                synchronized (PING_CORE_LOCK) {
                    result = measureDelayWithFallback(configJson);
                }
            } catch (Throwable t) {
                Log.d(TAG, "AntiFilter: " + nodeId + " failed: " + t.getMessage());
            }
            tested++;
            Log.i(TAG, "AntiFilter: " + nodeId + " -> " + result + "ms");
            if (result > 0) {
                succeeded++;
                JSONObject val = new JSONObject();
                val.put("ms", result);
                val.put("ts", ts);
                ed.putString("af_" + nodeId, val.toString());
            }
        }
        ed.apply();
        Log.i(TAG, "AntiFilter: batch done " + succeeded + "/" + tested + " reachable");
        emitJsEvent("antifilter-update", "{\"tested\":" + tested + ",\"ok\":" + succeeded + "}");
    }

    private volatile boolean pingBatchCancelled = false;

    @JavascriptInterface
    public void nativePingBatch(String serversJson, String taskId) {
        pingBatchCancelled = false;
        executor.execute(() -> {
            try {
                JSONArray servers = new JSONArray(serversJson);
                int total = servers.length();
                Log.i(TAG, "PingBatch: started, " + total + " servers");

                VpnServiceImpl vpn = VpnServiceImpl.getInstance();
                if (vpn != null && vpn.isRunning()) {
                    // VPN включён: активный сервер — live SOCKS, остальные — measureOutboundDelay.
                    // REALITY-серверы RST-ят plain TCP → только REALITY-путь даёт реальный RTT.
                    // measureOutboundDelay поднимает легковесный инстанс рядом с VPN (как Happ).
                    // Сериализуем через PING_CORE_LOCK — параллельные инстансы не поддерживаются.
                    String activeEndpoint = VpnServiceImpl.getActiveProxyEndpoint();
                    int liveSocks = vpn.getSocksPort();
                    if (liveSocks <= 0) liveSocks = LIVE_SOCKS_PORT;
                    Log.i(TAG, "PingBatch(vpn): active=" + activeEndpoint);

                    for (int i = 0; i < total; i++) {
                        if (pingBatchCancelled) { Log.i(TAG, "PingBatch(vpn): cancelled at " + i); break; }
                        JSONObject entry = servers.getJSONObject(i);
                        String nodeId = entry.optString("id", "?");
                        String configJson = entry.getString("config");
                        long delay = -1;
                        try {
                            org.json.JSONObject cfg = new org.json.JSONObject(configJson);
                            String pingEndpoint = extractProxyEndpoint(cfg);
                            boolean isSame = activeEndpoint != null && activeEndpoint.equals(pingEndpoint);
                            Log.i(TAG, "PingBatch(vpn): " + nodeId + " ep=" + pingEndpoint + " same=" + isSame);
                            if (isSame) {
                                delay = httpGetViaSocks(liveSocks, "connectivitycheck.gstatic.com", 80, "/generate_204", 10000);
                            } else {
                                // Non-active server: measureOutboundDelay only.
                                // tcpPingViaSocks gives false results (measures VPN-tunnel latency, not server latency).
                                try {
                                    new XrayManager().boot(activity, activity.getFilesDir().getAbsolutePath());
                                    synchronized (PING_CORE_LOCK) {
                                        delay = libxray.Libxray.measureOutboundDelay(configJson, "http://cp.cloudflare.com/");
                                    }
                                } catch (Throwable t) {
                                    Log.i(TAG, "PingBatch(vpn): " + nodeId + " measureOutbound err: " + t.getMessage());
                                }
                            }
                        } catch (Throwable t) {
                            Log.e(TAG, "PingBatch(vpn): " + nodeId + " err: " + t);
                        }
                        Log.i(TAG, "PingBatch(vpn): " + nodeId + " -> " + delay + "ms");
                        emitPingItem(nodeId, delay, i, total, taskId);
                    }
                } else {
                    // VPN выключен: последовательный measureDelayWithFallback (требует PING_CORE_LOCK).
                    for (int i = 0; i < total; i++) {
                        if (pingBatchCancelled) { Log.i(TAG, "PingBatch: cancelled at " + i); break; }
                        JSONObject entry = servers.getJSONObject(i);
                        String nodeId = entry.getString("id");
                        String configJson = entry.getString("config");
                        long delay = -1;
                        try {
                            synchronized (PING_CORE_LOCK) { delay = measureDelayWithFallback(configJson); }
                        } catch (Throwable t) {
                            Log.e(TAG, "PingBatch: " + nodeId + " error: " + t);
                        }
                        Log.i(TAG, "PingBatch: " + nodeId + " -> " + delay + "ms (" + (i + 1) + "/" + total + ")");
                        emitPingItem(nodeId, delay, i, total, taskId);
                    }
                }
            } catch (Throwable t) {
                Log.e(TAG, "nativePingBatch error: " + t);
            } finally {
                emitJsEvent("ping-batch-done", "{\"taskId\":\"" + taskId + "\"}");
            }
        });
    }

    @JavascriptInterface
    public void cancelPingBatch() {
        pingBatchCancelled = true;
    }

    private void emitPingItem(String nodeId, long ms, int idx, int total, String taskId) {
        try {
            JSONObject ev = new JSONObject();
            ev.put("id", nodeId); ev.put("ms", ms); ev.put("i", idx); ev.put("n", total);
            ev.put("taskId", taskId);
            emitJsEvent("ping-batch-item", ev.toString());
        } catch (Exception ignored) {}
    }

    private void sendToJs(String taskId, String result) {
        final String safeId = taskId != null ? taskId.replaceAll("[^A-Za-z0-9_\\-]", "") : "";
        activity.runOnUiThread(() -> {
            String script = "if(window.onNativeTaskComplete) window.onNativeTaskComplete('" + safeId + "', " + result + ");";
            webView.evaluateJavascript(script, null);
        });
    }


    // TCP-соединение к IPv4-адресу без DNS. Возвращает true если соединение успешно.
    private static boolean tcpConnectIp(String ip, int port, int timeoutMs) {
        try (java.net.Socket sock = new java.net.Socket()) {
            // InetAddress.getByName на IPv4-строке не делает DNS-запрос
            sock.connect(new java.net.InetSocketAddress(
                java.net.InetAddress.getByName(ip), port), timeoutMs);
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    private static boolean configHasDialerProxy(String configJson) {
        try {
            org.json.JSONArray outbounds = new org.json.JSONObject(configJson).optJSONArray("outbounds");
            if (outbounds == null) return false;
            for (int i = 0; i < outbounds.length(); i++) {
                org.json.JSONObject ob = outbounds.optJSONObject(i);
                if (ob == null) continue;
                org.json.JSONObject ss = ob.optJSONObject("streamSettings");
                if (ss == null) continue;
                org.json.JSONObject so = ss.optJSONObject("sockopt");
                if (so != null && !so.optString("dialerProxy", "").isEmpty()) return true;
            }
        } catch (Throwable ignored) {}
        return false;
    }
}
