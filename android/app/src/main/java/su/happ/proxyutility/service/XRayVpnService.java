package su.happ.proxyutility.service;

import android.content.Context;
import android.net.VpnService;
import android.os.ParcelFileDescriptor;
import android.util.Log;

public class XRayVpnService {
    private static boolean nativeLoaded = false;
    private static String nativeLoadError = null;

    private static final XRayVpnService INSTANCE = new XRayVpnService();

    // The Go wrapper calls thiz.protect(fd) to shield sockets from VPN routing.
    // Since we're not a VpnService subclass, we delegate to the real service here.
    private static VpnService vpnService;

    // JNI reads the TUN fd from field 'Q' (original obfuscated field name from Happ).
    public ParcelFileDescriptor Q;
    // Secondary long field present in original Happ XRayVpnService.
    public long R;

    static {
        try {
            System.loadLibrary("tun2socks");
            nativeLoaded = true;
            Log.i("XRayVpnService", "libtun2socks loaded successfully");
        } catch (UnsatisfiedLinkError e) {
            nativeLoaded = false;
            nativeLoadError = Log.getStackTraceString(e);
            Log.e("XRayVpnService", "Failed to load libtun2socks: " + e.getMessage());
        } catch (Throwable t) {
            nativeLoaded = false;
            nativeLoadError = Log.getStackTraceString(t);
            Log.e("XRayVpnService", "Unexpected error loading libtun2socks: " + t.getMessage());
        }
    }

    public static void setVpnService(VpnService service) {
        vpnService = service;
    }

    // Called by the Go JNI wrapper to protect sockets from VPN routing.
    public boolean protect(int socket) {
        if (vpnService != null) {
            boolean ok = vpnService.protect(socket);
            Log.d("XRayVpnService", "protect(" + socket + ") = " + ok);
            return ok;
        }
        Log.w("XRayVpnService", "protect(" + socket + ") called but vpnService is null");
        return false;
    }

    public native boolean startTun2Socks(String[] args, T2SSupportSet supportSet);
    public native boolean stopTun2Socks();

    public static boolean isNativeLoaded() { return nativeLoaded; }
    public static String getNativeLoadError() { return nativeLoadError; }

    public static int safeStartTun2Socks(Context context, ParcelFileDescriptor tunPfd,
                                          String socksAddr, String dnsAddr, int mtu) {
        if (!nativeLoaded) {
            Log.e("XRayVpnService", "safeStartTun2Socks: native library not loaded");
            return -1;
        }
        try {
            INSTANCE.Q = tunPfd;
            INSTANCE.R = 0L;
            T2SSupportSet supportSet = new T2SSupportSetImpl(context);
            final String sockPath = context.getCacheDir().getAbsolutePath() + "/tun2socks.sock";
            new java.io.File(sockPath).delete();
            String[] args = {
                "--netif-ipaddr",      "172.19.0.1",
                "--netif-netmask",     "255.255.255.0",
                "--socks-server-addr", socksAddr,
                "--socks5-udp",
                "--sock-path",         sockPath,
                "--tunmtu",            String.valueOf(mtu),
                "--loglevel",          "warning"
            };
            boolean ok = INSTANCE.startTun2Socks(args, supportSet);
            Log.i("XRayVpnService", "startTun2Socks returned: " + ok);
            if (ok) {
                // --sock-path: tun2socks creates a Unix socket and waits for Java to send
                // the TUN fd via SCM_RIGHTS. We must connect and deliver it within ~10s.
                // Join the sender thread so safeStartTun2Socks returns only AFTER the fd
                // is delivered — otherwise VPN is marked "connected" before tun2socks
                // starts forwarding, causing intermittent "no internet" on first seconds.
                final java.io.FileDescriptor tunFileFd = tunPfd.getFileDescriptor();
                Thread sender = new Thread(() -> {
                    try {
                        java.io.File sockFile = new java.io.File(sockPath);
                        // Wait up to 2s for tun2socks goroutine to create the socket
                        for (int i = 0; i < 40; i++) {
                            if (sockFile.exists()) break;
                            Thread.sleep(50);
                        }
                        if (!sockFile.exists()) {
                            Log.e("XRayVpnService", "tun2socks socket not created after 2s");
                            return;
                        }
                        android.net.LocalSocket client = new android.net.LocalSocket();
                        client.connect(new android.net.LocalSocketAddress(
                                sockPath, android.net.LocalSocketAddress.Namespace.FILESYSTEM));
                        client.setFileDescriptorsForSend(new java.io.FileDescriptor[]{tunFileFd});
                        client.getOutputStream().write(1);
                        client.getOutputStream().flush();
                        client.close();
                        Log.i("XRayVpnService", "TUN fd sent to tun2socks via " + sockPath);
                    } catch (Exception e) {
                        Log.e("XRayVpnService", "Failed to send TUN fd: " + e);
                    }
                }, "TunFdSender");
                sender.start();
                try { sender.join(3000); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
            }
            return ok ? 0 : -10;
        } catch (UnsatisfiedLinkError e) {
            Log.e("XRayVpnService", "UnsatisfiedLinkError in startTun2Socks: " + e.getMessage());
            nativeLoaded = false;
            return -2;
        } catch (Throwable t) {
            Log.e("XRayVpnService", "Exception in startTun2Socks: " + t.getMessage());
            return -3;
        }
    }

    public static void safeStopTun2Socks() {
        if (!nativeLoaded) return;
        try {
            INSTANCE.Q = null;
            INSTANCE.stopTun2Socks();
        } catch (Throwable ignored) {
            Log.e("XRayVpnService", "Exception in stopTun2Socks: " + ignored.getMessage());
        }
    }
}
