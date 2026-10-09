package com.simproxy.core;

import android.net.VpnService;
import android.util.Log;

import androidx.annotation.Keep;

import com.simproxy.simcore.Protector;

/**
 * Защита сокетов ядра от попадания обратно в VPN-туннель: Go-код вызывает protect(fd)
 * для каждого исходящего сокета, а мы передаём его в VpnService.protect().
 */
@Keep
public final class SocketProtector implements Protector {
    private static final String TAG = "SocketProtector";
    private static final SocketProtector INSTANCE = new SocketProtector();
    private static volatile VpnService service;

    private SocketProtector() {}

    public static SocketProtector get() { return INSTANCE; }

    /** Вызывать из VpnService.onCreate(); null при уничтожении сервиса. */
    public static void attach(VpnService s) { service = s; }

    @Override
    public boolean protect(int fd) {
        VpnService s = service;
        if (s == null) {
            // Сервис ещё не поднят (например, пинг до включения VPN): защищать нечего.
            return true;
        }
        boolean ok = s.protect(fd);
        if (!ok) Log.w(TAG, "protect(" + fd + ") = false");
        return ok;
    }
}
