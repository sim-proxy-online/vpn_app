package com.simproxy.app;

import android.util.Log;
import java.io.File;
import java.io.FileOutputStream;
import libxray.Libxray;
import libxray.XRayPoint;
import android.content.Context;
import go.Seq;

public class XrayManager {
    private static final String TAG = "XrayManager";
    private static volatile boolean isNativeBooted = false;

    private volatile XRayPoint xrayPoint = null;
    private volatile boolean isRunning = false;
    private volatile Thread xrayThread = null;
    // Фактический SOCKS-порт работающего боевого ядра (из конфига, не хардкод).
    // Нужен пингу: он ходит GET'ом через живой SOCKS, который уже прошёл белый список.
    private volatile int liveSocksPort = 0;
    // Инкрементируется при каждом start(). stopIfEpoch() пропустит stop, если
    // epoch уже сменился (т.е. новый start() уже запущен).
    private volatile int xrayEpoch = 0;

    public int getSocksPort() { return liveSocksPort; }
    public int getXrayEpoch() { return xrayEpoch; }

    private void extractAssets(Context context, String datPath) {
        String[] files = {"geoip.dat", "geosite.dat"};
        for (String f : files) {
            File target = new File(datPath, f);
            if (target.exists() && target.length() > 1024) continue;
            try (java.io.InputStream in = context.getAssets().open(f);
                 FileOutputStream out = new FileOutputStream(target)) {
                byte[] buf = new byte[65536];
                int r; while ((r = in.read(buf)) != -1) out.write(buf, 0, r);
                Log.i(TAG, "Asset synced: " + f);
            } catch (Exception e) {
                Log.e(TAG, "Asset error: " + f, e);
            }
        }
    }

    public synchronized void boot(Context context, String datPath) throws Exception {
        if (isNativeBooted) return;
        try {
            File logsDir = new File(datPath, "logs");
            if (!logsDir.exists()) logsDir.mkdirs();

            extractAssets(context, datPath);

            // Инициализация через Gomobile (Seq) — выполняется один раз
            Seq.setContext(context.getApplicationContext());
            Libxray.initXEnv(datPath, "simproxy_default_id");
            
            isNativeBooted = true;
            Log.i(TAG, "Native Core System Boot Success");
        } catch (Throwable t) {
            Log.e(TAG, "Native Core System Boot FAIL", t);
            throw new Exception("Core init failed: " + t.getMessage());
        }
    }

    public synchronized int start(Context context, String datPath, String config, int tunFd, boolean localOnly) throws Exception {
        boot(context, datPath);

        xrayEpoch++; // новый запуск — epoch меняется, старый stopIfEpoch будет проигнорирован
        int socksPort = parseSocksPort(config);
        this.liveSocksPort = socksPort;

        if (xrayPoint != null) {
            try { xrayPoint.coreStopLoop(); } catch (Throwable ignored) {}
            xrayPoint = null;
        }

        // СМЕНА СЕРВЕРА В ОДНОМ ПРОЦЕССЕ: дождаться, пока предыдущее ядро полностью
        // освободит ресурсы (SOCKS-порт, netstack, goroutines observatory/balancer).
        // Иначе новое ядро поднимает socks-инбаунд, но outbound'ы не работают
        // (приходилось полностью перезапускать приложение). Порт держит старое ядро —
        // ждём его закрытия, затем небольшая пауза на доумирание goroutine.
        if (waitForPortClosed(socksPort, 9000)) {
            try { Thread.sleep(600); } catch (InterruptedException ignored) {}
        } else {
            Log.w(TAG, "Previous core did not release SOCKS " + socksPort + " in time");
        }

        try {
            xrayPoint = Libxray.newXRayPoint(SimApplication.staticSupportSet, true);
        } catch (Throwable t) {
            throw new Exception("newXRayPoint failed: " + t.getMessage());
        }

        final String finalConfig = config;
        final int finalFd = tunFd;
        final libxray.XRayPoint point = xrayPoint;

        isRunning = false;
        Thread t = new Thread(() -> {
            try {
                if (finalFd > 0) {
                    Log.i(TAG, "Core RunLoop Start (NATIVE TUN MODE)");
                    point.coreRunLoopWithTun(finalConfig, finalFd);
                } else {
                    Log.i(TAG, "Core RunLoop Start (LOCAL SOCKS)");
                    point.coreRunLoop(finalConfig);
                }
                // ВНИМАНИЕ: в этом форке libxray coreRunLoop* НЕ блокирует —
                // возвращается сразу после инициализации, ядро живёт нативно.
                // Поэтому здесь НЕ трогаем isRunning (готовность определит проверка порта в start()).
                Log.i(TAG, "Core RunLoop call returned (core runs natively)");
            } catch (Throwable ex) {
                Log.e(TAG, "Core RunLoop Error", ex);
                isRunning = false;
            }
        }, "XrayCore");
        xrayThread = t;
        t.start();

        // Честная готовность: ядро реально поднялось только когда открылся SOCKS-порт.
        // Переносим проверку в вызывающий код или выполняем ее здесь, но БЕЗ
        // удержания глобального лока на 12 секунд, чтобы не блокировать пинги.
        return socksPort;
    }

    public boolean waitForReady(int socksPort) {
        boolean ready = waitForSocksPort(socksPort, 12000);
        isRunning = ready;
        Log.i(TAG, ready
            ? ("Core ready: SOCKS 127.0.0.1:" + socksPort + " open")
            : ("Core FAILED: SOCKS 127.0.0.1:" + socksPort + " not open in 12s"));
        return ready;
    }

    private int parseSocksPort(String config) {
        try {
            org.json.JSONObject obj = new org.json.JSONObject(config);
            org.json.JSONArray ins = obj.optJSONArray("inbounds");
            if (ins != null) {
                for (int i = 0; i < ins.length(); i++) {
                    org.json.JSONObject in = ins.optJSONObject(i);
                    if (in != null && "socks".equals(in.optString("protocol"))) {
                        int p = in.optInt("port", 0);
                        if (p > 0) return p;
                    }
                }
            }
        } catch (Throwable ignored) {}
        return 10808;
    }

    private boolean waitForSocksPort(int port, int timeoutMs) {
        long deadline = System.currentTimeMillis() + timeoutMs;
        while (System.currentTimeMillis() < deadline) {
            try (java.net.Socket s = new java.net.Socket()) {
                s.connect(new java.net.InetSocketAddress("127.0.0.1", port), 500);
                return true;
            } catch (Throwable ignored) {}
            // НЕ выходим по завершению потока: coreRunLoop* в этом форке возвращается
            // сразу, ядро живёт нативно. Готовность определяем только по открытию порта.
            try { Thread.sleep(200); } catch (InterruptedException ie) { return false; }
        }
        return false;
    }

    // Ждём, пока SOCKS-порт ПЕРЕСТАНЕТ слушаться (предыдущее ядро освободило ресурсы).
    // true — порт закрыт (можно стартовать новое ядро); false — таймаут (порт всё ещё занят).
    private boolean waitForPortClosed(int port, int timeoutMs) {
        long deadline = System.currentTimeMillis() + timeoutMs;
        while (System.currentTimeMillis() < deadline) {
            boolean open;
            try (java.net.Socket s = new java.net.Socket()) {
                s.connect(new java.net.InetSocketAddress("127.0.0.1", port), 300);
                open = true;
            } catch (Throwable t) {
                open = false;
            }
            if (!open) return true;
            try { Thread.sleep(200); } catch (InterruptedException ie) { return false; }
        }
        return false;
    }

    public synchronized void stop() {
        isRunning = false;
        if (xrayPoint != null) {
            try { xrayPoint.coreStopLoop(); } catch (Throwable ignored) {}
            xrayPoint = null;
        }
    }

    // Останавливает ядро только если epoch совпадает с targetEpoch.
    // Предотвращает убийство нового Xray из stopVpnGraceful после того,
    // как startVpn уже вызвал start() (epoch сменился).
    public synchronized void stopIfEpoch(int targetEpoch) {
        if (xrayEpoch != targetEpoch) {
            Log.i(TAG, "stopIfEpoch: epoch mismatch (target=" + targetEpoch + " current=" + xrayEpoch + "), skip");
            return;
        }
        stop();
    }

    public boolean isRunning() { return isRunning; }
    public String getLogs() {
        StringBuilder sb = new StringBuilder();
        for (String line : SimApplication.globalLogs) sb.append(line).append("\n");
        return sb.toString();
    }
}
