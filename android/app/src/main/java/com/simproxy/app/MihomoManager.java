package com.simproxy.app;

import android.content.Context;
import android.util.Log;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStreamReader;
import java.util.ArrayList;
import java.util.List;

/**
 * Второе ядро: mihomo (Clash.Meta). Умеет протоколы, которые Xray-core не тянет —
 * hysteria/hysteria2/tuic/anytls/shadowtls. Запускается как ПОДПРОЦЕСС (CLI-бинарь),
 * а не JNI: бинарник лежит в APK как lib/<abi>/libmihomo.so и извлекается в
 * nativeLibraryDir (единственное место на Android 10+, откуда можно exec'ать).
 *
 * TUN: VpnService.Builder.establish() уже создал TUN fd и поставил маршруты.
 * Передаём этот fd ядру через `tun.device: fd://<fd>` в конфиге (плейсхолдер
 * __SIM_TUN_FD__ из JS заменяем на реальный fd). Дочерний процесс наследует
 * незакрытые не-CLOEXEC дескрипторы — поэтому fd должен оставаться открытым.
 *
 * ВНИМАНИЕ: путь требует проверки на реальном устройстве (наследование fd +
 * W^X exec). Сборка/компиляция чистая; туннель тестируется на телефоне.
 */
public class MihomoManager {
    private static final String TAG = "MihomoManager";
    private static final String BIN_NAME = "libmihomo.so";
    private static final String FD_PLACEHOLDER = "__SIM_TUN_FD__";

    private volatile Process process = null;
    private volatile boolean isRunning = false;
    private volatile int liveSocksPort = 0;
    private Thread logThread = null;
    // Incremented every time start() is called. Lets concurrent stopVpnInternal
    // callers detect that a new session started during their 1200ms tun2socks wait
    // and skip the stop() that would kill the freshly-launched mihomo.
    private final java.util.concurrent.atomic.AtomicInteger startEpoch = new java.util.concurrent.atomic.AtomicInteger(0);
    public int getStartEpoch() { return startEpoch.get(); }

    public int getSocksPort() { return liveSocksPort; }
    // Проверяем и Java-флаг, и реальный процесс: если Android убил mihomo в фоне,
    // isRunning останется true но isProcessAlive() вернёт false — watchdog это поймает.
    public boolean isRunning() { return isRunning && isProcessAlive(); }

    private final StringBuilder logBuffer = new StringBuilder();
    public String getLogs() { synchronized (logBuffer) { return logBuffer.toString(); } }
    private void appendLog(String line) {
        synchronized (logBuffer) {
            logBuffer.append(line).append('\n');
            if (logBuffer.length() > 16000) logBuffer.delete(0, logBuffer.length() - 12000);
        }
    }

    /** Полный путь к исполняемому бинарнику mihomo (извлечён из APK). */
    private File binaryFile(Context ctx) {
        String nativeDir = ctx.getApplicationInfo().nativeLibraryDir;
        return new File(nativeDir, BIN_NAME);
    }

    public boolean isAvailable(Context ctx) {
        File b = binaryFile(ctx);
        return b.exists() && b.canExecute();
    }

    public synchronized void start(Context ctx, String dataPath, String config, int tunFd) throws Exception {
        startEpoch.incrementAndGet(); // signal to concurrent stopVpnInternal callers that a new session began
        stop(); // подчистить предыдущий процесс

        File bin = binaryFile(ctx);
        if (!bin.exists()) throw new Exception("mihomo бинарник не найден: " + bin.getAbsolutePath()
            + " (нужно положить mihomo в jniLibs/<abi>/libmihomo.so)");
        if (!bin.canExecute()) { try { bin.setExecutable(true, false); } catch (Throwable ignored) {} }

        if (tunFd < 0) throw new Exception("Невалидный TUN fd для mihomo");

        // Рабочая директория ядра.
        File home = new File(dataPath, "mihomo");
        if (!home.exists()) home.mkdirs();

        // Подставляем реальный fd и парсим mixed-port для readiness-пробы.
        String finalConfig = config.replace(FD_PLACEHOLDER, String.valueOf(tunFd));
        this.liveSocksPort = parseMixedPort(finalConfig);

        File cfgFile = new File(home, "config.yaml");
        try (FileOutputStream out = new FileOutputStream(cfgFile)) {
            out.write(finalConfig.getBytes("UTF-8"));
        }

        List<String> cmd = new ArrayList<>();
        cmd.add(bin.getAbsolutePath());
        cmd.add("-d"); cmd.add(home.getAbsolutePath());
        cmd.add("-f"); cmd.add(cfgFile.getAbsolutePath());

        ProcessBuilder pb = new ProcessBuilder(cmd);
        pb.redirectErrorStream(true);
        pb.environment().put("HOME", home.getAbsolutePath());

        Log.i(TAG, "Запуск mihomo: " + bin.getAbsolutePath() + " fd=" + tunFd + " port=" + liveSocksPort);
        process = pb.start();

        // Читаем вывод ядра в лог (и чтобы пайп не переполнился).
        final Process p = process;
        logThread = new Thread(() -> {
            try (BufferedReader r = new BufferedReader(new InputStreamReader(p.getInputStream()))) {
                String line;
                while ((line = r.readLine()) != null) {
                    appendLog(line);
                    Log.i(TAG, "[mihomo] " + line);
                }
            } catch (Throwable ignored) {}
        }, "MihomoLog");
        logThread.setDaemon(true);
        logThread.start();

        // Готовность: процесс жив И mixed-port открыт.
        boolean ready = waitForPort(liveSocksPort, 12000);
        boolean alive = isProcessAlive();
        isRunning = ready && alive;
        Log.i(TAG, isRunning
            ? ("mihomo готов: 127.0.0.1:" + liveSocksPort)
            : ("mihomo НЕ поднялся (alive=" + alive + ", portOpen=" + ready + ") — см. лог [mihomo]"));
        if (!isRunning) {
            throw new Exception("mihomo не открыл порт " + liveSocksPort + " за 12с (alive=" + alive + ")");
        }
    }

    private boolean isProcessAlive() {
        Process p = process;
        if (p == null) return false;
        try { p.exitValue(); return false; } catch (IllegalThreadStateException e) { return true; }
    }

    private int parseMixedPort(String config) {
        // Конфиг — JSON (валидный YAML). Парсим как JSON.
        try {
            org.json.JSONObject obj = new org.json.JSONObject(config);
            int p = obj.optInt("mixed-port", 0);
            if (p > 0) return p;
            p = obj.optInt("socks-port", 0);
            if (p > 0) return p;
        } catch (Throwable ignored) {}
        return 10808;
    }

    private boolean waitForPort(int port, int timeoutMs) {
        long deadline = System.currentTimeMillis() + timeoutMs;
        while (System.currentTimeMillis() < deadline) {
            if (!isProcessAlive()) return false; // ядро упало — дальше ждать смысла нет
            try (java.net.Socket s = new java.net.Socket()) {
                s.connect(new java.net.InetSocketAddress("127.0.0.1", port), 500);
                return true;
            } catch (Throwable ignored) {}
            try { Thread.sleep(200); } catch (InterruptedException ie) { return false; }
        }
        return false;
    }

    public synchronized void stop() {
        isRunning = false;
        int portToRelease = liveSocksPort;
        Process p = process;
        if (p != null) {
            try { p.destroy(); } catch (Throwable ignored) {}
            try {
                if (!p.waitFor(3, java.util.concurrent.TimeUnit.SECONDS)) {
                    try { p.destroyForcibly(); } catch (Throwable ignored) {}
                }
            } catch (Throwable ignored) {}
            process = null;
        }
        if (logThread != null) { try { logThread.interrupt(); } catch (Throwable ignored) {} logThread = null; }
        // Ждём освобождения порта: если следующий start() придёт раньше,
        // он получит EADDRINUSE и упадёт с "не открыл порт за 12с".
        if (portToRelease > 0) waitForPortClosed(portToRelease, 3000);
    }

    private void waitForPortClosed(int port, int timeoutMs) {
        long deadline = System.currentTimeMillis() + timeoutMs;
        while (System.currentTimeMillis() < deadline) {
            try (java.net.Socket s = new java.net.Socket()) {
                s.connect(new java.net.InetSocketAddress("127.0.0.1", port), 200);
                // порт ещё занят — ждём
            } catch (Throwable e) {
                return; // порт освобождён
            }
            try { Thread.sleep(100); } catch (InterruptedException ie) { return; }
        }
        Log.w(TAG, "waitForPortClosed: port " + port + " still open after " + timeoutMs + "ms");
    }
}
