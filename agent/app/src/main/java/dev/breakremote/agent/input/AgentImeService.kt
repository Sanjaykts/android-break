package dev.breakremote.agent.input

import android.inputmethodservice.InputMethodService
import android.view.View
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import dev.breakremote.agent.net.Session
import org.json.JSONObject

/**
 * Optional typing fallback.
 *
 * `ACTION_SET_TEXT` on a focused node is the primary path and covers almost
 * everything. It fails in two cases that matter:
 *
 *  - WebViews and games, which do not expose a usable node tree.
 *  - Fields that ignore programmatic text changes.
 *
 * In those cases a real `InputConnection.commitText` is delivered by the system to
 * the focused window, which those apps do honour. That is the whole point: we are
 * not synthesising key events, we are using a keyboard the user could also select.
 *
 * Off by default. It is opt-in from the enrollment screen so nobody ends up with
 * an unexpected keyboard on their phone.
 */
class AgentImeService : InputMethodService() {

    override fun onCreate() {
        super.onCreate()
        enabledFlag = prefs().getBoolean(KEY_ENABLED, false)
        current = this
    }

    /** Mirrors the persisted toggle so `isEnabled` can be read without a service
     *  instance (the service is only alive while the keyboard is selected). */
    @Volatile
    private var enabledFlag = false

    override fun onDestroy() {
        current = null
        super.onDestroy()
    }

    /**
     * The InputConnection must be captured in `onStartInput`, **not**
     * `onStartInputView`.
     *
     * `onStartInputView` is only invoked when the IME has been asked whether it
     * wants to show a view, and [onEvaluateInputViewShown] returns false on
     * purpose -- a visible keyboard would cover the screen we are streaming.
     * Capturing there meant `activeConnection` was permanently null, so
     * `commitText` always failed and the whole IME fallback silently did
     * nothing. `onStartInput` is called unconditionally when a field gains
     * focus, which is exactly the moment the connection becomes valid.
     */
    override fun onStartInput(info: EditorInfo?, restarting: Boolean) {
        super.onStartInput(info, restarting)
        activeConnection = currentInputConnection
    }

    override fun onFinishInput() {
        activeConnection = null
        super.onFinishInput()
    }

    /** Intentionally empty: a blank keyboard panel. Its only job is to hold an
     *  InputConnection open. A visible keyboard would cover the very screen we
     *  are streaming to the laptop. */
    override fun onCreateInputView(): View? = null

    override fun onEvaluateInputViewShown(): Boolean {
        // Deliberately never true: a visible keyboard would cover the very screen
        // being streamed to the laptop. The IME exists only to hold an
        // InputConnection open.
        super.onEvaluateInputViewShown()
        return false
    }

    private fun prefs() =
        getSharedPreferences("brk_settings", MODE_PRIVATE)

    companion object {
        private const val KEY_ENABLED = "ime_enabled"

        @Volatile
        private var current: AgentImeService? = null

        @Volatile
        private var activeConnection: InputConnection? = null

        val isEnabled: Boolean
            get() = current?.enabledFlag ?: false

        val hasActiveConnection: Boolean
            get() = activeConnection != null

        fun setEnabled(value: Boolean) {
            current?.enabledFlag = value
            current?.prefs()?.edit()?.putBoolean(KEY_ENABLED, value)?.apply()
            Session.sendEvent("connection", JSONObject().put("state", "ime_$value"))
        }

        /**
         * Commits text through the live InputConnection. Returns false when the
         * IME is not enabled or no field is focused, which is the honest answer
         * rather than pretending the text went somewhere.
         */
        fun commitText(text: String): Boolean {
            if (!isEnabled) return false
            val ic = activeConnection ?: return false
            return try {
                ic.commitText(text, 1)
                true
            } catch (_: Exception) {
                false
            }
        }

        /** Exposed for ControlService, which needs the live connection. */
        val currentInputConnection: InputConnection?
            get() = if (isEnabled) activeConnection else null
    }
}
