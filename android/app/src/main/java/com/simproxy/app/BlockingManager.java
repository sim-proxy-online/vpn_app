package com.simproxy.app;

import androidx.annotation.Keep;
import java.util.ArrayList;
import java.util.List;

@Keep
public class BlockingManager {
    public static List<String> getBlockedDomains() {
        List<String> domains = new ArrayList<>();
        // DPS
        domains.add("trace-flow.ru");
        // Tracer SDK
        domains.add("sdk-api.apptracer.ru");
        // MyTracker
        domains.add("mytracker.com");
        domains.add("tracker.my.com");
        // Mobile ID (HE-authentication leaks)
        domains.add("mobileid.megafon.ru");
        domains.add("idgw.mobileid.mts.ru");
        domains.add("hhe.mts.ru");
        domains.add("he-mc.tele2.ru");
        domains.add("he-mc.t2.ru");
        domains.add("balance.beeline.ru");
        // DoH Bypass prevention
        domains.add("dns.google.com");
        // Generic trackers
        domains.add("app-measurement.com");
        domains.add("analytics.google.com");
        return domains;
    }
}
