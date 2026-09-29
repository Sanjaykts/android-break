package dev.breakremote.toylab

import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.TextView

/**
 * FLAW 1 of 5 — Insecure deep links and intent handling (proposal section 10).
 *
 * The app registers a browsable `training://toylab` link, is exported, and
 * **never checks who sent the Intent**. Any application on the device, or any web
 * page the user opens, can therefore reach it and supply arbitrary extras.
 *
 * In a real application the untrusted extras drive a privileged action — opening
 * a payment flow, changing an account setting, disabling a check. That is the
 * vulnerability class, and it is a frequent way malicious apps chain into
 * legitimate ones.
 *
 * ## What this target deliberately does NOT do
 *
 * The triggered action displays a string. It does not change a setting, contact a
 * server, or write anywhere. The lesson is entirely in the missing check, and it
 * can be taught without a live target. Proposal section 3 excludes exactly the
 * part that would weaponise it.
 */
class DeepLinkDemo : ToyActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        header(
            lesson = "A browsable link is an unauthenticated input channel. Anything " +
                "the link carries is attacker-controlled, because the app never asks " +
                "who sent it. Real damage comes when those inputs reach a privileged " +
                "action rather than a display.",
            vulnerability = "Insecure deep links and intent handling",
        )

        section("Incoming intent, unvalidated")
        result(
            "action",
            intent?.action ?: "(none)",
        )
        result(
            "data",
            intent?.data?.toString() ?: "(none)",
        )
        result(
            "referrer",
            intent?.getStringExtra("referrer") ?: "(none)",
            tone = AMBER,
        )

        // The flaw, made visible: the extras are consumed with no caller check and
        // no signature check. If this were a real app, this is where the damage
        // would happen.
        val payload = intent?.getStringExtra("payload")
        if (payload != null) {
            result("payload consumed", payload, tone = RED)
            note("No check was made that the sender is this app. Whatever was " +
                "supplied has been acted on.")
        } else {
            note("No payload supplied. Open the trigger below to supply one.")
        }

        section("Trigger the flaw from outside the app")
        body.addView(
            actionButton("Simulate a link from another app") {
                val i = Intent(Intent.ACTION_VIEW, Uri.parse("training://toylab/demo"))
                    .setPackage(packageName)
                    .putExtra("payload", "action=grant_access&target=unverified")
                    .putExtra("referrer", "com.example.someotherapp")
                startActivity(i)
            }.withTop(6),
        )

        section("Why this matters on a real device")
        body.addView(
            text(
                "A hostile app needs no permission to send an Intent to an exported " +
                    "component. A web page can reach one too, through a browsable " +
                    "link, provided the user taps it. Neither path leaves a trace in " +
                    "the target app's own logs that distinguishes it from a legitimate " +
                    "launch.",
                13f, DIM,
            ).withTop(4),
        )

        fix(
            "Validate the caller, not just the input. Check the calling package or " +
                "require a signature-level permission on the component. Treat every " +
                "extra as hostile, validate it against an allowlist, and keep " +
                "privileged actions behind a re-authentication step the deep link " +
                "cannot reach.",
        )
    }

}
