package libxray;

import androidx.annotation.Keep;

@Keep
public interface XRayVPNServiceSupportsSet {
    @Keep
    long onEmitStatus(long status, String message);
    @Keep
    long shutdown();
    @Keep
    long startup();
}
