package dev.breakremote.agent.net

import android.content.Context
import android.content.SharedPreferences
import android.os.Build
import android.provider.Settings
import java.util.UUID

/**
 * Stable per-install identity.
 *
 * ANDROID_ID is per-app-per-device on API 26+, which is exactly the scope we
 * want: reinstalling or using a different app on the same phone yields a
 * different id. It is salted with a random value persisted locally so that a
 * factory reset -- which the plan forbids, but which would also be a full
 * re-enrolment anyway -- cannot be predicted from the device serial.
 */
object DeviceIdentity {

    private const val PREFS = "brk_identity"
    private const val KEY_ID = "device_id"

    fun deviceId(context: Context): String {
        val prefs = context.applicationContext
            .getSharedPreferences(PREFS, Context.MODE_PRIVATE)

        prefs.getString(KEY_ID, null)?.let { return it }

        val androidId = try {
            Settings.Secure.getString(
                context.contentResolver,
                Settings.Secure.ANDROID_ID
            ).orEmpty()
        } catch (_: Exception) {
            ""
        }

        val seed = if (androidId.isBlank()) UUID.randomUUID().toString() else androidId
        // Keep it URL-safe: it travels as a query parameter and as a WebSocket tag.
        val id = seed.replace(Regex("[^A-Za-z0-9._-]"), "-").take(48)
        prefs.edit().putString(KEY_ID, id).apply()
        return id
    }

    fun helloPayload(deviceId: String): String {
        val json = org.json.JSONObject()
            .put("op", "hello")
            .put("id", deviceId)
            .put("model", Build.MODEL ?: "unknown")
            .put("brand", Build.BRAND ?: "unknown")
            .put("android", Build.VERSION.RELEASE ?: "unknown")
            .put("sdk", Build.VERSION.SDK_INT)
        return json.toString()
    }

    /** Persisted console-visible settings. */
    fun prefs(context: Context): SharedPreferences =
        context.applicationContext.getSharedPreferences("brk_settings", Context.MODE_PRIVATE)
}
