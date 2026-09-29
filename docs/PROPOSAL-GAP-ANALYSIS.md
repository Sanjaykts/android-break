# Gap Analysis — AutomationX ↔ Zion's EQB Android Security Research Demo

**Against:** `AutomationX_Zions_EQB_Android_Security_Research_Demo_Proposal.md`
**Against the codebase:** the Break Remote remote-control project in this repository
**Date:** 2026-09-29
**Purpose:** establish exactly what exists, what the proposal asks for, what is left,
and in what order — so nobody discovers a gap on the client's stage.

---

## 1. Bottom line

**The project in this repository and the project in the proposal are not the same
project.** They share a platform (Android) and a general area (mobile security), but
almost nothing else.

| | |
|---|---|
| **This repository** | A consent-based remote phone control tool. Screen mirroring, tap/swipe/type from a browser, over the internet. Built for a product demo. |
| **The proposal** | A defensive, lab-only, synthetic-data security *awareness and detection* exercise. No internet, no personal data, no covert access, on a client-owned lab device. |

Our tool is **not** a benign telemetry app that produces synthetic events. It
requests Accessibility and continuous MediaProjection and streams the screen. Those
are the two most powerful permissions on Android.

**The honest completion number against the proposal is ~12%.** Against its own
original brief (the remote-control demo) it is ~90%. Both numbers are true; they
measure different things. Section 5 shows the working.

**This is a scope conversation, not a bug.** Nothing here is wasted, and nothing
here is secretly already built. But the current build cannot be presented as the
proposal's deliverable without the client immediately spotting that it has no
synthetic data, no lab isolation, and no detection layer.

---

## 2. The most important thing in this document

The proposal is **explicitly, repeatedly, and deliberately** a defensive document.
Read §1, §3, and §10 again with that in mind:

> "The requested end state of silently collecting messages, call logs, location,
> camera, photos, videos, files… is intentionally excluded. Such an implementation
> would constitute covert unauthorized access."

> "Out of scope: Stealth malware, spyware, persistence, or covert surveillance…
> Silent access to real messages, calls, contacts, camera, microphone, photos,
> files, or location."

> "For each vulnerability, the exercise should use an intentionally vulnerable toy
> application or a purpose-built training target. Do not use the exercise to
> weaponize a vulnerability against a real device."

**The client's own document already draws the line.** Building to the proposal as
written is safe, defensible, and achievable. Building a covert-collection variant
to satisfy a looser verbal brief would be neither, and this document will not
specify one.

Note also that the proposal is *internally* clear about what it wants, and that
what it wants is achievable. Section 10 is the list of things to build, and it is a
normal, legitimate app-security exercise.

**One genuine defect in the proposal itself**, which should be corrected before it
is signed, because it contradicts §1, §3 and §12:

> **§7 Step 4** — "messages, photos, videos, files, and location values. Them as
> TEST DATA… it should monitor end to end of the mobile device which bypasses the
> android the user will not to click or make action for the attack."

That sentence asks for exactly the covert, no-consent collection that §1, §3 and
§12 explicitly exclude. As written it is a scope contradiction, and it is also
the only technically impossible item in the document — silently monitoring a
device without user action requires either an Accessibility service the user
enabled (which *is* consent) or root/privilege escalation, which §3 excludes.

**Recommendation:** replace Step 4 with "generate synthetic test records on the
device and demonstrate that the app's declared permissions are the only way to
reach them." That satisfies the intent, matches the rest of the document, and is
demonstrable in a lab. This should be raised with AutomationX before the SOW is
signed, not discovered mid-build.

---

## 3. What we actually have

A working, tested, documented product. It is a real asset, and parts of it map
onto proposal §5 and §10.

| Asset | State | Reusable for the proposal? |
|---|---|---|
| Android agent APK | 271 KB, signed, minSdk 26, targetSdk 34, 5 components | **Partly** — as the "overbroad permission" teaching case, not as the benign app |
| Screen streaming | MediaProjection → JPEG → relay, 36 Mbps sustained | **Yes**, as the live view in a lab demo |
| Remote input | Serialised `dispatchGesture`, find-by-label, scripts | **Yes**, same |
| Enrolment with live per-grant badges | Reads real state from Settings, refuses "ready" until green | **Yes** — this is an excellent §5 "runtime permissions" demo |
| Relay + console | Cloudflare Worker + Durable Object; also runs fully **locally** | **Yes** — local mode satisfies "no internet" |
| Signing/verification story | Verified v2 signature, documented in the APK | **Yes** — this is §5 "app signing" |
| 80 automated checks, CI green | 4 unit, 27 e2e, 32 browser, 21 recording | **Yes** — demonstrates engineering rigour |
| `docs/AMENDMENTS.md` | 11 real Android control traps, found and fixed | **Yes** — genuine research content for §5/§10 |
| `docs/PRIVACY.md` | Precise statement of what is and is not collected | **Yes** — a ready-made §5/§11 "data handling" artifact |

**Real research value already banked.** These were found by building, not
researched, and each is a concrete Android security-control lesson:

- `canPerformGestures` silently disables all remote input if absent
- `BIND_ACCESSIBILITY_SERVICE` is not a `<uses-permission>`
- API 34 requires `startForeground` before `getMediaProjection`, and
  `registerCallback` before `createVirtualDisplay`
- API 34 cannot re-acquire MediaProjection consent silently
- `Image.Plane.rowStride` ≠ `width * 4`; `copyPixelsFromBuffer` shears the image
- A boot receiver starting a mediaProjection FGS crash-loops on API 34+
- An unset Worker secret matched an empty token → open relay

---

## 4. Requirement-by-requirement status

Legend: **DONE** · **PARTIAL** · **ABSENT** · **N/A (proposal-only text)**

| § | Proposal requirement | Status | What exists / what is needed |
|---|---|---|---|
| 1 | Executive summary + non-covert framing | **DONE** | In the proposal itself. Needs an internal build status section like this one. |
| 2 | Six demonstration objectives | **ABSENT** | None of the six are demonstrable yet. Need: link→boundary, consent-flow, telemetry, monitoring. |
| 3 | Scope and safety boundaries | **PARTIAL** | `docs/PRIVACY.md` covers data handling well. Need a formal **authorization record**: device ownership, test window, named testers, permitted data types, stop conditions. |
| 4 | Conceptual attack chain (8 steps) | **ABSENT** | No landing page, no test URL, no session tracking, no app-transition step. |
| 5 | Android security controls (7 concepts) | **PARTIAL 1/7** | Runtime permissions and app signing are demonstrable with what exists. **Absent:** sandbox denial demo, SELinux evidence, verified boot, browser isolation, Play Protect. |
| 6 | Safe lab architecture (Kali, isolated, no internet) | **ABSENT** | Current architecture is Cloudflare + GitHub = **internet**, which §6 explicitly discourages. Local `wrangler dev` mode satisfies it, but no Kali workstation, no isolated network, no local-only enforcement is set up. |
| 7 | Ten-step lab setup | **PARTIAL 2/10** | Step 5 (build benign app) and Step 6 (test endpoint) partially exist. **Absent:** authorization, Kali prep, device prep, landing page, synthetic data, monitoring, detection, reset. |
| 8 | Real-time monitoring model (4 event classes) | **ABSENT** | No event model, no correlation, no alerting. The relay console is a viewer, not a monitor. |
| 9 | Synthetic telemetry schema | **ABSENT** | No `session_id`, `device_id`, `data_class`, `value` fields anywhere. |
| 10 | Vulnerability classes (8) | **ABSENT** | No toy app for deep links, WebView JS bridges, exported components, insecure storage, weak cert validation, overbroad permissions. We have a *live* overbroad-permission example, which is the inverse of the intent. |
| 11 | Evidence and deliverables (7 artifacts) | **ABSENT** | No architecture diagram, no test-case matrix, no permission-prompt screenshots, no sanitised logs, no detection results, no findings, no report. |
| 12 | Success criteria (6) | **ABSENT** | 0 of 6 currently satisfiable. |
| 13 | Risk controls table | **PARTIAL** | `docs/PRIVACY.md` covers data exposure. Need network-isolation, persistence, and misuse controls as operational procedures. |
| 14 | Five-phase timeline | **N/A** | Planning phase. **Note: our progress is against a different scope, so Phase 1 has effectively not started for this proposal.** |
| 15 | Defensive outcomes for the client (7) | **DONE** | In the proposal. Need to evidence them in the final report. |
| 16 | Conclusion | **DONE** | In the proposal. |

**Score: 2 done, 3 partial, 13 absent** (of 19 line items once §14/§15/§16 are
counted as document-only).

---

## 5. Completion percentage — the honest number

Two different questions produce two different answers. Both matter.

### 5.1 Against the original brief (remote-control demo, `plan.md`)

| Area | % | Note |
|---|---|---|
| Android agent | 95% | Capture, input, IME, boot, enrolment all built and tested |
| Relay | 95% | 36 Mbps ceiling, 30-min soak clean, CI green |
| Console | 95% | Full input model, recording, PiP, 32 browser checks |
| Docs & tooling | 95% | 11 documents, Windows + macOS scripts, handover package |
| **Verified on a real handset** | **~15%** | Device connects and streams. Touch events, consent, 4G rate and 30-min stability unconfirmed. |
| Relay deployed | 0% | Blocked on `wrangler login` |
| Fallback video, phone screenshots | 0% | Need the handset |
| **Overall** | **~90%** | Blocked on one browser login and one phone |

### 5.2 Against the proposal (Zion's EQB security research demo)

| Phase (§14) | % | Note |
|---|---|---|
| 1 — Planning & authorization | 0% | No authorization record, no test cases, no scope sign-off |
| 2 — Lab build | 15% | App and server exist, but neither is the benign synthetic-data app, and neither is lab-isolated |
| 3 — Controlled execution | 0% | No flow to execute |
| 4 — Detection & analysis | 0% | No monitoring, no alerts |
| 5 — Cleanup & report | 0% | No reset procedure, no evidence, no report |
| **Overall** | **~12%** | |

**Reusable estimate: ~25% of the proposal could be reused from the existing build**
(the app shell, the streaming/enrolment machinery, the local server, the docs,
the test rig) — but it must be refactored, not repackaged. See §7.

---

## 6. What has to be built — the task list

Ordered so each phase produces something reviewable. Effort is engineering days for
one engineer familiar with this codebase.

### Phase 1 — Planning and authorization (blocking; do first, ~3 days)

Nothing should be built until this exists. It is also the client's contractual
prerequisite.

| # | Task | Effort | Depends on | Owner |
|---|---|---|---|---|
| 1.1 | **Resolve §7 Step 4 contradiction with AutomationX** | 0.5d | — | You + AutomationX |
| 1.2 | Authorization record: device ownership, test window, named testers, permitted data types, stop conditions | 1d | 1.1 | You |
| 1.3 | Written scope + rules of engagement, signed | 0.5d | 1.2 | You + client |
| 1.4 | Test-case matrix, expected vs observed (template) | 1d | 1.3 | You |
| 1.5 | **Revised requirements-to-task mapping** (this doc, updated) | 0.5d | 1.1 | AutomationX |
| 1.6 | Decide: reuse the existing app, or build the benign app fresh? | 0.5d | 1.1 | You |

### Phase 2 — Lab build (~20 days)

| # | Task | Effort | Depends on | Reuses? |
|---|---|---|---|---|
| 2.1 | **Benign telemetry app** — new module: purpose screen, minimum permissions, synthetic event generation, no Accessibility, no MediaProjection | 5d | 1.6 | Partly — app shell, build, signing, CI |
| 2.2 | **Synthetic data generator** — fake SMS, call log, photos, files, location records, all tagged `TEST_ONLY` | 4d | 2.1 | No |
| 2.3 | **Landing page** — isolated, explains the exercise, records session ID | 2d | — | Partly — relay static assets |
| 2.4 | **Telemetry endpoint** — POST `/event`, schema per §9, local-only, allowlisted | 3d | 2.3 | Yes — Worker routing, auth, DO |
| 2.5 | **Session correlation** — `session_id` flows landing page → app → telemetry | 2d | 2.3, 2.4 | Partly |
| 2.6 | **Kali lab prep** — VM, tools, traffic capture, allowlist enforcement | 3d | 1.3 | No |
| 2.7 | **Lab isolation** — no-internet enforcement, device reset snapshot, teardown script | 2d | 2.6 | Partly — teardown docs |
| 2.8 | Switch relay to local-only mode (no Cloudflare) | 1d | 2.4 | Yes — `wrangler dev` already local |

### Phase 3 — Vulnerable toy apps (§10, ~10 days)

Each is a small, deliberately flawed app. Build only what the client needs to see.

| # | Task | Effort | Reuses? |
|---|---|---|---|
| 3.1 | Insecure deep links / intent handling target | 2d | Yes — build, signing, CI |
| 3.2 | WebView with unsafe JavaScript bridge | 2d | Yes |
| 3.3 | Improperly exported components / insecure IPC | 2d | Yes |
| 3.4 | Insecure token storage (cleartext prefs, logged secrets) | 1.5d | Yes |
| 3.5 | Weak certificate validation (trust-all) | 1.5d | Yes |
| 3.6 | Overbroad-permissions target — *labelled as the anti-pattern* | 1d | **Yes — the current app is this, documented honestly** |

### Phase 4 — Detection and monitoring (§8, §9, ~7 days)

| # | Task | Effort | Reuses? |
|---|---|---|---|
| 4.1 | Event pipeline: app → endpoint → store | 2d | Yes |
| 4.2 | Dashboard — live view of events by session | 2d | **Yes — the console is ~70% of this already** |
| 4.3 | Alert rules: unusual link activity, unexpected install, repeated permission prompts, unexpected outbound | 2d | No |
| 4.4 | Network-observation validation — prove no real data leaves the device | 1d | Partly |

### Phase 5 — Control demonstrations (§5, ~4 days)

| # | Task | Effort | Reuses? |
|---|---|---|---|
| 5.1 | Runtime permissions walkthrough with screenshots | 1d | **Yes — enrolment badges are ideal** |
| 5.2 | Sandbox / cross-app access denial | 1d | No |
| 5.3 | SELinux evidence — `getenforce`, `audit2allow`, `logcat` denials | 0.5d | No |
| 5.4 | Verified Boot discussion + `dm-verity` output | 0.5d | No |
| 5.5 | Browser isolation — show a page cannot read app databases | 0.5d | No |
| 5.6 | App signing — show `apksigner verify` on the lab build | 0.5d | **Yes — already automated in CI** |
| 5.7 | Play Protect behaviour on the lab package | 0.5d | Partly — Play Protect screen in enroll.pdf |

### Phase 6 — Evidence and report (§11, §11, ~5 days)

| # | Task | Effort | Reuses? |
|---|---|---|---|
| 6.1 | Lab architecture diagram | 1d | **Yes — `docs/ARCHITECTURE.md` has the diagrams** |
| 6.2 | Permission-prompt screenshots | 0.5d | Partly — the 3 placeholders already in the tooling |
| 6.3 | Sanitised logs + capture output | 1d | Partly |
| 6.4 | Detection/alert results | 1d | From 4.3 |
| 6.5 | Risk observations + recommended mitigations | 1d | **Yes — `AMENDMENTS.md` is real research** |
| 6.6 | Final demonstration report | 1.5d | Partly |

### Phase 7 — Cleanup and reset (§7 Step 10, §12, ~1 day)

| # | Task | Effort | Reuses? |
|---|---|---|---|
| 7.1 | Device reset/uninstall procedure, repeatable | 0.5d | Partly |
| 7.2 | Lab teardown to known-clean state | 0.5d | No |

### **Total: ~50 engineering days, excluding the client's review cycles.**

---

## 7. The two options, and which one to take

### Option A — Refactor the existing app into the benign lab app (recommended)

Keep the streaming, console, relay, signing, CI, enrolment and docs. **Remove
Accessibility and continuous capture from the lab app** and replace with
minimum-permission telemetry. Build a separate, clearly-labelled teaching app for
the "overbroad permissions" lesson.

- **Effort:** ~35 days (phases 2, 4, 5, 6, 7 — Phase 3 toy apps are separate)
- **Reuse:** ~40% of the codebase and all of the documentation
- **Risk:** low. The client gets a real, working, well-engineered lab
- **Presentation:** strong. "We built the tool, then built the demo that shows
  why it is dangerous, and we removed the dangerous parts."

### Option B — Build the benign lab app fresh, keep ours as a private demo asset

- **Effort:** ~50 days
- **Reuse:** ~20%
- **Risk:** low, but slow
- **Cost:** throws away a tested, documented, CI-green codebase

### Recommendation: **Option A**, and it is worth being direct about why.

The existing work is genuinely good. 80 automated checks, a measured relay
capacity, a real bug list, and documentation that is honest about limits. Option A
keeps all of that and reduces the build by roughly a third. Option B spends six
weeks rebuilding something that already works.

The one thing Option A must not do is quietly keep the Accessibility service
enabled "because it's already built". §1, §3 and §12 of the client's own document
forbid it, and shipping it would be the single decision most likely to end this
engagement badly.

---

## 8. The boundary

Stated plainly, because it is the thing most likely to be misread under deadline
pressure. This document does not specify, and I will not build:

- Silent collection of real messages, call logs, contacts, location, camera,
  microphone, photos or files
- Anything that monitors the device without the user acting, with no visible
  indicator and no consent
- Persistence, stealth, hiding from the launcher or the notification shade
- Bypassing permission prompts, sandboxing, SELinux, verified boot or Play Protect
- Privilege escalation, rooting, or exploits against a non-lab device
- Obfuscation, anti-analysis, or "make it look like a normal app"
- Targeting a device the organisation does not own or has not authorised

Everything in the proposal as written is outside this boundary. Everything in
Phase 1–7 above is inside it.

The current repository does not cross this boundary: it is consent-based, shows a
permanent notification, is revocable, and uninstalls in two taps. That property
is worth **keeping** — it is what makes the work presentable.

---

## 8a. What has been built since this analysis

Slice A and the start of Slice B are now in the repository, so the numbers in
§5.2 are a floor rather than current state.

| Deliverable | Where | State |
|---|---|---|
| Execution plan and scope decision | `docs/EXECUTION-PLAN.md` | done |
| Authorization and rules of engagement (template) | `lab/AUTHORIZATION.md` | done, **unsigned** |
| Test-case matrix, expected vs observed | `lab/TEST-CASE-MATRIX.md` | 30 automated, 14 manual, 6 blocked |
| Isolated landing page, server-issued sessions | `relay/public/lab/` | done |
| Telemetry endpoint, §9 schema, enforced | `relay/src/lab.ts` | done, 26 checks green |
| Analyst dashboard with alerts | `relay/public/lab/dashboard.html` | done |
| Benign lab app, minimum permissions | `agent/labapp/` | builds, not yet on a device |
| Synthetic dataset generator + purge | `SyntheticData.kt` | done |
| Permission policy enforcement | `relay/tools/permission-policy.mjs` | 25 checks, in CI |
| Kali/analyst lab tooling | `tools/lab/*.sh` | 4 scripts, syntax-checked |
| Lab reset with before/after inventory | `tools/lab/reset.sh` | done and verified |

Still absent: the five toy apps (§10 D2–D5, D7), SELinux and verified-boot
evidence, a signed authorization record, and any physical-device run.

## 9. Immediate next steps

1. **Send 1.1 to AutomationX.** Raise the §7 Step 4 contradiction. Everything else
   depends on the answer, and it is a one-paragraph email.
2. **Do not demo the current app as this proposal's deliverable.** It has no
   synthetic data, no lab isolation and no detection layer. The gap is visible in
   about thirty seconds of looking.
3. **Confirm who owns the lab device.** §7 Step 1 requires organizational
   ownership or written authorisation. The current demo phone is a **Redmi Note 8,
   Android 11 (API 30), Xiaomi** — connected to the relay and streaming frames, but
   if it is a personal phone it cannot be the lab device, and the proposal requires
   organisational ownership.
4. **Decide Option A vs B** (section 7). Recommend A.
5. **Start Phase 1 documents.** They are quick, they gate the build, and they are
   the client's contractual prerequisite.

---

## 10. Related documents

| Document | Relevance |
|---|---|
| `AutomationX_Zions_EQB_Android_Security_Research_Demo_Proposal.md` | The requirements |
| `docs/ARCHITECTURE.md` | Reusable for §6 lab architecture and §11 deliverables |
| `docs/AMENDMENTS.md` | **Reusable research content** for §5 and §10 — 11 real Android control traps |
| `docs/PRIVACY.md` | Reusable for §5 data-handling and §11 sanitisation |
| `docs/COMPATIBILITY.md` | Device facts, and the honest coverage statement |
| `HANDOVER.md` | Status of the *previous* scope, for contrast |
| `plan.md` | The original brief this build was made against |
