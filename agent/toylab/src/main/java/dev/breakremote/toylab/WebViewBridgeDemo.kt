package dev.breakremote.toylab

import android.annotation.SuppressLint
import android.os.Bundle
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.LinearLayout

/**
 * FLAW 2 of 5 — WebView misconfiguration and unsafe JavaScript bridges
 * (proposal section 10).
 *
 * The app loads remote content into a WebView with JavaScript enabled, and
 * registers a native object into the JavaScript context via
 * `addJavascriptInterface`. Every method on that object is callable by whatever
 * page is loaded, including a page an attacker controls or one reached through a
 * redirect.
 *
 * This is the mechanism behind a long line of real-world compromise: a native
 * method that reads a file, loads a library, or starts an activity becomes
 * reachable from a web page that should not have been able to touch it at all.
 * The classic instance is `RemoteInterface`-style dispatch, where a single
 * reflected `invoke` method exposes an entire API surface.
 *
 * ## What this target deliberately does NOT do
 *
 * `NativeBridge.call()` returns a fixed acknowledgement. It does not read files,
 * load code, start activities, or contact anything. The demonstration is that
 * **JavaScript reached a native method at all** -- which is the whole finding.
 */
class WebViewBridgeDemo : ToyActivity() {

    /** Calls made by the page, so the analyst can see the bridge being used. */
    private val calls = mutableListOf<String>()

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        header(
            lesson = "`addJavascriptInterface` publishes a native object into the " +
                "JavaScript context. Anything the WebView loads — including a hostile " +
                "page or a redirect to one — can call its methods. The flaw is the " +
                "bridge existing at all, not the content of the method.",
            vulnerability = "WebView misconfiguration and unsafe JavaScript bridge",
        )

        val wv = WebView(this).apply {
            settings.javaScriptEnabled = true          // FLAW: needed for the bridge
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            addJavascriptInterface(NativeBridge(), "AndroidBridge")  // FLAW
            webViewClient = object : WebViewClient() {}
            loadDataWithBaseURL(
                "https://training.invalid/",
                PAGE,
                "text/html",
                "utf-8",
                null,
            )
        }
        // The WebView's layoutParams are set in its own constructor, so the generic
        // withTop() extension cannot infer the receiver type here. Set the margin
        // on a params object instead.
        val wvParams = LinearLayout.LayoutParams(MATCH, dp(240))
        wvParams.topMargin = dp(8)
        body.addView(wv, wvParams)

        section("Bridge calls received")
        val log = text("waiting for the page to call the bridge…", 12f, DIM)
        body.addView(log.withTop(4))
        Thread {
            while (true) {
                Thread.sleep(400)
                val snapshot = synchronized(calls) { calls.toList() }
                if (snapshot.isNotEmpty()) {
                    runOnUiThread {
                        log.text = snapshot.joinToString("\n")
                        log.setTextColor(RED)
                    }
                }
            }
        }.apply { isDaemon = true; start() }

        section("What the page could do instead")
        body.addView(
            text(
                "A real bridge often exposes something like `readFile(path)`, " +
                    "`loadClass(name)`, or a reflected `invoke(method, args)`. Any of " +
                    "those turns a page into code running with this app's identity and " +
                    "permissions. Here the method only records its argument, so the " +
                    "exercise is safe to run on a device you care about.",
                13f, DIM,
            ).withTop(4),
        )

        fix(
            "Do not add a JavaScript bridge to a WebView that loads untrusted or " +
                "remote content. If a bridge is unavoidable, keep the surface minimal, " +
                "validate every argument against an allowlist, never reflect, never " +
                "touch the filesystem or the classloader, and pin navigation with " +
                "`shouldOverrideUrlLoading` so a redirect cannot swap the page under " +
                "a trusted URL.",
        )
    }

    /**
     * The vulnerable surface. Intentionally trivial: it proves reachability,
     * which is the actual finding, and nothing more.
     */
    inner class NativeBridge {
        @JavascriptInterface
        fun call(payload: String): String {
            synchronized(calls) {
                calls += "NativeBridge.call(\"$payload\") reached the Android app"
            }
            return "acknowledged"
        }
    }

    private companion object {
        const val PAGE = """
<!doctype html>
<html><head><meta charset="utf-8"><style>
 body{font:14px system-ui;margin:16px;background:#fff;color:#111}
 .w{background:#fee;border:1px solid #c00;padding:10px;border-radius:6px;margin-bottom:12px}
 button{padding:8px 12px;font-size:14px}
</style></head>
<body>
<div class="w"><strong>Simulated hostile page.</strong> In a real attack this HTML
would be served by an attacker and loaded here, or reached through a redirect.</div>
<p>Attempting to reach the native bridge…</p>
<button onclick="tryBridge()">Call the native method</button>
<pre id="out"></pre>
<script>
function tryBridge(){
  var out = document.getElementById('out');
  try {
    if (typeof AndroidBridge === 'undefined') {
      out.textContent = 'no bridge exposed'; return;
    }
    var r = AndroidBridge.call('payload-from-untrusted-page');
    out.textContent = 'bridge returned: ' + r +
                      '\n\nThe page called into the Android app. On a real bridge this ' +
                      'is where it reads a file or starts an activity.';
  } catch (e) { out.textContent = 'blocked: ' + e; }
}
// Auto-attempt so the demonstration does not depend on someone tapping.
setTimeout(tryBridge, 300);
</script>
</body></html>
"""
    }
}
