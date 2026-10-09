-keep class com.simproxy.app.** { *; }
-keep class go.** { *; }
-keep class com.simproxy.simcore.** { *; }
-keep class com.simproxy.core.** { *; }
-keepclassmembers class com.simproxy.app.NativeBridge {
    @android.webkit.JavascriptInterface <methods>;
}
-keepclassmembers class * extends android.net.VpnService {
    public *;
}
-keepattributes Signature,Exceptions,*Annotation*
-dontwarn android.webkit.**

# JNI: hev-socks5-tunnel регистрирует native-методы класса com.simproxy.core.Tunnel по имени (RegisterNatives).
-keepclasseswithmembernames class com.simproxy.core.Tunnel { native <methods>; }
