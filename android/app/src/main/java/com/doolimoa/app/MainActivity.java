package com.doolimoa.app;

import android.app.Activity;
import android.graphics.Bitmap;
import android.os.Bundle;
import android.os.Build;
import android.view.WindowInsets;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.window.OnBackInvokedCallback;
import android.window.OnBackInvokedDispatcher;
import android.widget.ProgressBar;
import android.widget.FrameLayout;
import android.widget.TextView;
import android.view.Gravity;
import android.graphics.Color;

public class MainActivity extends Activity {
    private static final String HOME_URL = "file:///android_asset/index.html";
    private WebView webView;
    private View offlineView;
    private OnBackInvokedCallback backInvokedCallback;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(Color.rgb(255, 241, 242));
        getWindow().setNavigationBarColor(Color.WHITE);
        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR);

        FrameLayout root = new FrameLayout(this);
        webView = new WebView(this);
        ProgressBar progress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progress.setIndeterminate(false);
        progress.setMax(100);
        progress.setProgressTintList(android.content.res.ColorStateList.valueOf(Color.rgb(244, 63, 94)));
        FrameLayout.LayoutParams progressParams = new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, dp(3), Gravity.TOP);
        root.addView(webView, new FrameLayout.LayoutParams(-1, -1));
        root.addView(progress, progressParams);

        TextView offline = new TextView(this);
        offline.setText("인터넷 연결을 확인한 뒤 다시 시도해 주세요.\n화면을 눌러 새로고침할 수 있어요.");
        offline.setTextColor(Color.rgb(75, 85, 99));
        offline.setTextSize(16);
        offline.setGravity(Gravity.CENTER);
        offline.setBackgroundColor(Color.WHITE);
        offline.setVisibility(View.GONE);
        offline.setOnClickListener(v -> webView.reload());
        root.addView(offline, new FrameLayout.LayoutParams(-1, -1));
        offlineView = offline;
        setContentView(root);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            getWindow().setDecorFitsSystemWindows(false);
            root.setOnApplyWindowInsetsListener((view, insets) -> {
                android.graphics.Insets bars = insets.getInsets(
                        WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                view.setPadding(bars.left, bars.top, bars.right, bars.bottom);
                return insets;
            });
        }

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setLoadsImagesAutomatically(true);
        settings.setJavaScriptCanOpenWindowsAutomatically(true);
        settings.setSupportMultipleWindows(false);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true);

        webView.setWebChromeClient(new WebChromeClient() {
            @Override public void onProgressChanged(WebView view, int newProgress) {
                progress.setProgress(newProgress);
                progress.setVisibility(newProgress >= 100 ? View.GONE : View.VISIBLE);
            }
        });
        webView.setWebViewClient(new WebViewClient() {
            @Override public void onPageStarted(WebView view, String url, Bitmap favicon) {
                offlineView.setVisibility(View.GONE);
                super.onPageStarted(view, url, favicon);
            }
            @Override public void onReceivedError(WebView view, WebResourceRequest request,
                                                  android.webkit.WebResourceError error) {
                super.onReceivedError(view, request, error);
                if (request.isForMainFrame()) offlineView.setVisibility(View.VISIBLE);
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                String scheme = request.getUrl().getScheme();
                return !"https".equalsIgnoreCase(scheme) && !"http".equalsIgnoreCase(scheme);
            }
        });

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            backInvokedCallback = this::navigateBack;
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                    OnBackInvokedDispatcher.PRIORITY_DEFAULT, backInvokedCallback);
        }

        if (savedInstanceState == null) webView.loadUrl(HOME_URL);
        else webView.restoreState(savedInstanceState);
    }

    private int dp(int value) {
        return (int) (value * getResources().getDisplayMetrics().density + 0.5f);
    }

    @Override protected void onSaveInstanceState(Bundle outState) {
        webView.saveState(outState);
        super.onSaveInstanceState(outState);
    }

    @Override public void onBackPressed() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) navigateBack();
        else super.onBackPressed();
    }

    private void navigateBack() {
        if (webView != null && webView.canGoBack()) webView.goBack();
        else finish();
    }

    @Override protected void onDestroy() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && backInvokedCallback != null) {
            getOnBackInvokedDispatcher().unregisterOnBackInvokedCallback(backInvokedCallback);
        }
        if (webView != null) {
            webView.stopLoading();
            webView.destroy();
        }
        super.onDestroy();
    }
}
