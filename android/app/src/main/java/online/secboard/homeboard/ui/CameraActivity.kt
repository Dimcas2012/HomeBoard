package online.secboard.homeboard.ui

import android.Manifest
import android.annotation.SuppressLint
import android.content.pm.PackageManager
import android.net.Uri
import android.net.http.SslError
import android.os.Build
import android.os.Bundle
import android.view.View
import android.view.WindowManager
import android.webkit.PermissionRequest
import android.webkit.SslErrorHandler
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import online.secboard.homeboard.BuildConfig
import online.secboard.homeboard.bridge.HomeBoardNativeBridge
import online.secboard.homeboard.data.HomeBoardApi
import online.secboard.homeboard.data.Prefs
import online.secboard.homeboard.databinding.ActivityCameraBinding
import online.secboard.homeboard.util.AudioRouter
import online.secboard.homeboard.util.EconomyController
import org.json.JSONObject

class CameraActivity : AppCompatActivity() {
    private lateinit var binding: ActivityCameraBinding
    private lateinit var prefs: Prefs
    private lateinit var economy: EconomyController
    private lateinit var audioRouter: AudioRouter
    private val api = HomeBoardApi()
    private var pendingWebPermission: PermissionRequest? = null
    private var pageReady = false
    private var analyticsEnabled = false

    private val permissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions(),
    ) { result ->
        val camOk = result[Manifest.permission.CAMERA] == true ||
            ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) ==
            PackageManager.PERMISSION_GRANTED
        if (!camOk) {
            Toast.makeText(this, "Без доступу до камери стрім неможливий", Toast.LENGTH_LONG).show()
            finish()
            return@registerForActivityResult
        }
        pendingWebPermission?.let { req ->
            try {
                req.grant(req.resources)
            } catch (_: Exception) {
                req.deny()
            }
            pendingWebPermission = null
        }
        if (!pageReady) loadCameraPage()
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityCameraBinding.inflate(layoutInflater)
        setContentView(binding.root)
        prefs = Prefs(this)
        economy = EconomyController(this)
        audioRouter = AudioRouter(this)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        if (!prefs.isPaired) {
            finish()
            return
        }

        binding.overlayTitle.text = prefs.cameraName ?: "HomeBoard Camera"
        binding.btnReload.setOnClickListener {
            pageReady = false
            binding.webView.reload()
        }
        binding.btnTorch.setOnClickListener { toggleTorch() }
        binding.btnEco.setOnClickListener {
            if (economy.ecoScreenOn) exitEconomyMode() else enterEconomyMode()
        }
        binding.ecoCover.setOnClickListener { exitEconomyMode() }

        if (!economy.hasFlash()) {
            binding.btnTorch.isEnabled = false
            binding.btnTorch.alpha = 0.4f
        }

        setupWebView()
        binding.webView.addJavascriptInterface(
            HomeBoardNativeBridge(
                economy,
                audioRouter,
                onEcoChanged = { on ->
                    runOnUiThread {
                        if (on) enterEconomyMode() else exitEconomyMode()
                    }
                },
                onAnalytics = { json ->
                    runOnUiThread { applyAnalyticsUi(json) }
                },
                onTalkback = { on ->
                    runOnUiThread {
                        binding.talkBadge.visibility = if (on) View.VISIBLE else View.GONE
                    }
                },
            ),
            "HomeBoardNative",
        )
        startAnalyticsPolling()
        val needed = arrayOf(Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO)
            .filter {
                ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
            }.toTypedArray()
        if (needed.isEmpty()) loadCameraPage() else permissionLauncher.launch(needed)
    }

    private fun toggleTorch() {
        if (!economy.hasFlash()) {
            Toast.makeText(this, "Ліхтарик недоступний на цьому пристрої", Toast.LENGTH_SHORT).show()
            return
        }
        val ok = economy.toggleTorch()
        if (!ok) {
            Toast.makeText(
                this,
                "Ліхтарик зайнятий камерою. Спробуйте фронтальну камеру в стрімі або вимкніть/увімкніть знову.",
                Toast.LENGTH_LONG,
            ).show()
            updateTorchUi()
            return
        }
        updateTorchUi()
    }

    private fun updateTorchUi() {
        binding.btnTorch.text = if (economy.torchOn) "Ліхтар●" else "Ліхтар"
        binding.btnTorch.setTextColor(
            ContextCompat.getColor(
                this,
                if (economy.torchOn) online.secboard.homeboard.R.color.hb_warn
                else online.secboard.homeboard.R.color.hb_accent,
            ),
        )
    }

    private fun enterEconomyMode() {
        economy.enterEcoScreen(window)
        binding.ecoCover.visibility = View.VISIBLE
        binding.overlay.visibility = View.GONE
        // Opaque overlay used to steal focus and freeze WebRTC; keep WebView alive under dim screen.
        binding.webView.resumeTimers()
        binding.webView.onResume()
        keepStreamAliveInEco()
        Toast.makeText(
            this,
            if (analyticsEnabled) "Економ-режим: екран затемнено, стрім і AI працюють"
            else "Економ-режим: екран затемнено, стрім працює",
            Toast.LENGTH_SHORT,
        ).show()
    }

    private fun exitEconomyMode() {
        economy.exitEcoScreen(window)
        binding.ecoCover.visibility = View.GONE
        binding.overlay.visibility = View.VISIBLE
        binding.webView.evaluateJavascript(
            "(function(){ try { if (window.HomeBoardEco) window.HomeBoardEco(false); } catch(e) {} })();",
            null,
        )
    }

    /** Nudge WebView media tracks so Chromium does not park the camera while dimmed. */
    private fun keepStreamAliveInEco() {
        val js = """
            (function() {
              try {
                if (window.HomeBoardEco) window.HomeBoardEco(true);
                document.querySelectorAll('video').forEach(function(v) {
                  try { v.play(); } catch (e) {}
                });
              } catch (e) {}
            })();
        """.trimIndent()
        binding.webView.evaluateJavascript(js, null)
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun setupWebView() {
        val allowedHost = runCatching { Uri.parse(prefs.serverUrl).host?.lowercase() }.getOrNull()
        val web = binding.webView
        web.setLayerType(View.LAYER_TYPE_HARDWARE, null)

        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            cacheMode = WebSettings.LOAD_DEFAULT
            mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
            userAgentString = "$userAgentString HomeBoardAndroid/${BuildConfig.VERSION_NAME}"
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                offscreenPreRaster = true
            }
        }

        WebView.setWebContentsDebuggingEnabled(true)

        web.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest?) {
                if (request == null) return
                runOnUiThread {
                    val missing = mutableListOf<String>()
                    if (request.resources.any { it == PermissionRequest.RESOURCE_VIDEO_CAPTURE } &&
                        ContextCompat.checkSelfPermission(
                            this@CameraActivity,
                            Manifest.permission.CAMERA,
                        ) != PackageManager.PERMISSION_GRANTED
                    ) {
                        missing += Manifest.permission.CAMERA
                    }
                    if (request.resources.any { it == PermissionRequest.RESOURCE_AUDIO_CAPTURE } &&
                        ContextCompat.checkSelfPermission(
                            this@CameraActivity,
                            Manifest.permission.RECORD_AUDIO,
                        ) != PackageManager.PERMISSION_GRANTED
                    ) {
                        missing += Manifest.permission.RECORD_AUDIO
                    }
                    if (missing.isEmpty()) {
                        try {
                            request.grant(request.resources)
                        } catch (_: Exception) {
                            request.deny()
                        }
                    } else {
                        pendingWebPermission = request
                        permissionLauncher.launch(missing.toTypedArray())
                    }
                }
            }
        }

        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(
                view: WebView?,
                request: WebResourceRequest?,
            ): Boolean {
                val scheme = request?.url?.scheme?.lowercase()
                return scheme == "intent" || scheme == "market"
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                pageReady = true
                injectCredentialsAndStart(view)
            }

            @SuppressLint("WebViewClientOnReceivedSslError")
            override fun onReceivedSslError(
                view: WebView?,
                handler: SslErrorHandler?,
                error: SslError?,
            ) {
                val host = runCatching { Uri.parse(error?.url ?: view?.url).host?.lowercase() }
                    .getOrNull()
                val okHost = host != null && (
                    host == allowedHost || host.endsWith(".secboard.online")
                    )
                if (okHost && error?.primaryError == SslError.SSL_UNTRUSTED) {
                    handler?.proceed()
                } else {
                    handler?.cancel()
                }
            }
        }
    }

    private fun loadCameraPage() {
        val base = prefs.serverUrl.trimEnd('/')
        binding.webView.loadUrl(
            "$base/camera/?autostart=1&app=android&v=${BuildConfig.VERSION_CODE}",
        )
    }

    private fun startAnalyticsPolling() {
        lifecycleScope.launch {
            while (isActive) {
                refreshAnalyticsFromServer()
                delay(20_000)
            }
        }
    }

    private suspend fun refreshAnalyticsFromServer() {
        val cameraId = prefs.cameraId ?: return
        val token = prefs.deviceToken ?: return
        val server = prefs.serverUrl
        val json = runCatching {
            withContext(Dispatchers.IO) {
                api.analyticsSettings(server, cameraId, token)
            }
        }.getOrNull() ?: return
        applyAnalyticsUi(json)
    }

    private fun applyAnalyticsUi(json: JSONObject) {
        val enabled = json.optBoolean("enabled", false)
        val assist = json.optBoolean("phone_assist", false)
        analyticsEnabled = enabled
        if (!enabled) {
            binding.aiBadge.visibility = View.GONE
            binding.ecoAiHint.visibility = View.GONE
            return
        }
        binding.aiBadge.visibility = View.VISIBLE
        binding.aiBadge.text = if (assist) getString(online.secboard.homeboard.R.string.ai_phone)
            else getString(online.secboard.homeboard.R.string.ai_badge)
        binding.ecoAiHint.visibility = View.VISIBLE
    }

    private fun injectCredentialsAndStart(view: WebView?) {
        val cameraId = prefs.cameraId ?: return
        val token = prefs.deviceToken ?: return
        val name = prefs.cameraName ?: "Camera"
        val nameLiteral = JSONObject.quote(name)
        val js = """
            (function() {
              var data = {
                camera_id: ${JSONObject.quote(cameraId)},
                device_token: ${JSONObject.quote(token)},
                name: $nameLiteral
              };
              try { localStorage.setItem('homeboard_camera', JSON.stringify(data)); } catch (e) {}
              if (window.HomeBoardSetCreds) {
                try { window.HomeBoardSetCreds(data); } catch (e) {}
              }
              var pair = document.getElementById('pair-form');
              var live = document.getElementById('live-controls');
              var nameEl = document.getElementById('camName');
              var status = document.getElementById('status');
              if (pair) pair.hidden = true;
              if (live) live.hidden = false;
              if (nameEl) nameEl.textContent = $nameLiteral;
              if (status) status.textContent = 'Автостарт…';
              setTimeout(function() {
                var btn = document.getElementById('btnStart');
                if (btn && !btn.disabled) btn.click();
              }, 500);
            })();
        """.trimIndent()
        view?.evaluateJavascript(js, null)
    }

    override fun onPause() {
        // Never call webView.onPause() — it freezes getUserMedia / WebRTC.
        if (economy.ecoScreenOn) {
            binding.webView.resumeTimers()
            binding.webView.onResume()
            keepStreamAliveInEco()
        }
        super.onPause()
    }

    override fun onResume() {
        super.onResume()
        binding.webView.onResume()
        binding.webView.resumeTimers()
        if (economy.ecoScreenOn) keepStreamAliveInEco()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus || economy.ecoScreenOn) {
            binding.webView.resumeTimers()
            binding.webView.onResume()
        }
    }

    override fun onDestroy() {
        audioRouter.release()
        economy.release()
        economy.exitEcoScreen(window)
        binding.webView.apply {
            loadUrl("about:blank")
            stopLoading()
            clearHistory()
            removeAllViews()
            destroy()
        }
        super.onDestroy()
    }
}
