package com.simproxy.app;

import org.json.JSONObject;

public class VpnStats {
    public long upload;
    public long download;
    public long uplinkSpeed;
    public long downlinkSpeed;
    public long connectedSec;
    public String publicIp = "";
    public String country = "";
    // Diagnostics fields
    public String startupLogs = "";
    public int nativeExitCode = 0;
    public boolean routingOk = true;
    public String error = "";
    public String lastError = "";
    public String status = "";  // Status indicator: "starting", "running", "not_running", "not_routing"
    public String message = "";          // Detail message

    public VpnStats(long upload, long download, long uplinkSpeed, long downlinkSpeed, long connectedSec) {
        this.upload = upload;
        this.download = download;
        this.uplinkSpeed = uplinkSpeed;
        this.downlinkSpeed = downlinkSpeed;
        this.connectedSec = connectedSec;
    }

    public String toJson() {
        try {
            JSONObject obj = new JSONObject();
            obj.put("upload", upload);
            obj.put("download", download);
            obj.put("uplinkSpeed", uplinkSpeed);
            obj.put("downlinkSpeed", downlinkSpeed);
            obj.put("connectedSec", connectedSec);
            obj.put("publicIp", publicIp);
            obj.put("country", country);
            // Limit log size and strip ANSI only if logs are short enough to avoid ANR
            String logs = startupLogs;
            if (logs != null && logs.length() > 5000) {
                logs = logs.substring(logs.length() - 5000);
            }
            obj.put("startupLogs", stripAnsi(logs));
            obj.put("nativeExitCode", nativeExitCode);
            obj.put("routingOk", routingOk);
            obj.put("status", status);
            obj.put("message", message);
            obj.put("error", error);
            obj.put("lastError", lastError);
            return obj.toString();
        } catch (Exception e) {
            return "{\"error\":\"json_error\"}";
        }
    }

    private String stripAnsi(String s) {
        if (s == null || s.isEmpty()) return "";
        // More robust but still simple regex for ANSI codes
        // If the string is very long, replaceAll can be a bit slow, but we've limited length to 5k
        return s.replaceAll("\u001B\\[[;\\d]*[A-Za-z]", "");
    }
}

