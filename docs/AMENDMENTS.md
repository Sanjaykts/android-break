# Amendments to `plan.md`

The plan was written before any code existed and is sound in its architecture,
constraint analysis and honesty framing. These are the corrections and additions
that implementation forced. Each one is either a bug the plan would have shipped,
or a risk it did not know about.

Read this alongside `plan.md`, not instead of it.

---

## Bugs the plan would have shipped

### 1. `canPerformGestures` is missing (fatal)

§6.1 describes the entire input model on `dispatchGesture` but never mentions the
`android:canPerformGestures="true"` flag in the accessibility config XML. Without it
**every** `dispatchGesture` call returns false. There is no public getter for the
flag, no exception, and no log line -- a laptop tap simply does nothing.

This is plan risk #2's actual mechanism, and it is a much quieter failure than
"the owner cannot find the settings menu."

Implemented: the flag is set, and `ControlService` runs a one-pixel gesture probe
at startup that reports the result to the enrollment screen as a "Gestures work"
badge. The failure is now a red badge instead of silence.

### 2. `BIND_ACCESSIBILITY_SERVICE` is not a `<uses-permission>`

§6.1 lists it alongside `INTERNET` and `FOREGROUND_SERVICE`. It is a signature
permission that belongs on the `<service>` element as `android:permission`.
Declared as `<uses-permission>` it is inert. Same for `BIND_INPUT_METHOD`.

### 3. The boot receiver must not start `CaptureService`

§4 and §6.1 imply reboot restores capture. On API 34+ starting a `mediaProjection`
foreground service without a live `MediaProjection` throws, and consent can never be
re-acquired silently. Attempting it produces a crash loop whose only symptom is a
blank console.

Implemented: `BootReceiver` restores the relay session and posts a one-tap re-consent
notification. §2's limitation 5 is correct as written; the mechanism is not.

### 4. `FLAG_KEEP_SCREEN_ON` from a service does not work

§4 lists "keep screen awake" as a build item. The flag applies to a window and needs
focus; a service-created window is not reliably focused. A screen timeout mid-demo
is unrecoverable.

Implemented: a partial wakelock holds the CPU between frames (real, and
documented as such), and the enrollment screen walks the owner through
**Screen timeout → 30 minutes**, which is the only thing that actually works.

### 5. There is no `GLOBAL_ACTION_APP_SWITCH`

§3's protocol lists `appswitch` as a global action. The constant does not exist in
the platform. Implemented as `GLOBAL_ACTION_ACCESSIBILITY_ALL_APPS` (the app
drawer), with `GLOBAL_ACTION_RECENTS` as the OEM fallback.

### 6. `AccessibilityNodeInfo.setText()` returns void

Not a plan error, but the trap it leads into: `setText` cannot report success, so a
failed `settext` in the script runner is indistinguishable from a slow network. The
working path is `performAction(ACTION_SET_TEXT, args)`, which returns a Boolean.

---

## Risks the plan did not have

### 7. No device is ever reachable, so there is no short feedback loop

The plan's Day 1 exit is "download and install it on the demo device", and §10 risk
#1 assumes a build problem is discoverable quickly. Neither is true. The no-USB rule
means `adb` is never available, so **nothing about the agent can be verified from a
laptop** except that it compiles.

The compensation is to move verification as far left as possible:

| Layer | Verified by | Runs locally |
|---|---|---|
| Kotlin compiles, lints, shrinks | Gradle | yes |
| Binary frame format | 4 JVM unit tests | yes |
| Relay transport, auth, pairing, byte integrity | `relay/tools/e2e.mjs`, 26 checks | yes |
| Relay throughput | `relay/tools/loadtest.mjs` | yes |
| Console, in a real browser | `relay/tools/console-smoke.mjs`, 27 checks | yes |
| Accessibility actually works | a human, on the phone | **no** |

Only the last row is untestable locally, and it is the row that carries plan risks
#2, #3, #7 and #8. Budget real time for phone testing; the automated coverage does
not reduce that need, it stops you wasting phone-testing time on transport bugs.

### 8. The relay was the plan's largest untested assumption

§6.2 asserts the Durable Object will work and §10 rates the risk "low–medium". It
is the component everything depends on, and "a free Durable Object can relay
sustained media" is not a safe assumption to build a five-day plan on.

Measured: **36 Mbps sustained at 100% delivery, about 10x the 3.2 Mbps the demo
needs**, and a 30-minute soak at 17,818 frames / 731 MB with zero drops. The
Koyeb fallback in §6.2 remains unnecessary, which is worth knowing -- it was
estimated at "10 minutes" to swap, which is optimistic for a media relay.

### 9. `WRANGLER` note — the hibernation API is not what you remember

The pattern in most examples, `new WebSocketRequestResponsePair(request)`, does not
exist. That global name is an unrelated auto-response helper. The working pattern is
`new WebSocketPair()` + `state.acceptWebSocket(server, tags)` +
`new Response(null, { status: 101, webSocket: client })`.

Worth recording because getting it wrong fails at runtime with an error message
that does not mention hibernation.

### 10. Backpressure was unspecified

Nothing in the plan says what happens when the uplink stalls. An unbounded send
queue grows until the phone runs out of memory, and on demo day an OOM is
unrecoverable because the only fix is uninstalling.

Implemented: frames are latest-wins with a hard drop at a 512 KB queue high-water
mark, mirroring the console's own latest-frame-wins decode policy.

### 11. `Image.Plane` row stride

Not a plan gap so much as a trap the plan's warning gestures at. `ImageReader`
routinely returns `rowStride > width * 4`, and `Bitmap.copyPixelsFromBuffer` assumes
they are equal. Assuming so shears the image by a few pixels per row -- which looks
*almost* right, so it survives review and only fails on particular hardware.
`CaptureService` honours the stride explicitly.

---

## Two protocol decisions the plan left open

**`did` in the frame header, and frames fanned out to every console.** §6.2 implies
the DO decides which console a frame belongs to. Instead the frame carries its
device id and the console filters. This removes the pairing lookup from the frame
path entirely -- the header is read anyway to map tap coordinates -- so the hot path
is a tag lookup and a send, with no storage and no JSON.

**Identity in tags and `serializeAttachment`, never in storage reads.** Both survive
hibernation, so the frame path and the command path perform **zero** storage
operations. Storage is written at most once per agent connection and read only by
`/devices`.

**Latency is measured on the console's clock.** The console sends `t`, the agent
echoes it, the console subtracts. Phone and laptop clocks will disagree, and any
scheme that compares them produces a meaningless badge.

---

## Things the plan got right and should not be changed

- The Day-2 gate ("choppy but complete: live view + tap + type over 4G") being the
  real deliverable. Everything after it is polish. Under compression, stop there.
- Refusing to promise a dark phone, a locked screen, or invisibility. §2 is the most
  valuable section in the document.
- The claim discipline in §8. With one device, "validated on \[model\], running
  \[version\]" is the only honest wording.
- Rotating the shared secret after the demo, and replacing it with per-device
  enrolment tokens before any real deployment.
- The pre-install ask in §9.3. It is the single largest risk reduction available and
  it costs one conversation.

---

## Open questions still unanswered

§15 is still open, and these change work rather than polish:

1. **Actual demo date.** Determines which row of §9.1 applies. Cut on Day 1.
2. **Personal phone or company/loan device.** Decides the consent slide and whether
   the AirDroid second-path ask is appropriate at all. Asking an audience member to
   install two remote-control apps on a personal phone is not reasonable.
3. **Does the phone have 4G data.** If it is WiFi-only, the cross-network claim
   weakens to "same router, different subnets" and the architecture slide must say
   so.
4. **Model and Android version of the demo phone.** Needed for the compatibility
   claim and to screenshot the real Accessibility settings path.
5. **Can a second phone be borrowed for one afternoon.** One vendor is the difference
   between a one-data-point claim and a credible one.
