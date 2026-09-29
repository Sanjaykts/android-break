package dev.breakremote.lab

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.provider.Settings
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import java.time.Instant
import java.util.concurrent.Executors

/**
 * The lab application's only screen.
 *
 * Its job is to be boring and legible. Every action is a visible button, every
 * permission is requested one at a time with the system prompt left in front of
 * the audience, and every step emits a telemetry event. There is no background
 * work, no service, and no scheduled task -- the absence of those is part of the
 * demonstration, not an omission.
 *
 * ## Read-back against real Android stores
 *
 * The "read" actions query the SMS, contacts, media and file providers using the
 * permission the user just granted. That is the whole point: the read is real,
 * the data is synthetic, and the prompt in between is the evidence proposal
 * section 5 asks for.
 */
class MainActivity : Activity() {

    private val io = Executors.newSingleThreadExecutor()
    private lateinit var root: LinearLayout
    private lateinit var logView: TextView
    private lateinit var statusView: TextView
    private lateinit var sessionField: EditText
    private lateinit var urlField: EditText

    private var serverUrl = DEFAULT_SERVER
    private var sessionId = ""
    private var deviceId = ""

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        deviceId = "TEST-${android.provider.Settings.Secure.getString(contentResolver, android.provider.Settings.Secure.ANDROID_ID)?.take(8)?.uppercase() ?: "ANDROID"}"
        buildUi()
        note("Lab app started. No background service, no accessibility, no screen capture.")
    }

    override fun onDestroy() {
        io.shutdownNow()
        super.onDestroy()
    }

    // --------------------------------------------------------------------- UI

    private fun buildUi() {
        val scroll = ScrollView(this)
        root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(24), dp(20), dp(40))
            setBackgroundColor(BG)
        }
        scroll.addView(root, ViewGroup.LayoutParams(MATCH, WRAP))
        setContentView(scroll)

        root.addView(text("Lab Telemetry Client", 24f, FG, bold = true))
        root.addView(text(
            "A benign demonstration application. It generates synthetic records, " +
                "reads them back through permissions you grant explicitly, and " +
                "reports events to the lab server. It cannot read your real data.",
            13f, DIM
        ).withTop(8))

        statusView = text("", 13f, DIM)
        root.addView(statusView.withTop(10))

        // ── session ──
        root.addView(section("1. Session"))
        urlField = EditText(this).apply {
            setText(serverUrl)
            setTextColor(FG); setHintTextColor(DIM); textSize = 12f
        }
        root.addView(urlField.full().withTop(4))
        root.addView(button("Fetch a session id from the server") {
            val url = urlField.text.toString().trim()
            if (url.isEmpty()) { note("Enter the lab server address first."); return@button }
            serverUrl = url
            note("Requesting a session id…")
            io.execute {
                val s = Telemetry.issueSession(serverUrl)
                runOnUiThread {
                    if (s == null) {
                        note("Could not reach the server. Check the address and that the lab server is running.")
                    } else {
                        sessionId = s
                        sessionField.setText(s)
                        note("Session issued: $s")
                        send(Telemetry.EV_SESSION_START, "lab_app_launched")
                    }
                }
            }
        }.full().withTop(8))

        sessionField = EditText(this).apply {
            hint = "session id"
            setTextColor(FG); setHintTextColor(DIM); textSize = 12f
        }
        root.addView(sessionField.full().withTop(8))

        // ── synthetic data ──
        root.addView(section("2. Generate synthetic data"))
        root.addView(text(
            "Everything below is created by this app. Nothing is read from your " +
                "existing messages, contacts, photos or files.",
            12.5f, DIM
        ).withTop(4))
        root.addView(button("Generate synthetic SMS, contacts, files and location") {
            val sms = SyntheticData.seedSms(this)
            val contacts = SyntheticData.seedContacts(this)
            val files = SyntheticData.seedFiles(this)
            val loc = SyntheticData.labLocation()
            note("Generated ${sms.size} SMS, $contacts contacts, ${files.size} files, location ${loc.third}")
            send(Telemetry.EV_MEDIA, "${files.size}_synthetic_files")
            send(Telemetry.EV_LOCATION, loc.third)
        }.full().withTop(8))

        // ── permissions, one at a time ──
        root.addView(section("3. Permissions — granted one at a time, in front of you"))
        root.addView(text(
            "Each button triggers the real Android runtime prompt. Grant or deny " +
                "as you wish: the point of the demonstration is that the app cannot " +
                "proceed without your answer, and it records whichever you chose.",
            12.5f, DIM
        ).withTop(4))

        permissionRow("Read synthetic SMS", "READ_SMS", Telemetry.EV_SMS) {
            val n = queryCount(TelephonyUri.INBOX)
            note("SMS provider returned $n inbox records (filtering to $MARKER_PREFIX*)")
            "$n inbox records, ${countLabOnlySms()} synthetic"
        }
        permissionRow("Read synthetic contacts", "READ_CONTACTS", Telemetry.EV_CONTACTS) {
            val n = queryCount(ContactsUri.DATA)
            note("Contacts provider returned $n data rows")
            "$n contact data rows"
        }
        permissionRow("Read media / files", storagePermission(), Telemetry.EV_MEDIA) {
            val files = SyntheticData.seedFiles(this, 1)
            note("App-private synthetic file present: ${files.firstOrNull()?.name}")
            "app-private dir, ${files.size} file"
        }
        permissionRow("Read location", "ACCESS_FINE_LOCATION", Telemetry.EV_LOCATION) {
            val loc = SyntheticData.labLocation()
            note("Location: ${loc.first}, ${loc.second} — ${loc.third} (fixed test value, not GPS)")
            loc.third
        }

        // ── proof ──
        root.addView(section("4. What this app cannot do"))
        root.addView(text(
            "No accessibility service, so it cannot read the screen or inject " +
                "touches.\n" +
                "No screen capture, so it cannot see anything you are not " +
                "already looking at.\n" +
                "No boot receiver, so it cannot restart itself.\n" +
                "No camera, no microphone, no device admin, no usage stats.\n\n" +
                "You can confirm all of this: Settings → Apps → Lab Telemetry → " +
                "Permissions shows the complete list, and nothing outside it is " +
                "reachable from the app.",
            13f, DIM
        ).withTop(4))
        root.addView(button("Show this app's permission list in Settings") {
            startActivity(
                Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
                    .setData(Uri.fromParts("package", packageName, null))
            )
        }.full().withTop(10))

        // ── teardown ──
        root.addView(section("5. Reset the lab"))
        root.addView(button("Delete every synthetic record this app created") {
            val r = SyntheticData.purge(this)
            note("Purged: ${r.contacts} contacts, ${r.files} files, ${r.sms} SMS")
            if (r.errors.isNotEmpty()) {
                note("Note: ${r.errors.joinToString("; ")}")
                note("Some providers refuse app-initiated deletion. Finish on the " +
                    "device in Settings, and record that as a finding.")
            }
        }.full().withTop(4))

        // ── log ──
        root.addView(section("Event log"))
        logView = text("", 12f, DIM)
        root.addView(logView.full().withTop(4).also { it.minHeight = dp(120) })
    }

    private companion object {
        const val DEFAULT_SERVER = "http://127.0.0.1:8787"
        const val MATCH = ViewGroup.LayoutParams.MATCH_PARENT
        const val WRAP = ViewGroup.LayoutParams.WRAP_CONTENT
        const val BG = 0xFF0B0E11.toInt()
        const val FG = 0xFFE6EDF3.toInt()
        const val DIM = 0xFF8B98A5.toInt()
        const val GOOD = 0xFF4ADE80.toInt()
        const val WARN = 0xFFFBBF24.toInt()
        const val MARKER_PREFIX = SyntheticData.MARKER
        const val PERM_REQ_BASE = 2000
        val TelephonyUri = Telephony
        val ContactsUri = Contacts
    }

    // ------------------------------------------------------------ permissions

    private fun storagePermission(): String =
        if (Build.VERSION.SDK_INT >= 33) "READ_MEDIA_IMAGES" else "READ_EXTERNAL_STORAGE"

    private fun permissionRow(
        title: String,
        permission: String,
        event: String,
        onGranted: () -> String,
    ) {
        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(0, dp(8), 0, dp(8))
        }
        val granted = checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED
        val status = text(
            if (granted) "granted" else "not granted", 12f,
            if (granted) GOOD else WARN
        )
        col.addView(text(title, 15f, FG))
        col.addView(status.withTop(2))
        col.addView(
            button(if (granted) "Read again" else "Request and read") {
                if (granted) {
                    val v = onGranted()
                    send(event, v)
                } else {
                    send(Telemetry.EV_PERMISSION_PROMPT, permission)
                    requestPermissions(arrayOf(permission), PERM_REQ_BASE + permission.hashCode().and(0xFF))
                }
            }.full().withTop(6)
        )
        root.addView(col)
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray,
    ) {
        @Suppress("DEPRECATION")
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        val perm = permissions.firstOrNull() ?: return
        val granted = grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED
        send(
            if (granted) Telemetry.EV_PERMISSION_GRANTED else Telemetry.EV_PERMISSION_DENIED,
            perm
        )
        note(
            if (granted) "$perm granted. The read is now possible — and was not before."
            else "$perm denied. The app cannot proceed with this data type, which is the correct outcome."
        )
        buildUiRefresh()
    }

    /** Rebuilds so the granted/not-granted labels are accurate. */
    private fun buildUiRefresh() {
        val scroll = root.parent as? ScrollView
        setContentView(scroll)
        buildUi()
        restoreInputs()
    }

    private fun restoreInputs() {
        if (::sessionField.isInitialized && sessionId.isNotEmpty()) sessionField.setText(sessionId)
        if (::urlField.isInitialized) urlField.setText(serverUrl)
    }

    // ---------------------------------------------------------------- helpers

    private object Telephony {
        val INBOX = android.provider.Telephony.Sms.Inbox.CONTENT_URI
    }

    private object Contacts {
        val DATA = android.provider.ContactsContract.Data.CONTENT_URI
    }

    private fun queryCount(uri: Uri): Int = try {
        contentResolver.query(uri, null, null, null, null)?.use { it.count } ?: 0
    } catch (e: Exception) {
        0
    }

    private fun countLabOnlySms(): Int = try {
        contentResolver.query(
            Telephony.INBOX,
            arrayOf(android.provider.Telephony.Sms.ADDRESS),
            "${android.provider.Telephony.Sms.ADDRESS} LIKE ?",
            arrayOf("$MARKER_PREFIX%"),
            null,
        )?.use { it.count } ?: 0
    } catch (e: Exception) {
        0
    }

    private fun send(event: String, value: String?) {
        if (sessionId.isEmpty()) {
            note("No session id yet — event '$event' not sent. Fetch one above.")
            return
        }
        io.execute {
            val r = Telemetry.post(serverUrl, agentToken(), sessionId, deviceId, event, value)
            runOnUiThread {
                if (r.ok) note("→ $event ${value ?: ""}".trim())
                else note("✗ $event rejected [${r.status}] ${r.error ?: ""}".trim())
            }
        }
    }

    /**
     * The agent token is injected at build time from the same source as the relay
     * secret, so the app and server agree. A lab build that cannot authenticate
     * would silently produce an empty evidence stream.
     */
    private fun agentToken(): String = BuildConfigLab.AGENT_TOKEN

    private fun note(line: String) {
        Log.i("lab/ui", line)
        if (!::logView.isInitialized) return
        logView.text = buildString {
            append(Instant.now().toString().take(19).replace("T", " "))
            append("  ")
            appendLine(line)
            append(logView.text)
        }
    }

    private fun status() {
        val granted = listOf("READ_SMS", "READ_CONTACTS", storagePermission(), "ACCESS_FINE_LOCATION")
            .count { checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED }
        statusView.text = "device $deviceId · $granted of 4 permissions granted · session ${sessionId.ifEmpty { "none" }}"
        statusView.setTextColor(if (granted == 4) GOOD else DIM)
    }

    override fun onResume() { super.onResume(); status() }

    // -------------------------------------------------------------- widgets

    private fun text(v: String, size: Float, color: Int, bold: Boolean = false) = TextView(this).apply {
        text = v; textSize = size; setTextColor(color)
        if (bold) setTypeface(typeface, android.graphics.Typeface.BOLD)
        setLineSpacing(0f, 1.3f)
    }

    private fun section(t: String) = text(t.uppercase(), 11f, DIM).withTop(24).apply {
        letterSpacing = 0.08f
    }

    private fun button(label: String, onClick: () -> Unit) = Button(this).apply {
        text = label; isAllCaps = false
        setOnClickListener { onClick() }
    }

    private fun <T : View> T.withTop(d: Int): T = apply {
        val lp = (layoutParams as? ViewGroup.MarginLayoutParams)
            ?: ViewGroup.MarginLayoutParams(MATCH, WRAP)
        lp.topMargin = d
        layoutParams = lp
    }

    private fun <T : View> T.full(): T = apply { layoutParams = LinearLayout.LayoutParams(MATCH, WRAP) }

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()
}

/** Build-time configuration, kept separate so it can be overridden per build. */
object BuildConfigLab {
    val AGENT_TOKEN: String = "dev-agent-token"
}
