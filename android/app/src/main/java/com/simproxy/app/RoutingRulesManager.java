package com.simproxy.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.List;

/**
 * RoutingRulesManager — управляет правилами маршрутизации трафика.
 * Поддерживает:
 * - Правила на основе доменов
 * - Правила на основе IP адресов
 * - GeoIP маршрутизацию
 * - Кастомные правила
 */
public class RoutingRulesManager {
    private static final String TAG = "RoutingRules";
    private static final String PREFS_NAME = "routing_rules";
    private static volatile RoutingRulesManager instance;
    private final SharedPreferences prefs;
    private final Context context;

    public static class RoutingRule {
        public String id;
        public String type; // "domain", "ip", "geoip", "custom"
        public String pattern; // domain, IP range, or country code
        public String action; // "proxy", "direct", "block"
        public String description;
        public boolean enabled;
        public long createdAt;

        public RoutingRule() {}

        public JSONObject toJson() throws JSONException {
            JSONObject obj = new JSONObject();
            obj.put("id", id);
            obj.put("type", type);
            obj.put("pattern", pattern);
            obj.put("action", action);
            obj.put("description", description);
            obj.put("enabled", enabled);
            obj.put("createdAt", createdAt);
            return obj;
        }

        public static RoutingRule fromJson(JSONObject obj) throws JSONException {
            RoutingRule rule = new RoutingRule();
            rule.id = obj.getString("id");
            rule.type = obj.getString("type");
            rule.pattern = obj.getString("pattern");
            rule.action = obj.getString("action");
            rule.description = obj.optString("description", "");
            rule.enabled = obj.getBoolean("enabled");
            rule.createdAt = obj.getLong("createdAt");
            return rule;
        }
    }

    private RoutingRulesManager(Context context) {
        this.context = context;
        this.prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        initializeDefaultRules();
    }

    public static RoutingRulesManager getInstance(Context context) {
        if (instance == null) {
            synchronized (RoutingRulesManager.class) {
                if (instance == null) {
                    instance = new RoutingRulesManager(context.getApplicationContext());
                }
            }
        }
        return instance;
    }

    /**
     * Инициализирует правила по умолчанию
     */
    private void initializeDefaultRules() {
        if (prefs.contains("rules_initialized")) {
            return;
        }

        try {
            // Правило для локальных доменов
            RoutingRule localRule = new RoutingRule();
            localRule.id = "local_direct";
            localRule.type = "domain";
            localRule.pattern = "*.local,*.internal,localhost";
            localRule.action = "direct";
            localRule.description = "Direct connection for local networks";
            localRule.enabled = true;
            localRule.createdAt = System.currentTimeMillis();
            addRule(localRule);

            // Правило для IP адресов в приватных сетях
            RoutingRule privateRule = new RoutingRule();
            privateRule.id = "private_ips";
            privateRule.type = "ip";
            privateRule.pattern = "10.0.0.0/8,172.16.0.0/12,192.168.0.0/16";
            privateRule.action = "direct";
            privateRule.description = "Direct connection for private IPs";
            privateRule.enabled = true;
            privateRule.createdAt = System.currentTimeMillis();
            addRule(privateRule);

            prefs.edit().putBoolean("rules_initialized", true).apply();
            Log.d(TAG, "Default rules initialized");
        } catch (Exception e) {
            Log.e(TAG, "Error initializing default rules", e);
        }
    }

    /**
     * Добавляет новое правило
     */
    public boolean addRule(RoutingRule rule) {
        try {
            if (rule.id == null || rule.id.isEmpty()) {
                rule.id = "rule_" + System.currentTimeMillis();
            }
            if (rule.createdAt == 0) {
                rule.createdAt = System.currentTimeMillis();
            }

            JSONArray rules = getAllRulesJson();
            rules.put(rule.toJson());

            prefs.edit().putString("rules", rules.toString()).apply();
            Log.d(TAG, "Rule added: " + rule.id);
            return true;
        } catch (Exception e) {
            Log.e(TAG, "Error adding rule", e);
            return false;
        }
    }

    /**
     * Удаляет правило по ID
     */
    public boolean removeRule(String ruleId) {
        try {
            JSONArray rules = getAllRulesJson();
            JSONArray newRules = new JSONArray();

            for (int i = 0; i < rules.length(); i++) {
                JSONObject rule = rules.getJSONObject(i);
                if (!rule.getString("id").equals(ruleId)) {
                    newRules.put(rule);
                }
            }

            prefs.edit().putString("rules", newRules.toString()).apply();
            Log.d(TAG, "Rule removed: " + ruleId);
            return true;
        } catch (Exception e) {
            Log.e(TAG, "Error removing rule", e);
            return false;
        }
    }

    /**
     * Обновляет правило
     */
    public boolean updateRule(RoutingRule rule) {
        removeRule(rule.id);
        return addRule(rule);
    }

    /**
     * Получает все правила
     */
    public List<RoutingRule> getAllRules() {
        List<RoutingRule> result = new ArrayList<>();
        try {
            JSONArray rules = getAllRulesJson();
            for (int i = 0; i < rules.length(); i++) {
                result.add(RoutingRule.fromJson(rules.getJSONObject(i)));
            }
        } catch (Exception e) {
            Log.e(TAG, "Error getting all rules", e);
        }
        return result;
    }

    /**
     * Получает активные правила
     */
    public List<RoutingRule> getEnabledRules() {
        List<RoutingRule> result = new ArrayList<>();
        for (RoutingRule rule : getAllRules()) {
            if (rule.enabled) {
                result.add(rule);
            }
        }
        return result;
    }

    /**
     * Получает правило по ID
     */
    public RoutingRule getRule(String ruleId) {
        try {
            JSONArray rules = getAllRulesJson();
            for (int i = 0; i < rules.length(); i++) {
                JSONObject obj = rules.getJSONObject(i);
                if (obj.getString("id").equals(ruleId)) {
                    return RoutingRule.fromJson(obj);
                }
            }
        } catch (Exception e) {
            Log.e(TAG, "Error getting rule", e);
        }
        return null;
    }

    /**
     * Получает правила в JSON для Xray конфига
     */
    public String getXrayRoutingRules() {
        try {
            JSONArray xrayRules = new JSONArray();

            for (RoutingRule rule : getEnabledRules()) {
                JSONObject xrayRule = new JSONObject();

                if ("domain".equals(rule.type)) {
                    xrayRule.put("type", "field");
                    JSONArray domains = new JSONArray();
                    for (String domain : rule.pattern.split(",")) {
                        domains.put(domain.trim());
                    }
                    xrayRule.put("domain", domains);
                } else if ("ip".equals(rule.type)) {
                    xrayRule.put("type", "field");
                    JSONArray ips = new JSONArray();
                    for (String ip : rule.pattern.split(",")) {
                        String trimmed = ip.trim();
                        if (trimmed.isEmpty()) continue;
                        
                        // If it's a CIDR range, a valid IPv4, or an IPv6 address, use it as is
                        if (trimmed.contains("/") || isValidIpAddress(trimmed)) {
                            ips.put(trimmed);
                        } else {
                            // Otherwise, assume it's a country code for GeoIP
                            ips.put("geoip:" + trimmed);
                        }
                    }
                    xrayRule.put("ip", ips);
                } else if ("geoip".equals(rule.type)) {
                    xrayRule.put("type", "field");
                    JSONArray geoips = new JSONArray();
                    for (String country : rule.pattern.split(",")) {
                        geoips.put("geoip:" + country.trim());
                    }
                    xrayRule.put("ip", geoips);
                }

                xrayRule.put("outboundTag", rule.action);
                xrayRules.put(xrayRule);
            }

            return xrayRules.toString();
        } catch (Exception e) {
            Log.e(TAG, "Error building Xray rules", e);
            return "[]";
        }
    }

    /**
     * Получает все правила как JSON
     */
    public JSONArray getAllRulesJson() throws JSONException {
        String rulesStr = prefs.getString("rules", "[]");
        return new JSONArray(rulesStr);
    }

    /**
     * Очищает все правила (кроме default)
     */
    public void clearCustomRules() {
        List<RoutingRule> rules = getAllRules();
        for (RoutingRule rule : rules) {
            if (!rule.id.startsWith("local_") && !rule.id.startsWith("private_")) {
                removeRule(rule.id);
            }
        }
        Log.d(TAG, "Custom rules cleared");
    }

    private boolean isValidIpAddress(String ip) {
        if (ip.contains(":")) return true; // IPv6
        return ip.matches("^([0-9]{1,3}\\.){3}[0-9]{1,3}$");
    }

    /**
     * Экспортирует все правила
     */
    public String exportRules() {
        try {
            JSONArray rules = getAllRulesJson();
            JSONObject export = new JSONObject();
            export.put("version", 1);
            export.put("exportedAt", System.currentTimeMillis());
            export.put("rules", rules);
            return export.toString();
        } catch (Exception e) {
            Log.e(TAG, "Error exporting rules", e);
            return null;
        }
    }

    /**
     * Импортирует правила
     */
    public boolean importRules(String jsonData) {
        try {
            JSONObject import_data = new JSONObject(jsonData);
            JSONArray rules = import_data.getJSONArray("rules");

            clearCustomRules();

            for (int i = 0; i < rules.length(); i++) {
                RoutingRule rule = RoutingRule.fromJson(rules.getJSONObject(i));
                addRule(rule);
            }

            Log.d(TAG, "Rules imported: " + rules.length());
            return true;
        } catch (Exception e) {
            Log.e(TAG, "Error importing rules", e);
            return false;
        }
    }
}

