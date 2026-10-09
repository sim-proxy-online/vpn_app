package su.happ.proxyutility.dto;

public final class ConnectionOwner {
    public final int userId;
    public final String[] androidPackageNames;

    public ConnectionOwner(int userId, String[] androidPackageNames) {
        this.userId = userId;
        this.androidPackageNames = androidPackageNames;
    }
}
