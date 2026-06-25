package com.simproxy.app;

import android.net.VpnService;
import android.os.ParcelFileDescriptor;
import android.util.Log;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.Socket;

/**
 * Управляет TUN интерфейсом для перенаправления трафика в SOCKS прокси.
 * Работает как fallback когда libtun2socks недоступна.
 */
public class TunManager {
    private static final String TAG = "TunManager";

    private ParcelFileDescriptor tunFd;
    private String socksHost;
    private int socksPort;
    private volatile boolean isRunning = false;
    private Thread tunThread;

    public TunManager(ParcelFileDescriptor tunFd, String socksHost, int socksPort) {
        this.tunFd = tunFd;
        this.socksHost = socksHost;
        this.socksPort = socksPort;
    }

    /**
     * Запускает управление TUN интерфейсом
     * Используется как fallback когда libtun2socks не доступна
     */
    public void start() {
        if (isRunning) return;

        isRunning = true;
        tunThread = new Thread(() -> {
            try {
                monitorTunInterface();
            } catch (IOException e) {
                Log.e(TAG, "TUN monitor error: " + e.getMessage());
            }
        });
        tunThread.setName("TunManager");
        tunThread.start();
        Log.i(TAG, "TUN manager started (fallback mode)");
    }

    /**
     * Останавливает управление TUN интерфейсом
     */
    public void stop() {
        isRunning = false;
        if (tunThread != null) {
            try {
                tunThread.join(1000);
            } catch (InterruptedException ignored) {}
        }
        Log.i(TAG, "TUN manager stopped");
    }

    /**
     * Мониторит TUN интерфейс и перенаправляет трафик
     * Это примерная реализация - полная требует обработки пакетов
     */
    private void monitorTunInterface() throws IOException {
        Log.d(TAG, "Starting TUN monitoring on " + socksHost + ":" + socksPort);

        // В реальной реализации здесь нужно:
        // 1. Читать пакеты из TUN интерфейса (через ParcelFileDescriptor)
        // 2. Парсить IP/TCP/UDP заголовки
        // 3. Перенаправлять через SOCKS в прокси
        // 4. Обратно писать ответы в TUN

        // Пока просто мониторим что TUN активен
        while (isRunning) {
            try {
                if (tunFd == null) {
                    Log.e(TAG, "TUN interface became invalid");
                    break;
                }
                try {
                    tunFd.getFd();
                } catch (IllegalStateException e) {
                    Log.e(TAG, "TUN interface became invalid");
                    break;
                }
                Thread.sleep(5000);
            } catch (InterruptedException e) {
                break;
            }
        }
    }

    /**
     * Проверяет доступность SOCKS сервера
     */
    public boolean verifySocksServer() {
        try (Socket socket = new Socket()) {
            socket.connect(new InetSocketAddress(socksHost, socksPort), 3000);
            Log.i(TAG, "SOCKS server verified at " + socksHost + ":" + socksPort);
            return true;
        } catch (IOException e) {
            Log.e(TAG, "SOCKS server not reachable: " + e.getMessage());
            return false;
        }
    }

    /**
     * Проверяет валидность TUN интерфейса
     */
    public boolean isValid() {
        if (tunFd == null || !isRunning) return false;
        try {
            tunFd.getFd();
            return true;
        } catch (IllegalStateException e) {
            return false;
        }
    }
}

