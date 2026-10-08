package com.doolimoa.app

import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.ProgressBar
import android.widget.TextView
import com.android.installreferrer.api.InstallReferrerClient
import com.android.installreferrer.api.InstallReferrerStateListener
import com.kakao.sdk.common.KakaoSdk
import com.kakao.sdk.template.model.Link
import com.kakao.sdk.template.model.TextTemplate
import com.kakao.sdk.user.UserApiClient
import com.kakao.sdk.share.ShareClient
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLDecoder
import java.nio.charset.StandardCharsets
import java.util.concurrent.Executors

class MainActivity : Activity() {
    private lateinit var webView: WebView
    private lateinit var offlineView: View
    private val io = Executors.newSingleThreadExecutor()
    private val prefs by lazy { getSharedPreferences("secure-auth", MODE_PRIVATE) }
    private var pendingFirebaseCustomToken: String? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.statusBarColor = Color.rgb(255, 241, 242)
        window.navigationBarColor = Color.WHITE
        window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR
        if (BuildConfig.KAKAO_NATIVE_KEY.isNotBlank()) KakaoSdk.init(applicationContext, BuildConfig.KAKAO_NATIVE_KEY)

        val root = FrameLayout(this)
        webView = WebView(this)
        val progress = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply {
            max = 100
            progressTintList = android.content.res.ColorStateList.valueOf(Color.rgb(244, 63, 94))
        }
        root.addView(webView, FrameLayout.LayoutParams(-1, -1))
        root.addView(progress, FrameLayout.LayoutParams(-1, dp(3), Gravity.TOP))
        offlineView = TextView(this).apply {
            text = "인터넷 연결을 확인한 뒤 다시 시도해 주세요.\n화면을 눌러 새로고침할 수 있어요."
            setTextColor(Color.rgb(75, 85, 99)); textSize = 16f; gravity = Gravity.CENTER
            setBackgroundColor(Color.WHITE); visibility = View.GONE
            setOnClickListener { webView.reload() }
        }
        root.addView(offlineView, FrameLayout.LayoutParams(-1, -1))
        setContentView(root)

        webView.settings.javaScriptEnabled = true
        webView.settings.domStorageEnabled = true
        webView.settings.databaseEnabled = true
        webView.settings.loadsImagesAutomatically = true
        webView.settings.javaScriptCanOpenWindowsAutomatically = true
        webView.settings.setSupportMultipleWindows(false)
        webView.settings.mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true)
        webView.addJavascriptInterface(NativeAuthBridge(), "NativeAuth")
        webView.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView?, newProgress: Int) {
                progress.progress = newProgress
                progress.visibility = if (newProgress >= 100) View.GONE else View.VISIBLE
            }
        }
        webView.webViewClient = object : WebViewClient() {
            override fun onPageStarted(view: WebView?, url: String?, favicon: android.graphics.Bitmap?) { offlineView.visibility = View.GONE }
            override fun onPageFinished(view: WebView?, url: String?) {
                prefs.getString("pending_invite", null)?.let { token ->
                    webView.evaluateJavascript("window.setPendingInviteToken && window.setPendingInviteToken(${JSONObject.quote(token)})", null)
                }
            }
            override fun onReceivedError(view: WebView?, request: WebResourceRequest?, error: android.webkit.WebResourceError?) {
                if (request?.isForMainFrame == true) offlineView.visibility = View.VISIBLE
            }
            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                val url = request?.url ?: return true
                if (url.scheme == "file" && url.path?.startsWith("/android_asset/") == true) return false
                if (url.scheme == "https" || url.scheme == "http") {
                    runCatching { startActivity(Intent(Intent.ACTION_VIEW, url)) }
                    return true
                }
                return true
            }
        }
        processInviteIntent(intent)
        fetchInstallReferrer()
        webView.loadUrl("file:///android_asset/index.html")
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        processInviteIntent(intent)
    }

    private fun processInviteIntent(intent: Intent?) {
        val uri = intent?.data
        val token = uri?.getQueryParameter("token") ?: intent?.getStringExtra("invite_token")
        if (!token.isNullOrBlank()) {
            prefs.edit().putString("pending_invite", token).apply()
            if (::webView.isInitialized) webView.evaluateJavascript("window.setPendingInviteToken && window.setPendingInviteToken(${JSONObject.quote(token)})", null)
        }
    }

    private fun fetchInstallReferrer() {
        val client = InstallReferrerClient.newBuilder(this).build()
        client.startConnection(object : InstallReferrerStateListener {
            override fun onInstallReferrerSetupFinished(responseCode: Int) {
                if (responseCode == InstallReferrerClient.InstallReferrerResponse.OK) {
                    runCatching {
                        val raw = client.installReferrer.installReferrer
                        val decoded = URLDecoder.decode(raw, StandardCharsets.UTF_8.name())
                        val token = Regex("(?:^|&)invite=([^&]+)").find(decoded)?.groupValues?.get(1)
                        if (!token.isNullOrBlank()) {
                            prefs.edit().putString("pending_invite", token).apply()
                            runOnUiThread { webView.evaluateJavascript("window.setPendingInviteToken && window.setPendingInviteToken(${JSONObject.quote(token)})", null) }
                        }
                    }
                }
                client.endConnection()
            }
            override fun onInstallReferrerServiceDisconnected() = Unit
        })
    }

    private inner class NativeAuthBridge {
        @JavascriptInterface fun loginWithKakao() = runOnUiThread {
            if (BuildConfig.KAKAO_NATIVE_KEY.isBlank()) {
                notifyJs("window.onNativeAuthError('Android 설정에 카카오 네이티브 앱 키가 없습니다.')")
                return@runOnUiThread
            }
            val callback: (com.kakao.sdk.auth.model.OAuthToken?, Throwable?) -> Unit = { token, error ->
                when {
                    error != null && UserApiClient.instance.isKakaoTalkLoginAvailable(this@MainActivity) -> {
                        UserApiClient.instance.loginWithKakaoAccount(this@MainActivity) { accountToken, accountError -> handleLogin(accountToken, accountError) }
                    }
                    error != null -> handleLogin(null, error)
                    token != null -> exchangeKakaoToken(token.accessToken)
                }
            }
            if (UserApiClient.instance.isKakaoTalkLoginAvailable(this@MainActivity)) UserApiClient.instance.loginWithKakaoTalk(this@MainActivity, callback = callback)
            else UserApiClient.instance.loginWithKakaoAccount(this@MainActivity, callback = callback)
        }

        @JavascriptInterface fun shareText(text: String) = runOnUiThread {
            startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).apply {
                type = "text/plain"; putExtra(Intent.EXTRA_TEXT, text)
            }, "초대 링크 공유"))
        }

        @JavascriptInterface fun shareKakao(url: String) = runOnUiThread {
            if (BuildConfig.KAKAO_NATIVE_KEY.isBlank()) {
                shareText("둘이모아 가계부 초대 링크입니다. $url"); return@runOnUiThread
            }
            val template = TextTemplate(
                text = "둘이모아 가계부에 초대합니다. 링크를 열어 24시간 안에 연결해 주세요.",
                link = Link(webUrl = url, mobileWebUrl = url),
                buttonTitle = "초대 수락하기"
            )
            if (!ShareClient.instance.isKakaoTalkSharingAvailable(this@MainActivity)) {
                shareText("둘이모아 가계부 초대 링크입니다. $url"); return@runOnUiThread
            }
            ShareClient.instance.shareDefault(this@MainActivity, template) { result, error ->
                if (error != null) notifyJs("window.onNativeAuthError('카카오톡 공유를 열지 못했습니다.')")
                else if (result != null) runCatching { startActivity(result.intent) }
            }
        }

        @JavascriptInterface fun clearPendingInvite() { prefs.edit().remove("pending_invite").apply() }
    }

    private fun handleLogin(token: com.kakao.sdk.auth.model.OAuthToken?, error: Throwable?) {
        if (error != null || token == null) {
            notifyJs("window.onNativeAuthError('카카오 로그인이 취소되었거나 실패했습니다.')")
            return
        }
        exchangeKakaoToken(token.accessToken)
    }

    private fun exchangeKakaoToken(accessToken: String) {
        io.execute {
            try {
                val connection = (URL(BuildConfig.KAKAO_EXCHANGE_URL).openConnection() as HttpURLConnection).apply {
                    requestMethod = "POST"; connectTimeout = 10_000; readTimeout = 10_000; doOutput = true
                    setRequestProperty("Content-Type", "application/json")
                    setRequestProperty("Accept", "application/json")
                }
                connection.outputStream.use { it.write(JSONObject().put("accessToken", accessToken).toString().toByteArray()) }
                val status = connection.responseCode
                val stream = if (status in 200..299) connection.inputStream else connection.errorStream
                val body = stream.bufferedReader().use { it.readText() }
                connection.disconnect()
                if (status !in 200..299) throw IllegalStateException("로그인 인증 서버가 요청을 거부했습니다.")
                val customToken = JSONObject(body).getString("customToken")
                runOnUiThread { deliverFirebaseCustomToken(customToken) }
            } catch (error: Exception) {
                runOnUiThread { notifyJs("window.onNativeAuthError(${JSONObject.quote(error.message ?: "로그인 인증에 실패했습니다.")})") }
            }
        }
    }

    /** The Firebase module callback may not exist yet after WebView/activity recreation. */
    private fun deliverFirebaseCustomToken(token: String, attempt: Int = 0) {
        if (!::webView.isInitialized) {
            pendingFirebaseCustomToken = token
            return
        }
        pendingFirebaseCustomToken = token
        webView.evaluateJavascript("typeof window.onNativeFirebaseCustomToken === 'function' ? 'ready' : 'waiting'") { result ->
            if (pendingFirebaseCustomToken != token) return@evaluateJavascript
            if (result?.trim('"') == "ready") {
                pendingFirebaseCustomToken = null
                webView.evaluateJavascript("window.onNativeFirebaseCustomToken(${JSONObject.quote(token)})", null)
            } else if (attempt < 60) {
                webView.postDelayed({ deliverFirebaseCustomToken(token, attempt + 1) }, 250)
            } else {
                pendingFirebaseCustomToken = null
                notifyJs("window.onNativeAuthError('Firebase 로그인 화면을 준비하지 못했습니다. 앱을 다시 열고 로그인해 주세요.')")
            }
        }
    }

    private fun notifyJs(script: String) { if (::webView.isInitialized) webView.evaluateJavascript(script, null) }
    private fun dp(value: Int) = (value * resources.displayMetrics.density + 0.5f).toInt()
    override fun onBackPressed() { if (::webView.isInitialized && webView.canGoBack()) webView.goBack() else super.onBackPressed() }
    override fun onDestroy() { io.shutdown(); if (::webView.isInitialized) { webView.stopLoading(); webView.destroy() }; super.onDestroy() }
}
