-keep class com.simproxy.app.** { *; }
-keep class go.** { *; }
-keep class libxray.** { *; }
-keep class com.tencent.mmkv.** { *; }
-keepclassmembers class com.simproxy.app.NativeBridge {
    @android.webkit.JavascriptInterface <methods>;
}
-keepclassmembers class * extends android.net.VpnService {
    public *;
}
-keepattributes Signature,Exceptions,*Annotation*
-dontwarn android.webkit.**
-dontwarn com.tencent.mmkv.**

# JNI: libtun2socks.so reads field Q/R and calls protect(), startTun2Socks, stopTun2Socks by name.
-keep class su.happ.proxyutility.service.XRayVpnService {
    public android.os.ParcelFileDescriptor Q;
    public long R;
    public boolean protect(int);
    public native boolean startTun2Socks(java.lang.String[], su.happ.proxyutility.service.T2SSupportSet);
    public native boolean stopTun2Socks();
}
# JNI: libtun2socks.so reflects on T2SSupportSet methods by name for per-app routing callbacks.
-keep interface su.happ.proxyutility.service.T2SSupportSet { *; }
-keep class su.happ.proxyutility.service.T2SSupportSetImpl { *; }
-keep class su.happ.proxyutility.dto.ConnectionOwner { *; }
