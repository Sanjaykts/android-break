# Privacy

Short version: the app connects to exactly one server, which is ours. It has no
analytics, no third-party SDKs, and it stores nothing. Screen frames pass through
the relay in memory and are never written down.

This document exists because the product's credibility depends on the answer being
specific rather than reassuring. If you are asking "can it read my WhatsApp", the
answer is in §4, and it is a structural one rather than a promise.

---

## 1. What is transmitted

| Data | To | Notes |
|---|---|---|
| Screen frames (JPEG) | Relay, in memory | The live view. Never stored. |
| Device model, brand, Android version | Relay | Shown in the device list so you can pick the right phone |
| Tap, swipe, key, text commands | Relay, to the phone | Relayed; not inspected or stored |
| A per-install random device id | Relay | Not a hardware serial. See §5 |
| Relay heartbeat (RTT samples) | Relay, in memory | Not stored |

Nothing else. There is no crash reporting, no usage analytics, no telemetry of any
kind, because there are no third-party SDKs in the build to send it.

## 2. Where it goes

One endpoint: the Cloudflare Worker this build was compiled against. It appears as
`BuildConfig.RELAY_URL` in the APK and is shown on the enrollment screen, where it
is editable so you can point the app at your own instance.

- Transport is TLS on both legs (the agent dials `wss://`).
- The Durable Object is not publicly addressable and is unreachable without the
  correct token.
- Frames are held in the Durable Object's memory only long enough to forward, and
  are never written to storage.

## 3. Retention

**There is none.** No frame, command, or event is written to storage by the relay.
The only things the Durable Object persists are:

- Device model, brand, Android version, API level and id -- written once when a
  device connects, overwritten on reconnect. Enough to draw the device list.
- A console-to-device pairing -- overwritten whenever either side changes.

Both are metadata. Neither is a picture of the screen. A frame that passes through
the relay leaves no trace, which is also why there is no "record" of a session other
than the recording you deliberately start in the console.

The `.webm` file from the record button is written by your browser to your Downloads
folder. The relay never sees it. Deleting it is your browser's business, not ours.

## 4. What this app cannot read

This is the part people actually ask about, so it is worth being precise about the
*mechanism* rather than just asserting the outcome.

The app holds exactly these permissions:

```
INTERNET, ACCESS_NETWORK_STATE, FOREGROUND_SERVICE,
FOREGROUND_SERVICE_MEDIA_PROJECTION, POST_NOTIFICATIONS,
RECEIVE_BOOT_COMPLETED, WAKE_LOCK
```

Plus two service-level bindings the platform grants only when the user explicitly
enables them in Settings: `BIND_ACCESSIBILITY_SERVICE` and `BIND_INPUT_METHOD`.

**Notably absent:** `READ_SMS`, `READ_CONTACTS`, `READ_CALL_LOG`, `CAMERA`,
`RECORD_AUDIO`, `READ_EXTERNAL_STORAGE`, `MANAGE_EXTERNAL_STORAGE`,
`QUERY_ALL_PACKAGES`, `SYSTEM_ALERT_WINDOW`, `INSTALL_PACKAGES`, and any
device-admin or accessibility-service-adjacent privilege beyond what is listed.

So it cannot read WhatsApp, SMS, contacts, call history, photos, files, or another
app's database, because there is no permission that would let it and no code that
tries. Reading any of that on a non-rooted phone requires root, and this app has
none.

What it *can* see is the pixels of the screen you are already looking at, and it
can act on that screen. In practice that means it can read whatever you can read
while it is running, which is a real capability and is why it is opt-in and
visible.

`MediaProjection` gives pixels, not text. It cannot read a password field's
contents, notification content on a locked screen, or DRM-protected content, because
the compositor never renders those into a capturable surface.

## 5. Identity

The device id is a random value generated on first run, mixed with Android's
`ANDROID_ID` and salted, then stored locally. It is scoped to this app on this
device. It is not your IMEI, not your serial number, and not your advertising id.

It exists so the console can tell two phones apart. It is not a tracking identifier
for anything else, and it leaves the device only as the relay's device key.

## 6. What is visible, on purpose

Three things are always visible to the phone's owner, and this is the security
model rather than a shortcoming:

- **A permanent foreground-service notification** while the screen is being shared.
  On Android 10+ it cannot be suppressed. Android 13+ additionally requires
  `POST_NOTIFICATIONS`, which the enrollment screen asks for -- without it the
  service still runs, but the notification would be hidden, and a hidden
  notification is exactly what this project is arguing against.
- **An entry in Settings → Accessibility**, named, with a description of what it
  does.
- **The enrollment screen**, which states in plain language what the app can and
  cannot do.

The owner can revoke Accessibility or swipe away the notification at any moment,
and the app shuts down when they do. The console shows the state change immediately
rather than pretending to still be live.

## 7. Uninstalling

Two taps: Settings → Apps → Break Remote → Uninstall. That is the whole process,
and it is not a bug or an oversight. A tool that resists removal is a different
product -- Android Enterprise device-owner mode -- which requires a factory-reset,
IT-managed device. Pretending otherwise would be the actual problem.

Because the app is excluded from Android backup and device transfer, uninstalling
leaves nothing behind. There is no server-side record to clean up, because there was
never a server-side record.

## 8. Acceptable use

Consent-based remote support for devices you own or have permission to administer;
demos; QA; controlling your own phone.

**Not** covert monitoring. **Not** another person's device without their informed
consent. **Not** any unlawful surveillance. If you need to be able to act on a
device without the owner's knowledge and without them being able to stop you, the
correct answer is the MDM product that is designed for it on managed hardware --
not this, and not a modified version of this.
