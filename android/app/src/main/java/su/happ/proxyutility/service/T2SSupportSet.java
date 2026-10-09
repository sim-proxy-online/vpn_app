package su.happ.proxyutility.service;

import su.happ.proxyutility.dto.ConnectionOwner;

/** Callback interface passed to tun2socks JNI for per-connection owner resolution. */
public interface T2SSupportSet {
    boolean useProcFS();
    String[] getPackageNamesByUid(int uid);
    ConnectionOwner findConnectionOwner(int localPort, String localAddr, int remotePort, String remoteAddr, int protocol);
}
