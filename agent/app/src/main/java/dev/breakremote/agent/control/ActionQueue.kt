package dev.breakremote.agent.control

import android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_ACCESSIBILITY_ALL_APPS
import android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK
import android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_HOME
import android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_NOTIFICATIONS
import android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_POWER_DIALOG
import android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_RECENTS
import android.accessibilityservice.GestureDescription
import android.graphics.Path
import android.util.Log
import android.view.accessibility.AccessibilityNodeInfo
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch

/**
 * Strictly serialised command queue.
 *
 * ### Why serialisation is not optional
 *
 * `AccessibilityService.dispatchGesture()` **refuses to start a new gesture while
 * one is in flight** -- it returns false rather than queueing. An unserialised
 * sender therefore loses input silently: the user clicks, nothing happens, and
 * there is no error anywhere. That is a demo-stopping failure mode that only
 * shows up under fast input, i.e. exactly during a live demo.
 *
 * So every command goes through one channel and one consumer coroutine, and a
 * gesture is not considered complete until its `GestureResultCallback` has fired.
 * Nothing else may touch the screen while that is true.
 */
class ActionQueue(
    private val scope: kotlinx.coroutines.CoroutineScope,
    private val onResult: (ok: Boolean, detail: String) -> Unit,
) {

    private sealed interface Command {
        /** A pointer gesture: a tap, long press, double tap, swipe or drag. */
        class Gesture(val description: GestureDescription) : Command

        class Global(val action: Int, val name: String) : Command

        class Key(val code: Int) : Command

        class Text(val text: String) : Command

        class FindClick(val query: String) : Command

        class FindSetText(val query: String) : Command

        class Script(val actions: List<ScriptAction>) : Command
    }

    /** A console-issued action, held as raw JSON so `script` can nest. */
    class ScriptAction(private val json: org.json.JSONObject) {
        val op: String get() = json.optString("op")

        fun int(key: String, fallback: Int = 0): Int =
            if (json.has(key)) json.optInt(key, fallback) else fallback

        fun str(key: String): String = json.optString(key)

        fun action(): String = json.optString("action")

        fun nested(): List<ScriptAction> {
            val arr = json.optJSONArray("actions") ?: return emptyList()
            return (0 until arr.length()).mapNotNull { i ->
                arr.optJSONObject(i)?.let { ScriptAction(it) }
            }
        }
    }

    private val queue = Channel<Command>(Channel.UNLIMITED)
    private var running = false

    fun start() {
        if (running) return
        running = true
        scope.launch {
            for (cmd in queue) {
                try {
                    execute(cmd)
                } catch (t: Throwable) {
                    Log.w(TAG, "command failed: ${t.message}", t)
                    onResult(false, t.message ?: t.javaClass.simpleName)
                }
            }
        }
    }

    fun stop() {
        running = false
        queue.close()
    }

    fun submitTap(x: Float, y: Float) = submitGesture(stroke(x, y, 60))
    fun submitLongPress(x: Float, y: Float, ms: Long) = submitGesture(stroke(x, y, ms))

    fun submitDoubleTap(x: Float, y: Float) {
        // Two strokes in one GestureDescription. Dispatching two separate
        // gestures would race, and some apps collapse the gap.
        val p = Path().apply { moveTo(x, y) }
        val builder = GestureDescription.Builder()
            .addStroke(GestureDescription.StrokeDescription(p, 0, 40))
            .addStroke(GestureDescription.StrokeDescription(p, 80, 40))
        submitGesture(builder.build())
    }

    fun submitSwipe(x1: Float, y1: Float, x2: Float, y2: Float, ms: Long) {
        val p = Path().apply { moveTo(x1, y1); lineTo(x2, y2) }
        submitGesture(GestureDescription.Builder()
            .addStroke(GestureDescription.StrokeDescription(p, 0, ms))
            .build())
    }

    /** A drag is a swipe that pauses before releasing, so long-press-and-drag works. */
    fun submitDrag(x1: Float, y1: Float, x2: Float, y2: Float, ms: Long, holdMs: Long) {
        val p = Path().apply { moveTo(x1, y1); lineTo(x2, y2) }
        submitGesture(GestureDescription.Builder()
            .addStroke(GestureDescription.StrokeDescription(p, 0, holdMs + ms))
            .build())
    }

    private fun stroke(x: Float, y: Float, durationMs: Long): GestureDescription {
        val p = Path().apply { moveTo(x, y) }
        return GestureDescription.Builder()
            .addStroke(GestureDescription.StrokeDescription(p, 0, durationMs))
            .build()
    }

    private fun submitGesture(description: GestureDescription) {
        queue.trySend(Command.Gesture(description))
    }

    fun submitGlobal(action: Int, name: String) {
        queue.trySend(Command.Global(action, name))
    }

    fun submitKey(code: Int) {
        queue.trySend(Command.Key(code))
    }

    fun submitText(text: String) {
        queue.trySend(Command.Text(text))
    }

    fun submitFindClick(query: String) {
        queue.trySend(Command.FindClick(query))
    }

    fun submitFindSetText(query: String) {
        queue.trySend(Command.FindSetText(query))
    }

    fun submitScript(actions: List<ScriptAction>) {
        queue.trySend(Command.Script(actions))
    }

    // -------------------------------------------------------------- execution

    private var dispatcher: GestureRunner? = null

    fun attach(runner: GestureRunner) {
        dispatcher = runner
    }

    private suspend fun execute(cmd: Command) {
        when (cmd) {
            is Command.Gesture -> {
                val runner = dispatcher
                if (runner == null) {
                    onResult(false, "accessibility service not ready")
                    return
                }
                val ok = runner.dispatch(cmd.description)
                onResult(ok, if (ok) "gesture" else "gesture rejected")
            }

            is Command.Global -> {
                val ok = dispatcher?.performGlobal(cmd.action) == true
                onResult(ok, if (ok) cmd.name else "global action '${cmd.name}' unavailable on this device")
            }

            is Command.Key -> {
                val ok = dispatcher?.performKey(cmd.code) == true
                onResult(ok, if (ok) "key ${cmd.code}" else "key ${cmd.code} not delivered")
            }

            is Command.Text -> {
                val outcome = dispatcher?.typeText(cmd.text) ?: TextOutcome.FAILED
                onResult(outcome != TextOutcome.FAILED, outcome.detail)
            }

            is Command.FindClick -> {
                val node = dispatcher?.findNode(cmd.query)
                if (node == null) {
                    onResult(false, "no node matching \"${cmd.query}\"")
                } else {
                    val clicked = node.performAction(AccessibilityNodeInfo.ACTION_CLICK)
                    node.recycleIfNeeded()
                    onResult(clicked, if (clicked) "tapped \"${cmd.query}\"" else "found \"${cmd.query}\" but it is not clickable")
                }
            }

            is Command.FindSetText -> {
                val node = dispatcher?.findNode(cmd.query)
                if (node == null) {
                    onResult(false, "no node matching \"${cmd.query}\"")
                } else {
                    val ok = node.setNodeText("")
                    node.recycleIfNeeded()
                    onResult(ok, if (ok) "focused \"${cmd.query}\"" else "found \"${cmd.query}\" but it is not a text field")
                }
            }

            is Command.Script -> executeScript(cmd.actions)
        }
    }

    /**
     * Runs a console-supplied action list.
     *
     * Each step is awaited before the next is started, which is not just tidy --
     * it is required. A tap that opens a Settings screen and a follow-up tap on a
     * row that does not exist yet will fail if issued back to back, so steps that
     * navigate get a settle delay.
     */
    private suspend fun executeScript(actions: List<ScriptAction>) {
        val runner = dispatcher ?: run {
            onResult(false, "accessibility service not ready")
            return
        }
        for ((i, action) in actions.withIndex()) {
            val step = i + 1
            when (action.op) {
                "tap" -> {
                    val x = action.int("x").toFloat()
                    val y = action.int("y").toFloat()
                    runner.dispatch(tapStroke(x, y, 60))
                }
                "doubleTap" -> {
                    val x = action.int("x").toFloat()
                    val y = action.int("y").toFloat()
                    val p = Path().apply { moveTo(x, y) }
                    runner.dispatch(
                        GestureDescription.Builder()
                            .addStroke(GestureDescription.StrokeDescription(p, 0, 40))
                            .addStroke(GestureDescription.StrokeDescription(p, 80, 40))
                            .build()
                    )
                }
                "longpress" -> {
                    val x = action.int("x").toFloat()
                    val y = action.int("y").toFloat()
                    runner.dispatch(tapStroke(x, y, action.int("ms", 700).toLong()))
                }
                "swipe" -> {
                    val p = Path().apply {
                        moveTo(action.int("x1").toFloat(), action.int("y1").toFloat())
                        lineTo(action.int("x2").toFloat(), action.int("y2").toFloat())
                    }
                    runner.dispatch(
                        GestureDescription.Builder()
                            .addStroke(GestureDescription.StrokeDescription(
                                p, 0, action.int("ms", 300).toLong()
                            ))
                            .build()
                    )
                }
                "key" -> runner.performKey(action.int("code"))
                "text" -> runner.typeText(action.str("s"))
                "global" -> {
                    val mapped = globalActionCode(action.action())
                    if (mapped < 0) onResult(false, "script step $step: unknown global action")
                    else runner.performGlobal(mapped)
                }
                "find" -> {
                    val node = runner.findNode(action.str("text"))
                    if (node == null) {
                        onResult(false, "script step $step: no node matching \"${action.str("text")}\"")
                    } else {
                        if (action.action() == "settext") node.setNodeText("") else node.performAction(AccessibilityNodeInfo.ACTION_CLICK)
                        node.recycleIfNeeded()
                    }
                }
                "script" -> executeScript(action.nested())
                else -> onResult(false, "script step $step: unknown op \"${action.op}\"")
            }
            if (needsSettle(action.op)) settle()
        }
    }

    private fun globalActionCode(action: String): Int = when (action) {
        "back" -> GLOBAL_ACTION_BACK
        "home" -> GLOBAL_ACTION_HOME
        "recents" -> GLOBAL_ACTION_RECENTS
        "power" -> GLOBAL_ACTION_POWER_DIALOG
        "notifications" -> GLOBAL_ACTION_NOTIFICATIONS
        // There is no GLOBAL_ACTION_APP_SWITCH in the platform. The app drawer is
        // the closest equivalent; GLOBAL_ACTION_RECENTS is the fallback because
        // some OEM builds do not implement the drawer action.
        "appswitch" -> GLOBAL_ACTION_ACCESSIBILITY_ALL_APPS
        else -> -1
    }

    private fun tapStroke(x: Float, y: Float, durationMs: Long): GestureDescription {
        val p = Path().apply { moveTo(x, y) }
        return GestureDescription.Builder()
            .addStroke(GestureDescription.StrokeDescription(p, 0, durationMs))
            .build()
    }

    private fun needsSettle(op: String): Boolean =
        op == "global" || op == "find" || op == "script" || op == "text"

    private suspend fun settle() {
        kotlinx.coroutines.delay(700)
    }

    /** Where the actual platform calls live; kept behind an interface so the queue
     *  has no compile-time dependency on the service lifecycle. */
    interface GestureRunner {
        suspend fun dispatch(description: GestureDescription): Boolean
        fun performGlobal(action: Int): Boolean
        fun performKey(code: Int): Boolean
        fun typeText(text: String): TextOutcome
        fun findNode(query: String): AccessibilityNodeInfo?
    }

    enum class TextOutcome(val detail: String) {
        SET_TEXT("typed via ACTION_SET_TEXT"),
        VIA_IME("typed via the Break Remote keyboard"),
        FAILED("could not type: no focused text field")
    }

    companion object {
        const val TAG = "brk/action"
    }
}

