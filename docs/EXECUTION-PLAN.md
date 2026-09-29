# Execution Plan — Zion's EQB Android Security Research Demo

**Build target:** `AutomationX_Zions_EQB_Android_Security_Research_Demo_Proposal.md`
**Status of this document:** the authoritative build plan. `docs/PROPOSAL-GAP-ANALYSIS.md`
explains *why* the scope is what it is; this explains *what we build and in what order*.
**Working assumption:** completion by the next full working week, with a scoped
subset deliverable first (see §3).

---

## 1. Scope decision, made explicitly

The proposal is internally inconsistent in one place. §7 Step 4 asks for monitoring
"which bypasses the android the user will not to click", which §1, §3 and §12
explicitly exclude, and which is not technically possible without root.

**We build to the proposal minus that one sentence.** Specifically:

| §7 Step 4 asks for | We build |
|---|---|
| Silent end-to-end monitoring with no user action | Synthetic records generated on-device, read back **through the app's own declared permissions**, with the permission prompt visible and captured as evidence |
| "monitor end to end … which bypasses the android" | Every read goes through a runtime permission the user grants on camera, with the prompt screenshotted as §11 evidence |

Everything else in the proposal is unambiguous and gets built as written.

**Consequence for the existing codebase.** `Break Remote` (this repository's
current app) requests Accessibility and continuous MediaProjection. That is
precisely the overbroad-permission anti-pattern §10 asks us to teach. It is
therefore **not** the lab app. It becomes a **separately-labelled teaching
artifact** used in one demo beat. The lab app gets its own package id, its own
permission set, and no Accessibility service.

This is a deliberate design decision, not a limitation, and it is stated in the
demo narration.

---

## 2. Architecture

```
  ┌──────────────┐   landing page (isolated)          ┌─────────────────────────┐
  │ Lab device   │──────────────────────────────────▶│ Local telemetry server  │
  │              │   session id handshake            │                         │
  │ labapp       │   POST /lab/event (TEST_ONLY)     │  - /lab landing page    │
  │  minimal     │──────────────────────────────────▶│  - /lab/event ingest    │
  │  perms +     │   synthetic reads, all consented  │  - /lab/dashboard        │
  │  synthetic   │                                   │  - /lab/sessions         │
  │  dataset     │                                   │                         │
  └──────────────┘                                   └─────────────────────────┘
         │                                                      ▲
         │ screen / logs (opt-in, visible)                     │
         ▼                                                      │
  ┌──────────────────────────────────────────────────────────────┴──┐
  │ Analyst workstation: traffic capture, Android logs, correlation │
  └──────────────────────────────────────────────────────────────────┘
```

**Everything is local.** The telemetry server runs from `wrangler dev`, which
already works offline. No Cloudflare account, no GitHub, no internet — satisfying
§6. The existing relay is reused for its routing, auth and Durable Object
patterns, then extended with the lab routes.

**Data flow is one-way and inspectable.** Device → local server. The analyst
workstation observes. Nothing returns to the device. This is what makes §8's
"network event" and §12's "no real personal data" criteria provable rather than
asserted.

---

## 3. Delivery slices

### Slice A — "Scoping ready" (the subset deliverable)

The fastest path to something a client can review. Every item is a prerequisite
for the rest anyway, so nothing is thrown away.

| # | Deliverable | Proposal § | Status |
|---|---|---|---|
| A1 | Authorization & scope record | §7.1, §3, §13 | **this document set** |
| A2 | Test-case matrix, expected vs observed | §11 | **template + first rows** |
| A3 | Isolated landing page with session id | §4.1–4.2 | `relay/public/lab/` |
| A4 | Telemetry endpoint, §9 schema | §8, §9 | `relay/src/lab.ts` |
| A5 | Session dashboard | §8, §11 | `relay/public/lab/dashboard` |
| A6 | Lab reset/teardown procedure | §7.10, §12 | `tools/lab/` |

### Slice B — "Lab app"

| # | Deliverable | Proposal § |
|---|---|---|
| B1 | `labapp` Android module: purpose screen, minimum permissions | §7.5 |
| B2 | Synthetic dataset generator, all records `TEST_ONLY` | §4.5, §7.4 |
| B3 | Consented-read flow, permission prompts captured | §5 runtime permissions |
| B4 | Telemetry client with the §9 schema | §8 |
| B5 | Synthetic photo/file assets on device | §4.5 |

### Slice C — "Controls and detection"

| # | Deliverable | Proposal § |
|---|---|---|
| C1 | Android control demonstrations + evidence capture | §5 (all 7) |
| C2 | Toy targets: deep links, WebView bridge, exported components | §10 |
| C3 | Toy targets: insecure storage, weak TLS validation | §10 |
| C4 | Alert rules on the dashboard | §8, §7.9 |
| C5 | Traffic-capture validation, prove no real data egress | §11 |

### Slice D — "Evidence"

| # | Deliverable | Proposal § |
|---|---|---|
| D1 | Lab architecture diagram | §11 |
| D2 | Screenshots of every permission/security prompt | §11 |
| D3 | Sanitised logs | §11 |
| D4 | Detection results | §11 |
| D5 | Risk observations + mitigations | §11, §15 |
| D6 | Final demonstration report | §11 |

---

## 4. Build order and dependencies

```
A1 ──▶ A2 ──▶ B1 ──▶ B2 ──▶ B3 ──▶ A4 ──▶ B4 ──▶ A5 ──▶ C4
                  │                    ▲
                  └──▶ A3 ────────────┘
                                    C1 ──▶ D1..D6
              A6 ──▶ (every demo run ends with a reset)
C2, C3 run in parallel from B1 once the build pipeline is proven.
```

**A4 (telemetry endpoint) is on the critical path** and can be built before the
app exists, because it is testable with `curl`. That means the analyst can build
and verify the whole server half while the app half is still in progress.

---

## 5. Permission model — the core teaching artefact

This table is the demo's most valuable single asset. It is enforced in code, not
in a comment.

| Permission | Lab app | Break Remote (teaching artifact) | Why the difference matters |
|---|---|---|---|
| `INTERNET` | yes | yes | Both are lab apps with a server |
| `ACCESS_NETWORK_STATE` | yes | yes | Connection-type telemetry |
| `POST_NOTIFICATIONS` (33+) | yes | yes | Telemetry must be visible, never silent |
| `READ_SMS` (synthetic only) | **runtime, user-granted** | **never** | §5 runtime permissions; the prompt is the evidence |
| `READ_CONTACTS` (synthetic only) | **runtime, user-granted** | **never** | as above |
| `ACCESS_MEDIA_LOCATION` | **runtime, user-granted** | **never** | as above |
| `READ_EXTERNAL_STORAGE` | **runtime, user-granted** | **never** | as above |
| `RECORD_AUDIO` | **never** | **never** | §3 excludes microphone |
| `CAMERA` | **never** | **never** | §3 excludes camera |
| `BIND_ACCESSIBILITY_SERVICE` | **never** | yes | **The anti-pattern being taught** |
| `FOREGROUND_SERVICE_MEDIA_PROJECTION` | **never** | yes | **The anti-pattern being taught** |
| `RECEIVE_BOOT_COMPLETED` | **never** | yes | persistence, excluded by §3 |

**The lab app cannot see the screen, cannot inject touches, and cannot restart
itself.** If those capabilities are ever added to it, the demo is no longer the
demo.

---

## 6. Synthetic data rules

Non-negotiable, because §12 success criterion 2 is "no real personal data is
collected or transmitted" and it must be provable, not asserted.

1. Every synthetic record carries `data_class: "TEST_ONLY"`.
2. Synthetic files are written to the app's **own** external files directory,
   never to shared storage that could mix with real user data.
3. No synthetic generator reads anything the user did not explicitly create for
   the lab.
4. Every telemetry payload is validated server-side against the §9 schema; a
   payload without `data_class: "TEST_ONLY"` is rejected and logged as a control
   failure. This is an alert rule, not a comment.
5. Session ids are generated server-side and issued to the device; the device
   cannot invent one, so events cannot be attributed to a fabricated session.

---

## 7. Stop conditions

From §13. These are checked by the teardown script, not left to memory.

| Trigger | Action |
|---|---|
| Any real personal data appears in a payload or log | Stop immediately, capture the evidence of *why*, then wipe |
| Any outbound connection to a non-allowlisted destination | Block, record, stop |
| Any event lacking a valid session id | Reject, alert, investigate attribution |
| Test window expires | Terminate, reset, archive |
| Activity moves outside the written scope | Stop, escalate to the engagement lead |

---

## 8. Definition of done

1. A fresh lab device goes from install to first telemetry event in under 5
   minutes, using only the runbook.
2. Every one of the seven §5 controls has a captured artefact.
3. Every one of the eight §10 classes has either a target app or a written
   decision not to build one.
4. The dashboard shows a live session, correlated, with alerts firing on the
   §7.9 conditions.
5. `tools/lab/reset.sh` returns the device to a known-clean state, verified by a
   before/after inventory.
6. No real personal data appears anywhere in the evidence pack. Verified, not
   assumed.
7. The reset procedure is run and shown at the end of the demo.

---

## 9. What is deliberately not built

Restating §1 of `docs/PROPOSAL-GAP-ANALYSIS.md` here so it is in the build
document, not only the analysis:

- Silent collection of real messages, call logs, contacts, location, camera,
  microphone, photos or files
- Monitoring that operates without the user acting and without a visible
  indicator
- Persistence, stealth, launcher hiding, or notification suppression
- Bypassing permission prompts, sandboxing, SELinux, verified boot or Play Protect
- Root, privilege escalation, or exploits against a non-lab device
- Obfuscation or anti-analysis

The proposal as written requires none of these. If a future requirement appears
to need one, that is a scope change to be raised in writing, not a build decision.
