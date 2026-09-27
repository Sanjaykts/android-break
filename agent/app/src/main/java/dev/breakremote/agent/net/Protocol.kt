package dev.breakremote.agent.net

import org.json.JSONObject

/**
 * Wire protocol. The contract with relay/src/protocol.ts and
 * relay/public/app.js -- keep the three in step.
 *
 * Two frame shapes travel over the same WebSocket:
 *
 *  1. UTF-8 JSON text for control traffic.
 *  2. Binary screen frames:
 *
 *       0x01 | u16 headerLen (big-endian) | headerJSON (UTF-8) | JPEG bytes
 *
 * The header's `w`/`h` are the **display coordinate space**, i.e. exactly the
 * space a tap must use. The agent rotates and scales each frame into that space
 * before encoding, so the console never has to transform anything and a tap maps
 * to a pixel with a single multiply.
 */
object Protocol {

    const val FRAME_MAGIC: Byte = 0x01

    /** Plan section 3 caps a frame at 480 KB; the relay rejects anything larger. */
    const val MAX_FRAME_BYTES = 512 * 1024

    fun frameHeaderJson(
        deviceId: String,
        w: Int,
        h: Int,
        rot: Int,
        seq: Long,
        quality: Int,
        tsMs: Long,
    ): ByteArray {
        val json = JSONObject()
            .put("did", deviceId)
            .put("w", w)
            .put("h", h)
            .put("rot", rot)
            .put("seq", seq)
            .put("q", quality)
            .put("ts", tsMs)
            .toString()
        return json.toByteArray(Charsets.UTF_8)
    }

    /**
     * Builds the binary envelope around an already-encoded JPEG. The JPEG bytes
     * are copied into one exact-sized buffer rather than concatenated, so a frame
     * costs one allocation per frame instead of three.
     */
    fun buildFrame(headerJson: ByteArray, jpeg: ByteArray): ByteArray {
        val headerLen = headerJson.size
        val out = ByteArray(3 + headerLen + jpeg.size)
        out[0] = FRAME_MAGIC
        out[1] = ((headerLen shr 8) and 0xFF).toByte()
        out[2] = (headerLen and 0xFF).toByte()
        System.arraycopy(headerJson, 0, out, 3, headerLen)
        System.arraycopy(jpeg, 0, out, 3 + headerLen, jpeg.size)
        return out
    }

    /** Console -> agent commands we accept. Anything else is ignored. */
    fun opOf(json: JSONObject): String = json.optString("op")

    fun json(raw: String): JSONObject? = try {
        JSONObject(raw)
    } catch (_: Exception) {
        null
    }
}
