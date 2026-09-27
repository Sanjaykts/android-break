# Compatibility

## The honest claim

> **Engineered for Android 8.0 (API 26) and newer. Validated on \[model\], running
> Android \[version\].**

One tested device is a fact. Two vendors is a claim. Do not say "works on any
Android phone" until at least two vendors are green.

## Test matrix status

| Device class | Android | Status | Known risk |
|---|---|---|---|
| **The demo device** | *fill in on Day 1* | **not yet tested** | Unknown until identified. Record model and API level below before anything else |
| Samsung Galaxy | 12–15 | untested | Aggressive battery manager kills background services. Accessibility path is `Downloaded apps` |
| Xiaomi / Redmi / Poco | 12–14 | untested | Most aggressive service killing. Path is `Installed services` |
| Oppo / Realme / Vivo | 12–14 | untested | Some versions restrict accessibility services from sideloaded apps |
| Android 8–11 | 8–11 | best-effort by construction | Different MediaProjection consent flow; no `getWindows()`; different foreground-service rules |

<!-- Demo device: record here on Day 1. Without this the compatibility claim is
     unmakeable and the enrollment screenshots cannot be taken. -->

- **Model:**
- **Android version / API level:**
- **Tested on:**

## Per-version code paths

The agent branches on API level in exactly four places. Each is a real difference in
platform behaviour, not defensive padding.

| Behaviour | API 26–29 | API 30+ | API 34+ |
|---|---|---|---|
| Window enumeration for `find` | `rootInActiveWindow` only | `getWindows()`, which is required to see anything in a secondary window or the system UI | same |
| `MediaProjection` | single consent, `createVirtualDisplay` order is flexible | same | `startForeground` **must** precede `getMediaProjection`; `registerCallback` **must** precede `createVirtualDisplay` |
| Foreground service | no type on the `startForeground` call | `FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION` required | same, plus consent cannot be re-acquired silently |
| `AccessibilityNodeInfo.recycle()` | called, to release | called | no-op and deprecated; skipped |

`minSdk 26` is the floor because `MediaProjection.createVirtualDisplay` and
`dispatchGesture` both need it, and Android 8 is also the floor below which
`ForegroundServiceType` enforcement and `getWindows()` diverge enough that the
code paths stop being the same shape.

## OEM-specific behaviour to check on the demo phone

These are the things that differ by manufacturer and that no amount of unit testing
will find.

- [ ] **Accessibility settings path.** Pixel → Accessibility → *Downloaded apps*.
      Samsung → Accessibility → *Downloaded apps*. Xiaomi/Oppo → *Installed services*.
      Screenshot the real path on the demo phone; `enroll.pdf` must show what is
      actually there.
- [ ] **Battery optimisation.** Set to Unrestricted. Xiaomi, Oppo, Vivo and Samsung
      kill background services aggressively, and an accessibility service being
      killed mid-demo is a silent input loss. Enrollment links straight to the
      screen.
- [ ] **Screen timeout.** 30 minutes. Nothing an app can do prevents the display
      timeout, and a sleeping screen mid-demo is unrecoverable.
- [ ] **Autostart / battery saver prompts.** Some OEMs show a "keep running in the
      background" dialog that can be dismissed into a broken state.
- [ ] **Gesture navigation vs 3-button.** `dispatchGesture` coordinates are display
      coordinates, so both work, but a swipe near the screen edge can be intercepted
      by the system back gesture. Test a swipe that starts at x < 30.
- [ ] **Work profile / MDM.** If the device has a work profile, accessibility may be
      restricted to the personal profile. Test on a personal profile, and prefer a
      company or loan device.

## What is verified automatically, and what is not

Being honest about coverage is the point of this document.

**Verified locally, repeatable:**

| Layer | How |
|---|---|
| Agent compiles, lints, shrinks, is signed | Gradle, `apksigner` |
| Binary frame format across three implementations | 4 JVM unit tests + a byte-integrity e2e check |
| Relay auth, pairing, routing, disconnect, limits | `relay/tools/e2e.mjs`, 26 checks |
| Relay throughput and 30-minute stability | `relay/tools/loadtest.mjs` |
| Console in a real browser: decode, tap mapping, rotation, keyboard, scripts | `relay/tools/console-smoke.mjs`, 27 checks |

**Not verified without a phone:**

- That Accessibility is actually granted, and that `dispatchGesture` produces real
  touch events. The startup probe reduces this to a visible badge, but only a human
  on a real device can confirm a tap lands.
- That `MediaProjection` consent behaves as documented on that OEM's build.
- Frame rate on real 4G, and the actual size of a real JPEG at quality 35.
- Whether the owner's Settings build exposes the paths in `enroll.pdf`.
- Every OEM behaviour in the checklist above.

So the compatibility claim is currently: *engineered for Android 8.0+, transport
fully tested, device behaviour untested.* That is not good enough to ship, which is
why the demo phone gets real testing time and why a borrowed second phone for one
afternoon is the highest-value hour available.

## When adding a device

1. Install the APK from the browser link, as the owner would.
2. Complete enrollment and screenshot the Accessibility path for `enroll.pdf`.
3. Confirm all three enrollment badges go green, including "Gestures work".
4. Confirm a tap in the console produces a tap on the device, at the right place.
5. Leave it connected for 10 minutes and watch for frame drops and reconnects.
6. Fill in the matrix above, and record any OEM quirk even if the device passed.
   A quirk that cost you an hour will cost the next person the same.
