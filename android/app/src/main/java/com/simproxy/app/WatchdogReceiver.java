package com.simproxy.app;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.util.Log;

/**
 * AlarmManager-based watchdog: раз в INTERVAL_MS (5 минут) проверяет что VPN жив.
 * Работает независимо от процесса приложения — выживает на агрессивных
 * прошивках (Xiaomi MIUI, Samsung OneUI), которые убивают START_STICKY.
 *
 * Android 12+ (API 31): точные будильники требуют SCHEDULE_EXACT_ALARM, который для
 * новых установок на Android 13+ по умолчанию не выдан. Без него setExact* бросает
 * SecurityException, и раньше это глоталось — цепочка будильников обрывалась молча,
 * и watchdog переставал работать. Теперь при недоступности точных будильников
 * используется setAndAllowWhileIdle: срабатывает неточно (в Doze — с задержкой до
 * нескольких минут), зато без разрешения и цепочка не рвётся.
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
            clearDownNotification(context); // VPN снова работает — «отключился» больше не актуально
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
            // На Android 12+ запуск foreground-сервиса из фона может быть запрещён
            // (ForegroundServiceStartNotAllowedException). Не теряем цепочку проверок —
            // ниже перепланируем следующий будильник; VPN поднимется при открытии
            // приложения или перезапуске сервиса системой (START_STICKY).
            Log.e(TAG, "Не удалось перезапустить VPN: " + e);
            // Тихо потерять защиту нельзя: сообщаем пользователю. Тап по уведомлению открывает
            // приложение уже на переднем плане (оттуда сервис стартовать можно) и включает VPN.
            notifyVpnDown(context);
        }
        schedule(context);
    }

    private static final String ALERT_CHANNEL_ID = "sim_vpn_alert";
    private static final int ALERT_NOTIFICATION_ID = 3;

    private static void notifyVpnDown(Context context) {
        try {
            NotificationManager nm = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return;
            Notification.Builder nb;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                nm.createNotificationChannel(new NotificationChannel(
                        ALERT_CHANNEL_ID, "VPN отключён", NotificationManager.IMPORTANCE_HIGH));
                nb = new Notification.Builder(context, ALERT_CHANNEL_ID);
            } else {
                nb = new Notification.Builder(context).setPriority(Notification.PRIORITY_HIGH);
            }
            // sim://vpn/on обрабатывает MainActivity/JS: включает VPN сразу, без подтверждения.
            Intent open = new Intent(context, MainActivity.class);
            open.setAction(Intent.ACTION_VIEW);
            open.setData(Uri.parse("sim://vpn/on"));
            PendingIntent pi = PendingIntent.getActivity(context, ALERT_NOTIFICATION_ID, open,
                    PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
            nb.setContentTitle("VPN отключился")
              .setContentText("Система остановила VPN в фоне. Нажмите, чтобы включить снова.")
              .setSmallIcon(android.R.drawable.ic_dialog_alert)
              .setContentIntent(pi)
              .setAutoCancel(true)
              .setOnlyAlertOnce(true);
            nm.notify(ALERT_NOTIFICATION_ID, nb.build());
        } catch (Exception e) {
            Log.w(TAG, "notifyVpnDown failed: " + e.getMessage());
        }
    }

    private static void clearDownNotification(Context context) {
        try {
            NotificationManager nm = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) nm.cancel(ALERT_NOTIFICATION_ID);
        } catch (Exception ignored) {}
    }

    static void schedule(Context context) {
        AlarmManager am = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;
        PendingIntent pi = buildIntent(context);
        long triggerAt = System.currentTimeMillis() + INTERVAL_MS;

        boolean exactAllowed = Build.VERSION.SDK_INT < Build.VERSION_CODES.S || am.canScheduleExactAlarms();
        if (exactAllowed) {
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                    am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAt, pi);
                } else {
                    am.setExact(AlarmManager.RTC_WAKEUP, triggerAt, pi);
                }
                return;
            } catch (SecurityException e) {
                // Разрешение отозвали между проверкой и вызовом — падаем на неточный вариант.
                Log.w(TAG, "exact alarm denied, falling back to inexact: " + e.getMessage());
            } catch (Exception e) {
                Log.w(TAG, "schedule failed: " + e.getMessage());
                return;
            }
        }
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAt, pi);
            } else {
                am.set(AlarmManager.RTC_WAKEUP, triggerAt, pi);
            }
        } catch (Exception e) {
            Log.w(TAG, "inexact schedule failed: " + e.getMessage());
        }
    }

    static void cancel(Context context) {
        AlarmManager am = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;
        try { am.cancel(buildIntent(context)); } catch (Exception ignored) {}
    }

    /**
     * Разовый будильник почти сразу — используется, когда процесс убивают намеренно
     * ради чистого ядра. Сам будильник живёт в системе и переживает смерть процесса,
     * поэтому он и поднимет сервис заново.
     *
     * Точный будильник предпочтителен (иначе в Doze можно ждать минутами), но при
     * отсутствии разрешения падаем на неточный: лучше подняться с задержкой, чем не подняться.
     */
    static void scheduleImmediate(Context context, long delayMs) {
        AlarmManager am = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;
        PendingIntent pi = buildIntent(context);
        long triggerAt = System.currentTimeMillis() + delayMs;
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAt, pi);
            } else {
                am.setExact(AlarmManager.RTC_WAKEUP, triggerAt, pi);
            }
            Log.i(TAG, "restart alarm set (exact) +" + delayMs + "ms");
            return;
        } catch (Exception e) {
            Log.w(TAG, "exact restart alarm denied, falling back: " + e.getMessage());
        }
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAt, pi);
            } else {
                am.set(AlarmManager.RTC_WAKEUP, triggerAt, pi);
            }
            Log.i(TAG, "restart alarm set (inexact) +" + delayMs + "ms");
        } catch (Exception e) {
            Log.e(TAG, "restart alarm failed: " + e.getMessage());
        }
    }

    private static PendingIntent buildIntent(Context context) {
        Intent intent = new Intent(context, WatchdogReceiver.class);
        intent.setAction(ACTION);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getBroadcast(context, 42, intent, flags);
    }
}
