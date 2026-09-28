# Deployment and releases

Three deployable pieces. Only two of them are live.

| Piece | Where | State |
|---|---|---|
| **Agent APK** | GitHub Releases, `apk-latest` | **Live.** Signed, 271 KB |
| **Relay Worker** | Cloudflare Workers | **Not deployed.** This document |
| **Console** | Served by the Worker as static assets | Ships with the Worker |

The console has no separate deploy. It is `relay/public/`, bound as Workers
Static Assets in `wrangler.jsonc`, and goes out with the Worker.

---

## 1. Deploy the relay — do this once

```powershell
cd relay
npx wrangler login
```

Opens a browser. Pick the **free** plan. A free Durable Object is enough: measured
throughput is 36 Mbps sustained, roughly ten times what the demo needs, and a
30-minute soak at 10 fps completed with 100% delivery and zero drops.

### Set the secrets

```powershell
npx wrangler secret put AGENT_TOKEN
npx wrangler secret put CONSOLE_TOKEN
```

Both are prompted for interactively. **Use different values**, 32+ random bytes:

```powershell
python -c "import secrets; print(secrets.token_urlsafe(32))"
```

> **`AGENT_TOKEN` must match the value the APK was built with.** It is compiled
> into the binary. If they differ, the phone connects and is immediately refused
> with a 401, and the only symptom on the phone is a connection error with no
> explanation. The current value is in the GitHub Actions secret of the same name
> — view it with:
> ```powershell
> gh secret list
> # (values cannot be read back; ask the original owner, or rotate both)
> ```

The two tokens are separate on purpose: `CONSOLE_TOKEN` can be rotated any time
without touching the phone, `AGENT_TOKEN` is baked into the APK.

> **Rotate `CONSOLE_TOKEN` immediately after the demo.** The APK is published from
> a public release and embeds `AGENT_TOKEN`, so that token is readable by anyone
> who downloads it. It only grants the ability to enrol a device, which is
> benign — but do not leave demo credentials live.

### Deploy

```powershell
npm run deploy
```

Note the printed URL, e.g. `https://android-break-relay.<x>.workers.dev`.

Verify:

```powershell
curl https://android-break-relay.<x>.workers.dev/health
# {"ok":true,"service":"android-break-relay"}
```

If you get a **503** with `relay is not configured`, the secrets did not take.
Check with `npx wrangler secret list`.

If you get **401**, the token is wrong, not missing.

---

## 2. Point the APK at the real relay

The published APK currently points at a placeholder. Fix it:

```powershell
gh secret set RELAY_URL --body "wss://android-break-relay.<x>.workers.dev"
gh workflow run build.yml
gh run watch
```

The workflow fails if the APK comes out unsigned, which is the one failure that
would otherwise only surface on the phone.

### The permanent download URL

```
https://github.com/Sanjaykts/android-break/releases/download/apk-latest/agent.apk
```

This is deliberately a **rolling tag**. The asset name is always `agent.apk`, so
the URL is a constant — which is what lets the QR code in `enroll.pdf` be printed
once and never regenerated. Do not "tidy" this into a per-commit tag.

Each build also cuts an immutable `v1.0.0+<sha>` release as a rollback target.

---

## 3. Cutting a release

Push to `main`. That is the whole process.

Both workflows run:

- **`build.yml`** — test, lint, assemble, verify the signature, publish
- **`relay.yml`** — typecheck, then four suites against a real local Worker

**Neither is green → do not demo.** A red `relay` run has caught real bugs,
including an open-relay authentication hole and a publish step that only worked on
the first run.

If you need to rebuild the Worker after a change:

```powershell
cd relay
npm run typecheck
.\check-all.cmd -Quick
npm run deploy
```

> Deploying a new Worker version **disconnects all WebSockets**. During a live demo
> that means the phone and console drop and reconnect. If you are mid-demo, do not
> touch it.

---

## 4. The signing key

```
agent/keystore.jks    alias agent-release    4096-bit RSA
```

**Never rotate it. Never regenerate it. Back it up somewhere private and durable.**

A new key is a different signing identity, and Android refuses to install an
update signed with it. The phone owner would have to uninstall first, which loses
the app's local settings and forces the whole enrolment again — on their own
phone, minutes before a demo.

It exists in two places only: your local file, and the `KEYSTORE_BASE64` Actions
secret. **Neither can regenerate the other.** If you lose both, the next release
must use a new `versionCode` and every device must uninstall first.

### Recovering the keystore from CI

```powershell
# You cannot read a secret back. If you have the base64 saved anywhere:
[IO.File]::WriteAllBytes("agent\keystore.jks", [Convert]::FromBase64String($env:KEYSTORE_BASE64))
```

If you have lost it entirely, generate a new one, bump `versionCode` in
`agent/app/build.gradle.kts`, and plan for a reinstall:

```powershell
cd tools
$env:KEYSTORE_PASSWORD = "..."; $env:KEY_PASSWORD = "..."
.\make-keystore.sh
```

---

## 5. Deploying the console separately

You cannot. It is bundled with the Worker.

If you only change `relay/public/`, redeploying the Worker is still required, and
it will drop live sockets. During development that is fine; during a demo, do not.

---

## 6. Rollback

**Relay:** `npx wrangler rollback` reverts to the previous Worker version.

**APK:** a rolling-tag build cannot be rolled back in place, because the asset is
overwritten. Use the immutable release:

```powershell
gh release download "v1.0.0+<sha>" --pattern agent.apk
```

A rollback APK signed by the same key installs as an update. One signed by a
different key does not — see §4.
