package online.secboard.homeboard.bridge

import android.webkit.JavascriptInterface
import online.secboard.homeboard.util.AudioRouter
import online.secboard.homeboard.util.EconomyController
import org.json.JSONObject

class HomeBoardNativeBridge(
    private val economy: EconomyController,
    private val audioRouter: AudioRouter,
    private val onEcoChanged: (Boolean) -> Unit,
    private val onAnalytics: (JSONObject) -> Unit = {},
    private val onTalkback: (Boolean) -> Unit = {},
) {
    @JavascriptInterface
    fun getCapabilities(): String {
        return JSONObject()
            .put("torch", economy.hasFlash())
            .put("eco", true)
            .put("analytics", true)
            .put("phone_detect", false)
            .put("talkback", true)
            .put("speaker", true)
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

    /** Route remote WebRTC audio to the phone loudspeaker. */
    @JavascriptInterface
    fun setSpeakerphone(on: Boolean): Boolean {
        val ok = audioRouter.setSpeakerphone(on)
        if (ok) onTalkback(on)
        return ok
    }

    @JavascriptInterface
    fun isSpeakerphoneOn(): Boolean = audioRouter.isSpeakerOn()

    @JavascriptInterface
    fun onAnalyticsStatus(json: String) {
        val obj = runCatching { JSONObject(json) }.getOrNull() ?: return
        onAnalytics(obj)
    }
}
