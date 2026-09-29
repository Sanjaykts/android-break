package dev.breakremote.toylab

import android.os.Bundle
import java.net.URL
import javax.net.ssl.HostnameVerifier
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocketFactory
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager

/**
 * FLAW 5 of 5 — Insecure network communication and weak certificate validation
 * (proposal section 10).
 *
 * The app installs a trust manager that accepts **every** certificate, and a
 * hostname verifier that accepts **every** hostname. Together they turn TLS into
 * encryption without authentication, which is close to no encryption at all: any
 * machine able to intercept the connection can present its own certificate and be
 * believed.
 *
 * This is the most common network finding in mobile assessment, and it is almost
 * always reached through a well-meant line:
 *
 *     // "just for testing"
 *     trustManager.checkServerTrusted = { _, _ -> }
 *
 * A `trust-all` trust manager also disables the protection against a
 * downgrade to a user-installed CA, so the vulnerability is rarely limited to
 * machines already on the network.
 *
 * ## What this target deliberately does NOT do
 *
 * The request goes to **127.0.0.1** — the lab's own telemetry server, or nothing
 * at all if it is not running. No external host is contacted, no data is sent
 * anywhere, and nothing is exfiltrated. The demonstration is that a hostile
 * certificate is accepted, shown by the fact that the connection succeeded.
 */
class WeakTlsDemo : ToyActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        header(
            lesson = "A trust-all TrustManager plus a permissive HostnameVerifier " +
                "means the certificate is never checked. The channel is encrypted, " +
                "but to whoever is in the middle. Anyone who can intercept can also " +
                "read and modify the traffic, and the app cannot tell.",
            vulnerability = "Insecure network communication and weak certificate validation",
        )

        section("The vulnerable code, which is short")
        body.addView(
            text(
                "class AcceptAllTrustManager : X509TrustManager {\n" +
                    "  override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {\n" +
                    "    // FLAW: accepts every certificate, including self-signed ones\n" +
                    "  }\n" +
                    "  override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) {}\n" +
                    "  override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()\n" +
                    "}\n\n" +
                    "sslContext.socketFactory = AcceptAllSSLSocketFactory(trustManager)\n" +
                    "connection.hostnameVerifier = HostnameVerifier { _, _ -> true }   // FLAW",
                12f, DIM,
            ).withTop(4),
        )

        section("Attempt a request with validation disabled")
        body.addView(
            actionButton("Connect to the lab server, accepting any certificate") { attempt() }.withTop(6),
        )

        section("What the fix looks like")
        body.addView(
            text(
                "Remove the custom trust manager entirely and let the platform " +
                    "default apply. The platform validates the chain, the hostname, " +
                    "and the expiry, and it is correct far more often than any " +
                    "replacement a developer writes.\n\n" +
                    "Where a private CA is genuinely needed — a corporate proxy, an " +
                    "internal PKI — add that one CA to the trust store in " +
                    "network_security_config. Pin to a specific CA, not to the " +
                    "system set.\n\n" +
                    "For certificate pinning, pin in network_security_config where " +
                    "possible. The code-based pinning libraries that predate it were " +
                    "routinely bypassable, because an attacker who controls the " +
                    "connection also controls the delegate the app trusts.",
                13f, DIM,
            ).withTop(4),
        )

        fix(
            "Delete the custom trust manager. Declare a network security " +
                "configuration that pins the CA you actually trust, enable " +
                "cleartextTraffic=\"false\" unless you have a specific reason, and " +
                "never ship a trust-all path even behind a debug flag — debug flags " +
                "survive into release more often than anyone expects.",
        )
    }

    private fun attempt() {
        val target = "https://127.0.0.1:8787/lab/health"
        var out: String
        var accepted = false
        try {
            val trust = object : X509TrustManager {
                @Suppress("TrustAllX509TrustManager")
                override fun checkServerTrusted(chain: Array<java.security.cert.X509Certificate>?, authType: String?) {
                    // FLAW, deliberately. Accepts anything.
                }
                override fun checkClientTrusted(chain: Array<java.security.cert.X509Certificate>?, authType: String?) {}
                override fun getAcceptedIssuers(): Array<java.security.cert.X509Certificate> = emptyArray()
            }
            val ctx = SSLContext.getInstance("TLS")
            ctx.init(null, arrayOf<TrustManager>(trust), java.security.SecureRandom())
            // A trust-all socket factory. On Android SSLSocketFactory declares
            // only two abstract createSocket overloads; the host/InetAddress
            // variants are not part of the abstract surface here, so overriding
            // them would not compile. javax.net.sockets is also absent from
            // android.jar, so the return type is java.net.Socket throughout.
            // A trust-all socket factory. Kotlin resolves three abstract
            // createSocket overloads on this platform (javap on android.jar shows
            // only two, which is why this is worth checking rather than guessing):
            //   (Socket, String, int, boolean)
            //   (Socket, InputStream, boolean)
            //   (String, int)
            // The remaining host/InetAddress variants are concrete here, and
            // javax.net.sockets does not exist on Android at all.
            // A trust-all socket factory. The exact set of abstract overloads
            // varies between the android.jar stubs and what Kotlin resolves, so
            // all six standard signatures are implemented rather than guessed at.
            // javax.net.sockets does not exist on Android, so everything here is
            // typed in terms of java.net.Socket.
            // A trust-all socket factory.
            //
            // SSLSocketFactory has exactly ONE abstract method on Android:
            // createSocket(Socket, String, int, boolean). The host/InetAddress
            // overloads are concrete in the base class and delegate to it, so
            // overriding them is unnecessary -- and attempting it fails to compile
            // with "overrides nothing". javax.net.sockets is also absent from
            // android.jar, so everything is typed in terms of java.net.Socket.
            val inner: SSLSocketFactory = ctx.socketFactory
            val factory = object : SSLSocketFactory() {
                override fun getDefaultCipherSuites(): Array<String> = inner.defaultCipherSuites
                override fun getSupportedCipherSuites(): Array<String> = inner.supportedCipherSuites
                override fun createSocket(
                    s: java.net.Socket,
                    host: String,
                    port: Int,
                    autoClose: Boolean,
                ): java.net.Socket = inner.createSocket(s, host, port, autoClose)

                override fun createSocket(host: String, port: Int): java.net.Socket =
                    inner.createSocket(host, port)

                override fun createSocket(
                    host: String,
                    port: Int,
                    localHost: java.net.InetAddress,
                    localPort: Int,
                ): java.net.Socket = inner.createSocket(host, port, localHost, localPort)

                override fun createSocket(host: java.net.InetAddress, port: Int): java.net.Socket =
                    inner.createSocket(host, port)

                override fun createSocket(
                    address: java.net.InetAddress,
                    port: Int,
                    localAddress: java.net.InetAddress,
                    localPort: Int,
                ): java.net.Socket = inner.createSocket(address, port, localAddress, localPort)
            }

            val conn = URL(target).openConnection() as HttpsURLConnection
            conn.sslSocketFactory = factory
            conn.hostnameVerifier = HostnameVerifier { _, _ -> true }   // FLAW
            conn.connectTimeout = 4000
            conn.readTimeout = 4000
            val code = conn.responseCode
            accepted = true
            out = "HTTP $code — connection succeeded against a certificate that was " +
                "never verified.\n\nThe app cannot distinguish this from a legitimate " +
                "server. An interceptor presenting its own certificate would look " +
                "identical."
            conn.disconnect()
        } catch (e: Exception) {
            out = "No lab TLS endpoint to attack (${e.javaClass.simpleName}).\n\n" +
                "That is the expected result when the lab server is not running. Start " +
                "it with `cd relay && npm run dev`, or point this at any lab endpoint " +
                "with a self-signed certificate — the point is that the handshake is " +
                "accepted, not that a particular server is up."
        }
        result(
            "result",
            out,
            tone = if (accepted) RED else AMBER,
        )
    }
}
