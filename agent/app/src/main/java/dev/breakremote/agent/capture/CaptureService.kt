package dev.breakremote.agent.capture

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.Paint
import android.hardware.display.DisplayManager
import android.view.Display
import android.hardware.display.VirtualDisplay
import android.media.Image
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.os.PowerManager
import android.os.SystemClock
import android.util.Log
import android.view.Surface
import dev.breakremote.agent.R
import dev.breakremote.agent.net.Protocol
import dev.breakremote.agent.net.Session
import dev.breakremote.agent.ui.MainActivity
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * Screen capture: MediaProjection -> ImageReader -> JPEG -> relay.
 *
 * ### The three orderings that break this if you get them wrong
 *
 *  1. **`startForeground()` before `getMediaProjection()`.** On API 34+ the
 *     reverse order throws. The notification is not optional here; it is the
 *     precondition for the token.
 *
 *  2. **`registerCallback()` before `createVirtualDisplay()`.** Also mandatory on
 *     API 34+. Skipping it means `createVirtualDisplay` throws and the service
 *     dies with no user-visible symptom beyond a blank canvas.
 *
 *  3. **`image.close()` in a `finally`, and never hold the buffer past it.** The
 *     ImageReader only has `maxImages` (2) buffers. Leaking one stalls the
 *     producer and the live view freezes permanently.
 *
 * ### Memory
 *
 * Every buffer in the loop is allocated once in [startCapture] and reused for the
 * life of the session: two `Bitmap`s, one `IntArray`, one row scratch buffer, one
 * `ByteArrayOutputStream`. Allocating a `Bitmap` per frame is the classic way this
 * pattern OOMs a mid-range phone within a minute.
 */
class CaptureService : Service() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    private var projection: MediaProjection? = null
    private var projectionCallback: MediaProjection.Callback? = null
    private var reader: ImageReader? = null
    private var virtualDisplay: VirtualDisplay? = null
    private var captureThread: HandlerThread? = null
    private var captureHandler: Handler? = null

    // Reused buffers. Never reassigned while the loop is running.
    private var srcBitmap: Bitmap? = null
    private var dstBitmap: Bitmap? = null
    private var pixels: IntArray = IntArray(0)
    private var rowScratch: ByteArray = ByteArray(0)
    private val jpegSink = ByteArrayOutputStream(256 * 1024)
    private val matrix = Matrix()
    private val paint = Paint(Paint.FILTER_BITMAP_FLAG)

    private var seq = 0L
    @Volatile private var running = false

    /** Raw (unrotated) capture size, i.e. what the VirtualDisplay produces. */
    private var rawW = 0
    private var rawH = 0
    @Volatile private var rotation = Surface.ROTATION_0

    /** Cached handle so the per-frame rotation check is a field read, not a
     *  service lookup. */
    private var display: Display? = null
    private var dstW = 0
    private var dstH = 0
    private var wakeLock: PowerManager.WakeLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // (1) Foreground first. Must precede getMediaProjection on API 34+.
        startForegroundCompat(notification())

        if (intent?.getBooleanExtra(EXTRA_NEEDS_CONSENT, false) == true) {
            reportNeedsConsent("screen capture consent is required")
            stopSelf()
            return START_NOT_STICKY
        }

        val resultCode = intent?.getIntExtra(EXTRA_RESULT_CODE, Int.MIN_VALUE) ?: Int.MIN_VALUE
        val resultData: Intent? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            intent?.getParcelableExtra(EXTRA_RESULT_DATA, Intent::class.java)
        } else {
            @Suppress("DEPRECATION")
            intent?.getParcelableExtra(EXTRA_RESULT_DATA) as? Intent
        }

        if (resultCode != android.app.Activity.RESULT_OK || resultData == null) {
            reportNeedsConsent("no screen capture consent was granted")
            stopSelf()
            return START_NOT_STICKY
        }

        if (running) return START_STICKY

        scope.launch {
            try {
                begin(resultCode, resultData)
            } catch (t: Throwable) {
                Log.e(TAG, "capture failed to start", t)
                reportNeedsConsent("capture could not start: ${t.message}")
                stopSelf()
            }
        }
        return START_STICKY
    }

    private suspend fun begin(resultCode: Int, resultData: Intent) {
        val mpm = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        val mp = mpm.getMediaProjection(resultCode, resultData)
            ?: throw IllegalStateException("MediaProjection was refused")
        projection = mp

        // (2) Callback before createVirtualDisplay, mandatory on API 34+.
        val callback = object : MediaProjection.Callback() {
            override fun onStop() {
                // The user revoked capture from the system UI, or the projection
                // was killed. Android 14+ cannot silently re-acquire consent, so
                // the honest response is to tell the console and stop.
                Log.w(TAG, "MediaProjection stopped by the system")
                reportNeedsConsent("screen capture was stopped; tap Re-grant on the phone")
                stopSelf()
            }
        }
        projectionCallback = callback
        mp.registerCallback(callback, captureHandler ?: Handler(mainLooper))

        val (rw, rh, rot) = displayGeometry()
        rawW = rw
        rawH = rh
        rotation = rot

        val scale = captureScaleFor(rw, rh)
        val capW = (rw * scale).roundToInt().coerceAtLeast(160)
        val capH = (rh * scale).roundToInt().coerceAtLeast(160)

        val imageReader = ImageReader.newInstance(capW, capH, android.graphics.PixelFormat.RGBA_8888, 2)
        reader = imageReader

        val surface = imageReader.surface
        virtualDisplay = mp.createVirtualDisplay(
            "break-remote",
            capW, capH, resources.displayMetrics.densityDpi,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_PUBLIC or
                DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
            surface, null, captureHandler ?: Handler(mainLooper)
        ) ?: throw IllegalStateException("createVirtualDisplay returned null")

        // Allocate every reusable buffer once, at the real capture size.
        srcBitmap = Bitmap.createBitmap(capW, capH, Bitmap.Config.ARGB_8888)
        pixels = IntArray(capW * capH)
        rowScratch = ByteArray(capW * 4)
        dstW = displayW()
        dstH = displayH()
        dstBitmap = Bitmap.createBitmap(dstW, dstH, Bitmap.Config.ARGB_8888)

        acquireWakeLock()
        startLoop()
        running = true
        isCapturing = true
        needsConsent = null

        Session.sendEvent("capture", JSONObject()
            .put("state", "live")
            .put("raw", "${capW}x$capH")
            .put("out", "${displayW()}x${displayH()}")
            .put("fps", quality.fps)
            .put("q", quality.jpegQuality))
        Log.i(TAG, "capturing ${capW}x$capH raw, ${displayW()}x${displayH()} display space")
    }

    // ------------------------------------------------------------- capture loop

    private fun startLoop() {
        val thread = HandlerThread("brk-capture", android.os.Process.THREAD_PRIORITY_URGENT_AUDIO)
        thread.start()
        captureThread = thread
        val handler = Handler(thread.looper)
        captureHandler = handler
        handler.post(frameTask)
    }

    private val frameTask = object : Runnable {
        override fun run() {
            val handler = captureHandler ?: return
            if (!running) return
            val started = SystemClock.elapsedRealtime()
            try {
                captureOnce()
            } catch (t: Throwable) {
                Log.w(TAG, "frame error: ${t.message}")
            }
            val elapsed = SystemClock.elapsedRealtime() - started
            // Never spin: if encoding is slower than the target interval, we
            // capture as fast as the phone manages and let the relay drop the
            // difference. A tight loop here is how a phone reaches thermal
            // shutdown mid-demo.
            val delay = (quality.intervalMs() - elapsed).coerceAtLeast(8L)
            handler.postDelayed(this, delay)
        }
    }

    private fun captureOnce() {
        val imageReader = reader ?: return
        val src = srcBitmap ?: return
        syncRotation()
        val dst = dstBitmap ?: return

        var image: Image? = null
        try {
            image = imageReader.acquireLatestImage() ?: return
            copyToBitmap(image, src)
        } finally {
            // (3) Always close, or the producer stalls after `maxImages` frames.
            image?.close()
        }

        transform(src, dst)

        jpegSink.reset()
        dst.compress(Bitmap.CompressFormat.JPEG, quality.jpegQuality, jpegSink)
        if (jpegSink.size() > Protocol.MAX_FRAME_BYTES) {
            Log.w(TAG, "frame too large (${jpegSink.size()} bytes); dropping")
            return
        }

        val header = Protocol.frameHeaderJson(
            deviceId = Session.currentDeviceId(this),
            w = dst.width,
            h = dst.height,
            rot = rotationDegrees(),
            seq = seq++,
            quality = quality.jpegQuality,
            tsMs = System.currentTimeMillis()
        )
        Session.sendFrame(Protocol.buildFrame(header, jpegSink.toByteArray()))
    }

    /**
     * Copies an Image plane into a Bitmap.
     *
     * `Bitmap.copyPixelsFromBuffer` assumes a tightly packed buffer, but
     * `Image.Plane.rowStride` is routinely wider than `width * 4`. Assuming they
     * are equal shears the image by a few pixels per row -- it looks almost
     * right, which is worse than an obvious failure, and it only shows up on
     * particular hardware. So the stride is honoured explicitly.
     */
    private fun copyToBitmap(image: Image, target: Bitmap) {
        val plane = image.planes[0]
        val buffer = plane.buffer
        val width = image.width
        val height = image.height
        val rowStride = plane.rowStride
        val pixelStride = plane.pixelStride

        buffer.rewind()
        val needed = width * height

        if (pixelStride == 4 && rowStride == width * 4 && buffer.remaining() >= needed * 4) {
            buffer.asIntBuffer().get(pixels, 0, needed)
        } else {
            val row = rowScratch
            for (y in 0 until height) {
                val base = y * rowStride
                val available = min(rowStride, buffer.limit() - base).coerceAtLeast(0)
                val take = min(available, row.size)
                buffer.position(base)
                buffer.get(row, 0, take)
                var x = 0
                var i = 0
                val limit = take - 3
                while (x < width && i <= limit) {
                    pixels[y * width + x] =
                        (row[i].toInt() and 0xFF) or
                            ((row[i + 1].toInt() and 0xFF) shl 8) or
                            ((row[i + 2].toInt() and 0xFF) shl 16) or
                            ((row[i + 3].toInt() and 0xFF) shl 24)
                    x++
                    i += pixelStride
                }
            }
        }
        target.setPixels(pixels, 0, width, 0, 0, width, height)
    }

    /**
     * Rotates and scales the raw capture into display space, so the header's
     * w/h are the coordinate space a tap must use and the console needs no
     * client-side transform.
     */
    private fun transform(src: Bitmap, dst: Bitmap) {
        matrix.reset()
        val degrees = rotationDegrees()
        if (degrees != 0) {
            matrix.postRotate(degrees.toFloat(), src.width / 2f, src.height / 2f)
        }
        canvas.setBitmap(dst)
        canvas.drawColor(Color.BLACK)
        canvas.drawBitmap(src, matrix, paint)
        canvas.setBitmap(null)
    }

    private val canvas = Canvas()

    // ---------------------------------------------------------------- geometry

    private fun displayGeometry(): Triple<Int, Int, Int> {
        val dm = getSystemService(Context.DISPLAY_SERVICE) as DisplayManager
        val d = dm.getDisplay(Display.DEFAULT_DISPLAY)
        display = d
        val rot = d?.rotation ?: Surface.ROTATION_0
        val pw = d?.mode?.physicalWidth ?: 1080
        val ph = d?.mode?.physicalHeight ?: 1920
        return Triple(pw, ph, rot)
    }

    /**
     * Picks up a rotation change.
     *
     * The VirtualDisplay always produces the raw panel, which does not change
     * with rotation -- so the capture buffers stay valid and only the transform
     * and the advertised display space change. That means a rotation mid-demo
     * costs one small reallocation rather than a dropped projection, and without
     * this the header's w/h go stale and every tap lands in the wrong place.
     */
    private fun syncRotation(): Boolean {
        val current = display?.rotation ?: return false
        if (current == rotation) return false
        rotation = current
        val w = displayW()
        val h = displayH()
        if (w != dstW || h != dstH) {
            dstW = w
            dstH = h
            if (w > 0 && h > 0) {
                dstBitmap?.recycle()
                dstBitmap = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
                canvas.setBitmap(null)
            }
        }
        Log.i(TAG, "rotation changed to ${rotationDegrees()}deg; display space is now ${dstW}x$dstH")
        Session.sendEvent("capture", JSONObject()
            .put("state", "rotated")
            .put("rot", rotationDegrees())
            .put("out", "$dstW x $dstH".replace(" ", "")))
        return true
    }

    /**
     * A partial wakelock keeps the CPU between frames so the encoder holds its
     * target rate. It does **not** keep the screen on -- nothing an app can do
     * prevents the display timeout, which is why the enrollment screen walks the
     * owner through Screen timeout -> 30 minutes instead of pretending otherwise.
     */
    private fun acquireWakeLock() {
        try {
            val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "brk:capture").apply {
                setReferenceCounted(false)
                acquire(10 * 60 * 60 * 1000L)
            }
        } catch (_: Exception) {
            // A missing wakelock costs frame rate, not correctness.
        }
    }

    private fun rotationDegrees(): Int = when (rotation) {
        Surface.ROTATION_90 -> 90
        Surface.ROTATION_180 -> 180
        Surface.ROTATION_270 -> 270
        else -> 0
    }

    /** Display space, i.e. portrait is tall regardless of how the panel is wired. */
    private fun displayW(): Int =
        if (rotationDegrees() % 180 == 0) rawW else rawH

    private fun displayH(): Int =
        if (rotationDegrees() % 180 == 0) rawH else rawW

    private fun captureScaleFor(w: Int, h: Int): Float {
        val longEdge = max(w, h)
        return min(1f, quality.longEdge.toFloat() / longEdge)
    }

    // ------------------------------------------------------------------ quality

    data class Quality(val fps: Int, val longEdge: Int, val jpegQuality: Int) {
        fun intervalMs(): Long = 1000L / fps.coerceAtLeast(1)
    }

    companion object {
        const val TAG = "brk/capture"
        const val CHANNEL_ID = "brk_capture"
        const val NOTIFICATION_ID = 4201

        const val EXTRA_RESULT_CODE = "result_code"
        const val EXTRA_RESULT_DATA = "result_data"
        const val EXTRA_NEEDS_CONSENT = "needs_consent"

        /** Plan section 6.1 caps the long edge at 854. */
        private const val MAX_LONG_EDGE = 854

        @Volatile
        private var quality = Quality(fps = 10, longEdge = 854, jpegQuality = 35)

        /** Read by the enrollment screen's live badge. Same process, so a plain
         *  static is the honest source of truth here. */
        @Volatile
        var isCapturing: Boolean = false
            private set

        /** Set when the system revokes capture and consent must be re-granted. */
        @Volatile
        var needsConsent: String? = null

        @Volatile
        private var consentCallback: ((String) -> Unit)? = null

        fun setConsentCallback(cb: (String) -> Unit) {
            consentCallback = cb
        }

        fun currentQuality(): Quality = quality

        /**
         * Applies a console-requested quality change. Clamped hard: the console is
         * a web page and must not be able to ask the phone for 0 fps or a 4000px
         * capture that would thermal-throttle the device.
         */
        @JvmStatic
        fun applyQuality(fps: Int, longEdge: Int, q: Int) {
            val next = Quality(
                fps = fps.coerceIn(1, 20),
                longEdge = longEdge.coerceIn(240, MAX_LONG_EDGE),
                jpegQuality = q.coerceIn(10, 90)
            )
            if (next == quality) return
            quality = next
            Log.i(TAG, "quality -> $next")
        }

        private fun reportNeedsConsent(reason: String) {
            Log.w(TAG, reason)
            needsConsent = reason
            Session.sendEvent("capture", JSONObject()
                .put("state", "needsConsent")
                .put("reason", reason))
            consentCallback?.invoke(reason)
        }

        fun buildStartIntent(context: Context, resultCode: Int, data: Intent?): Intent =
            Intent(context, CaptureService::class.java)
                .putExtra(EXTRA_RESULT_CODE, resultCode)
                .putExtra(EXTRA_RESULT_DATA, data)

        fun buildNeedsConsentIntent(context: Context): Intent =
            Intent(context, CaptureService::class.java)
                .putExtra(EXTRA_NEEDS_CONSENT, true)

        fun stop(context: Context) {
            context.stopService(Intent(context, CaptureService::class.java))
        }
    }

    // ------------------------------------------------------------- foreground

    private fun notification(): Notification {
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (manager.getNotificationChannel(CHANNEL_ID) == null) {
            manager.createNotificationChannel(
                NotificationChannel(
                    CHANNEL_ID,
                    getString(R.string.capture_channel_name),
                    NotificationManager.IMPORTANCE_LOW
                ).apply {
                    description = getString(R.string.capture_channel_description)
                    setShowBadge(false)
                }
            )
        }

        val reopen = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )

        return Notification.Builder(this, CHANNEL_ID)
            .setContentTitle(getString(R.string.capture_notification_title))
            .setContentText(getString(R.string.capture_notification_text))
            .setSmallIcon(android.R.drawable.ic_menu_view)
            .setContentIntent(reopen)
            .setOngoing(true)
            .setShowWhen(false)
            .build()
    }

    private fun startForegroundCompat(n: Notification) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                NOTIFICATION_ID, n,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
            )
        } else {
            startForeground(NOTIFICATION_ID, n)
        }
    }

    // ---------------------------------------------------------------- teardown

    override fun onDestroy() {
        running = false
        isCapturing = false
        captureHandler?.removeCallbacksAndMessages(null)
        virtualDisplay?.release()
        virtualDisplay = null
        reader?.close()
        reader = null
        try {
            // stop() releases the projection and its callbacks. unregisterCallback
            // is called explicitly too, and needs the original callback reference
            // because the no-arg overload only exists from API 34.
            projectionCallback?.let { projection?.unregisterCallback(it) }
            projection?.stop()
        } catch (_: Exception) {
            // Already stopped by the system.
        }
        projectionCallback = null
        projection = null
        try {
            wakeLock?.let { if (it.isHeld) it.release() }
        } catch (_: Exception) {
            // Already released.
        }
        wakeLock = null
        srcBitmap = null
        dstBitmap = null
        jpegSink.reset()
        captureThread?.quitSafely()
        captureThread = null
        captureHandler = null
        scope.cancel()
        Session.sendEvent("capture", JSONObject().put("state", "stopped"))
        super.onDestroy()
    }
}
