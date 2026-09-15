package online.secboard.homeboard.data

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

class HomeBoardApi(
    private val client: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        .build(),
) {
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

    fun analyticsSettings(serverUrl: String, cameraId: String, token: String): JSONObject {
        val base = serverUrl.trimEnd('/')
        val request = Request.Builder()
            .url("$base/analytics/api/device/settings/")
            .get()
            .header("Accept", "application/json")
            .header("X-Camera-Id", cameraId)
            .header("X-Device-Token", token)
            .build()

        client.newCall(request).execute().use { response ->
            val text = response.body?.string().orEmpty()
            val json = runCatching { JSONObject(text) }.getOrNull()
                ?: throw IllegalStateException("Порожня відповідь AI")
            if (!response.isSuccessful) {
                val err = json.optString("error").ifBlank { "HTTP ${response.code}" }
                throw IllegalStateException(err)
            }
            return json
        }
    }
}
