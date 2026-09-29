# Test-case matrix

**Engagement:** Android Security Research & Controlled Monitoring Demonstration
**Client:** Zion's EQB Pvt Ltd · **Vendor:** AutomationX

Status key: **AUTOMATED** (a script asserts it) · **MANUAL** (a human observes and
records) · **BLOCKED** (needs a device, an emulator, or a decision)

Every row is attributable to a lab session (`lab/AUTHORIZATION.md` §1). A row
marked BLOCKED is not a failure — it is a known gap, recorded so that nobody
mistakes it for a passing test.

---

## A. Proposal section 4 — attack chain

| # | Step | Expected | Observed | How it is checked | Status |
|---|---|---|---|---|---|
| A1 | Delivery of a test URL to a lab device | URL is delivered; only the lab domain is contacted | | analyst records | MANUAL |
| A2 | Landing page loads | Page states it is an authorised exercise; a server-issued session id appears | | `relay/public/lab/` + `POST /lab/session` | **AUTOMATED** |
| A3 | Session id is server-issued and unforgeable | Device cannot invent a session id | Client has no session-issuing code path | `claimSession` in `relay/src/lab.ts` | **AUTOMATED** |
| A4 | App transition (link to signed test app) | Install is deliberate, via a labelled link | | analyst records | MANUAL |
| A5 | Permission boundary | Android shows its normal consent UI; nothing is granted silently | Prompt appears per permission, one at a time | `labapp` `permissionRow` | MANUAL |
| A6 | Synthetic data generated | Records exist and are prefixed `LABONLY-` | | `SyntheticData.seed*` | **AUTOMATED** |
| A7 | Real-time telemetry | Events arrive at the dashboard, correlated to the session | | `POST /lab/event` → `/lab/sessions` | **AUTOMATED** |
| A8 | Detection | Alerts fire on the §7.9 conditions | | `evaluateAlerts` in `relay/src/lab.ts` | **AUTOMATED** |
| A9 | Response / teardown | App uninstalled, synthetic data gone, device clean | | `SyntheticData.purge` + `tools/lab/reset.sh` | **AUTOMATED** |

---

## B. Proposal section 5 — Android security controls

| # | Control | Expected behaviour | What we demonstrate | Status |
|---|---|---|---|---|
| B1 | Application sandbox | A direct read of another app's private data is denied | Attempt to read the SMS provider from a context with no grant; `SecurityException` captured | MANUAL |
| B2 | Runtime permissions | Each sensitive read requires an explicit grant | Four permissions requested individually; the read fails until granted, then succeeds | **AUTOMATED** (server side) + MANUAL (prompt capture) |
| B3 | SELinux | Denied operations appear in audit logs | `getenforce`, `logcat -b all \| grep avc`, `audit2allow` | MANUAL — `tools/lab/collect-device-evidence.sh` |
| B4 | App signing | Signature verifies; a modified APK does not install as an update | `apksigner verify` in CI; documented install-time failure | **AUTOMATED** |
| B5 | Verified boot | Tampering with system partitions is out of scope and detectable | `dm-verity` status, `getprop ro.boot.verifiedbootstate` | MANUAL — `tools/lab/collect-device-evidence.sh` |
| B6 | Browser isolation | A web page cannot read app databases | Show the page failing to reach any content provider | MANUAL |
| B7 | Play Protect / platform defences | A non-Play-Store package is flagged; we do not evade it | Record Play Protect's own warning during install | MANUAL |
| B8 | Overbroad permissions (the §10 anti-pattern) | Two apps, deliberately opposite permission sets, compared side by side | `labapp` vs the Break Remote teaching artifact | **AUTOMATED** — `relay/tools/permission-policy.mjs` (32 checks) |
| B9 | The consented read is real, not decorative | Denying the permission genuinely changes the result | `SyntheticData.consentedLocation` performs a real last-known-location read when granted, and returns the fixed lab coordinate when denied or revoked | **AUTOMATED** (code path) + MANUAL (prompt capture) |

---

## C. Proposal section 9 — telemetry schema

| # | Check | Expected | Status |
|---|---|---|---|
| C1 | `session_id` present and server-issued | rejected with 422 if absent | **AUTOMATED** |
| C2 | `device_id` present | rejected if absent | **AUTOMATED** |
| C3 | `event` is a known type | unknown types rejected — the device cannot inject arbitrary evidence | **AUTOMATED** |
| C4 | `timestamp` ISO-8601 and plausible | rejected if unparseable or >7 days out | **AUTOMATED** |
| C5 | `data_class` is exactly `TEST_ONLY` | **any other value is rejected and raises a critical alert** | **AUTOMATED** |
| C6 | `value` bounded | rejected over 200 chars | **AUTOMATED** |
| C7 | Only the agent token may write | unauthenticated ingest is 401 | **AUTOMATED** |
| C8 | A session id belongs to exactly one device | second device posting into it is 409 | **AUTOMATED** |

C5 and C8 together are what make proposal §12's "no real personal data" and "all
events attributable to a session" verifiable rather than asserted.

---

## D. Proposal section 10 — vulnerability classes

| # | Class | Target | Status |
|---|---|---|---|
| D1 | Social engineering / malicious-link delivery | the landing page flow | flow built; **narrative manual** |
| D2 | Insecure deep links / intent handling | `toylab/DeepLinkDemo.kt` | **AUTOMATED** — built; flaw presence enforced by `relay/tools/toy-policy.mjs` |
| D3 | WebView misconfiguration / unsafe JS bridge | `toylab/WebViewBridgeDemo.kt` | **AUTOMATED** — built; flaw presence enforced |
| D4 | Improperly exported components / insecure IPC | `toylab/ExportedComponentDemo.kt` | **AUTOMATED** — built; flaw presence enforced |
| D5 | Insecure storage of tokens or sensitive data | `toylab/InsecureStorageDemo.kt` | **AUTOMATED** — built; flaw presence enforced |
| D6 | Overbroad permissions / excessive collection | the Break Remote teaching artifact | **AUTOMATED** — built, and the comparison is enforced |
| D7 | Insecure network communication / weak certificate validation | `toylab/WeakTlsDemo.kt` + `relay/tools/lab-tls-endpoint.mjs` | **AUTOMATED** — built, and the flaw is now *observable*: a validating client rejects the self-signed cert while the target accepts it |
| D8 | Known patched vulnerabilities and update importance | `docs/D8-PATCHED-VULNERABILITIES.md` | **DELIVERED** — written discussion, public advisories only, no exploit code |

D2–D5 and D7 are five small deliberately-flawed apps, and they are the highest-value
part of §10. `relay/tools/toy-policy.mjs` enforces **two opposing properties** at
once, because either one alone would be worthless:

- **The flaw is still present.** A training target that accidentally does the right
  thing teaches nothing, and the demonstration quietly becomes a lie. The check
  fails if a flaw is ever "fixed" — verified by deliberately repairing the trust
  manager and confirming the check goes red.
- **The flaw is inert.** A live insecure-TLS or WebView-bridge bug on a real
  device is a liability to whoever installs it. The check enforces that the targets
  hold no dangerous permission, no root path, no shell-out, and that the only URLs
  in the whole module are loopback (`127.0.0.1`) or the RFC 2606 `.invalid` TLD,
  which can never resolve. The WebView loads inline HTML, never `loadUrl`. The
  token written to cleartext storage is a locally generated dummy.

What is deliberately **not** covered, per scope:

| Not built | Why |
|---|---|
| Silent monitoring that bypasses user action | Contradicts proposal §§1, 3 and 12, and §7 Step 4 contradicts them. Needs AutomationX's decision. |
| Rooting, rooting-detection evasion, Play Protect bypass | §13 forbids evasion; a demo that dodges platform defences cannot then teach §5 B7. |
| A real-world exfiltration target | The teaching targets point at loopback or `.invalid` on purpose. |

D8 is a written deliverable rather than code. It is framed around recurring
*patterns* rather than a list of CVE numbers, because a specific advisory is dated
the moment a client reads it while the pattern keeps applying. It cites no
exploit code and asserts no particular device is vulnerable.

---

## E. Proposal section 6 — lab architecture

| # | Requirement | Status |
|---|---|---|
| E1 | Telemetry server on an isolated network, not the internet | **AUTOMATED** — `wrangler dev` is local; no Cloudflare account needed |
| E2 | Allowlisted destinations only | **AUTOMATED** — `tools/lab/allowlist.sh` + firewall rules |
| E3 | No external DNS during the exercise | MANUAL — `tools/lab/lab-up.sh` documents it |
| E4 | Packet capture available as evidence | **AUTOMATED** — `tools/lab/capture.sh` |
| E5 | Analyst workstation tooling | **AUTOMATED** — `tools/lab/`, Kali-compatible, no exotic dependencies |

---

## F. Proposal section 13 — risk controls

| # | Risk | Control | Status |
|---|---|---|---|
| F1 | Accidental exposure of personal data | Synthetic-only, enforced server-side, `data_class` gate | **AUTOMATED** (C5) |
| F2 | Unintended internet communication | Isolated network + allowlist | **AUTOMATED** (E2) |
| F3 | Persistence beyond the test | No boot receiver, no services, enforced by policy check | **AUTOMATED** (B8) |
| F4 | Misuse of tooling | Authorised testers, documented scope | **BLOCKED** — `lab/AUTHORIZATION.md` unsigned |
| F5 | Evidence tampering | Session attribution + server-side validation | **AUTOMATED** (C8) |

---

## G. Known gaps, stated plainly

| Gap | Impact | Fix |
|---|---|---|
| §7 Step 4 contradiction | Scope ambiguity | Resolve with AutomationX — **blocking** |
| Authorization record unsigned | §12 attribution criterion unsatisfiable | Sign before the lab build |
| No physical device test | The one thing automation cannot prove | Lab device per `lab/AUTHORIZATION.md` §1; `tools/lab/collect-device-evidence.sh` gathers the evidence |
| SELinux / verified boot / browser-isolation / Play Protect evidence | §5 B3, B5, B6, B7 | Needs a device; collection tooling now exists |
| Synthetic SMS and contact seeding | §7 steps 5–6 | **CLOSED, both paths available.** The app attempts a `ContentResolver` insert and falls back to an in-app dataset when the platform refuses; `tools/lab/seed-synthetic.sh` stages the same `LABONLY-`-tagged records over adb so the app can *read* real provider records through the consent-gated path. Nothing is bypassed. |
| Weak-TLS target is not reachable over TLS | §10 D7 demonstration | `WeakTlsDemo` points at `https://127.0.0.1:8787`, but the local lab server runs plain HTTP over `wrangler dev`. Add a self-signed local TLS endpoint so the acceptance is actually observable. **Outstanding.** |
| No final report | §11 | `docs/REPORT.md` is a prefilled template; the results table cannot be completed without a device run |

**Summary: 166 automated checks — 4 Android unit, 28 relay, 32 console/browser,
21 recording, 26 lab telemetry, 32 permission policy, 23 training-target policy —
plus 15 manual, 5 blocked, and 1 blocking scope question.**

Re-derive rather than trusting the line above:

```sh
./agent/gradlew --project-dir agent :app:testDebugUnitTest   # 4   Android unit
cd relay && npm run e2e                                     # 28  relay
node tools/console-smoke.mjs                                 # 32  console/browser
node tools/record-smoke.mjs                                  # 21  recording
node tools/lab-e2e.mjs                                       # 26  lab telemetry
node tools/permission-policy.mjs                             # 32  lab permission policy
node tools/toy-policy.mjs                                    # 23  training-target policy
```

`npm run all` in `relay/` chains the relay-side runners, ending with the two
policy checks.
