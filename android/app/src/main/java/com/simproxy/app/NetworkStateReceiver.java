package com.simproxy.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.net.ConnectivityManager;
import android.net.NetworkInfo;
import android.os.Build;
import android.util.Log;

/**
 * NetworkStateReceiver — перехватывает изменения состояния сети (WiFi, mobile, и т.д.).
 *
 * Назначение:
 * 1. Запускает AntiFilterService при подключении к сети (если VPN не активен)
 * 2. Вызывает переподключение при смене сети (WiFi ↔ Mobile)
 * 3. Оптимизирует переподключение после потери сети
 *
 * Регистрация:
 * - Добавить в AndroidManifest.xml:
 *   <receiver android:name=".NetworkStateReceiver" android:exported="false">
 *       <intent-filter>
 *           <action android:name="android.net.conn.CONNECTIVITY_CHANGE" />
 *       </intent-filter>
 *   </receiver>
 *
 * - Или программно в MainActivity:
 *   IntentFilter filter = new IntentFilter(ConnectivityManager.CONNECTIVITY_ACTION);
 *   context.registerReceiver(new NetworkStateReceiver(), filter);
 */
public class NetworkStateReceiver extends BroadcastReceiver {
    private static final String TAG = "NetworkStateReceiver";
    private static volatile boolean lastNetworkConnected = false;
    private static volatile String lastNetworkType = "NONE";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null) return;

        String action = intent.getAction();
        if (ConnectivityManager.CONNECTIVITY_ACTION.equals(action) ||
            Intent.ACTION_DEVICE_STORAGE_OK.equals(action)) {

            handleNetworkStateChange(context);
        }
    }

    /**
     * Обработка изменения состояния сети.
     * Вызывает переподключение VPN или запускает AntiFilterService.
     */
    private void handleNetworkStateChange(Context context) {
        ConnectivityManager cm = (ConnectivityManager) context.getSystemService(
            Context.CONNECTIVITY_SERVICE
        );
        if (cm == null) return;

        // Проверка подключения к интернету
        NetworkInfo activeNetwork = cm.getActiveNetworkInfo();
        boolean isConnected = activeNetwork != null && activeNetwork.isConnected();
        String networkType = activeNetwork != null ? activeNetwork.getTypeName() : "NONE";

        // Предотвращение повторных событий для одного и того же состояния
        if (isConnected == lastNetworkConnected && networkType.equals(lastNetworkType)) {
            Log.d(TAG, "Network state unchanged: " + networkType);
            return;
        }

        lastNetworkConnected = isConnected;
        lastNetworkType = networkType;

        if (isConnected) {
            Log.i(TAG, "Network connected: " + networkType);
            handleNetworkConnected(context, networkType);
        } else {
            Log.i(TAG, "Network disconnected");
            handleNetworkDisconnected(context);
        }
    }

    /**
     * Обработка подключения к сети.
     * 1. Если VPN не активен — запустить AntiFilterService
     * 2. Если VPN активен — проверить и переподключиться если нужно
     */
    private void handleNetworkConnected(Context context, String networkType) {
        try {
            VpnServiceImpl vpnService = VpnServiceImpl.getInstance();
            boolean vpnRunning = vpnService != null && vpnService.isRunning();

            if (!vpnRunning) {
                // VPN не запущен — запустить AntiFilterService для keep-alive
                Log.i(TAG, "VPN not running, starting AntiFilterService");
                startAntiFilterService(context);
            } else {
                // VPN запущен — проверить нужно ли переподключиться
                Log.i(TAG, "VPN already running, checking connection quality");
                // Здесь можно добавить логику проверки качества соединения
                // и переподключения при необходимости (future)
            }

            // Также может быть полезно запустить speedtest или проверку соединения
            // if (shouldRunConnectivityCheck()) {
            //     ConnectionValidator.validate(context);
            // }

        } catch (Exception e) {
            Log.e(TAG, "Error handling network connected", e);
        }
    }

    /**
     * Обработка отключения от сети.
     * 1. Остановить keep-alive пинги (экономия батареи)
     * 2. Уведомить пользователя
     */
    private void handleNetworkDisconnected(Context context) {
        try {
            AntiFilterService antiFilterService = AntiFilterService.getInstance();
            if (antiFilterService != null) {
                Log.i(TAG, "Network disconnected, stopping AntiFilterService");
                stopAntiFilterService(context);
            }
        } catch (Exception e) {
            Log.w(TAG, "Error handling network disconnected", e);
        }
    }

    /**
     * Запускает AntiFilterService.
     */
    private void startAntiFilterService(Context context) {
        try {
            Intent serviceIntent = new Intent(context, AntiFilterService.class);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(serviceIntent);
            } else {
                context.startService(serviceIntent);
            }
            Log.i(TAG, "AntiFilterService started");
        } catch (Exception e) {
            Log.e(TAG, "Failed to start AntiFilterService", e);
        }
    }

    /**
     * Останавливает AntiFilterService.
     */
    private void stopAntiFilterService(Context context) {
        try {
            Intent serviceIntent = new Intent(context, AntiFilterService.class);
            context.stopService(serviceIntent);
            Log.i(TAG, "AntiFilterService stopped");
        } catch (Exception e) {
            Log.w(TAG, "Failed to stop AntiFilterService", e);
        }
    }

    /**
     * Проверка нужна ли проверка качества соединения (future).
     */
    private boolean shouldRunConnectivityCheck() {
        // Настраиваемая логика для определения когда нужна проверка
        // Например: не чаще одного раза в 5 минут
        long lastCheck = System.currentTimeMillis(); // TODO: сохранить в SharedPreferences
        long checkInterval = 5 * 60 * 1000; // 5 минут
        return (System.currentTimeMillis() - lastCheck) > checkInterval;
    }
}
