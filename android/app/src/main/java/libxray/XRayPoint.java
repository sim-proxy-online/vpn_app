package libxray;

import androidx.annotation.Keep;
import go.Seq;

@Keep
public class XRayPoint implements Seq.Proxy {
    private final int refnum;

    @Keep
    public XRayPoint(int refnum) {
        this.refnum = refnum;
    }

    @Override
    public final int incRefnum() {
        Seq.incGoRef(refnum, this);
        return refnum;
    }

    @Keep public native void coreRunLoop(String config);
    @Keep public native void coreRunLoopWithTun(String config, int fd);
    @Keep public native void coreStopLoop();
    
    @Keep public native boolean getIsRunning();
    @Keep public native void setIsRunning(boolean v);
    
    @Keep public native long measureDelay(String s1, String s2, long timeoutMs);
    @Keep public native long queryStats(String s1, String s2);
    @Keep public native long queryStatsCustom(String s1, String s2, String s3);
    @Keep public native String queryStatsServer();
    @Keep public native String queryStatsSys();
    @Keep public native void registerProcessFinder(ProcessFinder f);
    @Keep public native ConsoleLogWriter getLogWriter();
    @Keep public native void setLogWriter(ConsoleLogWriter w);

    @Keep public native void setSupportSet(XRayVPNServiceSupportsSet s);
    @Keep public native XRayVPNServiceSupportsSet getSupportSet();
}
