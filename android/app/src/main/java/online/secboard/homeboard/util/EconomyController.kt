package online.secboard.homeboard.util

import android.content.Context
import android.content.pm.PackageManager
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.view.Window
import android.view.WindowManager

class EconomyController(private val context: Context) {
    private val cameraManager =
        context.getSystemService(Context.CAMERA_SERVICE) as CameraManager

    var torchOn: Boolean = false
        private set
    var ecoScreenOn: Boolean = false
        private set

    private var savedBrightness: Float = WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE
    private var torchCameraId: String? = null

    fun hasFlash(): Boolean {
        if (!context.packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_FLASH)) {
            return false
        }
        return findTorchCameraId() != null
    }

    fun setTorch(enabled: Boolean): Boolean {
        val id = findTorchCameraId() ?: return false
        return try {
            cameraManager.setTorchMode(id, enabled)
            torchOn = enabled
            torchCameraId = id
            true
        } catch (_: Exception) {
            // Часто недоступно, коли задня камера вже зайнята WebView
            false
        }
    }

    fun toggleTorch(): Boolean {
        val next = !torchOn
        if (!setTorch(next)) {
            if (next) {
                // повторна спроба вимкнути на всяк випадок
                runCatching { setTorch(false) }
            }
            return false
        }
        return true
    }

    fun enterEcoScreen(window: Window) {
        if (ecoScreenOn) return
        val lp = window.attributes
        savedBrightness = lp.screenBrightness
        lp.screenBrightness = 0.01f
        window.attributes = lp
        // екран залишається «увімкненим» для стріму, але майже чорний
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        ecoScreenOn = true
    }

    fun exitEcoScreen(window: Window) {
        if (!ecoScreenOn) return
        val lp = window.attributes
        lp.screenBrightness = if (savedBrightness > 0f) savedBrightness
        else WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE
        window.attributes = lp
        ecoScreenOn = false
    }

    fun release() {
        if (torchOn) {
            runCatching { setTorch(false) }
        }
    }

    private fun findTorchCameraId(): String? {
        torchCameraId?.let { return it }
        return try {
            cameraManager.cameraIdList.firstOrNull { id ->
                val chars = cameraManager.getCameraCharacteristics(id)
                val hasFlash = chars.get(CameraCharacteristics.FLASH_INFO_AVAILABLE) == true
                val facing = chars.get(CameraCharacteristics.LENS_FACING)
                hasFlash && facing == CameraCharacteristics.LENS_FACING_BACK
            } ?: cameraManager.cameraIdList.firstOrNull { id ->
                cameraManager.getCameraCharacteristics(id)
                    .get(CameraCharacteristics.FLASH_INFO_AVAILABLE) == true
            }
        } catch (_: Exception) {
            null
        }
    }
}
