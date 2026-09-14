package online.secboard.homeboard.m.ui

import android.Manifest
import android.annotation.SuppressLint
import android.content.pm.PackageManager
import android.net.Uri
import android.net.http.SslError
import android.os.Build
import android.os.Bundle
import android.view.View
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
import online.secboard.homeboard.m.data.Prefs
import online.secboard.homeboard.m.databinding.ActivityCameraBinding
import org.json.JSONObject

class CameraActivity : AppCompatActivity() {
    private lateinit var binding: ActivityCameraBinding
    private lateinit var prefs: Prefs
    private var pendingWebPermission: PermissionRequest? = null
    private var pageReady = false

    private val permissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions(),
    ) { result ->
        val camOk = result[Manifest.permission.CAMERA] == true ||
            ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) ==
            PackageManager.PERMISSION_GRANTED
        val micOk = result[Manifest.permission.RECORD_AUDIO] == true ||
            ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) ==
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
        if (!micOk) {
            Toast.makeText(this, "Мікрофон не дозволено — відео без звуку", Toast.LENGTH_SHORT).show()
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityCameraBinding.inflate(layoutInflater)
        setContentView(binding.root)
        prefs = Prefs(this)

        if (!prefs.isPaired) {
            finish()
            return
        }

        binding.overlayTitle.text = prefs.cameraName ?: "HomeBoard Camera M"
        binding.btnReload.setOnClickListener {
            pageReady = false
            binding.webView.reload()
        }

        setupWebView()
        ensureAndroidPermissionsThenLoad()
    }

    private fun neededPermissions(): Array<String> {
        return arrayOf(Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO)
            .filter {
                ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
            }.toTypedArray()
    }

    private fun ensureAndroidPermissionsThenLoad() {
        val needed = neededPermissions()
        if (needed.isEmpty()) {
            loadCameraPage()
        } else {
            permissionLauncher.launch(needed)
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun setupWebView() {
        val allowedHost = runCatching { Uri.parse(prefs.serverUrl).host?.lowercase() }.getOrNull()
        val web = binding.webView
        web.setLayerType(View.LAYER_TYPE_HARDWARE, null)

        @Suppress("DEPRECATION")
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            mediaPlaybackRequiresUserGesture = false
            cacheMode = WebSettings.LOAD_DEFAULT
            allowFileAccess = false
            loadsImagesAutomatically = true
            userAgentString = "$userAgentString HomeBoardAndroidM/1.0"
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.JELLY_BEAN_MR1) {
                mediaPlaybackRequiresUserGesture = false
            }
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT) {
            WebView.setWebContentsDebuggingEnabled(true)
        }

        web.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest?) {
                if (request == null) return
                runOnUiThread {
                    val needCam = request.resources.any {
                        it == PermissionRequest.RESOURCE_VIDEO_CAPTURE
                    }
                    val needMic = request.resources.any {
                        it == PermissionRequest.RESOURCE_AUDIO_CAPTURE
                    }
                    val missing = mutableListOf<String>()
                    if (needCam && ContextCompat.checkSelfPermission(
                            this@CameraActivity,
                            Manifest.permission.CAMERA,
                        ) != PackageManager.PERMISSION_GRANTED
                    ) {
                        missing += Manifest.permission.CAMERA
                    }
                    if (needMic && ContextCompat.checkSelfPermission(
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
                    host == allowedHost ||
                        host.endsWith(".secboard.online") ||
                        host == "homeboard.secboard.online"
                    )
                val untrusted = error?.primaryError == SslError.SSL_UNTRUSTED ||
                    error?.primaryError == SslError.SSL_DATE_INVALID
                if (okHost && untrusted) handler?.proceed() else handler?.cancel()
            }
        }
    }

    private fun loadCameraPage() {
        val url = "${prefs.serverUrl.trimEnd('/')}/camera/?autostart=1"
        binding.webView.loadUrl(url)
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

    override fun onDestroy() {
        try {
            binding.webView.apply {
                loadUrl("about:blank")
                stopLoading()
                clearHistory()
                removeAllViews()
                destroy()
            }
        } catch (_: Exception) {
        }
        super.onDestroy()
    }
}
