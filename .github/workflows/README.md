# CI

| Workflow | What it proves |
|---|---|
| `build.yml` | The agent compiles, lints, passes unit tests, **is signed**, and is published to a permanent release URL. Fails if the APK is unsigned. |
| `relay.yml` | The relay typechecks and passes four suites against a **real** local Worker: control plane, console in real Chrome, recording, frame throughput. |

Both run on every push to `main`.

Secrets required by `build.yml` — set with `gh secret set NAME`:

| Secret | Source |
|---|---|
| `KEYSTORE_BASE64` | `base64 -i agent/keystore.jks` |
| `KEYSTORE_PASSWORD` | from `tools/make-keystore.sh` |
| `KEY_ALIAS` | `agent-release` |
| `KEY_PASSWORD` | from `tools/make-keystore.sh` |
| `AGENT_TOKEN` | random, 32 bytes: `python3 -c "import secrets;print(secrets.token_urlsafe(32))"` |
| `CONSOLE_TOKEN` | random, different from the agent token |
| `RELAY_URL` | `wss://<worker>.workers.dev` |

`RELAY_URL` and `AGENT_TOKEN` are compiled **into the APK**, and the release
asset is public so the phone owner can install from a browser link. That means the
agent token is readable by anyone who downloads the APK — it only grants the
ability to enrol a device, and it should be rotated after the demo. See
`docs/PRIVACY.md` §1.

`./check-all.sh` runs everything locally before pushing.
