package online.secboard.homeboard.bridge

import android.webkit.JavascriptInterface
import online.secboard.homeboard.util.EconomyController
import org.json.JSONObject

class HomeBoardNativeBridge(
    private val economy: EconomyController,
    private val onEcoChanged: (Boolean) -> Unit,
) {
    @JavascriptInterface
    fun getCapabilities(): String {
        return JSONObject()
            .put("torch", economy.hasFlash())
            .put("eco", true)
            .toString()
    }

    @JavascriptInterface
    fun setTorch(on: Boolean): Boolean {
        return economy.setTorch(on)
    }

    @JavascriptInterface
    fun isTorchOn(): Boolean = economy.torchOn

    @JavascriptInterface
    fun setEco(on: Boolean): Boolean {
        onEcoChanged(on)
        return true
    }

    @JavascriptInterface
    fun isEcoOn(): Boolean = economy.ecoScreenOn
}
