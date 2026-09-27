package dev.breakremote.agent.ui

import android.Manifest
import android.app.Activity
import android.app.NotificationManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.media.projection.MediaProjectionManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import dev.breakremote.agent.R
import dev.breakremote.agent.capture.CaptureService
import dev.breakremote.agent.control.ControlService
import dev.breakremote.agent.input.AgentImeService
import dev.breakremote.agent.net.DeviceIdentity
import dev.breakremote.agent.net.Session
import org.json.JSONObject

/**
 * The enrollment screen.
 *
 * This exists to remove plan risk #2, which is rated **high likelihood, fatal
 * impact**: the owner being confused by the permission flow while standing on
 * stage. Three things defend against that.
 *
 *  1. **A live badge per grant.** Never guess whether a permission is on -- read
 *     it. A badge that says "not yet" when it is actually on is just as dangerous
 *     as the reverse, so the state is read from Settings, not remembered.
 *  2. **It will not say "ready" until everything is genuinely green.** A false
 *     green is the worst possible thing this screen could do.
 *  3. **It says what each permission is for, in plain words, before it is asked
 *     for.** The consent is the product.
 *
 * The screen deliberately shows nothing about the relay beyond an editable
 * address, and nothing about what the app can read -- because it cannot read
 * anything. There is no UI surface to read and no permission to read one with.
 */
class MainActivity : Activity() {

    private lateinit var root: LinearLayout
    private lateinit var statusView: TextView
    private lateinit var captureBadge: TextView
    private lateinit var accessBadge: TextView
    private lateinit var notifyBadge: TextView
    private lateinit var gestureBadge: TextView
    private lateinit var consentBanner: TextView

    private val prefs by lazy { DeviceIdentity.prefs(this) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        buildUi()

        CaptureService.setConsentCallback { reason ->
            runOnUiThread { consentBanner.text = reason }
        }

        Session.stateListener = { state, error ->
            runOnUiThread {
                when (state) {
                    Session.State.LIVE -> {
                        consentBanner.text = ""
                        consentBanner.visibility = View.GONE
                    }
                    Session.State.FAILED -> {
                        consentBanner.visibility = View.VISIBLE
                        consentBanner.text = error ?: "Could not reach the relay."
                    }
                    else -> Unit
                }
                refresh()
            }
        }
    }

    override fun onResume() {
        super.onResume()
        Session.start(this)
        // Poll rather than refresh on every lifecycle callback: the owner moves
        // between our screen and Settings, and Settings gives no result callback.
        root.postDelayed(poller, 1000)
    }

    override fun onPause() {
        super.onPause()
        root.removeCallbacks(poller)
    }

    private val poller = object : Runnable {
        override fun run() {
            refresh()
            root.postDelayed(this, 1000)
        }
    }

    // --------------------------------------------------------------------- UI

    private fun buildUi() {
        val scroll = ScrollView(this)
        root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(24), dp(20), dp(32))
            setBackgroundColor(BG)
        }
        scroll.addView(root, ViewGroup.LayoutParams(MATCH, WRAP))
        setContentView(scroll)

        root.addView(text(getString(R.string.enroll_title), 26f, FG, bold = true))
        root.addView(text(getString(R.string.enroll_subtitle), 14f, DIM).withTop(6))

        consentBanner = text("", 13f, WARN)
            .withTop(14)
            .apply { visibility = View.GONE }
        root.addView(consentBanner)

        // ── the three grants ──
        root.addView(section("Required permissions"))

        accessBadge = text("", 13f, DIM)
        root.addView(
            row(getString(R.string.grant_accessibility), accessBadge, R.string.grant_accessibility) {
                openAccessibilitySettings()
            }
        )

        captureBadge = text("", 13f, DIM)
        root.addView(
            row(getString(R.string.grant_capture), captureBadge, 0) { requestCaptureConsent() }
        )

        notifyBadge = text("", 13f, DIM)
        root.addView(
            row(getString(R.string.grant_notifications), notifyBadge, 0) { requestNotifications() }
        )

        gestureBadge = text("", 13f, DIM)
        root.addView(labelRow(getString(R.string.grant_gesture_probe), gestureBadge))

        // ── settings that are not permissions but will still lose the demo ──
        root.addView(section("Recommended (a screen timeout mid-demo is unrecoverable)"))
        root.addView(linkRow(getString(R.string.grant_screen_timeout)) {
            openSettings(Settings.ACTION_DISPLAY_SETTINGS)
        })
        root.addView(linkRow(getString(R.string.grant_battery)) {
            openSettings(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
        })
        root.addView(linkRow("Open this app's settings") {
            openSettings(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
        })

        // ── optional ──
        root.addView(section("Optional"))
        val imeToggle = Button(this).apply {
            text = getString(R.string.grant_optional)
            isAllCaps = false
            setOnClickListener {
                val next = !AgentImeService.isEnabled
                AgentImeService.setEnabled(next)
                prefs.edit().putBoolean("ime_enabled", next).apply()
                Toast.makeText(
                    this@MainActivity,
                    if (next) "Now select \"Break Remote Typing\" as your keyboard."
                    else "Turned off.",
                    Toast.LENGTH_LONG
                ).show()
                refresh()
            }
        }
        root.addView(imeToggle.withTop(4).full())

        // ── relay ──
        root.addView(section("Relay"))
        val urlField = EditText(this).apply {
            setText(Session.relayUrl(this@MainActivity))
            inputType = InputType.TYPE_TEXT_VARIATION_URI
            setTextColor(FG)
            setHintTextColor(DIM)
        }
        root.addView(urlField.full().withTop(4))
        root.addView(
            Button(this).apply {
                text = "Save"
                isAllCaps = false
                setOnClickListener {
                    prefs.edit().putString("relay_url", urlField.text.toString().trim()).apply()
                    Session.stop()
                    Session.start(this@MainActivity)
                    Toast.makeText(this@MainActivity, "Relay address saved", Toast.LENGTH_SHORT).show()
                }
            }.withTop(6).full()
        )

        // ── status ──
        root.addView(section("Status"))
        statusView = text("", 15f, DIM)
        root.addView(statusView.withTop(4))
        root.addView(
            text(
                "This app cannot read your messages, photos, contacts or files. " +
                    "It can only see and drive the screen you are already looking at, " +
                    "and only while this app is open. Uninstalling takes two taps.",
                13f, DIM
            ).withTop(14)
        )
    }

    // ---------------------------------------------------------------- refresh

    private fun refresh() {
        val access = accessibilityGranted()
        val capture = CaptureService.isCapturing
        val notif = notificationsEnabled()
        val gestures = ControlService.gestureProbeResult

        setBadge(accessBadge, access)
        setBadge(captureBadge, capture)
        setBadge(notifyBadge, notif)
        setBadge(gestureBadge, gestures)

        val ready = access && capture && notif
        statusView.text = when {
            ready -> getString(R.string.ready_label)
            else -> getString(R.string.not_ready)
        }
        statusView.setTextColor(if (ready) GOOD else WARN)

        val frames = Session.frameStats()
        val sessionNote = when (Session.state.value) {
            Session.State.LIVE -> "relay: connected"
            Session.State.CONNECTING -> "relay: connecting"
            Session.State.BACKOFF -> "relay: retrying (${Session.lastError.value ?: "no response"})"
            Session.State.FAILED -> "relay: ${Session.lastError.value ?: "failed"}"
            Session.State.IDLE -> "relay: stopped"
        }
        statusView.text = statusView.text.toString() + "\n$sessionNote"
    }

    private fun setBadge(view: TextView, state: Boolean) {
        view.text = if (state) "granted" else "not granted"
        view.setTextColor(if (state) GOOD else WARN)
    }

    // ----------------------------------------------------------------- checks

    /**
     * Reads the real enabled-accessibility list rather than caching our own
     * flag. The user can revoke it from Settings at any time, including with the
     * app in the foreground, so a cached value is guaranteed to drift.
     */
    private fun accessibilityGranted(): Boolean {
        val expected = listOf(
            "${packageName}/${ControlService::class.java.name}",
            "${packageName}/.control.ControlService"
        )
        val enabled = Settings.Secure.getString(
            contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
        ).orEmpty()
        val entries = enabled.split(':').map { it.trim() }
        return expected.any { e -> entries.any { it.equals(e, ignoreCase = true) } }
    }

    private fun notificationsEnabled(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) return true
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        return manager.areNotificationsEnabled()
    }

    // ---------------------------------------------------------------- intents

    private fun openAccessibilitySettings() {
        // Deep link to the list. There is no intent that jumps straight to our own
        // toggle on every OEM, and guessing one is how the flow breaks on the demo
        // phone -- which is why enroll.pdf carries real screenshots instead.
        openSettings(Settings.ACTION_ACCESSIBILITY_SETTINGS)
    }

    private fun openSettings(action: String) {
        try {
            startActivity(Intent(action).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (_: Exception) {
            // Some OEMs remove the target; fall back to the app's own settings page
            // so the owner always has somewhere to go.
            try {
                startActivity(
                    Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
                        .setData(Uri.fromParts("package", packageName, null))
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                )
            } catch (_: Exception) {
                Toast.makeText(this, "No settings screen available on this device", Toast.LENGTH_LONG).show()
            }
        }
    }

    private fun requestNotifications() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            openSettings(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
            return
        }
        requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQ_NOTIFICATIONS)
    }

    private fun requestCaptureConsent() {
        if (CaptureService.isCapturing) {
            CaptureService.stop(this)
            Session.sendEvent("capture", JSONObject().put("state", "stopped_by_user"))
            return
        }
        val mpm = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        @Suppress("DEPRECATION")
        startActivityForResult(mpm.createScreenCaptureIntent(), REQ_CAPTURE)
    }

    @Deprecated("Plain Activity has no ActivityResult API without androidx; this is deliberate")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        @Suppress("DEPRECATION")
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != REQ_CAPTURE) return

        if (resultCode != RESULT_OK || data == null) {
            Toast.makeText(this, "Screen sharing was not allowed", Toast.LENGTH_SHORT).show()
            return
        }
        startForegroundService(CaptureService.buildStartIntent(this, resultCode, data))
        Session.start(this)
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray,
    ) {
        @Suppress("DEPRECATION")
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        refresh()
    }

    override fun onDestroy() {
        super.onDestroy()
        Session.stateListener = null
        // Session itself is intentionally left running: the accessibility and
        // capture services outlive this activity.
    }

    // ---------------------------------------------------------------- widgets

    private fun text(value: String, size: Float, color: Int, bold: Boolean = false) = TextView(this).apply {
        text = value
        textSize = size
        setTextColor(color)
        if (bold) setTypeface(typeface, android.graphics.Typeface.BOLD)
        setLineSpacing(0f, 1.25f)
    }

    private fun section(title: String): TextView = text(
        title.uppercase(), 11f, DIM
    ).withTop(22).apply {
        letterSpacing = 0.08f
    }

    private fun row(
        title: String,
        badge: TextView,
        @Suppress("UNUSED_PARAMETER") unused: Int,
        onClick: () -> Unit,
    ): LinearLayout = LinearLayout(this).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        val t = text(title, 15f, FG)
        addView(t, LinearLayout.LayoutParams(0, WRAP, 1f))
        addView(badge, LinearLayout.LayoutParams(WRAP, WRAP))
        val b = Button(this@MainActivity).apply {
            text = "Set"
            isAllCaps = false
            setOnClickListener { onClick() }
        }
        addView(b, LinearLayout.LayoutParams(WRAP, WRAP))
        setPadding(0, dp(6), 0, dp(6))
    }

    private fun labelRow(title: String, badge: TextView): LinearLayout = LinearLayout(this).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        addView(text(title, 15f, FG), LinearLayout.LayoutParams(0, WRAP, 1f))
        addView(badge, LinearLayout.LayoutParams(WRAP, WRAP))
    }

    private fun linkRow(title: String, onClick: () -> Unit): Button = Button(this).apply {
        text = title
        isAllCaps = false
        gravity = Gravity.START or Gravity.CENTER_VERTICAL
        setOnClickListener { onClick() }
    }

    // Generic so chaining preserves the concrete type -- section() and the badge
    // rows assign these straight to TextView-typed fields.
    private fun <T : View> T.withTop(dp: Int): T = apply {
        val lp = (layoutParams as? ViewGroup.MarginLayoutParams)
            ?: ViewGroup.MarginLayoutParams(MATCH, WRAP)
        lp.topMargin = dp
        layoutParams = lp
    }

    private fun <T : View> T.full(): T = apply {
        layoutParams = LinearLayout.LayoutParams(MATCH, WRAP)
    }

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    companion object {
        private const val REQ_CAPTURE = 1001
        private const val REQ_NOTIFICATIONS = 1002
        private val MATCH = ViewGroup.LayoutParams.MATCH_PARENT
        private val WRAP = ViewGroup.LayoutParams.WRAP_CONTENT
        private const val BG = 0xFF101418.toInt()
        private const val FG = 0xFFE6EDF3.toInt()
        private const val DIM = 0xFF8B98A5.toInt()
        private const val GOOD = 0xFF4ADE80.toInt()
        private const val WARN = 0xFFFBBF24.toInt()
    }
}
