package dev.breakremote.agent.net

import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The binary frame format is the contract between three implementations that do
 * not share a compiler: this agent, relay/src/protocol.ts and
 * relay/public/app.js. A mismatch shows up as a blank canvas with nothing in any
 * log, which is close to undiagnosable on demo day -- so it is pinned here.
 */
class ProtocolTest {

    @Test
    fun `header carries the fields the console maps taps with`() {
        val bytes = Protocol.frameHeaderJson("dev-1", 480, 854, 90, 42L, 35, 1_700_000L)
        val json = JSONObject(String(bytes, Charsets.UTF_8))

        assertEquals("dev-1", json.getString("did"))
        assertEquals(480, json.getInt("w"))
        assertEquals(854, json.getInt("h"))
        assertEquals(90, json.getInt("rot"))
        assertEquals(42L, json.getLong("seq"))
        assertEquals(35, json.getInt("q"))
    }

    @Test
    fun `frame is magic, big-endian header length, header, then jpeg`() {
        val header = "{\"w\":1}".toByteArray(Charsets.UTF_8)
        val jpeg = byteArrayOf(0xFF.toByte(), 0xD8.toByte(), 0xFF.toByte(), 0xD9.toByte())
        val frame = Protocol.buildFrame(header, jpeg)

        assertEquals(0x01.toByte(), frame[0])
        // 7 bytes, written most-significant byte first.
        assertEquals(0, frame[1].toInt())
        assertEquals(7, frame[2].toInt())
        assertArrayEquals(header, frame.copyOfRange(3, 3 + header.size))
        assertArrayEquals(jpeg, frame.copyOfRange(3 + header.size, frame.size))
    }

    @Test
    fun `header length is encoded correctly above 255 bytes`() {
        // Regression guard: a one-byte length would corrupt any frame with a
        // long header, and the corruption is silent.
        val header = ByteArray(300) { '{'.code.toByte() }
        val frame = Protocol.buildFrame(header, byteArrayOf(1, 2, 3))

        // 300 == 0x012C, so the high byte is 0x01 and the low byte is 0x2C.
        assertEquals(0x01, frame[1].toInt())
        assertEquals(0x2C, frame[2].toInt())
        assertEquals(3 + 300 + 3, frame.size)
    }

    @Test
    fun `frame is read back the way relay and console read it`() {
        val header = Protocol.frameHeaderJson("dev-9", 360, 640, 0, 7L, 30, 0L)
        val jpeg = ByteArray(1024) { 0x42 }
        val frame = Protocol.buildFrame(header, jpeg)

        val declared = ((frame[1].toInt() and 0xFF) shl 8) or (frame[2].toInt() and 0xFF)
        val parsed = JSONObject(String(frame, 3, declared, Charsets.UTF_8))

        assertEquals("dev-9", parsed.getString("did"))
        assertEquals(1024, frame.size - 3 - declared)
        assertTrue(frame.size <= Protocol.MAX_FRAME_BYTES)
    }
}
