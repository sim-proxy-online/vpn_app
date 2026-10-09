package libxray;

import androidx.annotation.Keep;
import go.Seq;

@Keep
public class Libxray {
    static {
        try { System.loadLibrary("mmkv"); } catch (Throwable ignored) {}
        try { System.loadLibrary("core"); } catch (Throwable ignored) {}
        try { System.loadLibrary("gojni"); } catch (Throwable ignored) {}
        Seq.touch();
        try { 
            _init();
            android.util.Log.e("Libxray", "Static block _init success");
        } catch (Throwable t) { 
            android.util.Log.e("Libxray", "Static block _init fail", t);
        }
    }

    @Keep public static native void _init();
    @Keep public static native void initXEnv(String datPath, String observedPath);

    @Keep public static native XRayPoint newXRayPoint(XRayVPNServiceSupportsSet s, boolean z);

    @Keep public static native String getCoreVersion();
    @Keep public static native String getWrapperVersion();

    @Keep public static native String checkVersionX();
    @Keep public static native void cutGeoData(String s1, String s2, String s3);
    @Keep public static native void disableWrapperLogs();
    @Keep public static native void enableWrapperLogs();
    @Keep public static native String loadGeoFileRuleNames(String s1);
    // Happ 4.7.1: у measureOutboundDelay* появился пятый/третий аргумент — таймаут (мс).
    // Сигнатуры обязаны совпадать с тем, что регистрирует новый libgojni.so.
    @Keep public static native long measureOutboundDelay(String s1, String s2, long timeoutMs);
    @Keep public static native long measureOutboundDelayWithType(String s1, String s2, String s3, String s4, long timeoutMs);

    @Keep
    public static final class proxyXRayVPNServiceSupportsSet implements Seq.Proxy, XRayVPNServiceSupportsSet {
        private final int refnum;

        public proxyXRayVPNServiceSupportsSet(int refnum) {
            this.refnum = refnum;
            Seq.incGoRef(refnum, this);
        }

        @Override public final int incRefnum() {
            Seq.incGoRef(refnum, this);
            return refnum;
        }

        @Override public native long onEmitStatus(long status, String message);
        @Override public native long shutdown();
        @Override public native long startup();
    }

    // Нужен новому libgojni.so (Happ 4.7.1): Libxray._init() делает FindClass
    // на этот inner-класс и регистрирует findProcessByConnection. Без класса —
    // JNI DETECTED ERROR (java_class null) → SIGABRT при загрузке.
    @Keep
    public static final class proxyProcessFinder implements Seq.Proxy, ProcessFinder {
        private final int refnum;

        public proxyProcessFinder(int refnum) {
            this.refnum = refnum;
            Seq.incGoRef(refnum, this);
        }

        @Override public final int incRefnum() {
            Seq.incGoRef(refnum, this);
            return refnum;
        }

        @Override public native long findProcessByConnection(String s1, String s2, long j1, String s3, long j2);
    }

    @Keep public static void touch() {}
}
