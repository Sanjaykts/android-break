# Break Remote

> **Taking this over? Read [`HANDOVER.md`](HANDOVER.md) first.** It has the exact
> remaining sequence, the Windows setup, and where the secrets are.

A single Android APK that turns a phone into a device you can drive from a laptop
over the internet, on two different networks, with nothing installed on the laptop
and no second app on the phone.

The phone owner installs one APK and grants three permissions. After that, control
lives in a browser tab.

```
   Phone (owner's, on 4G)         Cloudflare (free)         Laptop
  ┌────────────────────┐        ┌─────────────────┐      ┌──────────────────┐
  │ agent.apk          │  WSS   │ Worker          │  WSS │ Console (Chrome) │
  │  ControlService    ├───────▶│  /ws/agent  ┐   ├─────▶│  live view       │
  │  CaptureService    │        │  /ws/console┴─ Hub│     │  tap, swipe,type │
  │  MediaProjection   │◀───────┤  / static assets  │     │  find, record    │
  └────────────────────┘        └─────────────────┘      └──────────────────┘
```

## What this is, honestly

It is a **consent-based remote support tool**. The foreground-service notification
and the Accessibility entry in Settings are visible on purpose, and the phone owner
can uninstall it in two taps. That is deliberate: a tool that resists removal is a
different, much larger product (Android Enterprise device-owner mode), and it
requires a factory reset.

Read [`docs/PRIVACY.md`](docs/PRIVACY.md) before pointing it at anyone's phone.

### What it cannot do

These are not missing features. They are hard limits of a non-rooted phone, and
no amount of engineering changes them:

| | |
|---|---|
| Control a PIN/pattern/password-locked screen | Needs device-owner mode or the PIN |
| Work with the screen off | Needs ADB or root |
| Be invisible, or survive uninstallation | Needs device-owner mode (factory reset) |
| Read another app's private files, messages or photos | Needs root. No UI surface is exposed to us |
| Kiosk, lock the user out, silently install, remote wipe | Needs device-owner mode |
| Control iOS | No accessibility-injection equivalent exists |

The phone's own screen **stays on** and visibly shows what is happening. Do not
promise a dark phone.

## Layout

| Path | What it is |
|---|---|
| `agent/` | The Android app (Kotlin, minSdk 26, targetSdk 34) |
| `relay/` | Cloudflare Worker + Hub Durable Object, and the console SPA |
| `tools/` | Keystore generation, QR code, enroll PDF |
| `docs/` | Architecture, privacy, compatibility, amendments to the plan |
| `demo-start.sh` | One command: health check, then the console fullscreen |
| `demo-preflight.sh` | Red/green checks before walking on stage |
| `plan.md` | The original plan. Read [`docs/AMENDMENTS.md`](docs/AMENDMENTS.md) for what changed. |

## Documentation

| Document | Read it when |
|---|---|
| **[`HANDOVER.md`](HANDOVER.md)** | **Taking this over. Start here.** |
| [`docs/SETUP.md`](docs/SETUP.md) | Setting up a fresh machine, or a build fails |
| [`docs/DEPLOY.md`](docs/DEPLOY.md) | Deploying the relay, setting secrets, cutting a release |
| [`docs/TESTING.md`](docs/TESTING.md) | Running or extending the test suites |
| [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md) | Something is broken |
| [`DEMO_RUNBOOK.md`](DEMO_RUNBOOK.md) | Before a demo. Read it the night before, not during |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Before changing anything structural |
| [`docs/AMENDMENTS.md`](docs/AMENDMENTS.md) | Before changing anything — eleven known traps |
| [`docs/COMPATIBILITY.md`](docs/COMPATIBILITY.md) | Testing the real phone; record the model there |
| [`docs/PRIVACY.md`](docs/PRIVACY.md) | If anyone asks what is transmitted |
| [`docs/PROPOSAL-GAP-ANALYSIS.md`](docs/PROPOSAL-GAP-ANALYSIS.md) | **Zion's EQB security-research proposal: what exists, what is missing, what to build, in what order** |

## How it works

The phone can only make outbound connections, so it dials a Cloudflare Worker. A
Durable Object holds a small rendezvous: it accepts one socket from the phone and
one from the browser, and moves bytes between them. There is no port forwarding, no
public IP, no server to rent, and no Google sign-in on the phone.

The relay is deliberately dumb. Inbound screen frames are size-checked and
forwarded as the same `ArrayBuffer`, never parsed, never touched by storage. A
console filters frames by the `did` in the frame header. See
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for why that is what makes the free
tier viable.

### The permission model

| Grant | What it is for | Can it be pre-granted? |
|---|---|---|
| **Accessibility** | Turning laptop input into real touch events | No. This is the entire input model |
| **Screen capture** | The live view | No. System dialog, every time |
| **Notifications** | Making the foreground-service notification visible | No (API 33+) |

`INJECT_EVENTS`, the permission you would want, is signature-level and
unattainable by a sideloaded app. `AccessibilityService.dispatchGesture` is the
only route from a laptop to a real touch event on a non-rooted phone, and that one
fact determines the whole design.

The enrollment screen shows a live badge per grant and will not say "ready" until
all three are genuinely green. It reads the real state from Settings rather than
caching, because the owner can revoke accessibility with the app in the foreground.

## Build and release

Requires JDK 17+ and the Android SDK (platform 34, build-tools 34.0.0).

```bash
# one time -- see docs/AMENDMENTS.md before running this
export KEYSTORE_PASSWORD='...' KEY_PASSWORD='...'
./tools/make-keystore.sh

# local builds
cd agent && ./gradlew assembleRelease
# -> agent/app/build/outputs/apk/release/app-release.apk
```

CI (`.github/workflows/build.yml`) builds on every push to `main` and publishes to
a rolling GitHub release, so the download URL in the enrollment QR code is a
constant and never needs regenerating. The job **fails if the APK is unsigned**,
which is otherwise the failure mode that only surfaces on the phone.

Required repository secrets: `KEYSTORE_BASE64`, `KEYSTORE_PASSWORD`, `KEY_ALIAS`,
`KEY_PASSWORD`, `RELAY_URL`, `AGENT_TOKEN`, `CONSOLE_TOKEN`.

## Run the relay

```bash
cd relay
npm install
printf 'AGENT_TOKEN="..."\nCONSOLE_TOKEN="..."\n' > .dev.vars
npm run dev            # http://127.0.0.1:8787
```

Deploy with `npm run deploy` after setting the two tokens as Worker secrets
(`wrangler secret put AGENT_TOKEN`).

There are two tokens on purpose. `CONSOLE_TOKEN` can be rotated in a Worker secret
at any time without touching the phone. `AGENT_TOKEN` is baked into the APK, so
rotating it needs a new release. After a demo, rotate the console token
immediately and treat the agent token as spent.

## Scripts

Every script exists in both forms. The `.cmd` files are thin wrappers that
invoke PowerShell with `-ExecutionPolicy Bypass`, so a locked-down Windows
machine will not block them. The PowerShell is platform-agnostic and was verified
by running it.

| Purpose | Windows | macOS / Linux |
|---|---|---|
| Run every automated check | `.\check-all.cmd` | `./check-all.sh` |
| Pre-demo red/green checks | `.\demo-preflight.cmd` | `./demo-preflight.sh` |
| Health check, open the console | `.\demo-start.cmd` | `./demo-start.sh` |
| The final gate before the demo | `.\demo-freeze.cmd` | `./demo-freeze.sh` |

## Tests

Everything below runs against a real local relay, because hibernation, tag routing
and byte preservation only exist in the real runtime. A mock would test nothing
that matters.

```bash
cd relay
npm run typecheck

npx wrangler dev --port 8787 --ip 127.0.0.1 &     # in another shell

npm run e2e        # 26 checks: auth, pairing, routing, byte integrity
npm run smoke      # 27 checks: real headless Chrome against the real console
npm run loadtest   # sustained frame relay
```

One command runs all of it:

```bash
./check-all.sh          # android build + 4 relay suites
./check-all.sh --quick  # skip the 30s load test
```

Phase 5 tooling, for rehearsing and freezing:

```bash
cd relay
node tools/rehearse.mjs --url <relay>                    # all 6 beats, on a timer
node tools/rehearse.mjs --url <relay> --device <id>      # same, against the real phone
node tools/record-demo.mjs --url <relay> --device <id>   # writes demo.mp4
node tools/record-demo.mjs --url <relay> --rehearsal     # mock phone, NOT the fallback
node tools/soak-device.mjs --url <relay> --device <id> --minutes 30
```

`rehearse.mjs` works against a synthetic phone before a device exists and against
the real device afterwards, with identical choreography, so the first run on real
hardware is not also the first run of the code. `soak-device.mjs` is the
definition-of-done stability test, and it deliberately refuses to count a
synthetic device as a pass.

From the repo root, `./demo-freeze.sh` re-runs every check and then verifies the
things a laptop cannot see -- `demo.mp4` existing and not being a placeholder, the
relay being live, the install link resolving, and the enrollment sheet having no
unfilled gaps. It fails while `demo.mp4` is missing, on purpose.

Measured on a MacBook, local relay:

- **30-minute soak:** 17,818 frames, 731 MB, **100% delivery, zero drops**
- **Ceiling:** 36 Mbps sustained at 100% delivery, roughly 10x what the demo needs
- **Android:** 4 unit tests pinning the binary frame format

`npm run loadtest -- --seconds 1800` is the pre-demo 30-minute rehearsal. The plan's
definition of done requires 30 minutes of continuous operation, so run it once
before the day rather than discovering the answer in the room.

## Troubleshooting

**The console shows no devices.** The phone's app must be running, and the relay
sends a snapshot of the device list when a console connects, so an empty list means
the phone is genuinely not connected. Run `demo-preflight.sh`.

**Taps do nothing, everything else works.** `canPerformGestures` is missing from
`res/xml/accessibility_config.xml`, or the phone revoked the service. The
enrollment screen runs a startup gesture self-test and shows a "Gestures work"
badge, because there is no public getter for that flag and the only symptom
otherwise is silent input loss.

**The live view is blank but the console is connected.** Almost always
`MediaProjection` consent. The console shows `needsConsent` when the system
revokes capture, and Android 14+ cannot re-acquire it silently -- re-tap "2. Allow
screen sharing" on the phone. This also happens after every reboot.

**The phone's screen sleeps mid-demo.** Nothing an app can do prevents the display
timeout. Set Screen timeout to 30 minutes during enrollment. This is in the
enrollment screen for that reason.

**Frames arrive but the image is skewed by a few pixels.** An `Image.Plane` row
stride wider than `width * 4` not being honoured. `CaptureService` handles it
explicitly; if you port the capture code, do not use `copyPixelsFromBuffer`.

**The relay dropped the connection under load.** Run `npm run loadtest` at the
target rate. Cloudflare's free tier is the constraint the plan worries about, and
the answer is measured rather than assumed.

## Licence and responsible use

Consent-based remote support for devices you own or have permission to administer.
Not covert monitoring. Not another person's device without consent. See
[`docs/PRIVACY.md`](docs/PRIVACY.md).
