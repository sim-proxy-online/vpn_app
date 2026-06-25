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
    
    @Keep public native long measureDelay();
    @Keep public native String queryStats();
    @Keep public native String queryStatsCustom(String s);
    @Keep public native String queryStatsServer();
    @Keep public native String queryStatsSys();
    
    @Keep public native long setSupportSet(XRayVPNServiceSupportsSet s);
    @Keep public native XRayVPNServiceSupportsSet getSupportSet();
}
