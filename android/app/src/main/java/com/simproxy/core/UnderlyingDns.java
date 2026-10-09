package com.simproxy.core;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.LinkProperties;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.util.Log;

import com.simproxy.simcore.Simcore;

import java.net.InetAddress;
import java.util.LinkedHashSet;
import java.util.Set;

/**
 * Передаёт в ядро DNS-серверы нижележащей (не VPN) сети: оператора или Wi-Fi.
 *
 * Go-ядру нужен собственный резолвер (на Android у него нет resolv.conf), и раньше он ходил
 * только на публичные DNS. Под «белыми списками» мобильного оператора публичные DNS закрыты,
 * а DNS оператора отвечает, поэтому интернет в туннеле появлялся с большой задержкой.
 */
public final class UnderlyingDns {
    private static final String TAG = "UnderlyingDns";
    private static volatile boolean started = false;
    private static volatile String last = "";

    private UnderlyingDns() {}

    /** Запускает слежение за сетью и сразу передаёт текущий список. Повторный вызов безопасен. */
    public static synchronized void start(Context context) {
        if (started) return;
        try {
            final ConnectivityManager cm =
                    (ConnectivityManager) context.getApplicationContext()
                            .getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm == null) return;
            refresh(cm);
            ConnectivityManager.NetworkCallback cb = new ConnectivityManager.NetworkCallback() {
                @Override public void onAvailable(Network n) { refresh(cm); }
                @Override public void onLost(Network n) { refresh(cm); }
                @Override public void onLinkPropertiesChanged(Network n, LinkProperties lp) { refresh(cm); }
                @Override public void onCapabilitiesChanged(Network n, NetworkCapabilities c) { refresh(cm); }
            };
            cm.registerNetworkCallback(
                    new NetworkRequest.Builder()
                            .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                            .addCapability(NetworkCapabilities.NET_CAPABILITY_NOT_VPN)
                            .build(),
                    cb);
            started = true;
        } catch (Throwable t) {
            Log.w(TAG, "start: " + t);
        }
    }

    private static void refresh(ConnectivityManager cm) {
        try {
            // Сначала проверенные (VALIDATED) сети: под белыми списками это обычно мобильная.
            Set<String> validated = new LinkedHashSet<>();
            Set<String> other = new LinkedHashSet<>();
            for (Network n : cm.getAllNetworks()) {
                NetworkCapabilities c = cm.getNetworkCapabilities(n);
                if (c == null) continue;
                if (c.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) continue;
                if (!c.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)) continue;
                LinkProperties lp = cm.getLinkProperties(n);
                if (lp == null) continue;
                Set<String> target = c.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
                        ? validated : other;
                for (InetAddress a : lp.getDnsServers()) {
                    String h = a.getHostAddress();
                    if (h != null && !h.isEmpty()) target.add(h);
                }
            }
            validated.addAll(other);
            String csv = String.join(",", validated);
            if (!csv.equals(last)) {
                last = csv;
                Simcore.setSystemDNS(csv);
                Log.i(TAG, "DNS нижележащей сети: " + (csv.isEmpty() ? "(нет)" : csv));
            }
        } catch (Throwable t) {
            Log.w(TAG, "refresh: " + t);
        }
    }
}
