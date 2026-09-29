# Device-run findings

**What this is:** six defects found by running the apps on a real Android device,
none of which any static check in this repository could have caught.

**Environment:** Android 14, API 34, `google_apis` arm64-v8a AVD `lab34`, host
`10.0.2.2` reachable from the emulator.

This is recorded separately from `docs/REPORT.md` because the finding is not
about this proposal — it is that **a green CI run said nothing about whether the
apps worked.** The manifest parsed, the Kotlin compiled, the policy checks passed,
166 automated checks were green, and the central demonstration was still broken.

---

## 1. The consent prompt could never appear — severity: critical

`MainActivity` declared its permission rows with short names and passed them
straight to `requestPermissions()`:

```kotlin
permissionRow("Read synthetic SMS", "READ_SMS", Telemetry.EV_SMS) { ... }
    -> requestPermissions(arrayOf("READ_SMS"), ...)
```

Android resolves only fully qualified permission names. Two things happened, and
both look exactly like the platform working correctly:

- `requestPermissions()` launched the permission controller, which logged
  `GrantPermissionsViewModel: None of [READ_SMS] in {...}` and dismissed itself.
  **No prompt was ever displayed.** The row then read "denied".
- `checkSelfPermission("READ_SMS")` returned `PERMISSION_DENIED`
  unconditionally, so the header sat at "0 of 4 permissions granted" even after
  every permission was granted by hand.

So the §5 B2 demonstration — the proposal's core lesson about consent — was
non-functional on every Android device. An analyst would have shown a user a
refusal and concluded the platform was secure.

**Fix:** `fullyQualified()` normalises the name at the single point it is used.
Confirmed on device afterwards: the real `GrantPermissionsActivity` appears with
`Allow Lab Telemetry to send and view SMS messages?`, and the header correctly
reads `1 of 4 permissions granted`.

**Why CI missed it:** every check reads the manifest, and the manifest was always
correct.

---

## 2. Four of the five training targets were unreachable — severity: high

`MainActivity` launches the targets with `SomeDemo::class.java`, but the manifest
declared only `MainActivity`, `DeepLinkDemo` and the provider. The other four
were never declared, so tapping their tabs threw `ActivityNotFoundException`.

The toy policy asserted that each *flaw* was present. It never asserted that
each *target* could be reached — asserting what is wrong with something is a
different property from asserting that it is reachable at all.

**Fix:** declared the four activities as `exported="false"` (the correct posture —
they are internal lessons), and added reachability checks to `toy-policy.mjs`:
every target is declared, every declared target is linked from the launcher, and
the deep-link target handles `onNewIntent` with `singleTop`.

---

## 3. A second deep link was silently dropped — severity: high

`DeepLinkDemo` read `intent` once in `onCreate` and never implemented
`onNewIntent`, and the activity was not `singleTop`. A link opened while the app
was already running brought the existing activity to the front and the new intent
never surfaced, so the tab showed `(none)` for everything.

**Fix:** `singleTop` plus `onNewIntent` delegating to a shared `showIntent()`,
with `ToyActivity.rebuild()` to redraw.

A second defect sat behind it: the app read the payload only from
`getStringExtra("payload")`, but a browsable link can only carry a **URI query
string** — an external caller cannot attach extras to a `VIEW` intent. The tab
displayed the untrusted URI and then said "No payload supplied". `Uri
.getQueryParameter` also returned null for the received URI on API 34 despite
`toString()` plainly containing the parameter, so the query is now parsed
directly.

---

## 4. The weak-TLS demonstration could not run — severity: high

`WeakTlsDemo` performed its HTTPS request on the main thread. Android threw
`NetworkOnMainThreadException` on every attempt, and the tab reported a network
error — so the flaw was present in the source, enforced by CI, and never
observable in the app.

**Fix:** the request now runs on a background thread. Also added a **negative
control** — the same request with validation left on — because a bypass is only
persuasive when the same code path is shown *not* bypassing.

Observed on device, same URL, same certificate, two code paths:

| Path | Result |
|---|---|
| Flawed (trust-all + permissive verifier) | `HTTP 200 — connection succeeded against a certificate that was never verified` |
| Correctly validating | `Rejected: SSLHandshakeException — Trust anchor for certification path not found` |

`toy-policy.mjs` now fails if the negative control is removed or if the request
returns to the main thread.

---

## 5. The first permission decision was dropped — severity: medium

The session was only claimed when the analyst pressed "Fetch a session id", so the
first `PERMISSION_PROMPT` / `PERMISSION_GRANTED` events were discarded with
`No session id yet — event 'PERMISSION_DENIED' not sent`. Those are the most
important events in the exercise, and §12 requires every event to be attributable
to a session.

**Fix:** the session is claimed at launch, and an event that arrives before one
exists is replayed rather than dropped.

---

## 6. The synthetic-record filter produced a false negative — severity: medium

`countLabOnlySms()` matched the marker in the sender address only. The app's own
`seedSms` writes it there, but `tools/lab/seed-synthetic.sh` stages through the
emulator radio console, which needs a phone-number-shaped sender, so it carries
the marker in the body. The read correctly returned 9 inbox records and then
reported "0 synthetic".

**Fix:** match the marker in either field, because how a record is staged varies.

---

## Also found, and not a code defect

**Contacts cannot be seeded at all on Android 11+.** Neither the shell user
(`UnsupportedOperationException`) nor a non-default app may write the contacts
provider. The first version of `seed-synthetic.sh` silently swallowed that and
reported success; it was rewritten to detect and report the refusal, and to
explain that making the lab app the default contacts handler is itself a
role the user grants on purpose — worth showing rather than engineering around.

**Verified boot cannot be demonstrated on an emulator.** `ro.boot.verifiedbootstate`
and `ro.boot.bootverified` are empty by design, because there is no verified boot
chain to report. A device being *verifiably intact* and *current* are independent
facts, and only the first is even observable here.

---

## What the emulator run did establish

| Observation | Result |
|---|---|
| Server-issued session | `LAB-2026-2C15A534`, bound to one device |
| Telemetry chain | `SESSION_START` → `PERMISSION_PROMPT` → `PERMISSION_GRANTED` → `SYNTHETIC_SMS_ACCESS`, all `data_class=TEST_ONLY` |
| Consent prompt | Real `GrantPermissionsActivity`, captured as a screenshot |
| Deny path | `PERMISSION_DENIED`, read correctly refused |
| Allow path | Read returns 9 inbox records, 6 correctly identified as ours |
| SELinux | `Enforcing`, 36 `avc: denied` entries captured |
| App signing | v2 scheme present |
| D2 | External deep link received, payload consumed with no caller check |
| D4 | Cross-UID `content query` against the unprotected provider returned its rows |
| D5 | Token read back in cleartext from `logcat` and `shared_prefs/training_session.xml` |
| D7 | `HTTP 200` when flawed, `SSLHandshakeException` when validating |
| Crashes | 0 |

Screenshots are in `lab-evidence/screenshots/` (gitignored — regenerate with the
script below).

## Reproducing

```sh
sdkmanager "platform-tools" "emulator" "system-images;android-34;google_apis;arm64-v8a"
avdmanager create avd -n lab34 -k "system-images;android-34;google_apis;arm64-v8a" -d pixel_5
emulator -avd lab34 -no-window -no-audio -no-boot-anim &

cd relay && npm run dev &                       # lab server on :8787
node tools/lab-tls-endpoint.mjs &               # self-signed endpoint on :8443
cd ..
./tools/lab/seed-synthetic.sh                   # stage LABONLY- SMS

# point the apps at the host, not at loopback
RELAY_URL=http://10.0.2.2:8787 ./agent/gradlew --project-dir agent :labapp:assembleDebug
TOYLAB_TLS_URL=https://10.0.2.2:8443/lab/health ./agent/gradlew --project-dir agent :toylab:assembleDebug
```

Note the two different base URLs: the emulator reaches the host at `10.0.2.2`,
while `10.0.2.2` is meaningless on a physical device. The defaults stay on
loopback so a developer build still works untouched.
