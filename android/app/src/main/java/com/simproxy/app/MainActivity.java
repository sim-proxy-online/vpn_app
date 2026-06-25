package com.simproxy.app;

import android.app.Activity;
import android.content.Intent;
import android.net.VpnService;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import android.content.pm.PackageManager;
import com.simproxy.app.BuildConfig;

public class MainActivity extends Activity {
    private WebView webView;
    private static final int VPN_REQUEST_CODE = 1001;
    private NativeBridge bridge;
    // Deep link, пришедший до готовности страницы (холодный старт): JS-слой ещё
    // не загружен и слушателя 'deeplink' нет. Сохраняем и отдаём по запросу из JS
    // через consumePendingDeepLink() при монтировании.
    private volatile boolean pageReady = false;
    private volatile String pendingDeepLink = null;

    public String consumePendingDeepLink() {
        String u = pendingDeepLink;
        pendingDeepLink = null;
        return u;
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // --- GLOBAL CRASH HANDLER ---
        Thread.setDefaultUncaughtExceptionHandler((thread, throwable) -> {
            android.util.Log.e("SimProxyCRASH", "UNCAUGHT in thread " + thread.getName(), throwable);
            try {
                VpnServiceImpl svc = VpnServiceImpl.getInstance();
                if (svc != null) svc.stopVpn();
            } catch (Throwable ignored) {}
            // НЕ убиваем процесс — позволяем Android показать стандартный диалог об ошибке
        });

        android.util.Log.e("SimProxyMain", "MainActivity onCreate called");

        // Android 13+: без runtime-разрешения POST_NOTIFICATIONS система прячет
        // foreground-уведомление VPN (в шторке ничего не появляется). Запрашиваем его.
        if (Build.VERSION.SDK_INT >= 33) {
            if (ContextCompat.checkSelfPermission(this, android.Manifest.permission.POST_NOTIFICATIONS)
                    != PackageManager.PERMISSION_GRANTED) {
                ActivityCompat.requestPermissions(this,
                    new String[]{ android.Manifest.permission.POST_NOTIFICATIONS }, 2001);
            }
        }

        requestWindowFeature(Window.FEATURE_NO_TITLE);
        getWindow().setBackgroundDrawable(new android.graphics.drawable.ColorDrawable(0xFF0A0A1A));

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            getWindow().getAttributes().layoutInDisplayCutoutMode =
                WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
        }
        getWindow().setFlags(
            WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS
        );

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            getWindow().setDecorFitsSystemWindows(false);
        } else {
            //noinspection deprecation
            getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_LAYOUT_STABLE | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
            );
        }

        webView = new WebView(this);
        webView.setBackgroundColor(0xFF0A0A1A); // Set dark background early
        
        // Enable Hardware Acceleration
        webView.setLayerType(View.LAYER_TYPE_HARDWARE, null);
        
        getWindow().setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE);
        setContentView(webView);

        WebSettings ws = webView.getSettings();
        ws.setJavaScriptEnabled(true);
        ws.setDomStorageEnabled(true);
        ws.setDatabaseEnabled(true);
        ws.setAllowFileAccess(true);
        ws.setAllowContentAccess(true);
        ws.setLoadWithOverviewMode(true);
        ws.setUseWideViewPort(true);
        
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT) {
            WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
        }
        
        // Performance optimizations
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            ws.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        }

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                android.util.Log.d("SimProxyMain", "WebView page finished loading");
                pageReady = true;
                // Pending-ссылку НЕ диспатчим автоматически: React-слушатель
                // 'deeplink' навешивается чуть позже монтирования. JS сам заберёт
                // её через nativeGetPendingDeepLink() на старте.
            }

            @Override
            public void onReceivedError(WebView view, int errorCode, String description, String failingUrl) {
                android.util.Log.e("SimProxyMain", "WebView error: " + errorCode + " " + description + " " + failingUrl);
            }
        });
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(android.webkit.ConsoleMessage consoleMessage) {
                android.util.Log.d("SimProxyUI", consoleMessage.message() + " -- From line "
                        + consoleMessage.lineNumber() + " of "
                        + consoleMessage.sourceId());
                return true;
            }
        });
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);

        android.util.Log.e("SimProxyMain", "Registering SimNativeV2 JavaScript interface");
        bridge = new NativeBridge(this, webView);
        webView.addJavascriptInterface(bridge, "SimNativeV2");

        // Load the page (assets are in assets/ folder, not public/)
        android.util.Log.d("SimProxyMain", "Loading file:///android_asset/index.html");
        webView.loadUrl("file:///android_asset/index.html");

        handleDeepLink(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        handleDeepLink(intent);
    }

    private void handleDeepLink(Intent intent) {
        if (intent == null || intent.getData() == null) return;
        String uri = intent.getData().toString();
        if (pageReady) {
            // Тёплый старт: страница и React-слушатель уже есть — диспатчим сразу.
            // Экранируем URI через JSON.stringify чтобы избежать XSS (newline injection и т.д.)
            String escaped = org.json.JSONObject.quote(uri);
            webView.evaluateJavascript(
                "window.dispatchEvent(new CustomEvent('deeplink',{detail:" + escaped + "}))",
                null
            );
        } else {
            // Холодный старт: придержим до запроса из JS.
            pendingDeepLink = uri;
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == VPN_REQUEST_CODE && resultCode == RESULT_OK) {
            webView.evaluateJavascript("window.dispatchEvent(new Event('vpn-permission-granted'))", null);
        }
        if (bridge != null) {
            bridge.onActivityResult(requestCode, resultCode, data);
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (bridge != null) {
            bridge.onPermissionResult(requestCode, permissions, grantResults);
        }
    }

    @Override
    public void onBackPressed() {
        // Dispatch custom event to JS layer for app-side navigation handling
        webView.evaluateJavascript("window.dispatchEvent(new Event('androidback'))", null);
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (webView != null) {
            webView.evaluateJavascript("window.dispatchEvent(new Event('app-paused'))", null);
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) {
            webView.evaluateJavascript("window.dispatchEvent(new Event('app-resumed'))", null);
        }
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.destroy();
        }
        super.onDestroy();
    }
}
