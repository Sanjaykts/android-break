package dev.breakremote.agent.control

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.content.Intent
import android.os.Build
import android.util.Log
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import dev.breakremote.agent.input.AgentImeService
import dev.breakremote.agent.net.Session
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Turns console commands into real touch events.
 *
 * `INJECT_EVENTS` is a signature-level permission that no sideloaded app can
 * hold, so `dispatchGesture()` from an AccessibilityService is the *only* way this
 * app can produce input on a non-rooted phone. Everything here follows from that
 * one fact.
 */
class ControlService : AccessibilityService(), ActionQueue.GestureRunner {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private lateinit var queue: ActionQueue
    private val running = AtomicBoolean(false)

    /** Guards against the owner touching the phone mid-demo confusing the log. */
    private var lastEventAt = 0L

    override fun onServiceConnected() {
        super.onServiceConnected()
        if (!running.compareAndSet(false, true)) return

        queue = ActionQueue(scope) { ok, detail ->
            Session.sendResult(ok, detail)
        }.also {
            it.attach(this)
            it.start()
        }

        Session.commandHandler = ::onCommand
        Session.sendEvent("connection", JSONObject().put("state", "accessibility_bound"))
        Log.i(TAG, "accessibility service connected")
        probeGestures()
    }

    /**
     * The owner can revoke accessibility at any time, and when they do, the relay
     * session must die with it. Leaving a WebSocket alive after this would mean a
     * console that still shows "live" but can no longer do anything -- the worst
     * possible state to discover on stage.
     */
    override fun onUnbind(intent: Intent?): Boolean {
        Log.i(TAG, "accessibility service unbound; tearing down session")
        teardown()
        return super.onUnbind(intent)
    }

    override fun onDestroy() {
        teardown()
        super.onDestroy()
    }

    private fun teardown() {
        if (!running.compareAndSet(true, false)) return
        Session.commandHandler = null
        Session.sendEvent("lifecycle", JSONObject().put("state", "accessibility_revoked"))
        if (::queue.isInitialized) queue.stop()
        scope.cancel()
    }

    override fun onInterrupt() {
        // Another accessibility service took focus. Not fatal, but the console
        // should know input is no longer landing.
        Session.sendEvent("connection", JSONObject().put("state", "interrupted"))
    }

    // ----------------------------------------------------------------- events

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        if (event == null) return
        val now = System.currentTimeMillis()
        // TYPE_WINDOW_CONTENT_CHANGED fires many times per second on some apps.
        // Coalescing keeps the console's action log readable and the relay quiet.
        if (now - lastEventAt < 400) return
        lastEventAt = now

        Session.sendEvent(
            "accessibility",
            JSONObject()
                .put("type", event.eventType.toString())
                .put("class", event.className?.toString() ?: "")
                .put("package", event.packageName?.toString() ?: "")
        )
    }

    // ---------------------------------------------------------------- commands

    private fun onCommand(msg: JSONObject) {
        when (msg.optString("op")) {
            "tap" -> queue.submitTap(msg.optInt("x").toFloat(), msg.optInt("y").toFloat())
            "longpress" -> queue.submitLongPress(
                msg.optInt("x").toFloat(), msg.optInt("y").toFloat(),
                msg.optLong("ms", 700L)
            )
            "doubleTap" -> queue.submitDoubleTap(msg.optInt("x").toFloat(), msg.optInt("y").toFloat())
            "drag" -> queue.submitDrag(
                msg.optInt("x1").toFloat(), msg.optInt("y1").toFloat(),
                msg.optInt("x2").toFloat(), msg.optInt("y2").toFloat(),
                msg.optLong("ms", 400L), DRAG_HOLD_MS
            )
            "swipe" -> queue.submitSwipe(
                msg.optInt("x1").toFloat(), msg.optInt("y1").toFloat(),
                msg.optInt("x2").toFloat(), msg.optInt("y2").toFloat(),
                msg.optLong("ms", 300L)
            )
            "key" -> queue.submitKey(msg.optInt("code"))
            "text" -> queue.submitText(msg.optString("s"))
            "find" -> {
                val text = msg.optString("text")
                if (msg.optString("action") == "settext") queue.submitFindSetText(text)
                else queue.submitFindClick(text)
            }
            "global" -> globalAction(msg.optString("action"))
            "script" -> {
                val arr = msg.optJSONArray("actions") ?: return
                val actions = (0 until arr.length()).mapNotNull { i ->
                    arr.optJSONObject(i)?.let { ActionQueue.ScriptAction(it) }
                }
                queue.submitScript(actions)
            }
            "ping" -> Session.send(JSONObject().put("op", "pong").put("t", msg.optLong("t")))
            "quality" -> dev.breakremote.agent.capture.CaptureService.applyQuality(
                msg.optInt("fps", 10), msg.optInt("w", 480), msg.optInt("q", 35)
            )
            "ime" -> AgentImeService.setEnabled(msg.optBoolean("enabled"))
        }
    }

    /**
     * Proves that `canPerformGestures` was actually granted.
     *
     * There is no public getter for it, and if it is missing every
     * `dispatchGesture()` call returns false -- so a laptop tap does nothing, with
     * no error anywhere. That is plan risk #2, and it is invisible until someone
     * tries to click during the demo. A one-pixel gesture at startup turns that
     * silent failure into a red badge on the enrollment screen.
     */
    private fun probeGestures() {
        scope.launch {
            val ok = try {
                val path = android.graphics.Path().apply { moveTo(1f, 1f) }
                dispatch(
                    GestureDescription.Builder()
                        .addStroke(GestureDescription.StrokeDescription(path, 0, 30))
                        .build()
                )
            } catch (t: Throwable) {
                Log.w(TAG, "gesture probe failed: ${t.message}")
                false
            }
            recordGestureProbe(ok)
            Session.sendEvent("connection", JSONObject()
                .put("state", "gesture_probe")
                .put("ok", ok))
            if (!ok) {
                Log.e(TAG, "dispatchGesture refused: canPerformGestures is not set in accessibility_config.xml")
            }
        }
    }

    private fun globalAction(action: String) {
        val mapping = when (action) {
            "back" -> GLOBAL_ACTION_BACK
            "home" -> GLOBAL_ACTION_HOME
            "recents" -> GLOBAL_ACTION_RECENTS
            "power" -> GLOBAL_ACTION_POWER_DIALOG
            "notifications" -> GLOBAL_ACTION_NOTIFICATIONS
            // There is no GLOBAL_ACTION_APP_SWITCH in the platform; the app
            // drawer is the equivalent, and RECENTS is the fallback for OEM
            // builds that do not implement it.
            "appswitch" -> GLOBAL_ACTION_ACCESSIBILITY_ALL_APPS
            else -> {
                Session.sendResult(false, "unknown global action \"$action\"")
                return
            }
        }
        queue.submitGlobal(mapping, action)
    }

    // -------------------------------------------------------- GestureRunner

    override suspend fun dispatch(description: GestureDescription): Boolean {
        // Resolved by the platform callback. Timing out matters: if the callback
        // never arrives the queue would stall forever and the demo would look
        // frozen rather than broken.
        val done = CompletableDeferred<Boolean>()
        val accepted = dispatchGesture(
            description,
            object : GestureResultCallback() {
                override fun onCompleted(d: GestureDescription?) { done.complete(true) }
                override fun onCancelled(d: GestureDescription?) { done.complete(false) }
            },
            null
        )
        if (!accepted) return false
        return withTimeoutOrNull(GESTURE_TIMEOUT_MS) { done.await() } ?: false
    }

    override fun performGlobal(action: Int): Boolean =
        if (action >= 0) performGlobalAction(action) else false

    /**
     * Special keys.
     *
     * Key events cannot be injected without INJECT_EVENTS, so there is no honest
     * general implementation. What does work is going through a live
     * InputConnection, which is the same mechanism the IME fallback uses. Anything
     * else reports failure rather than pretending to have worked.
     */
    override fun performKey(code: Int): Boolean {
        val ic = AgentImeService.currentInputConnection ?: return false
        return when (code) {
            KEYCODE_DEL -> {
                ic.deleteSurroundingText(1, 0)
                true
            }
            KEYCODE_ENTER -> ic.commitText("\n", 1)
            KEYCODE_TAB -> ic.commitText("\t", 1)
            else -> false
        }
    }

    override fun typeText(text: String): ActionQueue.TextOutcome {
        // 1. Prefer ACTION_SET_TEXT on the focused node. It is instant, works
        //    without any keyboard, and cannot be rate-limited.
        val focused = focusedEditable()
        if (focused != null) {
            val current = focused.text?.toString().orEmpty()
            val ok = focused.setNodeText(current + text)
            focused.recycleIfNeeded()
            if (ok) return ActionQueue.TextOutcome.SET_TEXT
        }

        // 2. Fall back to our own IME, which exists precisely for WebViews and
        //    games where the node tree is not exposed to us.
        if (AgentImeService.commitText(text)) return ActionQueue.TextOutcome.VIA_IME

        return ActionQueue.TextOutcome.FAILED
    }

    override fun findNode(query: String): AccessibilityNodeInfo? {
        val needle = query.trim().lowercase()
        if (needle.isEmpty()) return null

        val roots = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            // Multi-window and system UI live in separate windows, so a single
            // root is frequently not enough to find what the user can see.
            windows.mapNotNull { it.root }
        } else {
            listOfNotNull(rootInActiveWindow)
        }

        for (root in roots) {
            try {
                val found = breadthFirstSearch(root, needle, 0)
                if (found != null) return found
            } finally {
                if (Build.VERSION.SDK_INT < 33) {
                    @Suppress("DEPRECATION")
                    root.recycle()
                }
            }
        }
        return null
    }

    /** Iterative BFS. Recursion over a deep view tree risks a StackOverflow on
     *  complex layouts, which on a WebView-heavy app is common. */
    private fun breadthFirstSearch(
        root: AccessibilityNodeInfo,
        needle: String,
        depth: Int,
    ): AccessibilityNodeInfo? {
        if (depth > MAX_SEARCH_DEPTH) return null

        if (matches(root, needle)) return root

        for (i in 0 until root.childCount) {
            val child = try {
                root.getChild(i)
            } catch (_: Exception) {
                continue
            } ?: continue

            if (matches(child, needle)) return child

            val deeper = breadthFirstSearch(child, needle, depth + 1)
            if (deeper != null) return deeper

            if (Build.VERSION.SDK_INT < 33) {
                @Suppress("DEPRECATION")
                child.recycle()
            }
        }
        return null
    }

    private fun matches(node: AccessibilityNodeInfo, needle: String): Boolean {
        val text = node.text?.toString()?.lowercase()
        if (text != null && text.contains(needle)) return true
        val desc = node.contentDescription?.toString()?.lowercase()
        if (desc != null && desc.contains(needle)) return true
        val hint = node.hintText?.toString()?.lowercase()
        return hint != null && hint.contains(needle)
    }

    private fun focusedEditable(): AccessibilityNodeInfo? {
        val root = rootInActiveWindow ?: return null
        val focused = try {
            root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)
        } catch (_: Exception) {
            null
        } ?: return null
        return if (focused.isEditable) focused else null
    }

    companion object {
        const val TAG = "brk/control"

        /**
         * Whether `dispatchGesture` actually works. There is no public getter for
         * `canPerformGestures`, so the startup probe in [probeGestures] is the
         * only honest signal -- and the enrollment screen needs it to avoid
         * showing a green badge over a dead input path.
         */
        @Volatile
        var gestureProbeResult: Boolean = false
            private set

        internal fun recordGestureProbe(ok: Boolean) {
            gestureProbeResult = ok
        }
        private const val GESTURE_TIMEOUT_MS = 5_000L

        /**
         * How long the finger stays down before moving, in a drag.
         *
         * Android gives a touched view a short grace period to claim the gesture
         * before the framework starts treating it as a scroll. A drag that moves
         * immediately is therefore interpreted as a flick, and a slider or a
         * reorder handle will not follow it. Holding first is what makes it a
         * drag rather than a swipe.
         */
        private const val DRAG_HOLD_MS = 250L
        private const val MAX_SEARCH_DEPTH = 40

        private const val KEYCODE_ENTER = 66
        private const val KEYCODE_TAB = 61
        private const val KEYCODE_DEL = 67
    }
}

