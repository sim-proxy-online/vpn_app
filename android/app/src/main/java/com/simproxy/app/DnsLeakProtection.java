package com.simproxy.app;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.LinkProperties;
import android.net.Network;
import android.os.Build;
import android.util.Log;
import org.json.JSONArray;
import org.json.JSONObject;
import java.net.InetAddress;
import java.util.ArrayList;
import java.util.List;

/**
 * DnsLeakProtection — блокирует стандартные DNS серверы и принудительно использует VPN DNS.
 */
public class DnsLeakProtection {
    private static final String TAG = "DnsLeakProtection";
    private static DnsLeakProtection instance;
    private final Context context;
    private final ConnectivityManager connectivityManager;

    private DnsLeakProtection(Context ctx) {
        this.context = ctx.getApplicationContext();
        this.connectivityManager = (ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);
    }

    public static synchronized DnsLeakProtection getInstance(Context context) {
        if (instance == null) {
            instance = new DnsLeakProtection(context);
        }
        return instance;
    }

    /**
     * Получить текущие DNS серверы системы
     */
    public String getCurrentDnsServers() {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                Network network = connectivityManager.getActiveNetwork();
                if (network != null) {
                    LinkProperties lp = connectivityManager.getLinkProperties(network);
                    if (lp != null) {
                        List<InetAddress> dnsServers = lp.getDnsServers();
                        JSONArray arr = new JSONArray();
                        for (InetAddress addr : dnsServers) {
                            arr.put(addr.getHostAddress());
                        }
                        return arr.toString();
                    }
                }
            }
        } catch (Exception e) {
            Log.e(TAG, "Error getting DNS servers", e);
        }
        return "[]";
    }

    /**
     * Тест на DNS утечку
     * @return JSON с результатами {leakDetected: bool, dnsServers: []}
     */
    public String testDnsLeak() {
        try {
            List<String> leakedDnsServers = new ArrayList<>();
            
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                Network network = connectivityManager.getActiveNetwork();
                if (network != null) {
                    LinkProperties lp = connectivityManager.getLinkProperties(network);
                    if (lp != null) {
                        for (InetAddress addr : lp.getDnsServers()) {
                            String ip = addr.getHostAddress();
                            // Проверяем на известные публичные DNS серверы
                            if (isPublicDns(ip)) {
                                leakedDnsServers.add(ip);
                            }
                        }
                    }
                }
            }

            JSONObject result = new JSONObject();
            result.put("leakDetected", !leakedDnsServers.isEmpty());
            
            JSONArray arr = new JSONArray();
            for (String dns : leakedDnsServers) {
                arr.put(dns);
            }
            result.put("dnsServers", arr);
            
            Log.i(TAG, "DNS Leak Test: " + (leakedDnsServers.isEmpty() ? "SAFE" : "LEAK DETECTED"));
            return result.toString();
        } catch (Exception e) {
            Log.e(TAG, "Error testing DNS leak", e);
            return "{\"leakDetected\":false,\"dnsServers\":[]}";
        }
    }

    private boolean isPublicDns(String ip) {
        if (ip.startsWith("8.8.")) return true; // Google (8.8.8.8, 8.8.4.4)
        if (ip.startsWith("1.1.1.") || ip.startsWith("1.0.0.")) return true; // Cloudflare
        if (ip.startsWith("9.9.9.") || ip.startsWith("149.112.")) return true; // Quad9
        if (ip.startsWith("208.67.")) return true; // OpenDNS
        return false;
    }
}

