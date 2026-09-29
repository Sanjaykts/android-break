package dev.breakremote.lab

import android.util.Log
import org.json.JSONObject
import java.io.BufferedReader
import java.net.HttpURLConnection
import java.net.URL
import java.time.Instant

/**
 * Telemetry client (proposal sections 7.6, 8 and 9).
 *
 * Deliberately plain: `HttpURLConnection` on a background thread. No HTTP
 * library, because the fewer moving parts on the device side, the clearer the
 * network capture is during the demonstration, and §11 requires a sanitised
 * capture as evidence.
 *
 * Every payload carries `data_class: TEST_ONLY`. The server rejects anything
 * without it, so this field is the contract between the two halves — and the
 * client is not the enforcement point, the server is. A compromised or buggy
 * client still cannot get non-synthetic data into the evidence store.
 */

object Telemetry {

    const val TAG = "lab/telemetry"

    const val EV_SESSION_START = "SESSION_START"
    const val EV_APP_LAUNCH = "APP_LAUNCH"
    const val EV_PERMISSION_PROMPT = "PERMISSION_PROMPT"
    const val EV_PERMISSION_GRANTED = "PERMISSION_GRANTED"
    const val EV_PERMISSION_DENIED = "PERMISSION_DENIED"
    const val EV_SMS = "SYNTHETIC_SMS_ACCESS"
    const val EV_CONTACTS = "SYNTHETIC_CONTACTS_ACCESS"
    const val EV_MEDIA = "SYNTHETIC_MEDIA_ACCESS"
    const val EV_LOCATION = "SYNTHETIC_LOCATION_ACCESS"
    const val EV_FILE = "SYNTHETIC_FILE_ACCESS"
    const val EV_HEARTBEAT = "HEARTBEAT"

    const val APP_VERSION = "1.0.0-lab"

    data class Result(val ok: Boolean, val status: Int = 0, val error: String? = null)

    /**
     * Posts one event.
     *
     * Returns rather than throws: a telemetry failure must never take down the
     * exercise mid-run, and the analyst needs to see the gap, not a crash dialog.
     */
    fun post(
        baseUrl: String,
        token: String,
        sessionId: String,
        deviceId: String,
        event: String,
        value: String? = null,
    ): Result {
        val body = JSONObject().apply {
            put("session_id", sessionId)
            put("device_id", deviceId)
            put("event", event)
            put("timestamp", Instant.now().toString())
            // The field the whole safety argument rests on. The server enforces it.
            put("data_class", SyntheticData.DATA_CLASS)
            put("app_version", APP_VERSION)
            if (value != null) put("value", value)
        }

        var conn: HttpURLConnection? = null
        return try {
            conn = (URL(baseUrl.trimEnd('/') + "/lab/event").openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = 5_000
                readTimeout = 5_000
                doOutput = true
                setRequestProperty("Content-Type", "application/json")
                setRequestProperty("Authorization", "Bearer $token")
            }
            conn.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }

            val status = conn.responseCode
            if (status in 200..299) {
                Result(ok = true, status = status)
            } else {
                // Read the rejection: it is the analyst's evidence that a control fired.
                val text = (conn.errorStream ?: conn.inputStream)
                    ?.bufferedReader()?.use(BufferedReader::readText).orEmpty()
                Log.w(TAG, "rejected $event [$status]: ${text.take(160)}")
                Result(ok = false, status = status, error = text.take(300))
            }
        } catch (e: Exception) {
            Log.w(TAG, "telemetry post failed for $event: ${e.message}")
            Result(ok = false, error = e.message)
        } finally {
            conn?.disconnect()
        }
    }

    /** Fetches a server-issued session id (proposal section 4.1). */
    fun issueSession(baseUrl: String): String? = try {
        val conn = (URL(baseUrl.trimEnd('/') + "/lab/session").openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            connectTimeout = 5_000
            readTimeout = 5_000
        }
        val text = conn.inputStream.bufferedReader().use(BufferedReader::readText)
        conn.disconnect()
        JSONObject(text).optString("session_id").takeIf { it.isNotBlank() }
    } catch (e: Exception) {
        Log.w(TAG, "could not issue a session: ${e.message}")
        null
    }
}
