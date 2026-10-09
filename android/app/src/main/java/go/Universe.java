package go;

import androidx.annotation.Keep;

@Keep
public abstract class Universe {
    static {
        Seq.touch();
        _init();
    }

    @Keep public static native void _init();
    @Keep public static void touch() {}

    @Keep
    public static final class proxyerror extends Exception implements Seq.Proxy {
        private final int refnum;
        @Keep proxyerror(int refnum) { this.refnum = refnum; }
        @Override public final int incRefnum() {
            Seq.incGoRef(refnum, this);
            return refnum;
        }
        @Override public String getMessage() { return error(); }
        private native String error();
    }
}
