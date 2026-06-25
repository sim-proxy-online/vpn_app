package com.simproxy.app;

import android.util.Log;
import java.net.Socket;
import java.net.InetSocketAddress;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicReference;

/**
 * ConnectionQualityMonitor — отслеживает качество VPN соединения.
 * Измеряет пинг, потери пакетов, стабильность соединения.
 */
public class ConnectionQualityMonitor {
    private static final String TAG = "QualityMonitor";
    private static volatile ConnectionQualityMonitor instance;
    private final List<PingResult> pingHistory = new ArrayList<>();
    private final AtomicReference<ConnectionQuality> currentQuality = new AtomicReference<>(new ConnectionQuality());
    private static final int MAX_HISTORY = 60; // Keep last 60 pings
    private static final int PING_TEST_TIMEOUT = 5000; // 5 seconds

    public static class PingResult {
        public long latency; // ms
        public long timestamp;
        public boolean success;

        public PingResult(long latency, boolean success) {
            this.latency = latency;
            this.success = success;
            this.timestamp = System.currentTimeMillis();
        }
    }

    public static class ConnectionQuality {
        public double avgLatency = 0;
        public double minLatency = 0;
        public double maxLatency = 0;
        public double packetLoss = 0; // 0-100%
        public String quality = "UNKNOWN"; // EXCELLENT, GOOD, FAIR, POOR, DISCONNECTED
        public long stableTime = 0; // seconds
        public long measureTime = 0; // last measurement time

        public ConnectionQuality() {}
    }

    private ConnectionQualityMonitor() {}

    public static ConnectionQualityMonitor getInstance() {
        if (instance == null) {
            synchronized (ConnectionQualityMonitor.class) {
                if (instance == null) {
                    instance = new ConnectionQualityMonitor();
                }
            }
        }
        return instance;
    }

    /**
     * Измеряет пинг к серверу
     */
    public long measurePing(String testServer, int testPort) {
        long startTime = System.currentTimeMillis();
        try (Socket socket = new Socket()) {
            socket.setSoTimeout(PING_TEST_TIMEOUT);
            socket.connect(new InetSocketAddress(testServer, testPort), PING_TEST_TIMEOUT);
            long latency = System.currentTimeMillis() - startTime;

            PingResult result = new PingResult(latency, true);
            addPingResult(result);

            Log.d(TAG, "Ping to " + testServer + ":" + testPort + " = " + latency + "ms");
            return latency;
        } catch (Exception e) {
            long latency = System.currentTimeMillis() - startTime;
            PingResult result = new PingResult(latency, false);
            addPingResult(result);

            Log.w(TAG, "Ping failed: " + e.getMessage());
            return -1;
        }
    }

    /**
     * Добавляет результат пинга в историю
     */
    private synchronized void addPingResult(PingResult result) {
        pingHistory.add(result);
        if (pingHistory.size() > MAX_HISTORY) {
            pingHistory.remove(0);
        }
        calculateQuality();
    }

    /**
     * Вычисляет текущее качество соединения
     */
    private synchronized void calculateQuality() {
        if (pingHistory.isEmpty()) {
            currentQuality.set(new ConnectionQuality());
            return;
        }

        ConnectionQuality quality = new ConnectionQuality();

        // Calculate statistics
        long totalLatency = 0;
        long minLatency = Long.MAX_VALUE;
        long maxLatency = 0;
        int successCount = 0;

        for (PingResult result : pingHistory) {
            if (result.success) {
                successCount++;
                totalLatency += result.latency;
                minLatency = Math.min(minLatency, result.latency);
                maxLatency = Math.max(maxLatency, result.latency);
            }
        }

        quality.packetLoss = ((double)(pingHistory.size() - successCount) / pingHistory.size()) * 100;
        quality.avgLatency = successCount > 0 ? (double)totalLatency / successCount : 0;
        quality.minLatency = minLatency == Long.MAX_VALUE ? 0 : minLatency;
        quality.maxLatency = maxLatency;
        quality.measureTime = System.currentTimeMillis();

        // Determine quality level
        if (successCount == 0) {
            quality.quality = "DISCONNECTED";
        } else if (quality.packetLoss > 20 || quality.avgLatency > 300) {
            quality.quality = "POOR";
        } else if (quality.packetLoss > 5 || quality.avgLatency > 150) {
            quality.quality = "FAIR";
        } else if (quality.avgLatency > 75) {
            quality.quality = "GOOD";
        } else {
            quality.quality = "EXCELLENT";
        }

        currentQuality.set(quality);
        Log.i(TAG, "Quality: " + quality.quality + " | Latency: " + quality.avgLatency + "ms | Loss: " + quality.packetLoss + "%");
    }

    /**
     * Получает текущее качество соединения
     */
    public ConnectionQuality getQuality() {
        return currentQuality.get();
    }

    /**
     * Получает историю пингов
     */
    public synchronized List<PingResult> getPingHistory() {
        return new ArrayList<>(pingHistory);
    }

    /**
     * Очищает историю
     */
    public synchronized void clearHistory() {
        pingHistory.clear();
        currentQuality.set(new ConnectionQuality());
    }

    /**
     * Получает оценку качества в процентах (0-100)
     */
    public int getQualityScore() {
        ConnectionQuality q = currentQuality.get();
        if (q.quality.equals("DISCONNECTED")) return 0;
        if (q.quality.equals("POOR")) return 25;
        if (q.quality.equals("FAIR")) return 50;
        if (q.quality.equals("GOOD")) return 75;
        return 100; // EXCELLENT
    }
}

