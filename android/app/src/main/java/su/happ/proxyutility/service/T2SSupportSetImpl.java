package su.happ.proxyutility.service;

import android.content.Context;
import su.happ.proxyutility.dto.ConnectionOwner;

public final class T2SSupportSetImpl implements T2SSupportSet {
    private final Context context;

    public T2SSupportSetImpl(Context context) {
        this.context = context;
    }

    @Override
    public boolean useProcFS() {
        return true;
    }

    @Override
    public String[] getPackageNamesByUid(int uid) {
        try {
            return context.getPackageManager().getPackagesForUid(uid);
        } catch (Exception e) {
            return null;
        }
    }

    @Override
    public ConnectionOwner findConnectionOwner(int localPort, String localAddr,
            int remotePort, String remoteAddr, int protocol) {
        return null;
    }
}
