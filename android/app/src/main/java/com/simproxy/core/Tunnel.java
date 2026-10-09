package com.simproxy.core;

import android.content.Context;
import android.os.ParcelFileDescriptor;
import android.util.Log;

import androidx.annotation.Keep;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;

/**
 * Мост TUN → SOCKS5 на базе открытого hev-socks5-tunnel (MIT, github.com/heiher/hev-socks5-tunnel).
 *
 * Имена native-методов зарегистрированы библиотекой через RegisterNatives для класса
 * com/simproxy/core/Tunnel (сборка с -DPKGNAME=com/simproxy/core -DCLSNAME=Tunnel,
 * см. android/native/build-tunnel.ps1), поэтому имя и пакет класса менять нельзя.
 */
@Keep
public final class Tunnel {
    private static final String TAG = "SimTunnel";
    private static volatile boolean nativeLoaded = false;
    private static volatile String nativeLoadError = null;

    static {
        try {
            System.loadLibrary("hev-socks5-tunnel");
            nativeLoaded = true;
        } catch (Throwable t) {
            nativeLoadError = Log.getStackTraceString(t);
            Log.e(TAG, "Не удалось загрузить hev-socks5-tunnel: " + t.getMessage());
        }
    }

    @Keep private static native boolean TProxyStartService(String configPath, int fd);
    @Keep private static native boolean TProxyStopService();
    @Keep private static native boolean TProxyIsRunning();
    @Keep private static native long[] TProxyGetStats();

    private Tunnel() {}

    public static boolean isNativeLoaded() { return nativeLoaded; }
    public static String getNativeLoadError() { return nativeLoadError; }

    /**
     * Запускает туннель: пакеты из TUN уходят на локальный SOCKS5 (host:port).
     * Дескриптор остаётся во владении вызывающего (ParcelFileDescriptor закрывает он сам).
     *
     * @return 0 — успех; отрицательное значение — ошибка запуска.
     */
    public static synchronized int start(Context context, ParcelFileDescriptor tunPfd,
                                         String socksHost, int socksPort, int mtu) {
        if (!nativeLoaded) {
            Log.e(TAG, "start: нативная библиотека не загружена");
            return -1;
        }
        try {
            // Остатки предыдущего запуска (быстрая смена сервера): stop синхронный.
            if (TProxyIsRunning()) TProxyStopService();

            File cfg = new File(context.getCacheDir(), "simtunnel.yml");
            String yaml = ""
                    + "tunnel:\n"
                    + "  mtu: " + mtu + "\n"
                    + "  ipv4: 198.18.0.1\n"
                    + "  ipv6: 'fd00:198:18::1'\n"
                    + "socks5:\n"
                    + "  port: " + socksPort + "\n"
                    + "  address: " + socksHost + "\n"
                    + "  udp: 'udp'\n"
                    + "misc:\n"
                    + "  log-level: warn\n";
            try (FileOutputStream out = new FileOutputStream(cfg, false)) {
                out.write(yaml.getBytes(StandardCharsets.UTF_8));
            }

            boolean ok = TProxyStartService(cfg.getAbsolutePath(), tunPfd.getFd());
            Log.i(TAG, "start: socks=" + socksHost + ":" + socksPort + " mtu=" + mtu + " ok=" + ok);
            return ok ? 0 : -10;
        } catch (UnsatisfiedLinkError e) {
            Log.e(TAG, "start: UnsatisfiedLinkError " + e.getMessage());
            nativeLoaded = false;
            return -2;
        } catch (Throwable t) {
            Log.e(TAG, "start: " + t);
            return -3;
        }
    }

    /** Останавливает туннель. Вызов синхронный: к возврату поток hev уже завершён. */
    public static synchronized void stop() {
        if (!nativeLoaded) return;
        try {
            TProxyStopService();
        } catch (Throwable t) {
            Log.e(TAG, "stop: " + t.getMessage());
        }
    }

    public static boolean isRunning() {
        if (!nativeLoaded) return false;
        try { return TProxyIsRunning(); } catch (Throwable t) { return false; }
    }

    /** {txPackets, txBytes, rxPackets, rxBytes} либо null. */
    public static long[] stats() {
        if (!nativeLoaded) return null;
        try { return TProxyGetStats(); } catch (Throwable t) { return null; }
    }
}
