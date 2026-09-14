package online.secboard.homeboard.m.data

import android.content.Context
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.TimeUnit

data class PairResult(
    val cameraId: String,
    val deviceToken: String,
    val name: String,
    val owner: String,
)

class HomeBoardApi(context: Context) {
    private val client: OkHttpClient

    init {
        val appContext = context.applicationContext
        val tm = SslHelper.trustManager(appContext)
        val ssl = SslHelper.sslContext(tm)
        client = OkHttpClient.Builder()
            .connectTimeout(20, TimeUnit.SECONDS)
            .readTimeout(20, TimeUnit.SECONDS)
            .sslSocketFactory(ssl.socketFactory, tm)
            .build()
    }

    fun pair(serverUrl: String, code: String): PairResult {
        val base = serverUrl.trimEnd('/')
        val body = JSONObject().put("code", code.trim().uppercase()).toString()
            .toRequestBody("application/json; charset=utf-8".toMediaType())
        val request = Request.Builder()
            .url("$base/cameras/api/pair/")
            .post(body)
            .header("Accept", "application/json")
            .build()

        client.newCall(request).execute().use { response ->
            val text = response.body?.string().orEmpty()
            val json = runCatching { JSONObject(text) }.getOrNull()
            if (!response.isSuccessful) {
                val err = json?.optString("error").orEmpty().ifBlank { "HTTP ${response.code}" }
                throw IllegalStateException(err)
            }
            require(json != null) { "Порожня відповідь сервера" }
            return PairResult(
                cameraId = json.getString("camera_id"),
                deviceToken = json.getString("device_token"),
                name = json.optString("name", "Camera"),
                owner = json.optString("owner", ""),
            )
        }
    }
}
