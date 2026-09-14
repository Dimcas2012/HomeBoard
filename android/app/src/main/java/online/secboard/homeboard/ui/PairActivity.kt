package online.secboard.homeboard.ui

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.view.View
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import online.secboard.homeboard.BuildConfig
import online.secboard.homeboard.data.HomeBoardApi
import online.secboard.homeboard.data.Prefs
import online.secboard.homeboard.databinding.ActivityPairBinding

class PairActivity : AppCompatActivity() {
    private lateinit var binding: ActivityPairBinding
    private lateinit var prefs: Prefs
    private val api = HomeBoardApi()

    private val permissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions(),
    ) { result ->
        val granted = result.values.all { it }
        if (!granted) {
            Toast.makeText(this, online.secboard.homeboard.R.string.permission_required, Toast.LENGTH_LONG).show()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityPairBinding.inflate(layoutInflater)
        setContentView(binding.root)
        prefs = Prefs(this)

        binding.inputServer.setText(prefs.serverUrl.ifBlank { BuildConfig.DEFAULT_SERVER })
        updateSavedButton()
        ensurePermissions()

        binding.btnConnect.setOnClickListener { connect() }
        binding.btnOpenSaved.setOnClickListener {
            if (!prefs.isPaired) {
                Toast.makeText(this, "Спочатку підключіть код pairing", Toast.LENGTH_SHORT).show()
                return@setOnClickListener
            }
            openCamera()
        }
    }

    private fun updateSavedButton() {
        binding.btnOpenSaved.isEnabled = prefs.isPaired
        binding.statusText.text = if (prefs.isPaired) {
            "Збережено: ${prefs.cameraName ?: "Camera"}"
        } else {
            "Не підключено"
        }
    }

    private fun ensurePermissions() {
        val needed = arrayOf(Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO)
            .filter {
                ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
            }
        if (needed.isNotEmpty()) {
            permissionLauncher.launch(needed.toTypedArray())
        }
    }

    private fun connect() {
        val server = binding.inputServer.text?.toString()?.trim().orEmpty()
        val code = binding.inputCode.text?.toString()?.trim().orEmpty()
        if (server.isBlank()) {
            Toast.makeText(this, "Вкажіть URL сервера", Toast.LENGTH_SHORT).show()
            return
        }
        if (code.isBlank()) {
            Toast.makeText(this, "Введіть код pairing", Toast.LENGTH_SHORT).show()
            return
        }

        binding.progress.visibility = View.VISIBLE
        binding.btnConnect.isEnabled = false
        binding.statusText.text = "Підключення…"

        lifecycleScope.launch {
            try {
                val result = withContext(Dispatchers.IO) {
                    api.pair(server, code)
                }
                prefs.serverUrl = server
                prefs.savePairing(result.cameraId, result.deviceToken, result.name)
                binding.statusText.text = "OK: ${result.name}"
                openCamera()
            } catch (e: Exception) {
                binding.statusText.text = e.message ?: "Помилка"
                Toast.makeText(this@PairActivity, e.message ?: "Помилка", Toast.LENGTH_LONG).show()
            } finally {
                binding.progress.visibility = View.GONE
                binding.btnConnect.isEnabled = true
                updateSavedButton()
            }
        }
    }

    private fun openCamera() {
        startActivity(Intent(this, CameraActivity::class.java))
    }
}
