package com.simproxy.app;

import android.util.Log;
import org.json.JSONObject;
import java.io.BufferedInputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Random;

/**
 * SpeedTestService — измеряет скорость интернета (Download, Upload, Ping) через VPN.
 */
public class SpeedTestService {
    private static final String TAG = "SpeedTest";
    private static SpeedTestService instance;
    private volatile boolean testRunning = false;

    private SpeedTestService() {}

    public static synchronized SpeedTestService getInstance() {
        if (instance == null) {
            instance = new SpeedTestService();
        }
        return instance;
    }

    public void startSpeedTestAsync(SpeedTestCallback callback) {
        if (testRunning) {
            callback.onError("Тест уже запущен");
            return;
        }

        new Thread(() -> {
            try {
                testRunning = true;
                double ping = measurePing("8.8.8.8");
                double download = performDownloadTest();
                double upload = performUploadTest();

                JSONObject result = new JSONObject();
                result.put("download", download);
                result.put("upload", upload);
                result.put("ping", ping);
                result.put("timestamp", System.currentTimeMillis());

                callback.onResult(result.toString());
            } catch (Exception e) {
                Log.e(TAG, "Speed test failed", e);
                callback.onError(e.getMessage());
            } finally {
                testRunning = false;
            }
        }).start();
    }

    private double measurePing(String host) {
        // isReachable() использует ICMP/TCP-7 — не работает через VPN-туннель.
        // Используем TCP connect на порт 443 вместо этого.
        try {
            long start = System.currentTimeMillis();
            try (java.net.Socket socket = new java.net.Socket()) {
                socket.connect(new java.net.InetSocketAddress(host, 443), 3000);
                return (double) (System.currentTimeMillis() - start);
            }
        } catch (Exception e) {
            Log.e(TAG, "Ping failed", e);
        }
        return 0;
    }

    private double performDownloadTest() throws Exception {
        long startTime = System.currentTimeMillis();
        long bytesDownloaded = 0;
        String testUrl = "https://speed.cloudflare.com/__down?bytes=5242880"; // 5MB

        HttpURLConnection conn = null;
        try {
            URL url = new URL(testUrl);
            conn = (HttpURLConnection) url.openConnection();
            conn.setConnectTimeout(5000);
            conn.setReadTimeout(15000);

            if (conn.getResponseCode() == 200) {
                try (InputStream is = new BufferedInputStream(conn.getInputStream())) {
                    byte[] buffer = new byte[16384];
                    int len;
                    while ((len = is.read(buffer)) > 0 && testRunning) {
                        bytesDownloaded += len;
                        if (System.currentTimeMillis() - startTime > 10000) break;
                    }
                }
            }
        } finally {
            if (conn != null) conn.disconnect();
        }
        long duration = Math.max(System.currentTimeMillis() - startTime, 1);
        return (bytesDownloaded * 8.0 / 1000.0) / (duration / 1000.0); // Kbps
    }

    private double performUploadTest() throws Exception {
        long startTime = System.currentTimeMillis();
        long bytesUploaded = 0;
        // Cloudflare speed test endpoint — same provider as download test, no third-party dependency
        String testUrl = "https://speed.cloudflare.com/__up";

        HttpURLConnection conn = null;
        try {
            URL url = new URL(testUrl);
            conn = (HttpURLConnection) url.openConnection();
            conn.setDoOutput(true);
            conn.setRequestMethod("POST");
            conn.setRequestProperty("Content-Type", "application/octet-stream");
            conn.setChunkedStreamingMode(16384);
            conn.setConnectTimeout(5000);
            conn.setReadTimeout(15000);

            byte[] data = new byte[16384];
            new Random().nextBytes(data);

            try (OutputStream os = conn.getOutputStream()) {
                while (testRunning && (System.currentTimeMillis() - startTime < 8000)) {
                    os.write(data);
                    bytesUploaded += data.length;
                    if (bytesUploaded > 2_000_000) break; // 2 MB cap
                }
            }
            conn.getResponseCode(); // drain response
        } finally {
            if (conn != null) conn.disconnect();
        }
        long duration = Math.max(System.currentTimeMillis() - startTime, 1);
        return (bytesUploaded * 8.0 / 1000.0) / (duration / 1000.0); // Kbps
    }

    public void stopSpeedTest() {
        testRunning = false;
    }

    public interface SpeedTestCallback {
        void onResult(String result);
        void onError(String error);
    }
}

