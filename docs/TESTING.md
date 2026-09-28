# Testing

Everything runs against a **real** local Worker, not a mock. Hibernation, tag
routing and byte preservation only exist in the real runtime — a mock would test
none of the things that actually break.

```powershell
.\check-all.cmd
```

| Suite | Checks | What it proves |
|---|---|---|
| Android unit tests | 4 | The binary frame format, which three implementations share and no compiler |
| `e2e` | 27 | Auth, pairing, command routing, byte integrity, limits, disconnect |
| `console` | 32 | Frame decode, tap mapping, rotation, keyboard, scripts, in real Chrome |
| `record` | 21 | Recording produces a real, decodable WebM; presenter camera |
| `load` | — | Sustained frame relay, exit code gated on delivery rate |

Plus the rehearsal harness, which is a test you can watch:

```powershell
cd relay
npm run rehearse    # all six demo beats, on a timer
```

---

## Running them individually

```powershell
cd relay
npx wrangler dev --port 8787 --ip 127.0.0.1     # in one shell
```

```powershell
cd relay
node tools/e2e.mjs            --url ws://127.0.0.1:8787
node tools/console-smoke.mjs  --url http://127.0.0.1:8787
node tools/record-smoke.mjs   --url http://127.0.0.1:8787
node tools/loadtest.mjs       --url ws://127.0.0.1:8787 --fps 10 --kb 40 --seconds 30
```

`check-all.cmd` starts and stops the Worker for you.

### Useful flags

| Tool | Flag | Effect |
|---|---|---|
| `loadtest` | `--fps N --kb N` | Target rate. 10/40 is the demo. Try 20/100 to find the ceiling. |
| `loadtest` | `--seconds N` | Default 30. Use `1800` for the 30-minute soak. |
| `loadtest` | `--tolerance 0.98` | Default 0.9. Raise for a strict soak. |
| `rehearse` | `--device <id>` | Run against the real phone instead of the synthetic one |
| `rehearse` | `--budget N` | Seconds. Default 240 (4 minutes). |
| `rehearse` | `--headful` | Watch it happen in a real window. |
| `record-demo` | `--device <id>` | Real fallback video. Without it you get a **rehearsal** capture. |
| `soak-device` | `--minutes N` | Default 30. |

---

## The rehearsal harness

`rehearse.mjs` is the only test that runs the demo as a performance.

```powershell
npm run rehearse                              # synthetic phone
npm run rehearse -- --device abc123           # the real phone
```

It drives all six beats, asserts each one, times every beat, reports which one ran
long, and exits non-zero if the total exceeds the budget.

It runs against a **synthetic** phone by default — a stand-in that serves frames
and reacts to the same console commands a real phone would. The choreography is
identical in both modes, so the first run on real hardware is not also the first
run of the code.

Current result: **18.5s against a 240s budget**, all beats green.

---

## The device soak

Definition-of-done item 4 — "30 minutes of continuous operation with no crash and
no dropped session" — is the one requirement the synthetic harness cannot satisfy.
What breaks in 30 minutes is phone-side: the OEM battery manager killing a
background service, MediaProjection consent being revoked, the encoder drifting, a
socket dropping on a moving network.

```powershell
npm run soak -- --url $env:RELAY_URL --device abc123 --minutes 30
```

It watches from the laptop and never touches the phone. Leave the phone on 4G,
screen on, untouched.

It reports per minute, then:

```
duration      30.0 min
frames        17818  (9.9 fps avg)
data          731.4 MB
longest gap   0s
rtt median    84ms
rtt p95       142ms
reconnects    0
```

It explicitly **refuses to count a synthetic device as a pass** — the summary says
so, because this test exists precisely to catch things a fake device cannot.

If it fails with a long frame gap, check whether the screen slept. That is a
Settings problem, not a bug in the app, and the tool says so.

---

## Extending the suites

**Adding a protocol field** — three places must agree, and there is no shared
compiler:

1. `agent/app/src/main/java/dev/breakremote/agent/net/Protocol.kt`
2. `relay/src/protocol.ts`
3. `relay/public/app.js`

Add a unit test in `ProtocolTest.kt` and a round-trip check in `tools/e2e.mjs`.
A mismatch here surfaces as a blank canvas with nothing in any log, which is close
to undiagnosable in the room.

**Adding a console command** — add it to `VALID_SCRIPT_OPS` in `app.js`, to
`ActionQueue.Command` in `ActionQueue.kt`, to the `when` in `ControlService`, and
to the `REACTIONS` table in `tools/lib/synthetic-agent.mjs` so rehearsals still
drive it.

**Testing the phone** — there is no unit test for `dispatchGesture` and there
cannot be. Use the enrolment screen's "Gestures work" badge, then the rehearsal
harness with `--device`.

---

## What is *not* covered

Be honest about this. `docs/COMPATIBILITY.md` has the full table.

| Layer | Covered |
|---|---|
| Agent compiles, lints, shrinks, is signed | yes |
| Binary frame format across three implementations | yes |
| Relay auth, pairing, routing, byte integrity | yes |
| Relay throughput and 30-minute stability (synthetic) | yes |
| Console in a real browser | yes |
| Recording produces a playable file | yes |
| **Accessibility produces real touch events** | **NO — needs a phone** |
| **MediaProjection consent on a real OEM build** | **NO — needs a phone** |
| **Frame rate on real 4G** | **NO — needs a phone** |
| **The owner's actual Settings paths** | **NO — needs a phone** |
| **Any second vendor** | **NO — needs a borrowed phone** |
