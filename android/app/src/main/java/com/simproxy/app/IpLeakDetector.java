package com.simproxy.app;

import android.util.Log;
import org.json.JSONObject;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.InetSocketAddress;
import java.net.Proxy;
import java.net.URL;

/**
 * IpLeakDetector — проверяет, что интернет видит адрес сервера, а не ваш настоящий адрес.
 *
 * Приложение исключено из VPN (иначе его собственный трафик зациклился бы), поэтому прямой запрос из него
 * показывает НАСТОЯЩИЙ адрес, а запрос через живой SOCKS-прокси — адрес выхода туннеля. Утечкой считаем только
 * случай, когда известны оба адреса и они совпадают: туннель адрес не меняет.
 *
 * Если узнать один из двух не удалось (оператор не пускает напрямую к сервисам определения адреса — например,
 * при белых списках, туннель ещё не поднялся, сеть моргнула), результат «не удалось проверить»: это НЕ утечка.
 * Раньше любая неудача объявлялась утечкой, и приложение каждый раз пугало уведомлением «Обнаружена утечка».
 */
public class IpLeakDetector {
    private static final String TAG = "IpLeakDetector";
    private static final int LIVE_SOCKS_PORT = 10808;
    private static final String IP_PATTERN = "^[0-9a-fA-F:.]{2,45}$";
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
     * Синхронный тест IP утечки. Результат — JSON: ipAddress и country (как их видит интернет СКВОЗЬ туннель),
     * hasLeak (true только при уверенном совпадении адресов), inconclusive + error, если проверить не удалось.
     */
    public String testIpLeak() {
        try {
            String[] tunnel = tunnelIpAndCountry();
            String direct = tunnel[0].isEmpty() ? "" : directIp();

            JSONObject result = new JSONObject();
            result.put("ipAddress", tunnel[0]);
            result.put("country", tunnel[1].isEmpty() ? "XX" : tunnel[1]);
            result.put("timestamp", System.currentTimeMillis());
            if (tunnel[0].isEmpty()) {
                result.put("hasLeak", false);
                result.put("inconclusive", true);
                result.put("error", "tunnel_unreachable");
            } else if (direct.isEmpty()) {
                result.put("hasLeak", false);
                result.put("inconclusive", true);
                result.put("error", "direct_unreachable");
            } else {
                result.put("hasLeak", direct.equals(tunnel[0]));
            }
            Log.i(TAG, "IP leak test: tunnel=" + tunnel[0] + " (" + tunnel[1] + ") direct="
                    + (direct.isEmpty() ? "n/a" : "known") + " leak=" + result.optBoolean("hasLeak")
                    + (result.optBoolean("inconclusive") ? " (inconclusive: " + result.optString("error") + ")" : ""));
            return result.toString();
        } catch (Exception e) {
            Log.e(TAG, "IP leak test error", e);
            try {
                JSONObject error = new JSONObject();
                error.put("hasLeak", false);
                error.put("inconclusive", true);
                error.put("error", String.valueOf(e.getMessage()));
                error.put("timestamp", System.currentTimeMillis());
                return error.toString();
            } catch (Exception ex) {
                return "{\"hasLeak\":false,\"inconclusive\":true,\"error\":\"unknown\"}";
            }
        }
    }

    /**
     * Адрес и страна через живой SOCKS-прокси: 1.1.1.1/cdn-cgi/trace (IP-литерал, DNS не нужен) отвечает
     * строками «ip=…» и «loc=…». {"",""} — туннель не поднят или ответа нет.
     */
    private String[] tunnelIpAndCountry() {
        VpnServiceImpl svc = VpnServiceImpl.getInstance();
        if (svc == null || !svc.isRunning()) return new String[] { "", "" };
        int socks = svc.getSocksPort();
        if (socks <= 0) socks = LIVE_SOCKS_PORT;
        Proxy proxy = new Proxy(Proxy.Type.SOCKS, new InetSocketAddress("127.0.0.1", socks));
        for (String target : new String[] { "https://1.1.1.1/cdn-cgi/trace", "http://1.1.1.1/cdn-cgi/trace" }) {
            HttpURLConnection conn = null;
            try {
                conn = (HttpURLConnection) new URL(target).openConnection(proxy);
                conn.setConnectTimeout(6000);
                conn.setReadTimeout(6000);
                conn.setRequestProperty("User-Agent", "SimProxy/1.0");
                if (conn.getResponseCode() != 200) continue;
                String ip = "";
                String loc = "";
                try (BufferedReader br = new BufferedReader(new InputStreamReader(conn.getInputStream(), "UTF-8"))) {
                    String line;
                    while ((line = br.readLine()) != null) {
                        if (line.startsWith("ip=")) ip = line.substring(3).trim();
                        else if (line.startsWith("loc=")) loc = line.substring(4).trim();
                    }
                }
                if (ip.matches(IP_PATTERN)) {
                    return new String[] { ip, loc.matches("^[A-Za-z]{2}$") ? loc.toUpperCase() : "" };
                }
            } catch (Exception e) {
                Log.d(TAG, "Tunnel check failed with " + target + ": " + e.getMessage());
            } finally {
                if (conn != null) conn.disconnect();
            }
        }
        return new String[] { "", "" };
    }

    /**
     * Настоящий адрес: прямой запрос из приложения (оно исключено из VPN). Пустая строка — ни один сервис
     * не ответил (например, оператор не пускает напрямую); это не утечка, а невозможность сравнить.
     */
    private String directIp() {
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
                conn.setConnectTimeout(3000);
                conn.setReadTimeout(3000);
                conn.setRequestProperty("User-Agent", "SimProxy/1.0");

                if (conn.getResponseCode() == 200) {
                    try (BufferedReader br = new BufferedReader(new InputStreamReader(conn.getInputStream()))) {
                        String line = br.readLine();
                        if (line != null && line.trim().matches(IP_PATTERN)) return line.trim();
                    }
                }
            } catch (Exception e) {
                Log.d(TAG, "Direct check failed with " + urlStr + ": " + e.getMessage());
            } finally {
                if (conn != null) conn.disconnect();
            }
        }
        return "";
    }

    public interface IpLeakCallback {
        void onResult(String result);
        void onError(String error);
    }
}
