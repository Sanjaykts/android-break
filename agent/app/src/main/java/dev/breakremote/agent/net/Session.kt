package dev.breakremote.agent.net

import android.content.Context
import android.util.Log
import dev.breakremote.agent.BuildConfig
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import org.json.JSONObject
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong

/**
 * The phone's single outbound connection to the relay.
 *
 * The phone can only dial out, so this is the whole transport: one WebSocket that
 * reconnects forever, re-identifies itself on every reconnect, and keeps a
 * protocol-level ping running so the relay's Durable Object can hibernate between
 * frames instead of staying resident and billing.
 *
 * ### Backpressure
 *
 * Screen frames are **latest-wins with a hard drop**. If the previous frame has
 * not drained, the new one is discarded rather than queued. This is not a
 * nicety: on a stalled 4G uplink an unbounded queue grows until the phone OOMs,
 * which on demo day is unrecoverable because the only fix is uninstalling.
 * A dropped frame is invisible; a crash ends the session.
 */
object Session {

    const val TAG = "brk/session"

    enum class State { IDLE, CONNECTING, LIVE, BACKOFF, FAILED }

    /** A high-water mark for the send queue, in bytes. */
    private const val QUEUE_HIGH_WATER = 512L * 1024L

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    private val _state = MutableStateFlow(State.IDLE)
    val state: StateFlow<State> = _state

    private val _lastError = MutableStateFlow<String?>(null)
    val lastError: StateFlow<String?> = _lastError

    private var client: OkHttpClient? = null
    private var socket: WebSocket? = null
    private var deviceId: String = ""
    private var backoffMs = 1_000L
    private var stopped = true

    private val droppedFrames = AtomicLong(0)
    private val sentFrames = AtomicLong(0)

    /** Set by ControlService; receives every inbound command. */
    @Volatile
    var commandHandler: ((JSONObject) -> Unit)? = null

    /** Set by the enrollment screen; reports connectivity for the live badges. */
    @Volatile
    var stateListener: ((State, String?) -> Unit)? = null

    fun currentDeviceId(context: Context): String {
        if (deviceId.isEmpty()) deviceId = DeviceIdentity.deviceId(context)
        return deviceId
    }

    // ------------------------------------------------------------------ config

    fun relayUrl(context: Context): String =
        DeviceIdentity.prefs(context).getString("relay_url", null)
            ?.takeIf { it.isNotBlank() }
            ?: BuildConfig.RELAY_URL

    fun agentToken(context: Context): String =
        DeviceIdentity.prefs(context).getString("agent_token", null)
            ?.takeIf { it.isNotBlank() }
            ?: BuildConfig.AGENT_TOKEN

    // --------------------------------------------------------------- lifecycle

    fun start(context: Context) {
        val app = context.applicationContext
        deviceId = currentDeviceId(app)
        if (!stopped) return
        stopped = false
        backoffMs = 1_000L
        open(app)
    }

    fun stop() {
        stopped = true
        socket?.close(NORMAL_CLOSURE, "agent stopping")
        socket = null
        client?.dispatcher?.executorService?.shutdown()
        client = null
        _state.value = State.IDLE
        publish(State.IDLE, null)
    }

    private fun open(context: Context) {
        _state.value = State.CONNECTING
        publish(State.CONNECTING, null)

        val http = OkHttpClient.Builder()
            // Protocol-level ping: the runtime answers it and, per Cloudflare's
            // docs, it does not interrupt Durable Object hibernation. Without it
            // an idle relay stays resident and bills.
            .pingInterval(15, TimeUnit.SECONDS)
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .writeTimeout(15, TimeUnit.SECONDS)
            .retryOnConnectionFailure(true)
            .build()
        client = http

        val url = buildString {
            append(relayUrl(context).trimEnd('/'))
            append("/ws/agent?token=")
            append(java.net.URLEncoder.encode(agentToken(context), "UTF-8"))
            append("&device=")
            append(java.net.URLEncoder.encode(deviceId, "UTF-8"))
        }

        val request = Request.Builder().url(url).build()

        socket = http.newWebSocket(request, object : WebSocketListener() {

            override fun onOpen(webSocket: WebSocket, response: Response) {
                Log.i(TAG, "connected to ${relayUrl(context)}")
                backoffMs = 1_000L
                _lastError.value = null
                // Re-identify on every reconnect. A reconnect is the common case
                // on cellular, not an error, and the console should never have to
                // be told twice which phone this is.
                webSocket.send(DeviceIdentity.helloPayload(deviceId))
                _state.value = State.LIVE
                publish(State.LIVE, null)
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                val msg = Protocol.json(text) ?: return
                val handler = commandHandler ?: return
                scope.launch { handler(msg) }
            }

            override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                // The relay never sends frames to an agent. Anything binary here
                // is a protocol error, not something to guess at.
                Log.w(TAG, "unexpected binary message from relay (${bytes.size} bytes)")
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(NORMAL_CLOSURE, null)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                Log.i(TAG, "closed: $code $reason")
                scheduleReconnect(context, if (code == 4401) "relay rejected the agent token" else null)
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                val code = response?.code
                val msg = when {
                    code == 401 -> "relay rejected the agent token"
                    code == 400 -> "relay rejected the device id"
                    else -> t.message ?: t.javaClass.simpleName
                }
                Log.w(TAG, "connection failed: $msg")
                _lastError.value = msg
                // A 401 will never fix itself. Backing off forever just burns
                // battery; stop and let the enrollment screen show the error.
                if (code == 401 || code == 400) {
                    _state.value = State.FAILED
                    publish(State.FAILED, msg)
                    return
                }
                scheduleReconnect(context, msg)
            }
        })
    }

    private fun scheduleReconnect(context: Context, error: String?) {
        if (stopped) return
        socket = null
        _state.value = State.BACKOFF
        publish(State.BACKOFF, error)
        val delay = backoffMs
        backoffMs = (backoffMs * 2).coerceAtMost(30_000L)
        scope.launch {
            delay(delay)
            if (!stopped) open(context)
        }
    }

    private fun publish(s: State, error: String?) {
        scope.launch { stateListener?.invoke(s, error) }
    }

    // ------------------------------------------------------------------ send

    /** Control traffic. Small, ordered, never dropped. */
    fun send(json: JSONObject): Boolean {
        val ws = socket ?: return false
        if (_state.value != State.LIVE) return false
        return ws.send(json.toString())
    }

    fun sendEvent(kind: String, extra: JSONObject = JSONObject()): Boolean {
        val msg = JSONObject().put("op", "event").put("kind", kind)
        for (k in extra.keys()) msg.put(k, extra.get(k))
        return send(msg)
    }

    fun sendResult(ok: Boolean, detail: String): Boolean =
        send(JSONObject().put("op", "result").put("ok", ok).put("detail", detail))

    /**
     * Offers a screen frame. Returns false when the frame was dropped because the
     * previous one has not drained -- the caller should not block or retry.
     */
    fun sendFrame(frame: ByteArray): Boolean {
        val ws = socket ?: return false
        if (_state.value != State.LIVE) return false
        if (ws.queueSize() > QUEUE_HIGH_WATER) {
            droppedFrames.incrementAndGet()
            return false
        }
        val ok = ws.send(frame.toByteString(0, frame.size))
        if (ok) sentFrames.incrementAndGet() else droppedFrames.incrementAndGet()
        return ok
    }

    fun frameStats(): Pair<Long, Long> = sentFrames.get() to droppedFrames.get()

    fun isLive(): Boolean = _state.value == State.LIVE

    private const val NORMAL_CLOSURE = 1000

    fun shutdownForTest() {
        stopped = true
        scope.cancel()
    }
}
