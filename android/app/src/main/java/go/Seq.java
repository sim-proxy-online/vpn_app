package go;

import android.content.Context;
import androidx.annotation.Keep;
import java.util.Collections;
import java.util.HashMap;
import java.util.IdentityHashMap;
import java.util.Map;
import java.util.logging.Logger;

@Keep
public class Seq {
    private static final int NULL_REFNUM = 41;
    private static final Logger log = Logger.getLogger("go.Seq");
    public static final Ref nullRef = new Ref(NULL_REFNUM, null);
    static final RefTracker tracker = new RefTracker();

    static {
        try {
            System.loadLibrary("gojni");
            init();
            Universe.touch();
        } catch (Throwable t) {
            android.util.Log.e("SEQ_LOG", "static init fail", t);
        }
    }

    private Seq() {}

    @Keep public static native void setContext(Context context);
    @Keep private static native void init();
    @Keep public static native void destroyRef(int refnum);
    @Keep public static native void incGoRef(int refnum, GoObject obj);

    @Keep
    public static void incRefnum(int refnum) {
        tracker.incRefnum(refnum);
    }

    @Keep
    public static int incRef(Object obj) {
        if (obj == null) return NULL_REFNUM;
        if (obj instanceof GoObject) {
            return ((GoObject) obj).incRefnum();
        }
        return tracker.inc(obj);
    }

    @Keep
    public static int register(Object obj) {
        return tracker.register(obj);
    }

    @Keep
    public static int incGoObjectRef(GoObject obj) {
        return obj == null ? NULL_REFNUM : obj.incRefnum();
    }

    @Keep
    public static void decRef(int refnum) {
        tracker.dec(refnum);
    }

    @Keep
    public static Ref getRef(int refnum) {
        return tracker.get(refnum);
    }

    @Keep
    public static void track(GoObject obj) {
        // Optional tracking logic
    }

    @Keep
    public static final class Ref {
        public final int refnum;
        public final Object obj;
        private int refcnt = 0;

        public Ref(int refnum, Object obj) {
            if (refnum < 0) {
                // throw new RuntimeException("Ref instantiated with a Go refnum " + refnum);
            }
            this.refnum = refnum;
            this.obj = obj;
        }
        
        public synchronized void inc() {
            refcnt++;
        }
        
        public synchronized int dec() {
            return --refcnt;
        }
    }

    @Keep
    public interface GoObject {
        int incRefnum();
    }
    
    @Keep
    public interface Proxy extends GoObject {}

    static final class RefTracker {
        private static final int REF_OFFSET = 42;
        private final Map<Integer, Ref> javaObjs = Collections.synchronizedMap(new HashMap<Integer, Ref>());
        private final IdentityHashMap<Object, Integer> javaRefs = new IdentityHashMap<>();
        private int next = REF_OFFSET;

        synchronized int inc(Object obj) {
            if (obj == null) return NULL_REFNUM;
            if (obj instanceof Proxy) return ((GoObject)obj).incRefnum();
            
            Integer refnum = javaRefs.get(obj);
            if (refnum == null) {
                refnum = next++;
                javaRefs.put(obj, refnum);
                javaObjs.put(refnum, new Ref(refnum, obj));
            }
            javaObjs.get(refnum).inc();
            return refnum;
        }

        synchronized int register(Object obj) {
            return inc(obj);
        }

        synchronized void dec(int refnum) {
            if (refnum <= 0) return;
            if (refnum == NULL_REFNUM) return;
            
            Ref ref = javaObjs.get(refnum);
            if (ref != null) {
                if (ref.dec() <= 0) {
                    javaObjs.remove(refnum);
                    javaRefs.remove(ref.obj);
                }
            }
        }

        synchronized void incRefnum(int refnum) {
            Ref ref = javaObjs.get(refnum);
            if (ref != null) ref.inc();
        }

        synchronized Ref get(int refnum) {
            if (refnum == NULL_REFNUM) return nullRef;
            Ref ref = javaObjs.get(refnum);
            return ref;
        }
    }

    @Keep public static void touch() {}
}
