# HANDOVER

**Read this first.** Everything else is reference material.

You are taking over a working, tested build of a remote Android control system:
an Android agent APK, a Cloudflare Worker relay, and a browser console. The code
is complete and the transport is fully tested. **What is left requires a physical
Android phone**, and one interactive web login.

| | |
|---|---|
| Repository | `https://github.com/Sanjaykts/android-break` (public) |
| Install link (permanent) | `https://github.com/Sanjaykts/android-break/releases/download/apk-latest/agent.apk` |
| Live artifact | 271 KB, signed, `minSdk 26` / `targetSdk 34`, exactly 7 permissions |
| Last CI run | `build: success`, `relay: success` |
| Automated coverage | 4 unit + 27 e2e + 32 browser + 21 recording checks, all green |
| Known limitation | Not yet tested on any physical handset |

---

## 0. If you were given the zip

The package contains a **built, signed, ready-to-install APK** at `apk/agent.apk`
— you do not need to compile anything to put it on a phone. Verify it:

```powershell
certutil -hashfile apk\agent.apk SHA256     # compare with apk\SHA256SUMS.txt
```

> ### It will not connect yet. That is expected.
>
> The APK in the package was compiled against a **placeholder** relay address
> (`wss://android-break-relay.example.workers.dev`). The relay has not been
> deployed. Until you do steps 2 and 3 below, the app installs, grants all three
> permissions and starts capture — then sits showing `relay: retrying` forever.
>
> You can still install it now to check the enrolment flow; only the connection
> is missing. Everything else — the permission UI, the live badges, the
> gesture self-test — works without the relay.

`DO-NOT-FORWARD/` holds the release signing key so you can sign locally. CI does
not need it. Read that folder's `README.txt` before sending it anywhere.

## 0b. New requirement: the Zion's EQB security-research proposal

The client sent a **different project** — a defensive, lab-only, synthetic-data
Android security awareness exercise. This repository is a remote-control tool.
They are not the same deliverable.

Read [`docs/PROPOSAL-GAP-ANALYSIS.md`](docs/PROPOSAL-GAP-ANALYSIS.md) before
quoting any completion figure. Short version: ~90% complete against the original
brief, **~12% against the proposal**, with one scope contradiction in the proposal
itself that must be resolved with AutomationX before anything is built.

## 1. Do these five things, in this order

### 1. Back up the release keystore — do this today

```
agent/keystore.jks
```

Passwords: `Br34kR3mote!demo` for both store and key. Alias `agent-release`.

**Copy it somewhere private and durable right now.** It is the release identity
for the app. If it is lost, the next build cannot be installed as an update on a
phone that already has the app — Android rejects it, the owner has to uninstall
first, and that breaks the whole "upgrade in place" story. It cannot be recovered
from GitHub; it only lives in the Actions secret `KEYSTORE_BASE64` and in your
local file.

**Never rotate this key.** A new key is a different signing identity.

### 2. Deploy the relay (the only interactive step)

The relay is not deployed yet. Everything else is ready and waiting for it.

```powershell
cd relay
npx wrangler login          # opens a browser, pick Cloudflare (free tier)
npx wrangler secret put AGENT_TOKEN
npx wrangler secret put CONSOLE_TOKEN
npm run deploy
```

**The token values you need.** They were generated during setup and are on the
original machine at `/tmp/agent_token.txt` and `/tmp/console_token.txt`. Get them
from whoever handed this to you. If they are gone, see §5 — there is a recovery
path, but it costs a rebuild.

`npm run deploy` prints a URL like
`https://android-break-relay.<something>.workers.dev`.

### 3. Point the APK at the real relay and rebuild

The published APK currently points at a placeholder relay URL. Fix that:

```powershell
gh secret set RELAY_URL --body "wss://android-break-relay.<something>.workers.dev"
gh workflow run build.yml
```

Wait for it to go green, then confirm:

```powershell
curl -sI https://github.com/Sanjaykts/android-break/releases/download/apk-latest/agent.apk
```

### 4. Enrol the phone

Ask the phone's owner to install it **on their own phone, in their own time**,
from the link above. This is the single biggest risk reduction available and it
costs one conversation — see `DEMO_RUNBOOK.md` §2.

Then on the phone:

1. Open the app. It shows three rows.
2. **Accessibility** → turn on *Break Remote Control*.
3. **Screen sharing** → allow (a system dialog appears).
4. **Notifications** → allow.
5. Set **Screen timeout → 30 minutes** and **Battery → Unrestricted**. Neither is a
   permission, and both will otherwise end the demo mid-run.
6. The app will not say **Ready** until all three are genuinely green. Check the
   **"Gestures work"** badge too — that is the one that tells you tapping actually
   works.

### 5. Record the fallback video, soak, rehearse, freeze

```powershell
cd relay
$env:RELAY_URL = "wss://android-break-relay.<something>.workers.dev"
$env:CONSOLE_TOKEN = "<console token>"

node tools/soak-device.mjs --url $env:RELAY_URL --device <device-id> --minutes 30
node tools/record-demo.mjs --url $env:RELAY_URL --device <device-id>   # writes demo.mp4
node tools/rehearse.mjs    --url $env:RELAY_URL --device <device-id>
```

Get the device id from `https://<relay>/devices?token=<console token>`, or the
pre-flight prints it.

Run the rehearsal **twice, on consecutive days**. Then, from the repo root:

```powershell
.\demo-freeze.cmd
```

It passes only when `demo.mp4` exists, the relay is live, the install link
resolves, and the enrollment sheet has no unfilled gaps. **After it passes:
no code changes.** Write findings down and fix them after the demo.

---

## 2. What is already done

Do not rebuild any of this. It is tested.

| Component | Where | State |
|---|---|---|
| Android agent | `agent/` | Complete. Capture, input, IME fallback, boot recovery, enrollment UI |
| Relay | `relay/src/` | Complete. Worker + Hub Durable Object on hibernation |
| Console | `relay/public/` | Complete. Device list, live view, full input, recording, PiP |
| Test suites | `relay/tools/` | 80 automated checks, all green |
| CI | `.github/workflows/` | Green on every push |
| Docs | `README.md`, `docs/`, `DEMO_RUNBOOK.md` | Current |

`docs/ARCHITECTURE.md` explains how it works and why. `docs/AMENDMENTS.md`
records eleven corrections to the original `plan.md` — read it before changing
anything, because several of those are bugs that will look like features.

### Bugs already found and fixed

Worth knowing so you do not reintroduce them:

- **`canPerformGestures`** must be in `res/xml/accessibility_config.xml`. Without
  it every `dispatchGesture` returns false and tapping silently does nothing.
- **`BIND_ACCESSIBILITY_SERVICE`** is not a `<uses-permission>`. It belongs on the
  `<service>` element as `android:permission`.
- **The boot receiver must not start `CaptureService`.** On API 34+ that throws;
  screen-capture consent can never be re-acquired silently.
- **The IME fallback needs `onStartInput`**, not `onStartInputView` — the keyboard
  is deliberately never shown, so the latter never fires.
- **Image row stride** must be honoured. `copyPixelsFromBuffer` assumes tight
  packing and shears the image by a few pixels per row.
- **Auth fails closed.** An unset Worker secret matches nothing. A Worker deployed
  before its secrets are set returns 503, never 200.

---

## 3. You are on Windows

Everything works on Windows. Use the `.cmd` files — they are thin wrappers that
invoke PowerShell with `-ExecutionPolicy Bypass`, so a locked-down machine will
not block them.

```powershell
.\check-all.cmd            # android build + all 4 relay suites   (~3 min)
.\check-all.cmd -Quick     # skip the frame-relay load test      (~2 min)
.\demo-preflight.cmd        # red/green checks before the demo
.\demo-start.cmd           # health check, open the console fullscreen
.\demo-freeze.cmd          # the final gate
```

The `.ps1` files next to them are the real logic and are readable/editable.

There are `.sh` equivalents for macOS and Linux. The PowerShell versions are
platform-agnostic (`Join-Path`, `$IsWindows` checks) and were verified by running
them, so they also work if you ever develop on a Mac.

Full environment setup: **`docs/SETUP.md`**. That is the file to read if a build
fails on a fresh Windows machine.

### Two files will break your build if you copy the folder

If you received this as a **zip of the working folder** rather than a git clone,
delete these before building. Both contain absolute paths from the original
macOS machine:

```
agent\local.properties        # sdk.dir=/Users/sanjaykt/android-sdk
agent\keystore.properties     # KEYSTORE_PATH=/Users/...
```

`local.properties` is regenerated by Gradle, or write it yourself:

```properties
sdk.dir=C\:\\Users\\<you>\\AppData\\Local\\Android\\Sdk
```

`keystore.properties` is only needed to sign **locally**. You do not need it —
CI signs the release APK from the `KEYSTORE_BASE64` secret. Delete it and local
release builds will simply be unsigned, which is fine for development.

Better: `git clone` the repository instead of copying the folder. Then none of
this applies.

---

## 4. Where the secrets are

| Secret | Where | Notes |
|---|---|---|
| `AGENT_TOKEN` | GitHub Actions secret + `/tmp/agent_token.txt` | **Compiled into the APK.** The Worker secret must match exactly or the phone gets 401 |
| `CONSOLE_TOKEN` | GitHub Actions secret + `/tmp/console_token.txt` | Rotatable any time via `wrangler secret put` — does not need a rebuild |
| `KEYSTORE_BASE64` | GitHub Actions secret | Back up `keystore.jks` too; this is not recoverable otherwise |

**The APK is published from a public release, and it embeds `AGENT_TOKEN`.**
Anyone who downloads the APK can read that token. It only grants the ability to
enrol a device, which is what you want the owner's phone to do — but rotate it
after the demo, and treat the console token as the one that matters.

If `AGENT_TOKEN` is lost: generate a new one, put it in the Worker
(`wrangler secret put AGENT_TOKEN`) **and** rebuild the APK with the same value
as the `AGENT_TOKEN` Actions secret. The phone then needs the new APK.

---

## 5. What could still go wrong

Ranked by how likely it is to cost you the demo.

| Risk | What you will see | What to do |
|---|---|---|
| Consent flow confuses the owner | Nothing works, no error | The enrollment screen has a live badge per grant and will not say Ready until all three are green. Walk them through it once, calmly. |
| Taps do nothing, video is fine | Video updates, clicks ignored | "Gestures work" badge is red → Accessibility was revoked. Re-enable on the phone, out loud |
| Live view blank | Console connected, no picture | The banner says **PHONE NEEDS A TAP**. Android 14+ cannot re-acquire capture consent silently. One tap. |
| Phone screen sleeps | Black screen mid-demo | Screen timeout is not 30 minutes. Fix in Settings. Nothing an app can do about this. |
| Anything wrong in the first 60 seconds | — | **Play `demo.mp4`.** Do not debug live. See `DEMO_RUNBOOK.md` §1. |

`docs/TROUBLESHOOTING.md` has the full list.

---

## 6. If you have to cut scope

The plan's compression rule: the Day-2 gate — "live view, tap and type over 4G" —
is the real deliverable. Everything after it is polish. If you run out of time,
ship that and cut:

- Recording and PiP — cut first, they are demo beat 5 and it is the weakest beat.
- Script runner — cut next.
- find-and-tap — cut last, it is the most impressive thing on screen.

The fallback ladder in order: `demo.mp4` → reconnect the agent (one click, most
"failures" are a dropped socket) → stop and talk about the architecture.

---

## 7. Reference

| Document | Read it when |
|---|---|
| `docs/SETUP.md` | Setting up Windows, or a build fails on a fresh machine |
| `docs/DEPLOY.md` | Deploying the relay, setting secrets, cutting a release |
| `docs/TESTING.md` | Running or extending the test suites |
| `docs/TROUBLESHOOTING.md` | Something is broken and you need the cause |
| `docs/ARCHITECTURE.md` | Before changing anything structural |
| `docs/AMENDMENTS.md` | Before changing anything — eleven known traps |
| `docs/COMPATIBILITY.md` | After testing on the real phone; record the model there |
| `docs/PRIVACY.md` | If anyone asks what is transmitted |
| `DEMO_RUNBOOK.md` | Before the demo. Read it the night before, not during. |
| `plan.md` | The original plan. `docs/AMENDMENTS.md` says where it was wrong. |
