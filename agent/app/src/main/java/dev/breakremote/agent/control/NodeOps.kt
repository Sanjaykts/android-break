package dev.breakremote.agent.control

import android.os.Build
import android.os.Bundle
import android.view.accessibility.AccessibilityNodeInfo

/**
 * Node operations that need more than a one-liner.
 *
 * `AccessibilityNodeInfo.setText()` returns void and is not the API for typing.
 * The real path is `performAction(ACTION_SET_TEXT, ...)` with the text in the
 * action arguments. That is also the only variant that reports success, and we
 * need that: a silent failure to type is indistinguishable from a slow network.
 */
internal fun AccessibilityNodeInfo.setNodeText(text: String): Boolean {
    val args = Bundle().apply {
        putCharSequence(
            AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE,
            text
        )
    }
    return try {
        performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
    } catch (_: Exception) {
        false
    }
}

/**
 * `recycle()` has been a no-op since API 33 and is deprecated. Below 33 it is
 * still correct hygiene, so it is called conditionally rather than removed.
 */
internal fun AccessibilityNodeInfo.recycleIfNeeded() {
    if (Build.VERSION.SDK_INT < 33) {
        @Suppress("DEPRECATION")
        recycle()
    }
}
