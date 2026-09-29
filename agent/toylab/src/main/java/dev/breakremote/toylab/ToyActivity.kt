package dev.breakremote.toylab

import android.app.Activity
import android.graphics.Color
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.TextView

/**
 * Shared UI for the training targets.
 *
 * Two rules every target screen follows, so the demonstration cannot drift into
 * something genuinely harmful:
 *
 *  1. **Every screen says it is a training target, and says what is wrong with
 *     it.** Proposal section 10 wants the flaw understood, not just triggered.
 *  2. **Every effect stays inside this app's own sandbox.** Nothing here writes
 *     outside app storage, reads a real user record, or contacts a remote host.
 *     The class of bug is real; the blast radius is nil.
 */
open class ToyActivity : Activity() {

    protected lateinit var body: LinearLayout

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val scroll = android.widget.ScrollView(this)
        body = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(20), dp(20), dp(40))
            setBackgroundColor(BG)
        }
        scroll.addView(body, ViewGroup.LayoutParams(MATCH, WRAP))
        setContentView(scroll)
    }

    /**
     * Clears the body and lets the caller repopulate it.
     *
     * Needed by targets that react to something arriving after onCreate -- most
     * notably a deep link delivered to onNewIntent, where the tab has to redraw
     * with the new intent rather than keep showing whatever it first rendered.
     */
    protected fun rebuild(fill: () -> Unit) {
        body.removeAllViews()
        fill()
    }

    /** The red banner. Present on every target, first thing, every time. */
    protected fun header(lesson: String, vulnerability: String) {
        body.addView(text("TRAINING TARGET — DELIBERATELY VULNERABLE", 12f, RED, bold = true))
        body.addView(text(vulnerability, 20f, FG, bold = true).withTop(6))
        body.addView(rule())
        body.addView(text("What this demonstrates", 11f, DIM).withTop(4))
        body.addView(text(lesson, 14f, FG).withTop(2))
        body.addView(rule().withTop(12))
    }

    protected fun section(title: String) {
        body.addView(text(title.uppercase(), 11f, DIM).withTop(18).apply { letterSpacing = 0.08f })
    }

    /** A labelled key/value panel. The common way a target shows "this is what the
     *  flaw gave the attacker". */
    protected fun result(label: String, value: String, tone: Int = FG) {
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(12), dp(10), dp(12), dp(10))
            setBackgroundColor(PANEL)
        }
        row.addView(text(label, 11f, DIM))
        row.addView(text(value, 13f, tone).withTop(2))
        body.addView(row.withTop(6))
    }

    protected fun actionButton(label: String, onClick: () -> Unit) =
        android.widget.Button(this).apply {
            text = label
            isAllCaps = false
            setOnClickListener { onClick() }
            layoutParams = LinearLayout.LayoutParams(MATCH, WRAP)
        }

    protected fun note(msg: String) {
        body.addView(text(msg, 13f, DIM).withTop(6))
    }

    protected fun fix(msg: String) {
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(12), dp(10), dp(12), dp(10))
            setBackgroundColor(GOOD_BG)
        }
        row.addView(text("HOW TO FIX IT", 11f, GOOD))
        row.addView(text(msg, 13f, FG).withTop(3))
        body.addView(row.withTop(10))
    }

    private fun rule() = View(this).apply {
        setBackgroundColor(LINE)
        layoutParams = LinearLayout.LayoutParams(MATCH, dp(1))
    }

    protected fun text(v: String, size: Float, color: Int, bold: Boolean = false) =
        TextView(this).apply {
            text = v
            textSize = size
            setTextColor(color)
            if (bold) setTypeface(typeface, android.graphics.Typeface.BOLD)
            setLineSpacing(0f, 1.35f)
        }

    protected fun <T : View> T.withTop(d: Int): T = apply {
        val lp = (layoutParams as? ViewGroup.MarginLayoutParams)
            ?: ViewGroup.MarginLayoutParams(MATCH, WRAP)
        lp.topMargin = dp(d)
        layoutParams = lp
    }

    protected fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    protected companion object {
        const val MATCH = ViewGroup.LayoutParams.MATCH_PARENT
        const val WRAP = ViewGroup.LayoutParams.WRAP_CONTENT
        val BG = Color.parseColor("#12100E")
        val PANEL = Color.parseColor("#1E1A17")
        val LINE = Color.parseColor("#3A2F28")
        val FG = Color.parseColor("#F2E8E0")
        val DIM = Color.parseColor("#A8968A")
        val RED = Color.parseColor("#F87171")
        val GOOD = Color.parseColor("#4ADE80")
        val GOOD_BG = Color.parseColor("#12210F")
        val AMBER = Color.parseColor("#FBBF24")
    }
}
