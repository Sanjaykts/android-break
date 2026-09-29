# D8 — Known patched vulnerabilities and the importance of updates

**Proposal section 10, class D8.** The only class in section 10 that is not an
app you build. It is a discussion deliverable, and it is written from public
advisories only — no exploit code, no weaponised proof-of-concept, and nothing
targeted at a specific person or organisation.

---

## Why this class is different from D1–D7

Everything else in section 10 is a flaw we deliberately built so a client can
watch it happen. D8 is the opposite: the vulnerability is already fixed on the
device, and the only thing to demonstrate is **the gap between a device being
patched and a user knowing it was.**

That gap is the actual lesson, and it is worth stating plainly: a patched device
still carries the risk of whatever was installed next.

---

## The discussion, in three movements

### 1. A vulnerability class is a pattern, not a CVE

Naming a CVE teaches nothing transferable. What transfers is the shape of the
mistake. The classes in D1–D7 are each a pattern, and each has recurred in
shipped applications for well over a decade:

| Pattern | Still seen in | Why it recurs |
|---|---|---|
| Unsafe WebView bridge (D3) | wrapper apps built for speed | A bridge object is three lines and looks harmless; the threat model is never written down |
| Exported component with no check (D4) | apps exposing a deep link to "just" open a screen | Exporting makes a component reachable by every app on the device, not just yours |
| Insecure deep link (D2) | apps adding one marketing link | The link is added for a campaign and the caller check never follows |
| Cleartext storage of a token (D5) | almost everything, historically | Storing in `SharedPreferences` is the path of least resistance and the default reading of "private" |
| Trust-all TLS (D7) | apps that hit a certificate error in staging and "fixed" it by disabling validation | The error message is the fix instruction, and the easy reading is wrong |
| Overbroad permissions (D6) | apps that request at install rather than at use | Asking for everything up front is fewer engineering decisions, at the cost of every user |

The pattern is the durable content. A specific advisory number is dated the
moment the client reads it.

### 2. Why the fix is often not adopted

A patch existing is not a patch being installed. The reasons are mundane, and
naming them is more useful than listing advisories:

- **Fragmentation.** The same app version runs on Android 8 through 14. A fix
  released for one API level does not retroactively reach a device three
  versions back, and many such fixes are simply not backportable.
- **The OEM layer.** A device that shipped in 2021 may never receive a platform
  security patch from its manufacturer, independent of the app. Verified Boot
  (§5 B5) tells you the *system* is intact; it says nothing about whether that
  system still contains last year's kernel bug.
- **Sideloading and store drift.** An app installed outside a store keeps the
  version it was installed with. The teaching targets in this repo are a worked
  example: they are deliberately unpatched by design, and the only thing keeping
  them safe is that `toy-policy.mjs` proves they can reach nothing.
- **The update is invisible.** Nothing tells a user a security update landed. The
  evidence script in `tools/lab/collect-device-evidence.sh` records version state;
  that is the whole mitigation available without a management channel.

### 3. What an organisation can actually do

The honest answer is that the useful measures are unglamorous, and every one of
them is an operational control rather than a technical one:

1. **Inventory what is actually installed**, including sideloaded and work-profile
   apps. You cannot patch what you have not listed. `collect-device-evidence.sh`
   produces the starting artifact.
2. **Set a support window and enforce it.** The most common real finding in an
   assessment is not an exotic bug; it is a device two major versions behind with
   an app last updated years ago.
3. **Install from a managed channel**, and make sideloading a deliberate,
   recorded exception with a reason and an expiry. Every sideloaded app needs a
   named owner.
4. **Record the platform patch level** (§5 B5) alongside the app inventory, because
   the two fail independently.
5. **Treat a security update as a change with an owner and a date** — the same
   discipline as any other change. Most of the gap is process, not code.

---

## Demonstrated live, if a device is available

None of this needs a bespoke build. On the lab device:

```sh
./tools/lab/collect-device-evidence.sh
```

- `installed-packages` shows what is actually on the device and from where
- `device-identity` records the platform version, which decides which fixes even
  *could* apply
- `verified-boot` shows whether the system partition is intact — a different
  question from whether it is current

Point 4 above is the one worth raising with the client: a device can be
verifiably intact and still years out of date. Those are independent facts, and
conflating them is how an organisation ends up confident for the wrong reason.

---

## What this deliverable does not do

- It does not list specific CVEs for a specific installed app. That requires the
  device inventory from `collect-device-evidence.sh`, and it is better done live
  than pre-written.
- It does not include exploit code, proof-of-concept, or reproduction steps. The
  discussion is about why patches are not adopted, which needs no exploit.
- It does not test the lab device for vulnerabilities. Proposal section 13 places
  testing out of scope; this is a discussion to inform policy, not a scan.
- It does not claim a specific device or app is vulnerable. Nothing in this
  repository has been assessed for defects, and the deliberately flawed training
  targets are flawed **by design and by documentation** — see
  `lab/TEST-CASE-MATRIX.md` §D.

---

## Coverage check

| Proposal section 10 class | Built | Where |
|---|---|---|
| D1 social engineering / malicious link | yes | `relay/public/lab/` |
| D2 insecure deep links | yes | `agent/toylab/…/DeepLinkDemo.kt` |
| D3 WebView misconfiguration | yes | `agent/toylab/…/WebViewBridgeDemo.kt` |
| D4 exported components | yes | `agent/toylab/…/ExportedComponentDemo.kt` |
| D5 insecure storage | yes | `agent/toylab/…/InsecureStorageDemo.kt` |
| D6 overbroad permissions | yes | `agent/app` (the teaching artifact) |
| D7 insecure network / weak TLS | yes | `agent/toylab/…/WeakTlsDemo.kt` + `relay/tools/lab-tls-endpoint.mjs` |
| **D8 patched vulnerabilities and updates** | **this document** | — |

**8 of 8 classes in section 10 are now delivered.**
