package com.simproxy.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.drawable.Drawable;
import android.util.Base64;
import android.util.Log;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicReference;

public class SplitTunnelManager {
    private static final String TAG = "SplitTunnelMgr";
    private static final String PREF_NAME   = "sim_split_tunnel";
    // Имя ключа, под которым хранится режим, явно выставленный пользователем.
    // Префикс "_user_" защищает от случайного совпадения с package name.
    private static final String USER_SET_PREFIX = "_user_set_";

    // ── Пресет «Российские сервисы → Напрямую» ───────────────────────────
    // Трафик этих приложений идёт мимо VPN-туннеля: они работают с российских
    // IP и часто ломаются через зарубежный прокси.
    private static final String[] BYPASS_PRESET = {
        // Госуслуги (реальный package name: ru.rtlabs.mobile.ebs.gosuslugi.android)
        "ru.rtlabs.mobile.ebs.gosuslugi.android",
        "ru.gosuslugi",                          // старое имя — на всякий случай
        "ru.gosuslugi.auto",
        "ru.gosuslugi.esiaplus.android",
        // Банки и платежи
        "ru.sberbankmobile",
        "ru.sberbank.sberpay",
        "com.idamob.tinkoff.android",
        "ru.tinkoff.sme",
        "ru.vtb24.mobilebanking.android",
        "ru.alfabank.mobile.android",
        "ru.gazprombank.android",
        "ru.raiffeisen.mobile",
        "ru.pochtabank.android",
        "ru.psbank.android",
        "ru.sovcombank.mobile",
        "ru.openbank.mobile",
        "ru.rosbank.android",
        "ru.akbarsbank.mobile",
        "ru.nspk.mirpay",
        "ru.nspk.sbpay",
        "com.yandex.bank",
        // Соцсети и VK
        "com.vkontakte.android",
        "ru.ok.android",
        "com.vk.vkvideo",                        // VK Видео (реальный пакет)
        "com.vk.clips",                          // старое имя VK Видео
        "com.vk.im",                             // VK Мессенджер
        "com.vk.calls",                          // VK Звонки
        "com.vk.mail",                           // VK Почта
        "com.vk.max",
        // Яндекс-сервисы (без браузера)
        "ru.yandex.searchplugin",
        "ru.yandex.yandexmaps",
        "ru.yandex.yandexnavi",
        "ru.yandex.taxi",
        "ru.yandex.uber",
        "ru.yandex.eda",
        "ru.yandex.disk",
        "ru.yandex.mail",
        "ru.yandex.music",
        "ru.yandex.travel",
        "ru.yandex.kinopoisk",
        "com.yandex.aliceapp",
        "ru.beru.android",
        // Кино и стриминг
        "ru.kinopoisk.android",
        "ru.ivi.client",
        "ru.okko.tv",
        "ru.rutube.app",
        "ru.more.tv",
        "ru.start.android",
        "tv.premier.frontend",
        // Операторы
        "ru.mts.mymts",                          // Мой МТС (реальный пакет)
        "com.mts.mts",                           // старый пакет МТС
        "com.beeline.ru",
        "ru.megafon.mlk",                        // МегаФон (реальный пакет)
        "ru.megafon.online",                     // старый пакет МегаФон
        "ru.tele2.mytele2",
        // Маркетплейсы
        "com.wildberries.ru",
        "ru.ozon.app.android",
        "com.avito.android",                     // Авито (реальный пакет)
        "ru.avito.android",                      // старый пакет Авито
        "ru.lamoda.android",
        // Связь и утилиты
        "ru.oneme.app",
        "ru.rostel",
        // Карты, сервисы, доставка
        "ru.dublgis.dgismobile",
        "ru.rzd.pass",                           // РЖД (реальный пакет)
        "ru.rzd.passenger",                      // старый пакет РЖД
        "ru.cdek.delivery",
        "com.octopod.russianpost.client.android", // Почта России (реальный пакет)
        "ru.russianpost.android",                // старый пакет Почта России
        "ru.hh.android",
        "ru.cian.app",
        "ru.domclick.mobile",
    };

    private static final AtomicReference<SplitTunnelManager> instance = new AtomicReference<>();
    private final Context context;
    private final SharedPreferences prefs;
    private final Map<String, String> appModes = new ConcurrentHashMap<>();

    private SplitTunnelManager(Context ctx) {
        this.context = ctx.getApplicationContext();
        this.prefs = context.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE);
        loadFromPrefs();
        applyPresetDefaults();
    }

    private void loadFromPrefs() {
        Map<String, ?> all = prefs.getAll();
        for (Map.Entry<String, ?> entry : all.entrySet()) {
            if (entry.getValue() instanceof String) {
                appModes.put(entry.getKey(), (String) entry.getValue());
            }
        }
        // Миграция: удаляем устаревшие записи-заглушки (не package name)
        // и старые wrong-пакеты, которые не установлены на устройстве.
        // Это позволяет applyPresetDefaults() снова записать правильные.
        String[] legacyKeys = { "_preset_v1", "_preset_v2", "_preset_v3" };
        SharedPreferences.Editor editor = prefs.edit();
        boolean migrated = false;
        for (String key : legacyKeys) {
            if (appModes.remove(key) != null) {
                editor.remove(key);
                migrated = true;
            }
        }
        if (migrated) editor.apply();
    }

    /**
     * При каждом старте: ставим bypass для пресетных пакетов если они не были
     * явно переведены в режим "always" (VPN) пользователем.
     * "smart" (авто) и незаданные — перезаписываем на "never".
     * Флаги версий не нужны — логика идемпотентна.
     */
    private void applyPresetDefaults() {
        SharedPreferences.Editor editor = prefs.edit();
        boolean changed = false;
        for (String pkg : BYPASS_PRESET) {
            String cur = appModes.get(pkg);
            // Единственный случай когда НЕ трогаем: пользователь явно выбрал VPN
            if ("always".equals(cur)) continue;
            // Уже bypass — не пишем лишний раз на диск
            if ("never".equals(cur)) continue;
            // null (не задан) или "smart" (авто) → ставим bypass
            appModes.put(pkg, "never");
            editor.putString(pkg, "never");
            changed = true;
        }
        if (changed) {
            editor.apply();
            Log.i(TAG, "Preset defaults applied");
        }
    }

    public static SplitTunnelManager getInstance(Context context) {
        if (instance.get() == null) instance.compareAndSet(null, new SplitTunnelManager(context));
        return instance.get();
    }

    public String getInstalledApps() {
        try {
            PackageManager pm = context.getPackageManager();
            List<ApplicationInfo> apps = pm.getInstalledApplications(PackageManager.GET_META_DATA);
            String self = context.getPackageName();
            JSONArray arr = new JSONArray();

            for (ApplicationInfo app : apps) {
                if (app.packageName.equals(self)) continue;

                boolean isSystem = (app.flags & ApplicationInfo.FLAG_SYSTEM) != 0;
                boolean hasLauncher = pm.getLaunchIntentForPackage(app.packageName) != null;
                if (isSystem && !hasLauncher) continue;

                JSONObject obj = new JSONObject();
                obj.put("id", app.packageName);
                obj.put("name", pm.getApplicationLabel(app).toString());
                obj.put("mode", appModes.getOrDefault(app.packageName, "smart"));
                obj.put("system", isSystem);
                String icon = iconToBase64(pm, app);
                if (icon != null) obj.put("icon", icon);
                arr.put(obj);
            }
            return arr.toString();
        } catch (Exception e) {
            Log.e(TAG, "Error getting installed apps", e);
            return "[]";
        }
    }

    private String iconToBase64(PackageManager pm, ApplicationInfo app) {
        Bitmap bmp = null;
        try {
            Drawable d = pm.getApplicationIcon(app);
            int size = 48;
            bmp = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888);
            Canvas canvas = new Canvas(bmp);
            d.setBounds(0, 0, size, size);
            d.draw(canvas);
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            bmp.compress(Bitmap.CompressFormat.PNG, 100, out);
            return "data:image/png;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP);
        } catch (Throwable e) {
            return null;
        } finally {
            if (bmp != null) bmp.recycle();
        }
    }

    public void setAppMode(String packageName, String mode) {
        if (mode.matches("always|never|smart")) {
            appModes.put(packageName, mode);
            prefs.edit().putString(packageName, mode).apply();
            Log.i(TAG, "App mode saved: " + packageName + " -> " + mode);
        }
    }

    public String getAppMode(String packageName) {
        return appModes.getOrDefault(packageName, "smart");
    }

    public String getBypassApps() {
        JSONArray arr = new JSONArray();
        for (Map.Entry<String, String> entry : appModes.entrySet()) {
            if ("never".equals(entry.getValue())) {
                arr.put(entry.getKey());
            }
        }
        return arr.toString();
    }

    public String getProxyApps() {
        JSONArray arr = new JSONArray();
        for (Map.Entry<String, String> entry : appModes.entrySet()) {
            if ("always".equals(entry.getValue())) {
                arr.put(entry.getKey());
            }
        }
        return arr.toString();
    }

    public void clearAll() {
        appModes.clear();
        prefs.edit().clear().apply();
        Log.i(TAG, "All app modes cleared");
    }
}
