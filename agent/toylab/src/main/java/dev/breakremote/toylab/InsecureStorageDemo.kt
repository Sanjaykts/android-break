package dev.breakremote.toylab

import android.content.Context
import android.os.Bundle
import android.util.Log
import android.webkit.WebView

/**
 * FLAW 4 of 5 — Insecure storage of tokens and sensitive application data
 * (proposal section 10).
 *
 * The app stores what is labelled a session token in `SharedPreferences` in
 * cleartext, and also writes it to logcat. Both are standard mistakes, and both
 * survive on a device long after the app that made them has been uninstalled.
 *
 * Three separate exposures, all shown side by side here because they compound:
 *
 *  1. **Cleartext preferences.** Readable by anything with access to app storage:
 *     a rooted device, a forensic image, or an `adb backup` of an app that has
 *     not set `allowBackup="false"`.
 *  2. **Logcat.** Any app on a pre-4.1 device, and anyone with `adb logcat` on a
 *     modern one, could see it. Logging a credential is a defect on its own.
 *  3. **Backup.** The preference is included in cloud backup and device transfer
 *     unless the app excludes it, so a token can outlive the install on a
 *     *different* device entirely.
 *
 * ## What this target deliberately does NOT do
 *
 * The token is a fixed dummy string generated at first run. It authenticates
 * nothing, is never transmitted, and is worthless. The lesson is the storage
 * discipline, and it is taught with a credential that does not matter.
 */
class InsecureStorageDemo : ToyActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        header(
            lesson = "A credential in cleartext preferences is readable from a forensic " +
                "image, from `adb backup`, and from logcat. None of those require the " +
                "app to be running, and none of them prompt the user.",
            vulnerability = "Insecure storage of tokens and sensitive data",
        )

        // FLAW: a credential-shaped value in cleartext SharedPreferences.
        val token = getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getString(KEY_TOKEN, null)
            ?: "training-token-" + java.util.UUID.randomUUID().toString().take(12)
                .also { getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY_TOKEN, it).apply() }

        section("1. Written in cleartext")
        result("SharedPreferences file", "$PREFS.xml", tone = RED)
        result("contents", "token = $token", tone = RED)
        note("The file is world-readable to the system and survives until the app is " +
            "uninstalled or the data is cleared. Reading it requires device access — " +
            "which is exactly what a stolen or imaged device gives you.")

        // FLAW: the same value to logcat, which is the habit that leaks far more
        // often than the storage choice does.
        section("2. Also logged")
        Log.w(TAG, "session established, token=$token")
        result("logcat", "adb logcat -s $TAG", tone = RED)
        note("Pasted straight out of the log above. A credential in a log is a " +
            "credential in a world-readable buffer, and it is the single most common " +
            "finding in a mobile review.")

        // FLAW: no backup exclusion, so the token travels.
        section("3. Also included in backup")
        result("android:allowBackup", "true (the Android default)", tone = RED)
        note("With backup enabled the preferences file is included in cloud backup and " +
            "device transfer. A token can therefore reappear on a different handset " +
            "from the same account.")

        section("Read it back the way an examiner would")
        body.addView(
            text(
                "On a lab device with adb available:\n\n" +
                    "    adb shell run-as $packageName cat /data/data/$packageName/shared_prefs/$PREFS.xml\n\n" +
                    "No root, no exploit, no permission. That is the point: this class " +
                    "of finding is cheap to look for and expensive to have.",
                12.5f, DIM,
            ).withTop(4),
        )

        section("The correct handling, shown next to it")
        body.addView(
            text(
                "A real application should:\n" +
                    "  - keep the token in the Android Keystore-backed EncryptedSharedPreferences, " +
                    "so the bytes are encrypted at rest with a key the keystore holds\n" +
                    "  - never log it, in any form, including truncated\n" +
                    "  - set android:allowBackup=\"false\", or exclude the preferences file " +
                    "with a data-extraction rule\n" +
                    "  - scope it: short-lived, refreshable, and revocable server-side\n" +
                    "  - treat any device that has been rooted or imaged as compromised, " +
                    "and re-issue on unlock",
                13f, DIM,
            ).withTop(4),
        )

        fix(
            "EncryptedSharedPreferences (Jetpack Security), Keystore-backed, " +
                "allowBackup=false, and a log scrubber in the build that fails CI if a " +
                "token-shaped literal reaches a Log call.",
        )
    }

    private companion object {
        const val PREFS = "training_session"
        const val KEY_TOKEN = "session_token"
        const val TAG = "toylab-token"
    }
}
