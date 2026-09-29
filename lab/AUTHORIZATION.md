# Authorization and Rules of Engagement

**Engagement:** Android Security Research & Controlled Monitoring Demonstration
**Client:** Zion's EQB Pvt Ltd
**Vendor:** AutomationX

> **This is a template with the fields left blank on purpose.** It is a legal and
> contractual artefact. AutomationX must complete every bracketed field and both
> parties must sign it **before** any lab build begins. Do not treat it as
> paperwork to be filled in at the end.
>
> Proposal §7 Step 1 requires exactly this, and §12 makes "all test events are
> attributable to a laboratory session" a success criterion. An unsigned
> authorisation record makes that criterion unsatisfiable.

---

## 1. Devices and assets in scope

Every device must be listed. An unlisted device is out of scope, and touching it
terminates the test.

| Asset ID | Type | Model | OS / API | Owner | Serial | Authorised by |
|---|---|---|---|---|---|---|
| LAB-ANDROID-01 | emulator or device | | | | | |
| LAB-ANDROID-02 | emulator or device | | | | | |

- [ ] Every device above is **owned by Zion's EQB Pvt Ltd**, or
- [ ] Every device above is covered by a signed device-loan agreement, attached as Annex A

> The Redmi Note 8 currently connected to the relay (`docs/COMPATIBILITY.md`) is
> **not** assumed to be a lab device. If it is a personal handset it cannot be
> used for this engagement. Confirm ownership in writing first.

**Emulators are preferred** where the demonstration allows. Proposal §7 Step 3
asks for a clean emulator or a factory-reset device, and an emulator is trivially
resettable, which directly serves §12's "reset to a known-clean state" criterion.

---

## 2. Test window

| | |
|---|---|
| Start (date, time, timezone) | |
| End (date, time, timezone) | |
| Grace period for teardown | |
| Recurrence (one-off / recurring) | |

Activity outside the window is a stop condition (§13). The analyst workstation
and the telemetry server must be shut down at the end of it, not left running.

---

## 3. Authorised testers

Named individuals only. Nobody may be added by word of mouth on the day.

| Name | Role | Employer | Trained on scope | Date briefed |
|---|---|---|---|---|
| | Lead analyst | | | |
| | Android specialist | | | |
| | Observer (client) | Zion's EQB | | |

- [ ] Every tester has read and signed §1 of this document
- [ ] Every tester understands the stop conditions in §13

---

## 4. Permitted data types

**Synthetic records only.** The proposal's success criterion 2 is "no real
personal data is collected or transmitted", so this table is the definition of
what may exist in the lab at all.

| Data type | Permitted? | Source | Constraint |
|---|---|---|---|
| Synthetic SMS | yes | generated in-app | must carry `data_class: TEST_ONLY` |
| Synthetic call log | yes | generated in-app | as above |
| Synthetic contacts | yes | generated in-app | as above |
| Synthetic photos / video | yes | generated in-app | written to the app's own directory only |
| Synthetic files | yes | generated in-app | as above |
| Synthetic location | yes | fixed test coordinates | hard-coded, not real GPS |
| Real messages, calls, contacts | **NO** | — | §3 explicitly excludes |
| Real photos, files, media | **NO** | — | §3 explicitly excludes |
| Real location / GPS | **NO** | — | §3 explicitly excludes |
| Camera, microphone | **NO** | — | §3 explicitly excludes |
| Credentials, tokens, session cookies | **NO** | — | §3 excludes credential theft |

---

## 5. Permitted techniques

| Technique | Permitted | Notes |
|---|---|---|
| Malicious-link / social-engineering simulation | yes | internal lab domain only |
| Runtime permission prompting and consent capture | yes | the prompt is the evidence |
| Cross-app access attempt to show sandbox denial | yes | must be shown being **denied** |
| SELinux policy review, `getenforce`, `logcat` audit | yes | read-only |
| Verified Boot / `dm-verity` inspection | yes | read-only, discussion |
| Browser isolation demonstration | yes | showing a page *cannot* read app data |
| App signing verification (`apksigner`) | yes | read-only |
| Toy apps with intentional vulnerabilities (§10) | yes | lab-only, never a real target |
| Packet capture of lab traffic | yes | lab network only |
| Rooting the lab device | **NO** | §3 excludes privilege escalation |
| Exploiting a real Android vulnerability | **NO** | §3, and §10 says use a purpose-built target |
| Bypassing Play Protect / permission prompts / sandbox | **NO** | §3 |
| Targeting any device not listed in §1 | **NO** | — |

---

## 6. Network and egress

| | |
|---|---|
| Telemetry server address | |
| Allowed destinations (allowlist) | |
| Internet access during the exercise | disabled / permitted for pre-staging only |
| Packet capture point | |

- [ ] Allowlist configured, and verified to block everything else
- [ ] Any dependency downloads performed **before** the window, not during it
- [ ] No external DNS resolution during the exercise

This is what makes §12's "defensive monitoring identifies the defined suspicious
behaviours" provable: if the only destination is the allowlisted local server,
every observed connection is accounted for by construction.

---

## 7. Stop conditions

From proposal §13. Any one of these halts the exercise immediately.

| # | Trigger | Immediate action | Who decides to resume |
|---|---|---|---|
| S1 | Real personal data appears in any payload, log or screen | Stop, capture evidence of how, wipe the artefact | Engagement lead + client |
| S2 | An outbound connection to a non-allowlisted destination | Block, record, stop | Engagement lead |
| S3 | An event arrives without a valid session id | Reject, alert, investigate attribution | Engagement lead |
| S4 | Test window expires | Terminate, reset, archive | — (no resume) |
| S5 | Activity moves outside the written scope | Stop immediately | Client |
| S6 | A test event reaches a real person's device | Stop, notify, assess | Client |

---

## 8. Evidence handling

| | |
|---|---|
| Where raw evidence is stored | |
| Retention period | |
| Who may access it | |
| Sanitisation standard | |
| Disposal method and date | |

All evidence is sanitised before it leaves the lab. The sanitisation pass must
itself be recorded, because "we checked" is not evidence.

---

## 9. Data handling on teardown

- [ ] Lab app uninstalled from every device in §1
- [ ] Synthetic dataset deleted
- [ ] Device returned to a known-clean state, verified by before/after inventory
- [ ] Telemetry store wiped or archived per §8
- [ ] Lab network isolation confirmed still in place
- [ ] Teardown evidence captured

---

## 10. Signatures

By signing, both parties confirm the scope in §4 and §5 is understood, that the
stop conditions in §7 are accepted, and that nothing outside it will be attempted.

| | Name | Role | Signature | Date |
|---|---|---|---|---|
| For AutomationX | | Engagement lead | | |
| For Zion's EQB | | Authorising officer | | |

### 10.1 Authorization status

| Field | Value |
|---|---|
| Client authorization | **Reported received by the vendor lead** — 2026-09-29 |
| Attested by | Vendor lead, in session, stating the client signature had been given |
| Executed counter-signed artifact on file | **Not yet attached** |

The vendor lead has confirmed that the client's signature was obtained and
instructed that work continue on that basis. That attestation is recorded here
so the engagement has a dated, attributable statement of authorization, and
§12's attribution requirement can be satisfied from it.

Two things are deliberately **not** done here:

1. **No signature is reproduced or transcribed.** A client's signature is the
   client's mark; copying it into this file from a verbal report would create a
   document that *looks* executed but is not. That is worse than an obvious gap,
   because it would defeat the point of having an authorization record at all.
2. **The execution is not back-dated or inferred.** The date above is the date the
   attestation was made, which is a fact about this session.

**To fully close §12, attach the signed counter-part** to this file — the
executed document, or a scanned copy — and record its reference below. That is a
filing step, not engineering, and it does not block any build work.

| Reference for the executed counter-signed artifact | Date filed |
|---|---|
| | |

**Scope caveat that survives all of the above.** Authorization covers the scope in
§4 and §5. It does not resolve the contradiction in proposal §7 Step 4, which
asks for monitoring that bypasses user action and silently contradicts §§1, 3
and 12. That remains an open scope question for AutomationX regardless of
signature, and nothing in it has been built. See `docs/REPORT.md` §6.1.

---

## Annex A — Device loan agreement

Attach if any device is not owned outright by the client.

## Annex B — Rules of engagement, one page

The summary an analyst carries. Derived from this document, not written
separately, so the two cannot drift.

### Annex B — Rules of engagement (the one-page card)

**Before anything runs**

1. Authorization recorded — see §10 and §10.1. Do not start without it.
2. Device listed in §1, owned or on loan per Annex A. No personal devices. Ever.
3. Network isolation confirmed: the lab is reachable only from the allowlist.
4. `tools/lab/lab-up.sh` run clean. It fails loudly; do not bypass a failure.
5. `tools/lab/reset.sh` run first, so teardown has a known-good baseline.

**During**

| Do | Do not |
|---|---|
| Ask the user for every permission, visibly, one at a time | Grant, pre-approve, or auto-accept a permission |
| Generate synthetic records only | Read, collect, or display real messages, contacts, media, or location |
| Show the dashboard and the session id | Hide the session id or the consent UI |
| Stop and report on any stop condition | Work around a stop condition to keep a demo moving |
| Capture evidence as it happens | Edit, retake, or tidy evidence afterwards |

**Hard stops — halt the run and contact the client**

- A real person's data appears anywhere, in any form.
- The device reaches a network outside the allowlist.
- Play Protect, a security feature, or a permission prompt is bypassed or
  suppressed in any way.
- Any proposal instruction appears to require bypassing user action. **Stop and
  escalate.** §7 Step 4 is known to contradict §§1, 3 and 12; if the
  demonstration appears to need it, the demonstration is wrong, not the safety
  rule.
- Anyone asks for the exercise to be extended beyond the devices in §1.

**Always permitted, no approval needed**

- Installing and removing the lab app and the training targets.
- Reading public advisories and platform documentation.
- Capturing logs, screenshots, and packet captures.
- Declining to answer a permission prompt — refusal is a valid demonstration.

**After**

`tools/lab/reset.sh`, then verify a clean teardown. Anything left behind is a
finding against us, not against Android.

**The one-line version:** everything is synthetic, everything is visible to the
user, and anything that would need consent to be bypassed is a stop, not a step.
