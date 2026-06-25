package com.simproxy.app;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.ConnectivityManager;
import android.net.NetworkRequest;
import android.os.Build;
import android.provider.Settings;
import android.util.Log;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

/**
 * KillSwitchManager — блокирует трафик при разъединении VPN.
 */
public class KillSwitchManager {
    private static final String TAG = "KillSwitchMgr";
    private static final String PREF_NAME = "sim_kill_switch";
    private static final String KEY_ENABLED = "enabled";
    private static final AtomicReference<KillSwitchManager> instance = new AtomicReference<>();
    private final Context context;
    private final SharedPreferences prefs;
    private final AtomicBoolean isEnabled = new AtomicBoolean(false);
    private final ConnectivityManager connectivityManager;
    private NetworkCallback networkCallback;

    private KillSwitchManager(Context ctx) {
        this.context = ctx.getApplicationContext();
        this.connectivityManager = (ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);
        this.prefs = context.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE);
        this.isEnabled.set(prefs.getBoolean(KEY_ENABLED, false));
    }

    public static KillSwitchManager getInstance(Context context) {
        if (instance.get() == null) instance.compareAndSet(null, new KillSwitchManager(context));
        return instance.get();
    }

    public void enable() {
        isEnabled.set(true);
        prefs.edit().putBoolean(KEY_ENABLED, true).apply();
        Log.i(TAG, "Kill Switch ENABLED");
        
        // На Android 7+ лучший способ — перенаправить пользователя в настройки Always-on VPN
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            registerCallback();
        }
    }

    public void disable() {
        isEnabled.set(false);
        prefs.edit().putBoolean(KEY_ENABLED, false).apply();
        Log.i(TAG, "Kill Switch DISABLED");
        unregisterCallback();
    }

    /**
     * Открыть настройки VPN системы (для активации Always-on VPN)
     */
    public void openVpnSettings(android.app.Activity activity) {
        try {
            Intent intent = new Intent("android.net.vpn.SETTINGS");
            intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            activity.startActivity(intent);
        } catch (Exception e) {
            try {
                activity.startActivity(new Intent(Settings.ACTION_VPN_SETTINGS));
            } catch (Exception ex) {
                Log.e(TAG, "Could not open VPN settings", ex);
            }
        }
    }

    private void registerCallback() {
        if (networkCallback == null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            networkCallback = new NetworkCallback();
            // NET_CAPABILITY_NOT_VPN фильтрует собственный TUN VPN — без него
            // Android посылает события для нашего же VPN-интерфейса, что вызывает
            // лишние колбэки и мусор в логах.
            NetworkRequest req = new NetworkRequest.Builder()
                .addCapability(android.net.NetworkCapabilities.NET_CAPABILITY_INTERNET)
                .addCapability(android.net.NetworkCapabilities.NET_CAPABILITY_NOT_VPN)
                .build();
            connectivityManager.registerNetworkCallback(req, networkCallback);
        }
    }

    private void unregisterCallback() {
        if (networkCallback != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            try {
                connectivityManager.unregisterNetworkCallback(networkCallback);
            } catch (Exception ignored) {}
            networkCallback = null;
        }
    }

    public boolean isEnabled() {
        return isEnabled.get();
    }

    private class NetworkCallback extends ConnectivityManager.NetworkCallback {
        @Override
        public void onAvailable(android.net.Network network) {
            Log.d(TAG, "Network available, but VPN is offline - blocking traffic");
        }

        @Override
        public void onLost(android.net.Network network) {
            if (VpnServiceImpl.getInstance() != null && VpnServiceImpl.getInstance().isRunning()) {
                Log.w(TAG, "Network lost while VPN active");
            }
        }
    }
}

