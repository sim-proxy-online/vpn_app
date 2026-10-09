package com.simproxy.app;

import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.util.Log;

/**
 * AntiFilterManager — централизованный API для управления AntiFilterService.
 *
 * Предоставляет:
 * - Запуск/остановка AntiFilterService
 * - Проверку статуса и параметров
 * - Обработку ошибок и восстановление
 *
 * Использование:
 *   AntiFilterManager manager = AntiFilterManager.getInstance(context);
 *   manager.startService();
 *   boolean running = manager.isRunning();
 *   int port = manager.getSocksPort();
 */
public class AntiFilterManager {
    private static final String TAG = "AntiFilterManager";
    private static volatile AntiFilterManager instance = null;
    private final Context context;

    private AntiFilterManager(Context context) {
        this.context = context.getApplicationContext();
    }

    /**
     * Получить singleton экземпляр AntiFilterManager.
     */
    public static AntiFilterManager getInstance(Context context) {
        if (instance == null) {
            synchronized (AntiFilterManager.class) {
                if (instance == null) {
                    instance = new AntiFilterManager(context);
                }
            }
        }
        return instance;
    }

    /**
     * Запустить AntiFilterService.
     */
    public void startService() {
        try {
            AntiFilterService.markStarting(); // Сбросить флаг userStopped
            Intent intent = new Intent(context, AntiFilterService.class);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent);
            } else {
                context.startService(intent);
            }
            Log.i(TAG, "AntiFilterService start requested");
        } catch (Exception e) {
            Log.e(TAG, "Failed to start AntiFilterService: " + e.getMessage(), e);
            throw new RuntimeException("Cannot start AntiFilterService", e);
        }
    }

    /**
     * Остановить AntiFilterService.
     */
    public void stopService() {
        try {
            AntiFilterService.markUserStopped();
            Intent intent = new Intent(context, AntiFilterService.class);
            context.stopService(intent);
            Log.i(TAG, "AntiFilterService stop requested");
        } catch (Exception e) {
            Log.w(TAG, "Failed to stop AntiFilterService: " + e.getMessage());
        }
    }

    /**
     * Перезапустить AntiFilterService (остановить и снова запустить).
     */
    public void restartService() {
        Log.i(TAG, "Restarting AntiFilterService");
        stopService();
        try {
            Thread.sleep(500); // Задержка для полной остановки
        } catch (InterruptedException ignored) {}
        startService();
    }

    /**
     * Проверить запущен ли AntiFilterService.
     */
    public boolean isRunning() {
        return AntiFilterService.isServiceRunning();
    }

    /**
     * Получить текущий SOCKS-порт.
     */
    public int getSocksPort() {
        return AntiFilterService.getActiveSocksPort();
    }

    /**
     * Получить адрес SOCKS-прокси (localhost:port).
     */
    public String getSocksAddress() {
        int port = getSocksPort();
        return port > 0 ? "127.0.0.1:" + port : null;
    }

    /**
     * Проверить доступен ли SOCKS-прокси.
     */
    public boolean isSocksAccessible() {
        return isPortAccessible("127.0.0.1", getSocksPort(), 3000);
    }

    /**
     * Получить статус AntiFilterService в виде объекта.
     */
    public AntiFilterStatus getStatus() {
        return new AntiFilterStatus(
            isRunning(),
            getSocksPort(),
            isSocksAccessible(),
            AntiFilterService.getInstance() != null ? 
                AntiFilterService.getInstance().lastPingSuccess : false
        );
    }

    /**
     * Простая проверка доступности порта (с timeout).
     */
    private boolean isPortAccessible(String host, int port, long timeoutMs) {
        if (port <= 0) return false;
        try (java.net.Socket socket = new java.net.Socket()) {
            socket.connect(new java.net.InetSocketAddress(host, port), (int) timeoutMs);
            return true;
        } catch (Exception e) {
            Log.d(TAG, "Port " + port + " not accessible: " + e.getMessage());
            return false;
        }
    }

    /**
     * Инструмент отладки — получить подробный лог состояния.
     */
    public String getDebugStatus() {
        AntiFilterService service = AntiFilterService.getInstance();
        return "AntiFilterManager Status:\n" +
            "  Running: " + isRunning() + "\n" +
            "  SOCKS Port: " + getSocksPort() + "\n" +
            "  SOCKS Accessible: " + isSocksAccessible() + "\n" +
            (service != null ? "  Last Ping Success: " + service.lastPingSuccess + "\n" : "") +
            (service != null ? "  Last Ping Time: " + service.lastPingTime + "\n" : "") +
            "  VPN Running: " + (VpnServiceImpl.getInstance() != null ? 
                VpnServiceImpl.getInstance().isRunning() : "N/A") + "\n" +
            "  Active Proxy Endpoint: " + VpnServiceImpl.getActiveProxyEndpoint() + "\n";
    }

    /**
     * Класс для передачи статуса.
     */
    public static class AntiFilterStatus {
        public final boolean running;
        public final int socksPort;
        public final boolean socksAccessible;
        public final boolean lastPingSuccess;

        public AntiFilterStatus(boolean running, int socksPort, 
                              boolean socksAccessible, boolean lastPingSuccess) {
            this.running = running;
            this.socksPort = socksPort;
            this.socksAccessible = socksAccessible;
            this.lastPingSuccess = lastPingSuccess;
        }

        @Override
        public String toString() {
            return "AntiFilterStatus{" +
                "running=" + running +
                ", socksPort=" + socksPort +
                ", socksAccessible=" + socksAccessible +
                ", lastPingSuccess=" + lastPingSuccess +
                '}';
        }
    }

    /**
     * Callback для мониторинга изменений статуса AntiFilterService.
     */
    public interface AntiFilterStatusListener {
        void onStatusChanged(AntiFilterStatus status);
    }
}
