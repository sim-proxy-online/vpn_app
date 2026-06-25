package com.simproxy.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.util.Log;

/**
 * BootReceiver — перехватывает ACTION_BOOT_COMPLETED для запуска сервисов при загрузке.
 *
 * Логика:
 * 1. При загрузке система запускает BootReceiver
 * 2. Если был активен основной VPN — запускается VpnServiceImpl с последней конфигурацией
 * 3. Одновременно запускается AntiFilterService для поддержания SOCKS-соединения
 * 4. AntiFilterService может работать независимо, захватывая живое TCP до подключения VPN
 */
public class BootReceiver extends BroadcastReceiver {
    private static final String TAG = "BootReceiver";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())) {
            Log.i(TAG, "Boot completed, initializing services...");

            // Запускаем сервисы только если был активен VPN до перезагрузки.
            // Без этой проверки AntiFilterService показывал бы ненужное уведомление
            // даже когда пользователь намеренно остановил VPN перед выключением.
            SharedPreferences prefs = context.getSharedPreferences("sim_last_vpn", Context.MODE_PRIVATE);
            boolean hasLastConfig = prefs.getString("config", null) != null;

            if (hasLastConfig) {
                startAntiFilterService(context);
                startVpnService(context);
            } else {
                Log.i(TAG, "No saved VPN config — skipping auto-start");
            }
        }
    }

    /**
     * Запускает AntiFilterService для поддержания живого SOCKS-соединения.
     */
    private void startAntiFilterService(Context context) {
        try {
            Intent serviceIntent = new Intent(context, AntiFilterService.class);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(serviceIntent);
            } else {
                context.startService(serviceIntent);
            }
            Log.i(TAG, "AntiFilterService started at boot");
        } catch (Exception e) {
            Log.w(TAG, "Failed to start AntiFilterService at boot: " + e.getMessage());
        }
    }

    /**
     * Запускает VpnServiceImpl для восстановления последнего соединения.
     */
    private void startVpnService(Context context) {
        try {
            Intent svcIntent = new Intent(context, VpnServiceImpl.class);
            svcIntent.setAction("START_LAST");
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(svcIntent);
            } else {
                context.startService(svcIntent);
            }
            Log.i(TAG, "VpnServiceImpl started at boot");
        } catch (Exception e) {
            Log.w(TAG, "Failed to start VpnServiceImpl at boot: " + e.getMessage());
        }
    }
}
