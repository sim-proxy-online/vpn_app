package com.simproxy.app;

import android.app.Application;
import android.util.Log;
import com.tencent.mmkv.MMKV;
import java.util.concurrent.ConcurrentLinkedQueue;

public class SimApplication extends Application {
    private static final String TAG = "SimApp";
    public static final ConcurrentLinkedQueue<String> globalLogs = new ConcurrentLinkedQueue<>();
    public static XraySupportSetImpl staticSupportSet = null;
    // Причина, по которой не загрузились нативные библиотеки ядра (null — всё загрузилось).
    // Раньше ошибка только логировалась, и приложение «жило» без ядра: пользователь видел
    // непонятные сбои подключения. Теперь UI забирает её через NativeBridge.getCoreLoadError().
    public static volatile String coreLoadError = null;

    @Override
    public void onCreate() {
        super.onCreate();
        installCrashHandler();
        android.util.Log.i(TAG, "SimApplication: Initializing Core Stack...");
        try {
            // ПРАВИЛЬНЫЙ порядок загрузки для Gomobile/Xray стека из Happ
            System.loadLibrary("mmkv");
            System.loadLibrary("core");
            System.loadLibrary("gojni");
            System.loadLibrary("tun2socks");

            MMKV.initialize(this);
            staticSupportSet = new XraySupportSetImpl(globalLogs);
            // Инициализируем SplitTunnelManager при старте приложения — это применяет
            // пресет российских сервисов при первой установке (до открытия настроек).
            SplitTunnelManager.getInstance(this);
            android.util.Log.i(TAG, "SimApplication: All libraries loaded successfully");
        } catch (Throwable t) {
            android.util.Log.e(TAG, "SimApplication: CRITICAL LOAD ERROR", t);
            coreLoadError = t.toString();
        }
    }

    // Ставим здесь, а не в MainActivity: сервис стартует и без Activity (BootReceiver,
    // WatchdogReceiver), и тогда исключение в нём тоже должно попасть в лог.
    //
    // Раньше обработчик вызывал VpnServiceImpl.stopVpn() на ЛЮБОЙ ошибке в любом потоке.
    // stopVpn() стирает сохранённый конфиг и отменяет watchdog, поэтому одно исключение
    // навсегда отключало автовосстановление, а предыдущий обработчик не вызывался вовсе.
    //   • Главный поток или Error (OOM и т.п.) — состояние процесса ненадёжно: отдаём
    //     системному обработчику. Процесс завершится, START_STICKY-сервис и watchdog
    //     поднимут туннель заново из сохранённого конфига.
    //   • Исключение фонового потока — только лог, чтобы не ронять работающий туннель.
    private void installCrashHandler() {
        final Thread.UncaughtExceptionHandler previous = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler((thread, throwable) -> {
            android.util.Log.e("SimProxyCRASH", "UNCAUGHT in thread " + thread.getName(), throwable);
            boolean fatal = thread == android.os.Looper.getMainLooper().getThread()
                    || throwable instanceof Error;
            if (fatal && previous != null) previous.uncaughtException(thread, throwable);
        });
    }
}
