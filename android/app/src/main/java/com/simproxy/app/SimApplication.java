package com.simproxy.app;

import android.app.Application;
import android.util.Log;
import com.tencent.mmkv.MMKV;
import java.util.concurrent.ConcurrentLinkedQueue;

public class SimApplication extends Application {
    private static final String TAG = "SimApp";
    public static final ConcurrentLinkedQueue<String> globalLogs = new ConcurrentLinkedQueue<>();
    public static XraySupportSetImpl staticSupportSet = null;

    @Override
    public void onCreate() {
        super.onCreate();
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
        }
    }
}
