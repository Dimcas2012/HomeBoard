package online.secboard.homeboard.ui

import android.Manifest
import android.annotation.SuppressLint
import android.content.pm.PackageManager
import android.net.Uri
import android.net.http.SslError
import android.os.Bundle
import android.view.View
import android.view.WindowManager
import android.webkit.PermissionRequest
import android.webkit.SslErrorHandler
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import online.secboard.homeboard.bridge.HomeBoardNativeBridge
import online.secboard.homeboard.data.Prefs
import online.secboard.homeboard.databinding.ActivityCameraBinding
import online.secboard.homeboard.util.EconomyController
import org.json.JSONObject

class CameraActivity : AppCompatActivity() {
    private lateinit var binding: ActivityCameraBinding
    private lateinit var prefs: Prefs
    private lateinit var economy: EconomyController
    private var pendingWebPermission: PermissionRequest? = null
    private var pageReady = false

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
            HomeBoardNativeBridge(economy) { on ->
                runOnUiThread {
                    if (on) enterEconomyMode() else exitEconomyMode()
                }
            },
            "HomeBoardNative",
        )
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
        Toast.makeText(this, "Економ-режим: екран затемнено, стрім працює", Toast.LENGTH_SHORT).show()
    }

    private fun exitEconomyMode() {
        economy.exitEcoScreen(window)
        binding.ecoCover.visibility = View.GONE
        binding.overlay.visibility = View.VISIBLE
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
            userAgentString = "$userAgentString HomeBoardAndroid/1.0"
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
        binding.webView.loadUrl("${prefs.serverUrl.trimEnd('/')}/camera/?autostart=1")
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
        // не глушимо стрім у eco — лише при реальному виході з activity torch вимикаємо в onDestroy
        super.onPause()
    }

    override fun onDestroy() {
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
