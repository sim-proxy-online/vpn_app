package libxray;

import androidx.annotation.Keep;
import go.Seq;

@Keep
public class ConsoleLogWriter implements Seq.Proxy {
    private final int refnum;

    @Keep
    public ConsoleLogWriter(int refnum) {
        this.refnum = refnum;
    }

    @Override public final int incRefnum() {
        Seq.incGoRef(refnum, this);
        return refnum;
    }

    @Keep public native void write(String s);
    @Keep public native void enable();
    @Keep public native void disable();
}
