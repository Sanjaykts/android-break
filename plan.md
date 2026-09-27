# PROJECT PLAN — Remote Android Control Agent

**Status:** Plan only. No code written yet.
**Repo root:** `D:\andriodBreak`
**Anchor date:** written Sun 27 Sep 2026. Default working window **Mon 28 Sep → Fri 2 Oct 2026** (5 working days). Actual demo date **TBD**.
**Stack:** Kotlin/Android + Cloudflare Workers (relay + console) + GitHub Actions (build) — free tier only.

---

## 1. Goal

A single Android APK that the phone's owner installs and grants 2–3 permissions to. After that, the phone is fully controlled from a laptop over the internet, on two different networks, with no further physical contact with the device.

### 1.1 Confirmed constraints

| Constraint | Consequence |
|---|---|
| Never touch the phone before the demo | No pre-provisioning, no ADB, no pre-enrollment, no spare device on our laptop |
| Never factory reset the phone | Device-owner mode is impossible. No kiosk, no app hiding, no silent install, no remote wipe, no camera disable, no forced lockout |
| No USB cable, ever | Rules out `adb tcpip`, wireless-debugging pairing, and scrcpy entirely |
| Phone and laptop on different networks | Rules out Android 11+ Wireless debugging (mDNS, LAN-only) and all LAN discovery |
| Setup = install an APK and allow permissions | AccessibilityService + MediaProjection is the only viable permission model |
| Any Android device | `minSdk 26` (Android 8.0+), must degrade across OEMs |
| Free only | ADB/Tailscale path, device-owner path, and paid MDM are all out. Cloudflare + GitHub is the stack |
| Android only | No iOS. iOS has no accessibility-injection equivalent; remote control requires paid relay software |
| **One test device** | See §9.2. This is the single largest source of demo risk |
| **Demo date not fixed** | Schedule is expressed in working days and gates in hours. See §9.1 |

### 1.2 Options that were considered and rejected

| Option | Why rejected |
|---|---|
| scrcpy + `adb tcpip 5555` + Tailscale | Best technical option (screen-off control, 60 fps) but requires a one-time USB **or** same-LAN wireless-debugging pairing. Both ruled out |
| Android Enterprise device-owner / QR provisioning | Requires a factory reset. Ruled out |
| App hidden from launcher, user cannot escape | `setApplicationHidden` and `startLockTask` are device-owner APIs. Ruled out |
| AirDroid / TeamViewer / AnyDesk as the primary | Working, but third-party, licence limits, and not our artifact. Retained as **fallback only** |
| WebRTC for video | 2–3 extra days, no visible benefit to an audience. Replaced by JPEG-over-WebSocket |
| Custom company relay server | Costs money and ops. Cloudflare Durable Object is free and always-on |

---

## 2. Honest limitations (state these before anyone asks)

1. **The phone's own screen stays on.** Controlling a device with its display off requires ADB or root. Neither is available. The phone will be visibly on, showing whatever is on it. Do not promise a dark phone.
2. **No app can control a PIN/pattern/password-locked screen.** The phone must be unlocked at demo time. Put this in `enroll.pdf`.
3. **The user can always revoke accessibility or uninstall.** This is a consent-based tool, not a covert one. The foreground-service notification and the Accessibility entry in Settings are visible by design — show them.
4. **No root means no private app data.** I can see and drive the screen the user sees. I cannot read another app's database, storage, or DRM content.
5. **Rebooting the phone loses the screen-capture grant.** It must be re-granted with one tap. Do not reboot the phone on demo day.
6. **One phone, no spare.** A single hardware failure or a revoked permission mid-session ends the live demo. Mitigations in §9.2 and §11.

---

## 3. Architecture

```
   Phone (owner's, on 4G)                Cloudflare (free)              Laptop (demo machine)
 ┌──────────────────────────┐        ┌───────────────────────┐        ┌──────────────────────────┐
 │ agent.apk                 │  WSS   │ Worker                │  WSS   │ Console (Chrome)         │
 │  ControlService           ├───────▶│  /ws/agent ─┐         ├───────▶│  /  live view            │
 │   AccessibilityService    │        │             ├─ Hub DO ┤        │  /  click, swipe, type   │
 │  CaptureService           │        │  /ws/console┘   (DO)  │        │  /  PiP cam, recording    │
 │   MediaProjection → JPEG  │◀───────┤  /  static assets    │        │  /  fullscreen, log       │
 └──────────────────────────┘        └───────────────────────┘        └──────────────────────────┘
  3 permission grants at install      device pool + byte relay        nothing to install
```

**Why this transport:** the phone can only make outbound connections. A Worker Durable Object is a free, always-on rendezvous that both sides dial into. No port forwarding, no public IP, no server to rent, no second app on the phone, and no Google sign-in on the phone.

**Wire protocol**

```
agent  → hub : {"op":"hello","id","model","brand","android","sdk"}
agent  → hub : 0x01 | u16 headerLen | headerJSON {rot,w,h,seq} | JPEG bytes   (≤ 480 KB)
agent  → hub : {"op":"event","kind":"accessibility|connection|lifecycle", ...}
console→ hub : {"op":"connect","id":"<deviceId>"}
console→ agent: {"op":"tap","x","y"}  {"op":"swipe","x1","y1","x2","y2","ms"}
               {"op":"longpress","x","y","ms"}  {"op":"doubleTap","x","y"}
               {"op":"key","code"}  {"op":"text","s"}
               {"op":"global","action":"back|home|recents|power|notifications|appswitch"}
               {"op":"find","text","action":"click|settext"}  {"op":"script","actions":[...]}
               {"op":"quality","fps","w","q"}  {"op":"ping"} → {"op":"pong","t"}
```

---

## 4. Capability matrix

| Capability | Mechanism | Status |
|---|---|---|
| Live screen view | MediaProjection → `ImageReader` → JPEG 480p/10fps | Build |
| Tap (coordinates) | `AccessibilityService.dispatchGesture` | Build |
| Long press / double tap / drag | `dispatchGesture`, multi-stroke `GestureDescription` | Build |
| Back / Home / Recents / power menu / notifications / app switch | `performGlobalAction` | Build |
| Type text | `ACTION_SET_TEXT` on focused node, `InputMethodService.commitText` fallback | Build |
| Tap button by label, resolution-independent | `getWindows()` → node tree → `ACTION_CLICK` | Build |
| Detect the owner touching the phone | `onAccessibilityEvent` → console action log | Build |
| Keep screen awake, survive timeouts | Foreground service + `FLAG_KEEP_SCREEN_ON` + partial wakelock | Build |
| Survive reboot | `BOOT_COMPLETED` receiver (screen capture needs one re-tap) | Build |
| Record the demo | `MediaRecorder` on a canvas in the console → `.webm` | Build |
| Presenter camera picture-in-picture | `getUserMedia` + CSS/canvas compositing | Build |
| **Turn the phone screen off while controlling** | needs ADB or root | **Not possible** |
| **Control a PIN-locked screen** | needs device owner or the PIN | **Not possible** |
| **Be invisible / uninstall-proof** | needs device owner | **Not possible** |
| **Read other apps' private files** | needs root | **Not possible** |
| **Kiosk / lockout / silent install / remote wipe** | needs device owner = factory reset | **Not possible** |
| **Run while the phone is powered off** | physically impossible | **Not possible** |

---

## 5. Permission model

| Grant | Trigger | Why required |
|---|---|---|
| Install from unknown sources | Browser prompt during APK install | Sideloading. Per-app grant for the browser on Android 8+ |
| **Accessibility** | In-app button → `Settings.ACTION_ACCESSIBILITY_SETTINGS` | The *only* way a non-rooted app turns laptop input into real touch events. `INJECT_EVENTS` is signature-only and unattainable by apps |
| **Screen capture** | System dialog after `createScreenCaptureIntent()` | The live view. Cannot be pre-granted by any app |
| *(optional)* Default keyboard | Settings → System → Languages & input | Typing fallback when `ACTION_SET_TEXT` fails in a WebView or game |

The enrollment screen shows a live badge per grant and will not display "ready" until Accessibility and screen capture are both green.

**Paths differ by vendor:** Pixel → Accessibility → *Downloaded apps* · Samsung → Accessibility → *Downloaded apps* · Xiaomi/Oppo → Accessibility → *Installed services*. `enroll.pdf` must show the real path for the demo phone, verified by screenshotting it during setup.

**Presentation stance:** the notification and the Accessibility entry are visible on purpose. "The owner consented, it ran in the open, uninstall is two taps" is what makes this deployable inside a company. It is also the correct answer to security.

---

## 6. Deliverables

| Path | Purpose |
|---|---|
| `PLAN.md` | This document |
| `README.md` | Install, enroll, troubleshoot |
| `DEMO_RUNBOOK.md` | Talk track, pre-flight checklist, the five hard questions, abort rules |
| `agent/` | Android app (Kotlin) |
| `relay/` | Cloudflare Worker + Durable Object |
| `console/` | Static SPA served by the Worker |
| `tools/` | QR generator, `enroll.pdf` generator |
| `docs/ARCHITECTURE.md` | Diagram and rationale for the slide |
| `docs/COMPATIBILITY.md` | Device test matrix, honest about coverage |
| `docs/PRIVACY.md` | What is transmitted, retention, removal |
| `demo-start.cmd` | One click: health check + fullscreen console |
| `demo-preflight.cmd` | Red/green checks before walking on stage |
| `demo.mp4` | 90-second prerecorded fallback video |

### 6.1 `agent.apk` specification

- **Build:** AGP 8.x, Kotlin 1.9.x, `compileSdk 34`, `minSdk 26`, `targetSdk 34`. Dependencies: `okhttp3`, `kotlinx-coroutines-android`. Nothing else.
- **Manifest permissions:** `INTERNET`, `ACCESS_NETWORK_STATE`, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_MEDIA_PROJECTION`, `RECEIVE_BOOT_COMPLETED`, `BIND_ACCESSIBILITY_SERVICE`, `BIND_INPUT_METHOD`. No analytics, no third-party SDKs.
- **`ControlService`** (`AccessibilityService`, `canRetrieveWindowContent = true`, no `packageNames` filter):
  - `onAccessibilityEvent` forwards lightweight events (window changed, click, scroll) to the console for the action log.
  - All gestures pass through a serialising `ActionQueue`. **Critical:** `dispatchGesture` refuses a new gesture while one is in flight, so unserialised input is silently dropped. Resolve each via `GestureResultCallback` before accepting the next.
  - `find` walks `windows` (API 30+) or `rootInActiveWindow` (26–29), recycles nodes, matches `text`/`contentDescription` case-insensitively, then `ACTION_CLICK` or `ACTION_SET_TEXT`.
- **`CaptureService`** (foreground, `foregroundServiceType="mediaProjection"`, mandatory notification):
  - `createScreenCaptureIntent` → result → `getMediaProjection` → **on API 34+ call `registerCallback` before `createVirtualDisplay`** → `ImageReader.newInstance(w, h, RGBA_8888, 2)` → loop `acquireLatestImage`, copy into a reusable `Bitmap`, `compress(JPEG, q)`, prepend header, send, `close()` the image immediately.
  - Cap the long edge at 854 and preserve the device's aspect ratio.
  - The classic failure in this pattern is holding the image buffer past `close()` or allocating a fresh `Bitmap` per frame. Both cause rapid OOM on mid-range phones. Reuse everything.
  - Re-request consent flow: Android 14+ cannot re-request `MediaProjection` silently. Surface an explicit `needsConsent` state that the console displays, rather than failing quietly.
- **`AgentImeService`:** optional, behind an enrollment toggle. Stores the `InputConnection` in `onStartInputView`; the `text` action calls `commitText(s, 1)`.
- **`Session`:** OkHttp WebSocket to the Worker. Exponential backoff 1s → 30s, `hello` on every reconnect, 15s heartbeat, state changes surfaced to the console.
- **Resilience:** `onTaskRemoved` + `BOOT_COMPLETED` restart the service; keep-awake via `FLAG_KEEP_SCREEN_ON` plus a partial wakelock scoped to the session.

### 6.2 `relay` (Cloudflare Worker + Durable Object)

- `GET /`, `/app.js` → static console assets (Workers Static Assets, free tier).
- `GET /devices` → JSON device list, also used by `demo-preflight.cmd`.
- `GET /ws/agent?token&device` → upgrade, register in the Hub DO pool, forward frames.
- `GET /ws/console?token` → upgrade, receive device list, on `{op:"connect"}` pair with the target device.
- **Hub DO:** `Map<deviceId, {ws, meta, lastSeen}>` using the **WebSocket Hibernation API** (`state.acceptWebSocket(server, tags)`) so idle sockets burn no CPU. This is what makes the free tier viable.
- Auth: shared secret in a Worker secret, mismatch → close 4401. **Rotate after the demo.** Replace with per-device enrolment tokens before any real deployment.
- Fallback if the free tier throttles: swap to a free Koyeb WebSocket host. One config value, ~10 minutes.

### 6.3 `console`

- `DeviceList` → `Connect` → `Stage`.
- `Stage`: a `<canvas>` fed by `createImageBitmap(blob)` per frame — not `<img>`, so PiP compositing and recording are possible. Pointer events normalised to device coordinates using the frame header's `w/h/rot`. Wheel → swipe. Keyboard → `text`/`key`. Buttons for Back/Home/Recents/Power/Notifications. A "tap button labelled ___" box. A script box taking a JSON action list. Live action log, latency badge, connection-state banner. Presenter camera via `getUserMedia`. `MediaRecorder` → `.webm` download. `F` for fullscreen.
- **Adaptive quality:** on RTT > 400ms or repeated frame drops, the console sends `{op:"quality", fps:6, w:360, q:25}`. Also exposed as a manual button so quality can be fixed live without a restart.

### 6.4 `enroll.pdf`

- **Page 1** — title, QR encoding the GitHub release URL for the APK, and the install flow: open link in Chrome → download → `Settings > Apps > Special app access > Install unknown apps > Chrome > Allow` → tap the downloaded file → "More details > Install anyway" on the Play Protect warning.
- **Page 2** — the three in-app permission steps as numbered, tap-by-tap instructions with real screenshots taken from the demo phone.
- **Page 3** — what the app can and cannot do, uninstall in two taps, and the consent line.

---

## 7. Build and release pipeline

1. `keytool -genkeypair` once → `keystore.jks`, stored in GitHub Actions secrets. Never rotate: a new key changes the signature and breaks upgrades.
2. `.github/workflows/build.yml`: on push to `main` and on `workflow_dispatch` → checkout → JDK 17 → `./gradlew assembleRelease` → sign with secrets → upload `agent.apk` as a release asset on a rolling tag → print the release URL as workflow output.
3. APK served from a **GitHub Releases asset URL**, which is permanent, so the QR in `enroll.pdf` never needs regenerating.
4. `wrangler deploy` for the Worker. Worker URL injected into the app's `BuildConfig`, overridable on the enrollment screen for testing.

**Day-1 gate:** a signed, installable APK downloads from Actions output. Nothing else in this plan matters if that fails.

---

## 8. Test matrix

| Device class | Android | Priority | Known risk |
|---|---|---|---|
| The one demo device | 12–16 expected | **Primary** | Unknown until identified — record model and Android version in `docs/COMPATIBILITY.md` on Day 1 |
| Samsung Galaxy | 12–15 | Borrow for 1h if possible | Aggressive battery manager kills background services; Accessibility path is `Downloaded apps` |
| Xiaomi / Redmi / Poco | 12–14 | Borrow if possible | Most aggressive service killing; path is `Installed services` |
| Oppo / Realme / Vivo | 12–14 | Borrow if possible | Some versions restrict accessibility services from sideloaded apps |
| Android 8–11 | 8–11 | Best-effort | Different `MediaProjection` consent flow and foreground-service types |

**Claim discipline:** with one device the honest wording is *"engineered for Android 8.0+, validated on \<model\> and Android \<version\>"*. Do not say "works on any Android phone" until at least two vendors are green. A single borrowed phone on Day 4 is worth more than any other hour in this plan.

---

## 9. Execution plan

### 9.1 Schedule and compression

Gates are in **hours**, not dates, so the plan compresses. Anchor Day 0 = first working day of implementation.

| Days available | What ships |
|---|---|
| **5** | Full plan: 10 fps 480p, find-and-tap, script runner, PiP, recording, 5 rehearsals |
| **3** | Drop adaptive quality, IME fallback, second-vendor testing. 8 fps 360p. All 6 demo beats intact |
| **2** | 5 fps 360p. No recording, no script runner. Beats 1–4 + architecture slide |
| **1** | Emergency path (§11). Present the built app as an architecture slide. Do not attempt the full build |

**The compression rule that matters:** the Day-2 gate — "choppy but complete: live view + tap + type over 4G" — **is the real deliverable.** Everything after it is polish. Under compression, stop at the Day-2 state and demo that rather than chasing frame rate.

### 9.2 Day by day

**Day 1 — Prove the two risky externals (≈6h)**
- Repo, Gradle skeleton, `MainActivity` rendering a static string.
- `build.yml` producing a signed release APK; download and install it on the demo device.
- Worker + Hub DO + a console page that lists devices. Agent connects over **cellular** with no permissions granted.
- Record the demo device's model and Android version in `docs/COMPATIBILITY.md`.
- Screenshot the Accessibility settings path on the demo device for `enroll.pdf`.
- **Exit:** APK builds and installs; the device appears in the console over 4G.
- **Gate:** if this fails, stop and fix it. Everything downstream depends on it.

**Day 2 — Choppy but complete, the demo insurance (≈6h)**
- `CaptureService` at 1–2 fps, 360p, q30 → console canvas.
- `ControlService`: tap, long press, swipe, Back/Home/Recents, `find`-and-click.
- Typing via `ACTION_SET_TEXT`.
- **Exit:** full loop works over cellular at low quality — live view, tap, type.
- **Gate:** working ugly demo. Commit and tag. Protect this state.

**Day 3 — Make it presentable (≈6h)**
- 10 fps, 480p, q35. Adaptive downgrade. Rotation and orientation. Keep-awake. Reconnect/heartbeat. Boot restart. Action log. PiP. Recording. Fullscreen. `demo-preflight.cmd`.
- **Exit:** projector-quality demo, 30 min continuous with no stall.
- **Go/no-go at the 4h mark:** if 10 fps is unstable, ship 6 fps and move on. Smoothness is not worth the deadline.

**Day 4 — Compatibility and paperwork (≈5h)**
- Test on a borrowed Samsung and/or Oppo if obtainable. Record quirks; add battery guidance to the enrollment screen and runbook.
- `enroll.pdf`, `README.md`, `DEMO_RUNBOOK.md`, `docs/*`.
- Confirm the fallback app situation with the demo phone's owner (§9.3).
- Record the 90-second fallback video.
- **Exit:** all docs exist; fallback video exists and plays.

**Day 5 — Rehearse and freeze (≈4h)**
- Five full rehearsals: at desk · venue WiFi · 4G only · standing while clicking · 15-second screen timeout.
- Time each end to end. Cut anything that adds risk.
- **Freeze at the 4-hour mark. No code changes after.**

### 9.3 Single-device risk register

Losing the spare costs four things. Each has a mitigation.

| Consequence | Mitigation |
|---|---|
| **The install happens live, on stage** — browser download, unknown-sources prompt, Play Protect, three permissions, all on the critical path | Preferred: ask the owner to install from the link a few hours before the meeting. They do it, on their own phone, with their own consent — we still never touch the device. Backup: rehearse the live flow verbatim, keep a screen recording of it in the runbook, and make the enrollment screen refuse to show "ready" until all three grants are green |
| **No fallback device** | Install AirDroid or TeamViewer **on the same phone** as a second control path. **Only if the phone is a company/loan device** — do not ask an audience member to install two remote-control apps on a personal phone |
| **Compatibility claim is one data point** | Wording is "engineered for Android 8.0+, validated on \<model\>". Ask a colleague to lend any Samsung/Oppo for one afternoon on Day 4 |
| **One chance, no spare** | Hard abort rule in the runbook: if anything is wrong in the first 60 seconds, stop and run the 90-second video. No live debugging, ever |

---

## 10. Risks

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| 1 | GitHub Actions Android build fails on Day 1 | Medium | Fatal | `choco install android-sdk` + local Gradle, or a free GitHub Codespace. Prove on Day 1 |
| 2 | Accessibility grant flow confuses the owner live | High | Fatal | Deep-link to the exact Settings screen, live ✓ badges, pre-install ask (§9.3), rehearsed wording, screen recording of the flow |
| 3 | OEM kills the accessibility service mid-demo | Medium | High | Battery → Unrestricted shown in `enroll.pdf`; keep-awake; instant dropped-state in console; force the owner to pre-install |
| 4 | MediaProjection consent lost after reboot or process death | Medium | High | Persistent FGS + boot receiver; honest `needsConsent` state; never reboot on demo day |
| 5 | Cloudflare free tier throttles media | Low–Med | Med | Adaptive bitrate; Worker swappable for free Koyeb via one config value |
| 6 | Venue WiFi blocks or heavily latencies WebSockets | Medium | High | Rehearse on venue WiFi on Day 4; the phone's own 4G is the fallback path |
| 7 | `dispatchGesture` drops rapid input | Medium | Low | Serialised `ActionQueue` with `GestureResultCallback` |
| 8 | Typing fails in WebViews or games | Medium | Low | IME fallback toggle in enrollment |
| 9 | Owner's phone has a work profile / existing MDM | Medium | High | Test on a personal profile. Document the limitation. Prefer a company/loan device |
| 10 | Single point of hardware failure | Low | **Total** | Pre-recorded video is mandatory, not optional |
| 11 | Owner cannot install an APK (no unknown-sources permission, corporate block) | Low–Med | Fatal | Detect on Day 4 rehearsal with a non-technical person; the fallback app path needs the same step, so no alternative exists — ask early |

---

## 11. Fallback ladder (use in order)

1. **Pre-built `demo.mp4`** (90 s) + architecture slide. Always ready before the demo.
2. **AirDroid free tier or TeamViewer** (TeamViewer is already installed on the demo laptop) on the same phone. Only appropriate if the phone is a company/loan device.
3. **Reconnect the agent.** Most "failures" are a dropped socket, not a crash — the console shows the state, and reconnect is one click.

**Emergency path if fewer than 2 days remain:** skip the build. Enrol AirDroid or TeamViewer in advance and demo cross-network control with that. Weaker story — not our code, licence limits, a visible notification — but a guaranteed-working demo in about two hours. This is the plan to fall back to, not the plan to build.

---

## 12. Demo script (6 beats, ~4 min, one phone)

**Opening:** one phone on the stand, screen on. Invite someone from the room to unlock it themselves — establishing it is their phone and their consent — then take over. "This phone has not been touched since it was installed, by you, three minutes ago."

1. Show `enroll.pdf` on screen for 20 seconds: link → install → three permissions. Say what each permission is for, out loud.
2. Live view on the projector. Type into a search field, open an app, send a message, take a photo. Phone on 4G, laptop on venue WiFi — say it, it is the whole point.
3. Hand the phone back. They tap, swipe, press Home. It all works. "This is your phone. Your consent screen is still running — the notification is the app being honest with you."
4. **Find and tap:** type a button's label, watch it get tapped without coordinates. Then the script runner: a three-step task with zero manual input.
5. Record button. Show it recording live to the projector.
6. Close: what it is, what it is not (not invisible, not root, consent-based), and where the real product boundary is — enterprise MDM on company-owned, IT-managed devices.

### 12.1 The five hard questions

1. **"Is this legal / can it be used without the user knowing?"** → No. Consent at install, visible notification, uninstall in two taps. It is deployable *because* it is transparent.
2. **"Can you read my WhatsApp?"** → No UI and no private app data without root. I see and drive the screen you see.
3. **"Can it work with the screen off?"** → Not on a non-rooted phone. That needs ADB or root.
4. **"What stops a user uninstalling it?"** → Nothing, by design. A device that must resist uninstallation is a different product: Android Enterprise device-owner mode, which requires a factory-reset, IT-managed device. That is the real answer and it belongs on the closing slide.
5. **"How is this different from AirDroid or TeamViewer?"** → Same primitives — accessibility plus screen capture. Ours is ours, no licence cost, and the code is the artifact.

---

## 13. Security, privacy and acceptable use

- The agent connects to exactly one endpoint (our Worker). No analytics, no third-party SDKs, no data retention. Frames are relayed in memory and never stored.
- The console is authenticated by a shared secret. **Rotate it after the demo.**
- Transport is TLS. The Durable Object is not publicly addressable and is unreachable without the token.
- `docs/PRIVACY.md` ships with the repo: what is transmitted, where it goes, how long it is kept (it is not), and how to remove it.
- Acceptable use: consent-based remote support, demos, QA, and control of one's own device. **Not** covert monitoring, **not** another person's device without consent, **not** any unlawful surveillance.

---

## 14. Definition of done

1. `agent.apk` builds signed from GitHub Actions and installs from a plain browser link.
2. A brand-new phone goes from download to fully controlled in under 4 minutes using only `enroll.pdf`.
3. Live view, tap, swipe, type, find-and-tap, and global nav all work over 4G with the laptop on a different network.
4. 30 minutes of continuous operation with no crash and no dropped session.
5. Verified on the demo device, plus at least one other vendor if a borrowed device was obtainable.
6. `demo-start.cmd` and `demo-preflight.cmd` both pass from a cold laptop start.
7. `README.md`, `DEMO_RUNBOOK.md`, `enroll.pdf`, and a 90-second fallback video all exist.
8. A full rehearsal completes in under 4 minutes, twice, on consecutive days.

---

## 15. Open questions (answers change the plan)

1. **Actual demo date.** Currently assumed Mon 28 Sep → Fri 2 Oct 2026. If it lands inside the 3-day or 2-day row of §9.1, the scope is cut on Day 1, not discovered on Day 4.
2. **Is the phone the audience's own personal phone, or a company/loan device?** Decides whether the pre-install ask (§9.3) and the second-fallback-app ask are appropriate, and shapes the consent slide.
3. **Does the demo phone have a 4G SIM with data?** If it is WiFi-only, the cross-network claim weakens to "same router, different subnets" and the architecture slide must say so.
4. **Model and Android version of the demo phone.** Needed to confirm the Accessibility settings path and to write the compatibility claim honestly.
5. **Can any Android phone be borrowed for one afternoon on Day 4?** One vendor is the difference between a one-data-point claim and a credible one.
6. **Does anyone need to own the Kotlin**, or is all of it being written from scratch here?

---

## Appendix A — Prior art and verified references

- **scrcpy + `adb tcpip 5555`** — the technically superior path (screen-off control, 60 fps, scripting). Requires a one-time USB or same-LAN wireless-debugging pairing. Both ruled out by constraints.
- **Android 11+ Wireless debugging** — mDNS-based, local network only. Ruled out.
- **Android Enterprise device-owner provisioning** (QR with `android.app.extra.PROVISIONING_DEVICE_ADMIN_PACKAGE_NAME` + `SIGNATURE_CHECKSUM` + `PACKAGE_DOWNLOAD_LOCATION`) — genuinely zero-touch after a factory reset, but the reset requirement is fatal here.
- **AirDroid Control Add-on, TeamViewer Universal Add-On** — commercial products built on exactly the same primitives (accessibility + screen capture). Our implementation is functionally equivalent at demo scope.
- **`INJECT_EVENTS`** is signature/privileged and unattainable by a sideloaded app. This single fact is why Accessibility is the entire design.
- **Foreground-service notification** for media capture and accessibility is mandatory and unsuppressible on Android 10+.

## Appendix B — Quick reference: what we can and cannot do

```
CAN                                    CANNOT
─────────────────────────────────      ─────────────────────────────────
See the screen live                    Control with the screen off
Tap, long press, drag, double tap      Control a PIN-locked screen
Type text, including in WebViews       Be invisible
Back / Home / Recents / power          Survive uninstallation
Tap a button by its label              Read another app's private data
Run unattended over 4G                 Work while powered off
Keep the screen awake                   Kiosk / lock the user out
Survive a reboot (1 re-tap)            Silently install apps
Detect the user touching it            Remote wipe or camera disable
Work on any Android 8.0+               Control iOS
```
