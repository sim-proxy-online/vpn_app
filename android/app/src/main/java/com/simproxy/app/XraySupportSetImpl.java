package com.simproxy.app;

import android.util.Log;
import androidx.annotation.Keep;
import libxray.XRayVPNServiceSupportsSet;
import java.util.Collection;

@Keep
public class XraySupportSetImpl implements XRayVPNServiceSupportsSet {
    private static final String TAG = "XraySupportSet";
    private final Collection<String> logs;

    public XraySupportSetImpl(Collection<String> logs) {
        this.logs = logs;
        Log.i(TAG, "Instance created: " + this);
    }

    @Override
    public long onEmitStatus(long status, String message) {
        String logMsg = "Status [" + status + "]: " + message;
        android.util.Log.e(TAG, logMsg);
        if (logs != null) {
            logs.add(logMsg);
            while (logs.size() > 500) ((java.util.Queue<?>) logs).poll();
        }
        return 0;
    }

    @Override
    public long shutdown() {
        Log.i(TAG, "shutdown() called from native");
        return 0;
    }

    @Override
    public long startup() {
        Log.i(TAG, "startup() called from native");
        return 0;
    }
}
