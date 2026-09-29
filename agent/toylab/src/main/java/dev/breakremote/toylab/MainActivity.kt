package dev.breakremote.toylab

import android.content.Intent
import android.os.Bundle
import android.view.ViewGroup
import android.widget.LinearLayout

/**
 * Index of the five training targets (proposal section 10).
 *
 * One app, five lessons, one install. Each target is a real, deliberately
 * introduced vulnerability class, and each keeps its effect inside this app's own
 * sandbox so the exercise is safe to run on a device anyone cares about.
 */
class MainActivity : ToyActivity() {

    private val targets = listOf(
        Target(
            "1",
            "Insecure deep links and intent handling",
            "An exported, browsable link with no caller check. Untrusted input reaches " +
                "the app from anywhere on the device.",
            DeepLinkDemo::class.java,
        ),
        Target(
            "2",
            "WebView misconfiguration / unsafe JavaScript bridge",
            "addJavascriptInterface publishes a native object into the page, so remote " +
                "content can call into the app.",
            WebViewBridgeDemo::class.java,
        ),
        Target(
            "3",
            "Improperly exported components / insecure IPC",
            "A ContentProvider with no read permission. Every app on the device can " +
                "query it, silently.",
            ExportedComponentDemo::class.java,
        ),
        Target(
            "4",
            "Insecure storage of tokens and sensitive data",
            "A credential in cleartext preferences, in logcat, and in the backup set.",
            InsecureStorageDemo::class.java,
        ),
        Target(
            "5",
            "Insecure network communication / weak certificate validation",
            "A trust-all TrustManager and a permissive HostnameVerifier. Encrypted, " +
                "but not authenticated.",
            WeakTlsDemo::class.java,
        ),
    )

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        body.addView(text("TRAINING TARGET", 12f, RED, bold = true))
        body.addView(text("Five deliberate vulnerabilities", 22f, FG, bold = true).withTop(6))
        body.addView(
            text(
                "This package is not a product. Every flaw on the following screens is " +
                    "intentional and is listed in the engagement scope. Each one keeps " +
                    "its effect inside this app's own sandbox: nothing here reads a " +
                    "real message, file or contact, and nothing contacts a remote host.",
                13.5f, DIM,
            ).withTop(6),
        )

        for (t in targets) {
            val row = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(dp(14), dp(12), dp(14), dp(12))
                setBackgroundColor(PANEL)
                isClickable = true
                isFocusable = true
                setOnClickListener { startActivity(Intent(this@MainActivity, t.activity)) }
            }
            row.addView(text("${t.number}.  ${t.title}", 15f, FG, bold = true))
            row.addView(text(t.blurb, 12.5f, DIM).withTop(4))
            row.addView(text("Open →", 12f, AMBER).withTop(6))
            body.addView(row.withTop(10))
        }

        body.addView(
            text(
                "How to use this in a review: for each target, ask what an attacker " +
                    "gains, then ask what the platform already gave them for free. " +
                    "Three of these five would have been caught by a manifest audit " +
                    "and a dependency check taking under an hour.",
                13f, DIM,
            ).withTop(18),
        )
    }

    private data class Target(
        val number: String,
        val title: String,
        val blurb: String,
        val activity: Class<out android.app.Activity>,
    )
}
