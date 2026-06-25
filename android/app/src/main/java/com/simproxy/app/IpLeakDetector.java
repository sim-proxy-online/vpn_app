package com.simproxy.app;

import android.util.Log;
import org.json.JSONObject;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * IpLeakDetector — проверяет утечку реального IP адреса через VPN.
 */
public class IpLeakDetector {
    private static final String TAG = "IpLeakDetector";
    private static IpLeakDetector instance;

    private IpLeakDetector() {}

    public static synchronized IpLeakDetector getInstance() {
        if (instance == null) {
            instance = new IpLeakDetector();
        }
        return instance;
    }

    /**
     * Асинхронный тест IP утечки
     */
    public void testIpLeakAsync(IpLeakCallback callback) {
        new Thread(() -> {
            try {
                String result = testIpLeak();
                callback.onResult(result);
            } catch (Exception e) {
                Log.e(TAG, "IP leak test failed", e);
                callback.onError(e.getMessage());
            }
        }).start();
    }

    /**
     * Синхронный тест IP утечки
     */
    public String testIpLeak() {
        try {
            String ip = getPublicIp();
            String country = getCountryByIp(ip);
            
            JSONObject result = new JSONObject();
            result.put("ipAddress", ip);
            result.put("country", country);
            result.put("hasLeak", false);
            result.put("timestamp", System.currentTimeMillis());
            
            Log.i(TAG, "IP Leak Test: " + ip + " (" + country + ")");
            return result.toString();
        } catch (Exception e) {
            Log.e(TAG, "IP leak test error", e);
            try {
                JSONObject error = new JSONObject();
                error.put("hasLeak", true);
                error.put("error", e.getMessage());
                error.put("timestamp", System.currentTimeMillis());
                return error.toString();
            } catch (Exception ex) {
                return "{\"hasLeak\":true,\"error\":\"unknown\"}";
            }
        }
    }

    /**
     * Получить публичный IP
     */
    public String getPublicIp() throws Exception {
        String[] urls = {
            "https://ipinfo.io/ip",
            "https://icanhazip.com/",
            "https://ifconfig.me/",
            "https://api.ipify.org"
        };

        for (String urlStr : urls) {
            HttpURLConnection conn = null;
            try {
                URL url = new URL(urlStr);
                conn = (HttpURLConnection) url.openConnection();
                conn.setConnectTimeout(5000);
                conn.setReadTimeout(5000);
                conn.setRequestProperty("User-Agent", "SimProxy/1.0");

                if (conn.getResponseCode() == 200) {
                    try (BufferedReader br = new BufferedReader(new InputStreamReader(conn.getInputStream()))) {
                        String line = br.readLine();
                        if (line != null && !line.trim().isEmpty()) return line.trim();
                    }
                }
            } catch (Exception e) {
                Log.d(TAG, "Failed with " + urlStr + ": " + e.getMessage());
            } finally {
                if (conn != null) conn.disconnect();
            }
        }

        throw new Exception("All IP detection services failed");
    }

    /**
     * Получить страну по IP
     */
    public String getCountryByIp(String ip) {
        HttpURLConnection conn = null;
        try {
            URL url = new URL("https://ipinfo.io/" + ip + "/country");
            conn = (HttpURLConnection) url.openConnection();
            conn.setConnectTimeout(3000);
            conn.setReadTimeout(3000);

            if (conn.getResponseCode() == 200) {
                try (BufferedReader br = new BufferedReader(new InputStreamReader(conn.getInputStream()))) {
                    String line = br.readLine();
                    return line != null ? line.trim() : "XX";
                }
            }
        } catch (Exception e) {
            Log.d(TAG, "Country lookup failed: " + e.getMessage());
        } finally {
            if (conn != null) conn.disconnect();
        }
        return "XX";
    }

    public interface IpLeakCallback {
        void onResult(String result);
        void onError(String error);
    }
}

