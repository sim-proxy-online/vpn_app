package com.simproxy.app;

import android.util.Log;
import androidx.annotation.Keep;
import com.simproxy.simcore.Listener;
import java.util.Collection;

/** Приёмник событий жизненного цикла ядра (simcore) — пишет их в общий журнал приложения. */
@Keep
public class XraySupportSetImpl implements Listener {
    private static final String TAG = "XraySupportSet";
    private final Collection<String> logs;

    public XraySupportSetImpl(Collection<String> logs) {
        this.logs = logs;
        Log.i(TAG, "Instance created: " + this);
    }

    @Override
    public void onStatus(long code, String message) {
        String logMsg = "Status [" + code + "]: " + message;
        Log.i(TAG, logMsg);
        if (logs != null) {
            logs.add(logMsg);
            while (logs.size() > 500) ((java.util.Queue<?>) logs).poll();
        }
    }
}
