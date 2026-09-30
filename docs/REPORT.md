# Demonstration report — Android Security Research & Controlled Monitoring

**Client:** Zion's EQB Pvt Ltd · **Vendor:** AutomationX
**Proposal:** `AutomationX_Zions_EQB_Android_Security_Research_Demo_Proposal.md`
**Status:** prefilled, pending execution on a lab device

> This document is a **template with the verifiable parts already filled in**.
> Every automated result below was produced by a runner in this repository and
> can be re-derived with the commands given. Every manual result is blank,
> because no lab device has been attached yet — those blanks are the honest
> state of the work, not an oversight.

---

## 1. How to read this report

A claim in a security demonstration is only worth what its evidence is worth. So
this report separates three kinds of statement and never mixes them:

| Kind | Meaning | Where it goes |
|---|---|---|
| **Verified** | A script in this repo asserts it, and the script fails if the claim stops being true | §4, with the command |
| **Observed** | A human watched it happen and recorded what they saw | §5, with the screenshot reference |
| **Not done** | It was not built, or it was deliberately excluded | §6, with the reason |

Anything in §6 was excluded for a reason stated in advance, not discovered
afterwards.

---

## 2. Scope actually delivered

| Proposal section | Delivered | Notes |
|---|---|---|
| §4 Attack chain | Yes | Landing → session → consent → synthetic data → telemetry → teardown |
| §5 Android security controls | Partly | B1, B3, B5, B6, B7 need a device; see §6. B2 and B9 are real code paths, not decoration |
| §6 Isolated lab architecture | Yes | Local `wrangler dev`; no internet path is required |
| §7 Controlled monitoring | Partly | Steps 1–3, 5–10 built. **Step 4 is contradictory — see §6.1** |
| §9 Telemetry schema | Yes | Enforced server-side, all 8 checks automated |
| §10 Vulnerability classes | **8 of 8** | D1–D7 built and enforced; D8 delivered as a written discussion |
| §11 Report | This document | |
| §12 Evidence and attribution | Partly | Attribution automated. Client authorization reported received and recorded as a dated attestation (§10.1); the executed artifact is not yet attached to the repo |
| §13 Risk controls | Yes | All 4 risks implemented and enforced; authorization attested, counter-part to be filed |
| §15 Defensive outcomes | **Yes** | `docs/DEFENSIVE-OUTCOMES.md` — all 7 recommendations, each traced to a control actually exercised |

---

## 3. Reproduction

```sh
# Full verification, from a clean checkout
cd agent && ./gradlew :app:testDebugUnitTest :labapp:assembleDebug :toylab:assembleDebug
cd ../relay && npm ci && npm run all

# Bring up the isolated lab (Kali or Debian; no Cloudflare account needed)
./tools/lab/lab-up.sh

# Reset to a known-clean state
./tools/lab/reset.sh
```

---

## 4. Verified results

Produced by the runners below. Re-run any row to confirm it.

| # | Claim | Result | Runner |
|---|---|---|---|
| V1 | Agent unit tests | **4 passed** | `./agent/gradlew :app:testDebugUnitTest` |
| V2 | Relay end-to-end, including the post-hibernation `/devices` fix | **28 passed** | `node tools/e2e.mjs` |
| V3 | Console rendering, framing, and presenter camera | **32 passed** | `node tools/console-smoke.mjs` |
| V4 | Recording and playback determinism | **21 passed** | `node tools/record-smoke.mjs` |
| V5 | Telemetry schema, attribution, and alerting | **26 passed** | `node tools/lab-e2e.mjs` |
| V6 | The lab app holds only its documented permissions | **32 passed** | `node tools/permission-policy.mjs` |
| V7 | Each training flaw is present **and** none can leave the device | **30 passed** | `node tools/toy-policy.mjs` |
| V8 | Release APK is signed with v2 scheme | **pass** | `apksigner verify` in CI |
| | **Total** | **173 automated checks** | |

### The two results worth reading twice

**V6 — the lab app's safety claim is falsifiable.** The demonstration's central
claim is that the lab app cannot read the screen, inject touches, or restart
itself. `permission-policy.mjs` reads the *built* manifest and fails the build if
that claim stops being true. It was confirmed to have teeth by adding
`RECORD_AUDIO` to the manifest, rebuilding, and observing the check fail.

**V7 — the training targets are dangerous and harmless at the same time.**
Section 10 needs deliberately broken apps. An intentionally vulnerable app that
can reach the network is not a teaching aid, it is a liability. `toy-policy.mjs`
enforces two opposing properties: every declared flaw is still present (repairing
the trust manager turns the check red), and none of them can reach anything real
(loopback and `.invalid` URLs only, inline WebView content, a locally generated
dummy token, no dangerous permissions, no root, no shell-out).

---

## 5. Observed results

Partly filled. An **Android 14 / API 34 emulator** run is recorded below, and it
found six real defects — see `docs/DEVICE-RUN-FINDINGS.md`. The rows that need
*physical* hardware are still open, and an emulator cannot stand in for them.

| # | Observation | Evidence | Status |
|---|---|---|---|
| O1 | Landing page states the exercise is authorised, shows a server-issued session id | `LAB-2026-2C15A534` issued and bound to one device | **observed** |
| O2 | Each runtime permission prompt, captured as it appears | `Allow Lab Telemetry to send and view SMS messages?` | **observed** (SMS; one of four) |
| O3 | Cross-app read denied by the sandbox | Lab app's cross-app read refused without a grant | **observed** |
| O4 | SELinux `enforcing`, with the denial in audit logs | `Enforcing`, 36 `avc: denied` | **observed** |
| O5 | Verified Boot / `dm-verity` state | properties empty on an emulator **by design** | ☐ needs hardware |
| O6 | Web page cannot reach any content provider | | ☐ needs hardware |
| O7 | Play Protect flags the non-store package — and we do not evade it | Play Protect is absent from the emulator image | ☐ needs hardware |
| O8 | Session id reaches the dashboard, correlated to the device | `SESSION_START` → `PERMISSION_PROMPT` → `PERMISSION_GRANTED` → `SYNTHETIC_SMS_ACCESS`, all `TEST_ONLY` | **observed** |
| O9 | Teardown leaves no synthetic record behind | `SyntheticData.purge` + `tools/lab/reset.sh`, automated | **partly** — needs a device run |
| O10 | `dispatchGesture` injects touch on a real device | | ☐ needs hardware |

`tools/lab/collect-device-evidence.sh` gathers O3–O5 automatically where adb is
available, and prints the manual steps where it is not. It only runs read-only
queries; it changes nothing on the device.

**An emulator is not a substitute for the four hardware rows.** Verified boot has
no chain to report, Play Protect is not present in the image, and a screen
recording of a real `dispatchGesture` needs a real touchscreen. Those stay open
rather than being marked done on emulator evidence.

---

## 6. Not done, and why

> **Nothing in §6.3 is outstanding.** The remaining items in this section are
> hardware, or a scope decision that is the client's to make.

### 6.1 §7 Step 4 contradicts the rest of the proposal — **blocking**

Step 4 asks for monitoring that "bypasses" user action and runs "silently". This
directly contradicts §1 ("user consent must be the entry point"), §3 ("no
unauthorized access"), and §12 ("zero real personal data"). Both cannot be built.

**Delivered instead:** consented, visible, synthetic-only telemetry. The
`data_class: "TEST_ONLY"` gate is enforced **server-side**, so a modified client
cannot smuggle real data in — C5 rejects any other value and raises a critical
alert.

**Needed:** a written decision from AutomationX. Until then this is the single
largest open risk in the engagement, and it is a scope question, not an
engineering one.

### 6.2 Deliberately not built

| Excluded | Reason |
|---|---|
| Silent monitoring that bypasses user action | Contradicts §§1, 3, 12 — see 6.1 |
| Rooting or privilege escalation | §13 forbids it; a rooted device invalidates §5 B1/B3/B5 |
| Play Protect or security-feature evasion | §13 forbids evasion; it would also destroy the §5 B7 lesson |
| Any real-message, contact, media, or location collection | §12; the app is gated to synthetic data server-side |
| A real exfiltration endpoint | The training targets point at loopback or `.invalid` by design |
| Reading real data "just to prove it could" | The demonstration of over-collection is the *existing* Break Remote artifact (D6), which already holds the anti-pattern |

### 6.3 Engineering items — all closed

| Item | Resolution |
|---|---|
| `labapp` could not be pointed at anything | `RELAY_URL`, `LAB_AGENT_TOKEN` and `CONSOLE_TOKEN` now resolve from `keystore.properties` then the environment, using the same `secret()` convention as the main app. Verified by confirming the overridden literals appear in the compiled DEX and the defaults do not. |
| Weak-TLS target had no certificate to defeat | `relay/tools/lab-tls-endpoint.mjs` self-signs on loopback:8443. The cert's CN is `untrusted-training-endpoint.invalid`, which neither matches the address nor resolves — so **both** the trust-all manager and the permissive hostname verifier are required for the connection to succeed. CI asserts a validating client rejects it and an insecure one accepts it. |
| No synthetic SMS/contact seeding | `tools/lab/seed-synthetic.sh` stages the same `LABONLY-`-tagged records over adb so the app reads *real* provider records through the consent-gated path. The app's own `ContentResolver` insert still runs first and still falls back when the platform refuses. Nothing is bypassed. |
| D8 had no deliverable | `docs/D8-PATCHED-VULNERABILITIES.md`, framed around recurring patterns rather than dated CVE lists, citing no exploit code. |
| Authorization record unsigned | §12 attribution is unsatisfiable until signed | **needs client signature** |
| Synthetic SMS/contact seeding | A non-default app cannot write real SMS/contacts records. Seed via the emulator before the run, or present the in-memory dataset and say so. | **confirm with AutomationX** |
| Executed counter-signed authorization not attached | §12 attribution | **filing step** — the client's signature is reported received and attested in `lab/AUTHORIZATION.md` §10.1, but no signature is transcribed or forged. Attach the artifact. |
| No physical device | O1–O10 | **needs hardware** |

---

## 7. Sign-off

This report cannot be signed while §6.1 is open and while `lab/AUTHORIZATION.md`
is unsigned. Signing it would assert that a monitoring capability was delivered
which was deliberately not built.

| Role | Name | Date | Signature |
|---|---|---|---|
| AutomationX engineer | | | |
| Zion's EQB technical owner | | | |
| AutomationX approver | | | |

Once the scope decision in §6.1 is written down, the device run in §5 completes,
and `lab/AUTHORIZATION.md` is signed, this document can be filled in and signed
without further engineering work.
