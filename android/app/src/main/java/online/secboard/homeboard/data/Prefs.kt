package online.secboard.homeboard.data

import android.content.Context
import online.secboard.homeboard.BuildConfig

class Prefs(context: Context) {
    private val sp = context.getSharedPreferences("homeboard", Context.MODE_PRIVATE)

    var serverUrl: String
        get() = sp.getString(KEY_SERVER, BuildConfig.DEFAULT_SERVER)?.trimEnd('/')
            ?: BuildConfig.DEFAULT_SERVER
        set(value) = sp.edit().putString(KEY_SERVER, value.trimEnd('/')).apply()

    var cameraId: String?
        get() = sp.getString(KEY_CAMERA_ID, null)
        set(value) = sp.edit().putString(KEY_CAMERA_ID, value).apply()

    var deviceToken: String?
        get() = sp.getString(KEY_TOKEN, null)
        set(value) = sp.edit().putString(KEY_TOKEN, value).apply()

    var cameraName: String?
        get() = sp.getString(KEY_NAME, null)
        set(value) = sp.edit().putString(KEY_NAME, value).apply()

    val isPaired: Boolean
        get() = !cameraId.isNullOrBlank() && !deviceToken.isNullOrBlank()

    fun savePairing(cameraId: String, deviceToken: String, name: String?) {
        sp.edit()
            .putString(KEY_CAMERA_ID, cameraId)
            .putString(KEY_TOKEN, deviceToken)
            .putString(KEY_NAME, name)
            .apply()
    }

    fun clearPairing() {
        sp.edit()
            .remove(KEY_CAMERA_ID)
            .remove(KEY_TOKEN)
            .remove(KEY_NAME)
            .apply()
    }

    companion object {
        private const val KEY_SERVER = "server_url"
        private const val KEY_CAMERA_ID = "camera_id"
        private const val KEY_TOKEN = "device_token"
        private const val KEY_NAME = "camera_name"
    }
}
