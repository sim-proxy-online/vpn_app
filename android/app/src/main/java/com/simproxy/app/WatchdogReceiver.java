package com.simproxy.app;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.util.Log;

/**
 * AlarmManager-based watchdog: каждые 2 минуты проверяет что VPN жив.
 * Работает независимо от процесса приложения — выживает на агрессивных
 * прошивках (Xiaomi MIUI, Samsung OneUI), которые убивают START_STICKY.
 */
public class WatchdogReceiver extends BroadcastReceiver {
    private static final String TAG = "SimWatchdog";
    static final String ACTION = "com.simproxy.app.WATCHDOG_CHECK";
    private static final long INTERVAL_MS = 5 * 60 * 1000L;

    @Override
    public void onReceive(Context context, Intent intent) {
        if (!ACTION.equals(intent.getAction())) return;

        SharedPreferences prefs = context.getSharedPreferences("sim_last_vpn", Context.MODE_PRIVATE);
        String config = prefs.getString("config", null);
        if (config == null) {
            cancel(context);
            return;
        }

        VpnServiceImpl svc = VpnServiceImpl.getInstance();
        boolean vpnAlive = svc != null && (svc.isRunning() || svc.isStarting());
        if (vpnAlive) {
            schedule(context);
            return;
        }

        Log.w(TAG, "VPN не запущен, перезапускаю...");
        Intent svcIntent = new Intent(context, VpnServiceImpl.class);
        svcIntent.setAction("START_LAST");
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(svcIntent);
            } else {
                context.startService(svcIntent);
            }
        } catch (Exception e) {
            Log.e(TAG, "Не удалось перезапустить VPN: " + e.getMessage());
        }
        schedule(context);
    }

    static void schedule(Context context) {
        AlarmManager am = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;
        PendingIntent pi = buildIntent(context);
        long triggerAt = System.currentTimeMillis() + INTERVAL_MS;
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAt, pi);
            } else {
                am.setExact(AlarmManager.RTC_WAKEUP, triggerAt, pi);
            }
        } catch (Exception e) {
            Log.w(TAG, "schedule failed: " + e.getMessage());
        }
    }

    static void cancel(Context context) {
        AlarmManager am = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;
        try { am.cancel(buildIntent(context)); } catch (Exception ignored) {}
    }

    private static PendingIntent buildIntent(Context context) {
        Intent intent = new Intent(context, WatchdogReceiver.class);
        intent.setAction(ACTION);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getBroadcast(context, 42, intent, flags);
    }
}
