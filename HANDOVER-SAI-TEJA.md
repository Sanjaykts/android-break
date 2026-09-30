# Handover — Android Security Research & Controlled Monitoring demo

**To:** Sai Teja
**From:** Sanjay
**Date:** 2026-09-30
**Client:** Zion's EQB Pvt Ltd · **Vendor:** AutomationX
**Proposal:** `AutomationX_Zions_EQB_Android_Security_Research_Demo_Proposal.md`

Read `docs/DEVICE-RUN-FINDINGS.md` before you change anything in `agent/`. It
explains the single most important thing about this codebase.

---

## 1. Where the work stands

| | |
|---|---|
| Code, tooling and documentation | **complete** |
| Verified on a real Android device (emulator) | **most of it** — 9 controls observed |
| Verified on *physical* hardware | **4 items outstanding** |
| Blocking scope question | **1 — open, and not mine to close** |
| Automated checks | **173, all green** |
| Crashes on device | **0** |

I would describe it as ~95% done. Read section 4 before repeating that number to
anyone, because the remaining 5% is not evenly weighted: one of the five items is
a question only AutomationX can answer, and it has **not** been answered.

---

## 2. What is built and how it is verified

| Proposal section | State | Evidence |
|---|---|---|
| §3 Scope and safety | enforced | `relay/tools/permission-policy.mjs`, 32 checks |
| §4 Attack chain (A1–A9) | built | A2, A3, A6–A9 automated; A1, A4, A5 need a human |
| §5 Android controls (B1–B9) | B1, B2, B3, B4, B8, B9 **observed**; B5, B6, B7 need hardware | `collect-device-evidence.sh` |
| §6 Lab architecture (E1–E5) | complete | runs locally, no Cloudflare account needed |
| §7 Ten setup steps | 9 of 10 | **Step 4 deliberately not built** — see 4.1 |
| §8 Monitoring model | complete | dashboard at `/lab/` |
| §9 Telemetry schema (C1–C8) | complete, enforced server-side | 26 lab checks |
| §10 Vulnerability classes (D1–D8) | **8 of 8** | D2, D4, D5, D7 observed on device |
| §11 Evidence and report | tooling complete, pack partial | `docs/REPORT.md` §5 |
| §12 Success criteria | 4 of 6 fully met | 2 need a device |
| §13 Risk controls | all 4 implemented | — |
| §15 Defensive outcomes | **7 of 7** | `docs/DEFENSIVE-OUTCOMES.md` |

### Re-verify everything yourself

```sh
./agent/gradlew --project-dir agent :app:testDebugUnitTest :labapp:assembleDebug :toylab:assembleDebug
cd relay && npm ci && npm run all
```

Expect: 4 + 28 + 32 + 21 + 26 + 32 + 30 = **173 passing, 0 failing.**

If you get a different count, something has drifted. Do not "fix" the docs to
match a lower number — find out why.

---

## 3. Read this before touching `agent/`

`docs/DEVICE-RUN-FINDINGS.md` documents six defects that CI could not catch.
The important one:

> The lab app passed short permission names (`"READ_SMS"`) to
> `requestPermissions()`. Android only resolves fully qualified names, so the
> permission controller dismissed itself, **the consent prompt never appeared**,
> and the status line read "0 of 4 permissions granted" even after everything was
> granted by hand. The proposal's central consent demonstration was broken on
> every Android device, and 166 automated checks were green throughout.

**The lesson: a green CI run here says nothing about whether the apps work.** Every
automated check reads a manifest or a source file. None of them ran the app.

So: **after any change to either app, run it.** The emulator recipe is in
`docs/DEVICE-RUN-FINDINGS.md` §"Reproducing". Ten minutes, and it is the only way
to know.

Two policy checks now guard the specific traps that bit me:

- every training target must be declared in the manifest *and* linked from the
  launcher — a flaw being present is not the same property as a target being
  reachable
- the weak-TLS target must keep its negative control and must not run its request
  on the main thread

---

## 4. What is left

### 4.1 BLOCKING — §7 Step 4 contradicts the rest of the proposal

Step 4 asks for monitoring that "bypasses" user action and runs "silently". This
contradicts §1 ("user consent must be the entry point"), §3, and §12 ("zero real
personal data"). Both cannot be built.

**Delivered instead:** consented, visible, synthetic-only telemetry, with the
`data_class: "TEST_ONLY"` gate enforced server-side so a modified client cannot
smuggle real data in.

**AutomationX has not ruled on this.** Do not build it, do not describe it as
agreed, and do not let a demo appear to need it. If the demonstration seems to
require bypassing a user decision, the demonstration is wrong, not the safety
rule. This is the single largest open risk in the engagement.

### 4.2 Needs physical hardware — 4 rows

An emulator cannot stand in for these, and I did not fake them:

| Item | Why an emulator cannot do it |
|---|---|
| §5 B5 verified boot | `ro.boot.verifiedbootstate` and `ro.boot.bootverified` are **empty by design** — there is no verified boot chain to report |
| §5 B7 Play Protect | Not present in the emulator image at all |
| §5 B6 browser isolation | Needs a real browser and a real profile |
| O10 `dispatchGesture` | Needs a real touchscreen |

A device being *verifiably intact* and *current* are independent facts. Only the
first is observable here, and conflating them is how an organisation ends up
confident for the wrong reason. Say this to the client.

### 4.3 Filing — the executed authorization

The client signature is reported received and is recorded as a dated, attributable
attestation in `lab/AUTHORIZATION.md` §10.1. The **executed counter-signed
artifact is not attached to the repo.** No signature was transcribed or forged —
a document that looks executed but is not defeats the purpose of having an
authorization record. Attaching the real artifact is a filing step.

### 4.4 The two base URLs — read this, it will bite you

The emulator reaches the host at `10.0.2.2`. A physical device does not. So:

```sh
# emulator
RELAY_URL=http://10.0.2.2:8787 ./agent/gradlew --project-dir agent :labapp:assembleDebug
TOYLAB_TLS_URL=https://10.0.2.2:8443/lab/health ./agent/gradlew --project-dir agent :toylab:assembleDebug

# physical device — the host's real LAN address
RELAY_URL=http://192.168.x.x:8787 ...
```

Both resolve from `keystore.properties` first, then the environment, then a
loopback default. The defaults stay on loopback so a developer's build works
untouched. **If telemetry silently does not arrive, check this before anything
else.**

### 4.5 Platform limits you will hit again

- **Synthetic contacts cannot be seeded on Android 11+.** The shell user gets
  `UnsupportedOperationException` and a non-default app cannot write them either.
  `tools/lab/seed-synthetic.sh` detects and reports this rather than pretending.
  The app shows its visible in-app dataset instead.
- **Synthetic SMS *can* be seeded**, via the emulator radio console
  (`adb emu sms send`). Verified: 9 inbox records, 6 correctly identified as ours.
- On a physical device the SMS provider exposes no host-side delete, so
  `seed-synthetic.sh --purge` reports the row count and tells you to wipe.

---

## 5. Security landmines — handle these deliberately

1. **The release signing key was published and must be treated as compromised.**
   `android-break-handover-20260928.zip`, containing `keystore.jks` and its
   password, was committed publicly in `e79a5b1` and only untracked in `b35d738`.
   Removal is not remediation. **The key has to be rotated** before any real
   deployment. Rotation means the device stops accepting updates, so it has to be
   a planned reinstall/re-enrolment, not a quiet action.

2. **`AGENT_TOKEN` is embedded in the published APK.** Extractable by anyone who
   downloads it. Treat as compromised. Rotate alongside the key.

3. **`labapp`'s token is not a secret** — it is `dev-agent-token` by default and
   the lab server is local. That is correct for a lab and wrong for anything else.

4. **The training targets are deliberately vulnerable.** Never install them on a
   personal device. `relay/tools/toy-policy.mjs` (30 checks) is what keeps them
   harmless: every flaw present, nothing able to reach the internet, loopback and
   `.invalid` URLs only. Do not remove it to "tidy up".

---

## 6. Windows notes — you are on Windows

**The four `.cmd` files are CRLF and must stay CRLF.** `git` will convert them if
`core.autocrlf` is not set. Check before your first commit:

```sh
git config core.autocrlf
```

If it is `true` and you see whole files rewritten, set `git config core.autocrlf
input` for this repo.

**You will need:**

- JDK 17
- Android SDK with `platform-tools`, `emulator`, and
  `system-images;android-34;google_apis;x86_64` (x86_64 on an Intel/AMD host —
  **not** `arm64-v8a`, which I used on Apple Silicon)
- Node 20+
- Git, with the line-ending check above

```sh
sdkmanager "platform-tools" "emulator" "system-images;android-34;google_apis;x86_64"
avdmanager create avd -n lab34 -k "system-images;android-34;google_apis;x86_64" -d pixel_5
emulator -avd lab34 -no-window -no-audio -no-boot-anim
```

**`tools/lab/*.sh` have no Windows equivalent yet** — six scripts, all POSIX:
`lab-up.sh`, `allowlist.sh`, `capture.sh`, `collect-device-evidence.sh`,
`reset.sh`, `seed-synthetic.sh`. Most of what you need on Windows is already in
`collect-device-evidence.sh`, which degrades to printing manual steps when adb is
absent, so the highest-value one to port is **`collect-device-evidence.sh`**.
The firewall rules in `allowlist.sh` are the other real gap; `lab-up.sh`
references `iptables` and will not work natively on Windows — WSL is the
shortest path.

I have not tested any of this on Windows. Treat the SDK and line-ending
instructions as the part most likely to need adjusting.

---

## 7. Repository layout

```
AutomationX_..._Proposal.md   the client document. Everything traces to this.
docs/
  EXECUTION-PLAN.md           build sequence and the scope decision
  PROPOSAL-GAP-ANALYSIS.md    what was missing, and when
  DEVICE-RUN-FINDINGS.md      READ THIS FIRST
  REPORT.md                   section 11; section 5 is partly filled
  D8-PATCHED-VULNERABILITIES.md   section 10 class D8
  DEFENSIVE-OUTCOMES.md       section 15
  COMPATIBILITY.md            device compatibility (Redmi Note 8, Android 11)
lab/
  AUTHORIZATION.md            unsigned; section 10.1 has the attestation
  TEST-CASE-MATRIX.md         every case, with status
relay/
  src/lab.ts                  telemetry ingest, attribution, alerts
  public/lab/                 landing page and analyst dashboard
  tools/lab-e2e.mjs           26 lab checks
  tools/permission-policy.mjs 32 checks: the lab app's safety claim
  tools/toy-policy.mjs        30 checks: flaws present, flaws inert
  tools/lab-tls-endpoint.mjs  self-signed endpoint, so D7 is observable
agent/
  app/                        the Break Remote teaching artifact (D6, by contrast)
  labapp/                     the benign demonstration app
  toylab/                     the five deliberately flawed targets
tools/lab/                    six POSIX lab scripts
```

---

## 8. Two rules

1. **Run the apps after every change to `agent/`.** See section 3.
2. **Never build the §7 Step 4 capability.** See 4.1.

---

## 9. Where the code lives, and the history problem

- **This work:** `github.com/Sanjaykts/android-break`, branch **`sanjay`** (and
  `main`, which is the same content).
- **Your repo:** `github.com/ChadaSaiteja/remote-android-control`.

**Our two repositories have unrelated histories.** Yours is a single commit
(`3567a9e`, "Add Break Remote handover package"); mine is 18 commits. There is no
merge base, so **do not try to merge them.** The `sanjay` branch I pushed to your
repo is a complete, self-contained copy of the finished work — take it as the
starting point rather than as something to reconcile.

Your `main` is untouched, and I did not overwrite it.

The one change of yours I adopted: `relay/src/hub.ts`, where `/devices` did not
await `warmMeta()` after Durable Object hibernation, plus a regression check for
it in `relay/tools/e2e.mjs` and the Redmi Note 8 details in
`docs/COMPATIBILITY.md`. That fix is in the `sanjay` branch. If you later merge
your repo forward, keep it.

---

## 10. Contact

Questions on scope or on the client's intent: **Sanjay**. Questions on the build,
CI, or the Android specifics: **me** — this file, and `docs/DEVICE-RUN-FINDINGS.md`
for the traps.
