# Troubleshooting

Ordered by how likely each is to cost you the demo.

---

## Demo-day failures

### The console shows no devices

The phone's app must be running, and the relay sends a snapshot of the device
list when a console connects — so an empty list means the phone is genuinely not
connected, not that the page loaded too early.

```powershell
curl "https://<relay>/devices?token=<console token>"
```

If the phone is missing: it is not connected to the relay. Open the app on the
phone and read the status line at the bottom of the enrolment screen. It will say
`relay: retrying (<reason>)`.

### Live view is blank but the console is connected

Almost always MediaProjection consent. The console banner says
**PHONE NEEDS A TAP** when it knows.

Android 14+ cannot re-acquire screen-capture consent silently. One tap on the
phone: **2. Allow screen sharing**. This also happens after every reboot, and after
the OS revokes capture from the notification shade.

Say it out loud while you do it. It is normal Android behaviour, and
demonstrating it honestly is better than hiding it.

### Taps do nothing, but the video updates

Check the enrolment screen's **"Gestures work"** badge. It is red when
`dispatchGesture` is being refused.

Almost always one of:

- Accessibility was revoked in Settings.
- `android:canPerformGestures="true"` is missing from
  `agent/app/src/main/res/xml/accessibility_config.xml`. Without it **every**
  gesture returns false and there is no error anywhere. If you ever edit that
  file, this is the first thing to break.

Re-enable Accessibility on the phone, live, out loud. The console updates within a
second.

### The phone's screen sleeps mid-demo

Nothing an app can do prevents the display timeout. It is a platform limit, not a
bug.

**Settings → Display → Screen timeout → 30 minutes.** Do this during enrolment.
The enrolment screen links straight to it.

### The live view freezes but the console is still "live"

The screen captured is likely locked, or the OEM killed the service. Check
**Settings → Battery → Unrestricted** for the app. Xiaomi, Oppo, Vivo and Samsung
are aggressive about this, and an accessibility service being killed is silent.

The console's reconnect is one click. Most "failures" are a dropped socket, not a
crash.

### Frame rate collapses

The console already stepped quality down automatically on high RTT, and says so
in the log. That is the feature working. Do not touch the quality control during
a demo.

### The venue wifi blocks or throttles WebSockets

The phone's own cellular is independent of the venue, so the cross-network claim
holds. If the **laptop** cannot reach the relay, put the laptop on a phone
hotspot.

---

## Build failures

### `SDK location not found`

```powershell
$env:ANDROID_HOME
```

Empty? Set it and reopen the shell:

```powershell
[Environment]::SetEnvironmentVariable("ANDROID_HOME", "$env:LOCALAPPDATA\Android\Sdk", "User")
```

Or delete `agent\local.properties` and let Gradle regenerate it. If you received
this as a zip, that file may hold a macOS path — delete it.

### `Unsupported class file major version`

Wrong JDK. Use 17 or 21:

```powershell
winget install EclipseAdoptium.Temurin.17.JDK
java -version
```

### Gradle daemon or lock errors

```powershell
cd agent
.\gradlew.bat --stop
Remove-Item -Recurse -Force .gradle -ErrorAction SilentlyContinue
.\gradlew.bat assembleDebug
```

### `npm error enoent` in the relay suites

`npm install` was not run, or was run in the wrong directory.

```powershell
cd relay
npm install
```

### `WebSocket is not defined`

Node older than 22. The test tools use Node's global `WebSocket`.

```powershell
node -v
winget install OpenJS.NodeJS.LTS
```

### Puppeteer's Chromium fails to download

Only the browser suites need it. Or set a path to an existing Chrome:

```powershell
$env:PUPPETEER_SKIP_DOWNLOAD = "true"
$env:PUPPETEER_EXECUTABLE_PATH = "C:\Program Files\Google\Chrome\Application\chrome.exe"
```

---

## Relay failures

### `/health` returns 503 with `relay is not configured`

A Worker secret is not set. Auth **fails closed** by design — an unconfigured
relay serves nothing rather than serving everything.

```powershell
cd relay
npx wrangler secret list
npx wrangler secret put AGENT_TOKEN
npx wrangler secret put CONSOLE_TOKEN
```

### The phone connects and is immediately refused (401)

`AGENT_TOKEN` on the Worker does not match the one compiled into the APK.

```powershell
gh secret list      # confirms the Actions secret exists
cd relay
npx wrangler secret put AGENT_TOKEN     # must be the same value
```

If the value is genuinely lost, see `docs/DEPLOY.md` §4.

### WebSockets connect, then nothing happens

Check `npx wrangler tail` while reproducing. The DO hibernates when idle, so
nothing is logged between events — that is correct, not broken.

### A Durable Object error about migrations

The DO class changed shape and needs a migration tag in `wrangler.jsonc`. Add a new
tag rather than editing `v1`:

```jsonc
"migrations": [
  { "tag": "v1", "new_sqlite_classes": ["Hub"] },
  { "tag": "v2", "new_sqlite_classes": ["Hub"] }
]
```

### Deploying drops the demo

**Deploying a new Worker version disconnects all WebSockets.** Do not deploy
during a live demo. `npx wrangler rollback` reverts a bad version.

---

## Release failures

### CI fails: `KEYSTORE_BASE64 secret is not set`

Repository secret not configured. `gh secret list` to check. See
`docs/DEPLOY.md` §1.

### CI fails: the APK is not signed

The signing guard is doing its job. The `keystore.properties` written by the
"Restore release keystore" step is malformed, or `KEYSTORE_BASE64` is not valid
base64. This guard exists because an unsigned APK otherwise fails only on the
phone.

### CI fails: `unknown flag: --notes`

`gh release upload` does not accept `--notes`. Notes go through a separate
`gh release edit`. Already fixed — if you reintroduce it, the first run works and
the second fails, which is the annoying way to find out.

### The install link 404s

The rolling release has not been published yet, or the build failed before
publishing. Check `gh run list` and `gh release list`.

---

## When you do not know

The tools are designed to tell you rather than make you guess:

- **`.\check-all.cmd`** — every automated check, names the failing layer.
- **`.\demo-preflight.cmd`** — the demo, red/green, with a phone checklist.
- **`.\demo-freeze.cmd`** — the final gate; fails on anything missing.
- **`npm run rehearse -- --device <id>`** — names the beat that failed and how long it took.
- **`npm run soak -- --device <id>`** — per-minute frame rate, gap, latency, reconnects.
- **`npx wrangler tail`** — live Worker logs.
- **`cd agent && .\gradlew.bat :app:assembleRelease --info`** — full Gradle output.

And when the first 60 seconds go wrong on stage: **play `demo.mp4`.** Do not
debug live. That is the one piece of advice in this repository with no
exceptions.
