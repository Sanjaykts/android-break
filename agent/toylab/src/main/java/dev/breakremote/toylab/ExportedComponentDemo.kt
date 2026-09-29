package dev.breakremote.toylab

import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.os.Bundle

/**
 * FLAW 3 of 5 — Improperly exported components and insecure inter-process
 * communication (proposal section 10).
 *
 * [LabProvider] is declared `android:exported="true"` with **no
 * `android:readPermission`**. Any application on the device can therefore query
 * it, with no permission dialog, no user consent, and nothing in this app's
 * control to stop it. That is the whole of insecure IPC: an exported component is
 * a public API whether or not anyone meant it to be.
 *
 * Secondary lesson, in the same file: a `ContentProvider` returning a mutable
 * `MatrixCursor` built from live state, with no caller check on `insert`, is
 * writable by anyone as well.
 *
 * ## What this target deliberately does NOT do
 *
 * The provider returns a version string and a build timestamp. It does not expose
 * contacts, files, messages, or any real device state. The demonstration is that
 * it is *reachable at all*.
 */
class ExportedComponentDemo : ToyActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        header(
            lesson = "A ContentProvider with no read permission is readable by every " +
                "app on the device, silently. The permission prompt never appears, " +
                "because there is no permission to prompt for. Exported components " +
                "are a public API surface whether or not they were intended to be one.",
            vulnerability = "Improperly exported components and insecure IPC",
        )

        section("Query the provider from this app")
        val outcome = runCatching {
            contentResolver.query(Uri.parse(AUTHORITY), null, null, null, null)?.use { c ->
                if (c.moveToFirst()) {
                    buildString {
                        for (i in 0 until c.columnCount) {
                            append(c.getColumnName(i))
                            append(" = ")
                            append(c.getString(i))
                            append('\n')
                        }
                    }
                } else {
                    "(no rows)"
                }
            } ?: "(null cursor)"
        }.getOrElse { "refused: ${it.message}" }

        val reached = !outcome.startsWith("refused")
        body.addView(
            text("Reached the provider and read:\n\n$outcome", 13f, if (reached) RED else AMBER)
                .withTop(4),
        )

        section("The same provider, from another app")
        body.addView(
            text(
                "A second application, with no permissions whatsoever, issues the " +
                    "identical query:\n\n" +
                    "    getContentResolver().query(\n" +
                    "        Uri.parse(\"content://$AUTHORITY\"),\n" +
                    "        null, null, null, null)\n\n" +
                    "It gets the same rows. There is nothing the user was asked, and " +
                    "nothing they could have declined, because no permission is " +
                    "involved.",
                13f, DIM,
            ).withTop(4),
        )

        section("The manifest line that causes it")
        body.addView(
            text(
                "<provider\n" +
                    "    android:name=\".ExportedComponentDemo${"$"}LabProvider\"\n" +
                    "    android:authorities=\"$AUTHORITY\"\n" +
                    "    android:exported=\"true\" />\n\n" +
                    "There is no android:readPermission. Adding one — a " +
                    "signature-level permission, ideally — is the entire fix, and is " +
                    "a one-line change.",
                12f, DIM,
            ).withTop(4),
        )

        section("Export audit: what else is exposed")
        body.addView(
            text(
                "Every component in an APK can be checked in one pass. On this device:\n\n" +
                    "    adb shell dumpsys package <package> | grep -A3 ResolverActivity\n\n" +
                    "Anything listed there with no permission is a public entry point. " +
                    "This is one of the cheapest and highest-value checks in a mobile " +
                    "assessment, and it belongs in every review of every app.",
                12.5f, DIM,
            ).withTop(4),
        )

        fix(
            "Set android:exported=\"false\" on every component that does not need to " +
                "be reachable. Where it must be reachable, protect it with a " +
                "signature-level permission so only apps signed with the same key can " +
                "use it. Apply the same to activities, services, receivers and " +
                "broadcast receivers, and remember that an intent filter implicitly " +
                "makes a component exported from API 31.",
        )
    }

    /**
     * The vulnerable provider. Reachable by any app; returns nothing sensitive.
     */
    class LabProvider : ContentProvider() {


        override fun onCreate(): Boolean = true

        override fun query(
            uri: Uri,
            projection: Array<out String>?,
            selection: String?,
            selectionArgs: Array<out String>?,
            sortOrder: String?,
        ): Cursor {
            val c = MatrixCursor(arrayOf("key", "value"))
            c.addRow(arrayOf("package", "dev.breakremote.toylab"))
            c.addRow(arrayOf("kind", "training-target"))
            c.addRow(
                arrayOf(
                    "note",
                    "Readable by any app on this device, with no permission. " +
                        "This is the flaw being demonstrated.",
                )
            )
            return c
        }

        override fun getType(uri: Uri): String = "vnd.android.cursor.item/vnd.training.lab"

        override fun insert(uri: Uri, values: ContentValues?): Uri? = null
        override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = 0
        override fun update(
            uri: Uri,
            values: ContentValues?,
            selection: String?,
            selectionArgs: Array<out String>?,
        ): Int = 0
    }

    private companion object {
        const val AUTHORITY = "dev.breakremote.toylab.lab"
    }
}
