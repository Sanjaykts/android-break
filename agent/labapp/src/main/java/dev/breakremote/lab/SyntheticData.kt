package dev.breakremote.lab

import android.content.ContentResolver
import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.provider.ContactsContract
import android.provider.Telephony
import android.util.Log
import java.io.File
import java.io.FileOutputStream
import kotlin.random.Random

/**
 * Generates the synthetic dataset the exercise runs against.
 *
 * ## The rule this class exists to enforce
 *
 * **Nothing here reads anything the user did not create for the lab.** Every
 * record is written by this code first, and every record is tagged
 * `TEST_ONLY`. There is no path in this class that returns a real message, a
 * real contact, a real photo or a real coordinate — which is what makes
 * proposal success criterion 2 ("no real personal data is collected or
 * transmitted") structurally true rather than a promise.
 *
 * ## Why the records go into real Android stores
 *
 * Writing synthetic SMS into the device's SMS provider, and synthetic contacts
 * into the contacts provider, is what makes the permission demonstration real.
 * The app then reads them back **through the same permission a real app would
 * need**, and the runtime prompt that appears is captured as evidence for
 * proposal section 5. Faking it with an in-memory list would demonstrate nothing
 * about Android's permission model.
 *
 * Records are prefixed `LABONLY-` so an analyst can tell them apart by eye, and
 * so teardown can find and remove every one of them.
 */

object SyntheticData {

    const val TAG = "lab/synthetic"

    /** Every synthetic record carries this prefix. Teardown greps for it. */
    const val MARKER = "LABONLY-"
    const val DATA_CLASS = "TEST_ONLY"

    /** Fixed coordinates, so the lab never touches real GPS. */
    const val LAB_LATITUDE = 12.9716
    const val LAB_LONGITUDE = 77.5946
    const val LAB_PLACE = "$MARKER Conference Room B, Bengaluru"

    private val rng = Random(System.currentTimeMillis())

    private fun tag(i: Int) = "$MARKER-%03d".format(i)

    // ------------------------------------------------------------------ SMS

    /**
     * Writes synthetic SMS into the device's SMS provider.
     *
     * Requires WRITE_SMS to insert, which is deliberately NOT requested. Where
     * the platform does not allow an app to insert SMS (and on many it does
     * not), the app falls back to its own store and the exercise notes the
     * difference — which is itself a legitimate finding about the SMS permission
     * model.
     */
    fun seedSms(context: Context, count: Int = 6): List<Pair<String, String>> {
        val bodies = listOf(
            "Lab test message: enrollment confirmed for session.",
            "Lab test message: synthetic appointment at 14:00, room B.",
            "Lab test message: do not action. This record is test data only.",
            "Lab test message: permission prompt screenshot pending.",
            "Lab test message: relay handshake acknowledged.",
            "Lab test message: end of synthetic dataset.",
        )
        val out = mutableListOf<Pair<String, String>>()
        for (i in 0 until count) {
            val sender = tag(i)
            val body = bodies.getOrElse(i) { "Lab test message $i." }
            val wrote = try {
                context.contentResolver.insert(
                    Telephony.Sms.Inbox.CONTENT_URI,
                    ContentValues().apply {
                        put(Telephony.Sms.ADDRESS, sender)
                        put(Telephony.Sms.BODY, body)
                        put(Telephony.Sms.DATE, java.lang.Long.valueOf(System.currentTimeMillis()))
                        put(Telephony.Sms.READ, java.lang.Integer.valueOf(1))
                    }
                ) != null
            } catch (e: SecurityException) {
                // Expected on most devices: an app cannot write other apps' SMS
                // without being the default SMS handler. Noted, not fatal.
                Log.i(TAG, "SMS insert refused (${e.message}); the permission demo still works")
                false
            }
            out += sender to body
            if (wrote) Log.i(TAG, "seeded synthetic SMS from $sender")
        }
        return out
    }

    // ------------------------------------------------------------- contacts

    /** Writes synthetic contacts into the contacts provider. */
    fun seedContacts(context: Context, count: Int = 5): Int {
        val names = listOf(
            "Lab Contact Alpha", "Lab Contact Bravo", "Lab Contact Charlie",
            "Lab Contact Delta", "Lab Contact Echo",
        )
        var written = 0
        for (i in 0 until count) {
            try {
                val uri: Uri? = context.contentResolver.insert(
                    ContactsContract.RawContacts.CONTENT_URI,
                    ContentValues().apply {
                        // Explicit String? casts: ContentValues.put is overloaded
                        // for every primitive plus String, so a bare `null` is
                        // ambiguous and will not compile.
                        put(ContactsContract.RawContacts.ACCOUNT_TYPE, null as String?)
                        put(ContactsContract.RawContacts.ACCOUNT_NAME, null as String?)
                    }
                )
                if (uri == null) continue
                context.contentResolver.insert(
                    ContactsContract.Data.CONTENT_URI,
                    ContentValues().apply {
                        put(ContactsContract.Data.RAW_CONTACT_ID,
                            ContentUrisCompat.parseId(uri))
                        put(ContactsContract.Data.MIMETYPE,
                            ContactsContract.CommonDataKinds.StructuredName.CONTENT_ITEM_TYPE)
                        put(ContactsContract.CommonDataKinds.StructuredName.DISPLAY_NAME,
                            tag(i) + " " + names.getOrElse(i) { "Contact $i" })
                    }
                )
                written++
            } catch (e: Exception) {
                Log.w(TAG, "contact insert failed: ${e.message}")
            }
        }
        return written
    }

    // ---------------------------------------------------------------- files

    /**
     * Writes synthetic media and document files into the app's own directory.
     *
     * App-private storage, never shared storage, so a synthetic file can never be
     * confused with a real one on the device.
     */
    fun seedFiles(context: Context, count: Int = 4): List<File> {
        val dir = File(context.filesDir, "lab-synthetic").apply { mkdirs() }
        val out = mutableListOf<File>()
        for (i in 0 until count) {
            val ext = listOf("jpg", "txt", "json", "mp4")[i % 4]
            val f = File(dir, "${tag(i)}.$ext")
            FileOutputStream(f).use { os ->
                os.write(buildString {
                    appendLine("synthetic_record: $DATA_CLASS")
                    appendLine("record_id: ${tag(i)}")
                    appendLine("generated_by: ${SyntheticData::class.java.simpleName}")
                    appendLine("note: not derived from any real user data")
                    append("payload_bytes: " + rng.nextInt(4096, 65536))
                }.toByteArray())
            }
            out += f
        }
        return out
    }

    /** A fixed synthetic location, returned without touching the GPS provider. */
    fun labLocation(): Triple<Double, Double, String> =
        Triple(LAB_LATITUDE, LAB_LONGITUDE, LAB_PLACE)

    // ----------------------------------------------------------------- teardown

    /**
     * Removes every synthetic record this class created.
     *
     * Proposal section 7.10 and section 12 require the lab to be resettable to a
     * known-clean state. Anything left behind is a finding against us, not
     * against Android, so teardown is part of the app rather than a runbook step
     * somebody might forget.
     */
    fun purge(context: Context): PurgeReport {
        val report = PurgeReport()
        val cr: ContentResolver = context.contentResolver

        // Synthetic contacts, by display-name prefix.
        try {
            val deleted = cr.delete(
                ContactsContract.Data.CONTENT_URI,
                "${ContactsContract.CommonDataKinds.StructuredName.DISPLAY_NAME} LIKE ?",
                arrayOf("$MARKER%")
            )
            report.contacts = deleted
        } catch (e: Exception) {
            report.errors += "contacts: ${e.message}"
        }

        // Synthetic files.
        try {
            val dir = File(context.filesDir, "lab-synthetic")
            report.files = dir.listFiles()?.size ?: 0
            dir.deleteRecursively()
        } catch (e: Exception) {
            report.errors += "files: ${e.message}"
        }

        // Synthetic SMS, where the platform allowed insertion.
        try {
            report.sms = cr.delete(
                Telephony.Sms.Inbox.CONTENT_URI,
                "${Telephony.Sms.ADDRESS} LIKE ?",
                arrayOf("$MARKER%")
            )
        } catch (e: Exception) {
            // Expected: an app normally cannot delete from the SMS provider.
            // Teardown on the device is therefore also done in Settings, and the
            // limitation is recorded rather than hidden.
            report.errors += "sms: ${e.message}"
        }

        return report
    }

    data class PurgeReport(
        var contacts: Int = 0,
        var files: Int = 0,
        var sms: Int = 0,
        val errors: MutableList<String> = mutableListOf(),
    ) {
        val clean: Boolean get() = errors.isEmpty()
    }
}

/** `ContentUris.parseId` without importing the compat shim. */
private object ContentUrisCompat {
    fun parseId(uri: Uri): Long =
        android.content.ContentUris.parseId(uri)
}
