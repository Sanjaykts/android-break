# Architecture

## The problem

One Android phone, one laptop, two different networks, no USB, no ADB, no root, no
server to rent, no second app on the phone, and nothing installed on the laptop.

The binding constraint is that **the phone can only make outbound connections.**
There is no way to accept an inbound one without a public IP, a port forward, or a
tunnel client on the phone. Every option that solves this that way is off the table:
Tailscale and ADB-over-WiFi both need something installed on the laptop, and the
plan's constraints rule those out too.

## The shape

```
   Phone (owner's, on 4G)         Cloudflare (free)         Laptop
  ┌────────────────────┐        ┌─────────────────┐      ┌──────────────────┐
  │ agent.apk          │  WSS   │ Worker          │  WSS │ Console (Chrome) │
  │                   │        │                 │      │                  │
  │  Session           ├───────▶│  /ws/agent   ┐   ├─────▶│  canvas          │
  │  ControlService    │        │              ├──▶│     │  pointer → tap   │
  │   AccessibilitySvc │◀───────┤  /ws/console ┘   │     │  header → coords │
  │  CaptureService    │        │      Hub DO       │     │  log, record     │
  │   MediaProjection  │        │                 │     │                  │
  └────────────────────┘        └─────────────────┘      └──────────────────┘
        3 grants at install          byte relay              nothing to install
```

Both sides dial the same Durable Object. It is a rendezvous, not a server: it holds
two sockets and moves bytes between them. No inbound path exists anywhere.

## Why a Durable Object specifically

A plain Worker could hold the sockets, but a plain Worker cannot hold *state*
between requests, and the alternative -- a KV store as a rendezvous -- means a
storage round trip to route every message. A Durable Object is a single-threaded,
stateful, always-addressable instance, which is exactly the shape of the problem.

**Hibernation is what makes the free tier viable.** A WebSocket accepted with
`state.acceptWebSocket()` does not keep the object resident when idle. An idle relay
costs approximately nothing, and the object wakes only when a frame arrives.

> Implementation note, because it cost real time: the commonly published pattern
> `new WebSocketRequestResponsePair(request)` does not exist. That global name is an
> unrelated auto-response helper and fails with an error that never mentions
> hibernation. The working form is
> `new WebSocketPair()` → `state.acceptWebSocket(server, tags)` →
> `new Response(null, { status: 101, webSocket: client })`.

## The relay is deliberately dumb

The single most important design decision: **the hot path does almost nothing.**

An inbound screen frame is:

1. Checked against a 512 KB cap.
2. Forwarded to every connected console as **the same `ArrayBuffer`**.

That is all. No parse, no JSON, no storage read, no device lookup. The console
decides whether the frame is its own by reading the `did` field in the frame header
-- which it has to read anyway, to map tap coordinates to the frame's declared size.

This is why identity lives where it does:

| Where | What | Why there |
|---|---|---|
| WebSocket **tags** | `agent` + `device:<id>`, `console` + `console:<id>` | In-memory, addressable via `getWebSockets(tag)`, survives hibernation |
| `serializeAttachment` | A console's paired device | Survives hibernation, read synchronously, no storage |
| Durable Object storage | Device model/brand/version | Written once per connection, read only by `/devices` |

**Net effect: the frame path and the command path perform zero storage operations.**
Storage is written at most once per agent connection.

Measured consequence: 36 Mbps sustained at 100% delivery, roughly 10x what the demo
needs, and a 30-minute soak with 17,818 frames and zero drops.

## Wire protocol

Two shapes on one WebSocket.

**JSON**, for control traffic. Never on the hot path.

```
agent  → hub : {"op":"hello","id","model","brand","android","sdk"}
agent  → hub : {"op":"event","kind":"accessibility|connection|lifecycle|capture", ...}
agent  → hub : {"op":"result","ok":bool,"detail":"..."}
agent  → hub : {"op":"pong","t":<echoed from console>}

console→ hub : {"op":"connect","id":"<deviceId>"}
console→ hub : {"op":"disconnect"}
console→ agent: {"op":"tap","x","y"}
                {"op":"swipe","x1","y1","x2","y2","ms"}
                {"op":"longpress","x","y","ms"}   {"op":"doubleTap","x","y"}
                {"op":"key","code"}              {"op":"text","s"}
                {"op":"global","action":"back|home|recents|power|notifications|appswitch"}
                {"op":"find","text","action":"click|settext"}
                {"op":"script","actions":[ ... ]}
                {"op":"quality","fps","w","q"}    {"op":"ime","enabled"}
console→ hub : {"op":"ping","t":<console clock>}
```

**Binary**, for screen frames:

```
 0x01 │ u16 headerLen (big-endian) │ headerJSON (UTF-8) │ JPEG bytes
```

```json
{"did":"dev-3f2a","w":480,"h":854,"rot":0,"seq":1841,"q":35,"ts":1756339200000}
```

`w`/`h` are the **display coordinate space** -- the exact space a tap must use. The
agent rotates and scales each frame into that space before encoding, so the console
performs no transform and a tap maps to a pixel with one multiply. The canvas's
intrinsic size comes from the decoded image, and taps map through its bounding
rect, which is what makes a CSS-scaled canvas still map correctly.

Three implementations share this format and no compiler: `agent/.../net/Protocol.kt`,
`relay/src/protocol.ts` and `relay/public/app.js`. It is pinned by unit tests on the
Kotlin side and by a byte-for-byte integrity check in the relay e2e suite, because a
mismatch surfaces as a blank canvas with nothing in any log.

## Screen capture

```
MediaProjection consent
      ↓
CaptureService  ── startForeground() FIRST        (API 34+ throws otherwise)
      ↓          ── registerCallback()   THEN
      ↓             createVirtualDisplay()
ImageReader (RGBA_8888, maxImages 2)
      ↓  acquireLatestImage()
row-stride-aware copy into a reused Bitmap
      ↓  rotate + scale into display space
      ↓  compress(JPEG, q)
      ↓
Session.sendFrame()  ── dropped if the previous frame has not drained
      ↓
relay → console
```

Four decisions in that chain are load-bearing, and each was found the hard way:

**`startForeground` before `getMediaProjection`.** Mandatory on API 34+. The
notification is not a courtesy here, it is the precondition for the token.

**`registerCallback` before `createVirtualDisplay`.** Also mandatory on API 34+.
Skipping it throws, and the only symptom is a blank canvas.

**Honour `Image.Plane.rowStride`.** `copyPixelsFromBuffer` assumes tight packing,
but `rowStride` is routinely wider than `width * 4`. Assuming they are equal shears
the image by a few pixels per row -- which looks *almost* right, so it survives
review and only fails on particular hardware.

**Reuse every buffer.** Two `Bitmap`s, one `IntArray`, one row scratch buffer, one
`ByteArrayOutputStream`, all allocated once. A `Bitmap` per frame is the classic way
this pattern OOMs a mid-range phone within a minute.

**Backpressure is a drop, not a queue.** If the previous frame has not drained, the
new one is discarded. On a stalled uplink an unbounded queue grows until the phone
OOMs -- and an OOM on demo day is unrecoverable, because the only fix is
uninstalling. A dropped frame is invisible; a crash ends the session.

## Input

`INJECT_EVENTS` is signature-level and unattainable by a sideloaded app. That one
fact determines the whole input design: `AccessibilityService.dispatchGesture` is
the only route from a laptop to a real touch event on a non-rooted phone.

`dispatchGesture` **refuses to start while a gesture is in flight.** It returns
false rather than queueing, so an unserialised sender loses input silently -- a
failure that appears only under fast input, i.e. exactly during a demo. So every
command goes through one channel and one consumer coroutine, and a gesture is not
complete until its `GestureResultCallback` fires.

`canPerformGestures` has no public getter. If it is missing from the config XML,
every gesture returns false with no error anywhere. `ControlService` therefore runs a
one-pixel gesture probe at startup and reports it, so the failure is a red badge on
the enrollment screen rather than silence.

Typing prefers `ACTION_SET_TEXT` on the focused node, which is instant and reports
success. WebViews and games that do not expose a node tree fall back to a real
`InputConnection` via an optional IME, which those apps do honour -- and which is not
key injection, just a keyboard the user could also select.

## Why not something else

| Option | Why not |
|---|---|
| scrcpy + `adb tcpip` | Technically superior (screen-off, 60 fps, scripting). Needs one USB **or** same-LAN wireless-debugging pairing. Both ruled out |
| Android Enterprise device-owner | Genuinely zero-touch after provisioning. Requires a factory reset. Ruled out |
| WebRTC for video | 2–3 extra days and no visible audience benefit. JPEG over WebSocket is smaller to build and easier to debug |
| A rented relay server | Costs money and adds ops. The Durable Object is free and always-on |
| AirDroid / TeamViewer as the primary | They work, but they are not our artifact and carry licence limits. Retained as fallback only |
| Push from phone to server, poll from console | Adds seconds of latency to the control path, which is the one thing that must feel direct |

## The honest cost of this design

The phone's screen stays on, visibly. The user can revoke access or uninstall at any
moment. Rebooting the phone loses screen-capture consent and needs one re-tap. The
app cannot read another app's private data, and cannot work on a PIN-locked screen.

None of these are bugs. They are what a non-rooted, non-managed Android phone
actually permits, and every one of them is a property of the platform rather than of
this implementation. `DEMO_RUNBOOK.md` §6 has the answers ready, because they will be
asked.
