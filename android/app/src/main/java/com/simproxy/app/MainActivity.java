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
    // Момент последнего восстановления после падения рендерера WebView. static —
    // чтобы пережить recreate() Activity и не уйти в цикл пересоздания.
    private static long lastRendererRecoveryMs = -1_000_000L;

    public String consumePendingDeepLink() {
        String u = pendingDeepLink;
        pendingDeepLink = null;
        return u;
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Глобальный обработчик необработанных исключений — в SimApplication.
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
        
        // Защита от скриншотов (FLAG_SECURE) убрана по просьбе пользователя: скриншоты экрана и записи
        // экрана разрешены, окно приложения видно в списке недавних.
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

            // К WebView подключён нативный мост SimNativeV2, поэтому он не должен уходить
            // на чужие страницы: они получили бы доступ к мосту. Внешние http(s)-ссылки
            // открываем в браузере, остальное блокируем.
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, android.webkit.WebResourceRequest request) {
                android.net.Uri uri = request.getUrl();
                if ("file".equals(uri.getScheme())) return false; // собственная страница из assets
                String scheme = uri.getScheme();
                if ("http".equals(scheme) || "https".equals(scheme)) {
                    try {
                        startActivity(new Intent(Intent.ACTION_VIEW, uri));
                    } catch (Exception e) {
                        android.util.Log.w("SimProxyMain", "No handler for " + uri, e);
                    }
                }
                return true;
            }

            // Без этого обработчика падение/убийство процесса рендерера (нехватка памяти на
            // слабых устройствах и Android TV) валит ВЕСЬ процесс приложения, а в нём же
            // живёт VPN-сервис. Возвращаем true, чтобы процесс остался, и пересоздаём
            // Activity с новым WebView; состояние VPN UI подхватит из getStats().
            @Override
            @android.annotation.TargetApi(Build.VERSION_CODES.O)
            public boolean onRenderProcessGone(WebView view, android.webkit.RenderProcessGoneDetail detail) {
                android.util.Log.e("SimProxyMain", "WebView render process gone, didCrash=" + detail.didCrash());
                long now = android.os.SystemClock.elapsedRealtime();
                boolean tooSoon = now - lastRendererRecoveryMs < 10_000;
                lastRendererRecoveryMs = now;
                if (!tooSoon) {
                    // Пересоздание безопасно вызывать здесь: колбэк приходит в главном потоке.
                    recreate();
                }
                // Если рендерер падает повторно за 10 с — не зацикливаемся, оставляем процесс живым.
                return true;
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

        // При пересоздании Activity (recreate() после падения рендерера, восстановление
        // после убийства процесса) в getIntent() лежит исходная ссылка — повторно её не
        // обрабатываем, иначе прежнее действие выполнится снова.
        if (savedInstanceState == null) handleDeepLink(getIntent());
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
        if (bridge != null) {
            bridge.shutdownExecutors();
        }
        if (webView != null) {
            webView.destroy();
        }
        super.onDestroy();
    }
}
