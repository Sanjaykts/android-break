# Recommended defensive outcomes for Zion's EQB

**Proposal section 15.** The client-facing recommendations the engagement is
meant to produce. Written against what this repository actually demonstrates, so
each item can be traced to a control that was exercised rather than to a
generalisation about mobile security.

---

## How to read this

Section 15 lists seven recommendations. All seven are addressed below, because a
recommendation with no stated basis is just advice. Each is marked with:

- **Basis** — what in this engagement supports it
- **Status** — already in place · needs a decision · needs tooling
- **Effort** — a rough size, not a schedule

Nothing here requires the monitoring capability that proposal §7 Step 4 asks for
and that §§1, 3 and 12 forbid. Every item works on synthetic data and ordinary
platform controls.

---

## 1. Strengthen mobile phishing and malicious-link awareness

**Basis** — the §4 attack chain starts with a link, not with code. A1–A4 in
`lab/TEST-CASE-MATRIX.md` show the whole chain is reachable from one delivered
URL. The lesson is not that links are dangerous; it is that the decision to
follow one is made in about two seconds by someone who cannot see the difference.

**Status** — needs a decision. **Effort** — low.

Two things that measurably help, in order:

- **Link preview before navigation.** Show the real destination, not the
  registered domain. Most deceptive links put a familiar brand in the *path* or
  the *subdomain*, which a reader scanning the hostname alone will miss.
- **A one-click report path** to the security team, and a stated response time.
  A user who reports an odd link and hears nothing within a day learns not to
  report the next one.

**What this engagement cannot tell you** is how many real phishing attempts
Zion's EQB's staff actually receive. That needs mail and DNS logs, which are out
of scope here.

---

## 2. Maintain Android security updates and managed-device policies

**Basis** — §4 in `docs/D8-PATCHED-VULNERABILITIES.md`. A device can be
verifiably intact and still be years out of date; those are independent facts and
conflating them produces false confidence. The platform patch level and the app
inventory fail separately and must be recorded separately.

**Status** — needs tooling. **Effort** — medium.

- Record the **platform** patch level per device, not just the model.
- Set a support window with a real end date, and a defined action at that date.
- Make "no update available from the OEM" a recorded exception with an owner,
  not a silent condition.

`tools/lab/collect-device-evidence.sh` already produces the starting artifact:
`device-identity` and `verified-boot` are exactly the two fields to capture.

---

## 3. Restrict installation from untrusted sources where policy permits

**Basis** — the §10 training targets are installed from outside a store, by
design. `toy-policy.mjs` is what makes that safe, and it exists because an
unmanaged sideloaded app is a liability. That argument transfers directly: a
sideloaded app is an app with no update path, no store review, and no
accountability.

**Status** — needs a decision; partially available on managed devices.
**Effort** — low for managed fleets, high for BYOD.

- On managed devices, disable `INSTALL_NON_MARKET_APPS` via policy.
- Where sideloading is genuinely required, require a **named owner, a stated
  reason, and an expiry** per exception. This is the whole control.
- Note the honest limitation: this is enforceable on managed devices and on
  Android 11+ in some configurations. On older or unmanaged devices it is
  guidance, not a control, and should be recorded as such rather than claimed.

---

## 4. Use mobile threat defense / endpoint telemetry where appropriate

**Basis** — §9's schema and the `relay/src/lab.ts` evaluation, including the
`data_class: "TEST_ONLY"` gate and per-session device attribution (C5, C8).

**Status** — needs a decision. **Effort** — high. **This is the sensitive one.**

The value demonstrated here is **behavioural visibility**: knowing that an app
requested an unusual permission, contacted a new domain, or exported a component
nobody reviewed. The value is *not* in collecting content, and the design here
proves the distinction is enforceable — the server rejects any event not marked
`TEST_ONLY` and raises a critical alert on the attempt.

**Before adopting any such tooling, the client should be able to answer:**

1. What is collected, precisely, and can it be itemised?
2. What happens to the data — retention, location, who can query it?
3. Can employees see and challenge what is collected about them?
4. Is the tool itself a target? An endpoint agent is privileged and remote-capable.

If the answer to any of these is unclear, the tool creates risk faster than it
retires it. A tool that satisfies none of them is the §7 Step 4 problem with a
budget attached.

---

## 5. Monitor suspicious domains, newly registered domains, and unexpected behaviour

**Basis** — A1 and the allowlist model in `tools/lab/allowlist.sh`, where
reachability is bounded by an explicit destination list rather than by filtering
after the fact.

**Status** — needs tooling. **Effort** — medium.

- **DNS logging first.** It is the cheapest high-value signal available and it
  sees intent before any content is fetched.
- Flag **newly registered** and low-reputation domains. Registration age is a
  strong signal precisely because it is cheap for an attacker to fix and
  expensive to fake convincingly.
- Bound the app's own reachability by allowlist, as the lab does. Prevention is
  cheaper than detection, and this one is enforceable at the network.

**A caution worth stating:** domain reputation is noisy. Budget for false
positives, or the signal gets muted within a quarter and the one real finding
gets dismissed alongside the rest.

---

## 6. Review application permissions and exported components during assessments

**Basis** — the strongest evidence in this whole engagement. Two apps,
deliberately opposite, compared side by side, with the comparison **enforced in CI**
by `relay/tools/permission-policy.mjs` (32 checks). A permission set is either
narrow-and-justified or it is not, and a script settles that faster than a
review meeting.

**Status** — available now; the tooling is in this repository.
**Effort** — low to adopt.

The reusable part is the shape, not the specifics:

- **Every declared permission needs a stated reason**, and an unlisted
  permission is a build failure rather than a review comment.
- **Dangerous components are checked as code, not as a list.** An exported
  provider with no permission guard is invisible to a permission review and
  reachable by every app on the device.
- **A capability added to a benign app should break CI**, so that the safety
  claim stops being true loudly instead of quietly.

**The uncomfortable half:** this also means the teaching artifact in this repo —
`agent/app`, holding an Accessibility service and continuous screen capture — is
a genuine finding against itself, and the same check that validates the lab app
is what makes the contrast visible.

---

## 7. Establish an incident-response playbook for suspected mobile compromise

**Basis** — the teardown discipline in `tools/lab/reset.sh` and
`lab/AUTHORIZATION.md` §9. An exercise with no defined reset leaves a device in
an unknown state, and the next exercise cannot tell its starting point from the
last one's residue.

**Status** — needs a decision. **Effort** — medium.

The minimum viable playbook, and it is short:

| Step | Action | Why it is here |
|---|---|---|
| 1 | **Preserve before you clean.** Capture logs and state, *then* remediate. | A wiped device cannot be investigated. In this engagement `collect-device-evidence.sh` exists for exactly this ordering. |
| 2 | **Establish whether data actually left.** | Most suspected compromises are not. Determining this early prevents both escalation and false panic. |
| 3 | **Revoke access, not just uninstall.** | Tokens, sessions and enrolled devices outlive the app that issued them. |
| 4 | **Rotate anything that was exposed.** | Applies to signing keys and API tokens, not just user passwords. |
| 5 | **Record the indicator, so the next occurrence is faster.** | An unrepeatable incident is an incident that recurs unchanged. |

**Step 4 is not hypothetical here.** A keystore and its password were committed to
a public repository in this project's own history and later removed — the file
was deleted, but the credential was already public and had to be treated as
compromised. Removal is not remediation. It is a useful, uncomfortable worked
example to put in front of a client.

---

## Summary

| # | Recommendation | Status | Effort |
|---|---|---|---|
| 1 | Mobile phishing and link awareness | needs a decision | low |
| 2 | Update and managed-device policy | needs tooling | medium |
| 3 | Restrict untrusted installs | needs a decision | low / high by fleet type |
| 4 | Endpoint telemetry, if adopted | needs a decision, with four questions to answer first | high |
| 5 | Domain and behaviour monitoring | needs tooling | medium |
| 6 | Permission and exported-component review | **available now** | low |
| 7 | Incident-response playbook | needs a decision | medium |

One of the seven needs nothing but adoption, because it was built and enforced
while demonstrating the vulnerability class. That is the one to start with: it
delivers a control, not a recommendation.
