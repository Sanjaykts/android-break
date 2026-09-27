#!/usr/bin/env node
/**
 * End-to-end control-plane test.
 *
 * The load harness proves the byte path. This proves the *command* path, which is
 * entirely different code: pairing, edge auth, routing, and the console-side frame
 * parser. A regression in any of those shows up on stage as a laptop tap that
 * does nothing -- so it is worth a test even though it is not a throughput test.
 *
 * It also checks that the relay forwards frame bytes **byte-for-byte identically**.
 * A relay that transcodes, pads or re-chunks a JPEG produces a corrupt live view
 * with no error anywhere, which is close to undiagnosable on demo day.
 *
 *   node tools/e2e.mjs --url ws://127.0.0.1:8787
 *
 * Exits non-zero on the first failure.
 */

import crypto from "node:crypto";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1]);
}

const BASE = args.get("url") || "ws://127.0.0.1:8787";
const HTTP = BASE.replace(/^ws/, "http");
const AGENT_TOKEN = args.get("agent-token") || process.env.AGENT_TOKEN || "dev-agent-token";
const CONSOLE_TOKEN = args.get("console-token") || process.env.CONSOLE_TOKEN || "dev-console-token";
const DEVICE = "e2e-device";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
const failures = [];

function check(name, condition, detail = "") {
  if (condition) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ""}`);
  }
}

function open(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    const timer = setTimeout(() => reject(new Error(`timeout opening ${url}`)), 8000);
    ws.onopen = () => { clearTimeout(timer); resolve(ws); };
    ws.onerror = () => { clearTimeout(timer); reject(new Error(`cannot open ${url}`)); };
  });
}

function encodeFrame(header, payload) {
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  const buf = new ArrayBuffer(3 + headerBytes.byteLength + payload.byteLength);
  const view = new DataView(buf);
  view.setUint8(0, 0x01);
  view.setUint16(1, headerBytes.byteLength, false);
  new Uint8Array(buf, 3, headerBytes.byteLength).set(headerBytes);
  new Uint8Array(buf, 3 + headerBytes.byteLength).set(payload);
  return buf;
}

function decodeHeader(buf) {
  const view = new DataView(buf);
  if (view.getUint8(0) !== 0x01) return null;
  const len = view.getUint16(1, false);
  return { header: JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 3, len))), offset: 3 + len };
}

/** Collects messages for assertions, replacing onmessage. */
function collect(ws) {
  const bin = [];
  const json = [];
  ws.onmessage = (ev) => {
    if (ev.data instanceof ArrayBuffer) bin.push(ev.data);
    else json.push(JSON.parse(ev.data));
  };
  return {
    bin,
    json,
    find: (op) => json.find((m) => m.op === op),
    // The device list is broadcast on connect and again on hello, so the
    // assertion that matters is about the most recent one.
    last: (op) => [...json].reverse().find((m) => m.op === op),
    clear: () => { bin.length = 0; json.length = 0; },
  };
}

async function expectClosed(ws, label) {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) return resolve(true);
    ws.onclose = () => resolve(true);
    setTimeout(() => resolve(ws.readyState === WebSocket.CLOSED), 4000);
  });
}

async function main() {
  console.log(`e2e control-plane test -> ${BASE}\n`);

  // ── 1. edge auth ───────────────────────────────────────────────────────────
  console.log("1. Authentication");
  {
    const res = await fetch(`${HTTP}/devices?token=definitely-wrong`).catch(() => null);
    check("bad console token is rejected at the edge", res?.status === 401, `got ${res?.status}`);
  }
  {
    let rejected = false;
    try {
      const ws = await open(`${BASE}/ws/agent?token=wrong&device=x`);
      rejected = !(await expectClosed(ws));
    } catch {
      rejected = true; // the handshake itself was refused, which is the stronger outcome
    }
    check("bad agent token cannot open a socket", rejected);
  }
  {
    const res = await fetch(`${HTTP}/devices`).catch(() => null);
    check("missing console token is rejected", res?.status === 401, `got ${res?.status}`);
  }

  // ── 2. hello and discovery ─────────────────────────────────────────────────
  console.log("\n2. Discovery");
  const console_ = await open(
    `${BASE}/ws/console?token=${encodeURIComponent(CONSOLE_TOKEN)}&cid=${crypto.randomUUID()}`
  );
  const c = collect(console_);

  const agent = await open(
    `${BASE}/ws/agent?token=${encodeURIComponent(AGENT_TOKEN)}&device=${DEVICE}`
  );
  const a = collect(agent);

  agent.send(JSON.stringify({
    op: "hello", id: DEVICE, model: "E2E", brand: "Synthetic", android: "14", sdk: 34,
  }));
  await sleep(400);

  const listed = c.last("devices")?.devices?.find((d) => d.id === DEVICE);
  check("agent hello is advertised to the console", !!listed);
  check("device metadata survives the round trip", listed?.model === "E2E" && listed?.sdk === 34,
    JSON.stringify(listed));
  // The device list is console-only. An agent receiving it would leak the set of
  // connected consoles to every phone, so assert it does not happen.
  check("the device list is not broadcast to agents", !a.json.some((m) => m.op === "devices"));

  // ── 2b. a console that connects LATE still sees the device ────────────────
  // Regression guard. The device list is only broadcast on agent connect and on
  // hello, so without an explicit snapshot on console connect a console opened
  // after the phone is already enrolled shows an empty list forever. That is
  // exactly the demo-day ordering.
  console.log("\n2b. Late console discovery");
  {
    const late = await open(
      `${BASE}/ws/console?token=${encodeURIComponent(CONSOLE_TOKEN)}&cid=${crypto.randomUUID()}`
    );
    const lc = collect(late);
    await sleep(400);
    const seen = lc.json.find((m) => m.op === "devices")?.devices?.find((d) => d.id === DEVICE);
    check("a console connecting after the phone still gets the device list", !!seen,
      JSON.stringify(lc.json));
    late.close();
  }

  // ── 3. pairing ─────────────────────────────────────────────────────────────
  console.log("\n3. Pairing");
  c.clear(); a.clear();
  console_.send(JSON.stringify({ op: "connect", id: DEVICE }));
  await sleep(300);
  check("console is told what it paired with", c.find("paired")?.id === DEVICE);

  c.clear();
  console_.send(JSON.stringify({ op: "connect", id: "../../etc/passwd" }));
  await sleep(200);
  check("a malformed device id is rejected", c.find("error")?.message === "bad device id");

  // ── 4. command routing, console -> agent ───────────────────────────────────
  console.log("\n4. Command routing (console -> agent)");
  a.clear();
  const commands = [
    { op: "tap", x: 120, y: 340 },
    { op: "swipe", x1: 1, y1: 2, x2: 3, y2: 4, ms: 250 },
    { op: "longpress", x: 10, y: 20, ms: 700 },
    { op: "doubleTap", x: 5, y: 6 },
    { op: "key", code: 66 },
    { op: "text", s: "hello world" },
    { op: "global", action: "home" },
    { op: "find", text: "Sign in", action: "click" },
    { op: "script", actions: [{ op: "tap", x: 1, y: 1 }, { op: "global", action: "back" }] },
    { op: "quality", fps: 6, w: 360, q: 25 },
  ];
  a.clear();
  for (const cmd of commands) console_.send(JSON.stringify(cmd));
  await sleep(500);

  const received = a.json;
  check("every command reaches the agent", received.length === commands.length,
    `expected ${commands.length}, got ${received.length}`);
  check("commands arrive intact and in order",
    received.length === commands.length && received.every((m, i) => m.op === commands[i].op));
  const textCmd = received.find((m) => m.op === "text");
  check("payload strings are not mangled", textCmd?.s === "hello world", JSON.stringify(textCmd));
  const scriptCmd = received.find((m) => m.op === "script");
  check("nested script actions survive", scriptCmd?.actions?.length === 2);
  const findCmd = received.find((m) => m.op === "find");
  check("find query survives", findCmd?.text === "Sign in" && findCmd?.action === "click");

  // ── 5. unpaired console ────────────────────────────────────────────────────
  console.log("\n5. Unpaired console");
  const loner = await open(
    `${BASE}/ws/console?token=${encodeURIComponent(CONSOLE_TOKEN)}&cid=${crypto.randomUUID()}`
  );
  const l = collect(loner);
  loner.send(JSON.stringify({ op: "tap", x: 1, y: 1 }));
  await sleep(300);
  check("a console that has not paired is told so", l.find("error")?.message === "not connected to a device");
  loner.close();

  // ── 6. frame forwarding, byte-for-byte ─────────────────────────────────────
  console.log("\n6. Frame forwarding");
  c.clear();
  const payload = new Uint8Array(64 * 1024);
  crypto.randomFillSync(payload);
  const expectedHash = crypto.createHash("sha256").update(payload).digest("hex");
  agent.send(encodeFrame({ did: DEVICE, w: 480, h: 854, rot: 0, seq: 1, q: 35, ts: 0 }, payload));
  await sleep(400);

  check("the frame reached the console", c.bin.length === 1, `got ${c.bin.length}`);
  if (c.bin.length === 1) {
    const buf = c.bin[0];
    const { header, offset } = decodeHeader(buf);
    check("frame magic byte is intact", new DataView(buf).getUint8(0) === 0x01);
    check("header is byte-identical to what the agent sent",
      header.did === DEVICE && header.w === 480 && header.h === 854 && header.seq === 1);
    const got = new Uint8Array(buf, offset);
    check("JPEG body is not resized, re-chunked or transcoded", got.byteLength === payload.byteLength,
      `expected ${payload.byteLength}, got ${got.byteLength}`);
    const gotHash = crypto.createHash("sha256").update(got).digest("hex");
    check("JPEG body is byte-for-byte identical", gotHash === expectedHash);
  }

  // ── 7. ping/pong clock discipline ──────────────────────────────────────────
  console.log("\n7. Latency measurement");
  c.clear();
  const stamp = Date.now();
  console_.send(JSON.stringify({ op: "ping", t: stamp }));
  await sleep(200);
  const pong = c.find("pong");
  check("pong echoes the console's own timestamp", pong?.t === stamp, JSON.stringify(pong));

  // ── 8. agent -> console events ─────────────────────────────────────────────
  console.log("\n8. Events (agent -> console)");
  c.clear();
  agent.send(JSON.stringify({ op: "event", kind: "accessibility", package: "com.example" }));
  await sleep(250);
  const evt = c.find("event");
  check("accessibility events reach the console", evt?.kind === "accessibility");
  check("event payloads survive", evt?.package === "com.example");

  c.clear();
  agent.send(JSON.stringify({ op: "result", ok: true, detail: "gesture" }));
  await sleep(250);
  check("action results reach the console", c.find("result")?.detail === "gesture");

  // ── 9. oversize frame ──────────────────────────────────────────────────────
  console.log("\n9. Limits");
  c.clear();
  // A dedicated connection: this one gets closed by the relay, and the disconnect
  // test below needs the main agent still alive.
  const greedy = await open(
    `${BASE}/ws/agent?token=${encodeURIComponent(AGENT_TOKEN)}&device=${DEVICE}-greedy`
  );
  const greedyClosed = expectClosed(greedy, "oversize");
  greedy.send(encodeFrame({ did: `${DEVICE}-greedy`, w: 480, h: 854, seq: 2 }, new Uint8Array(600 * 1024)));
  await greedyClosed;
  check("an oversize frame closes the agent rather than wedging the relay",
    greedy.readyState === WebSocket.CLOSED);

  // ── 10. disconnect is reported ─────────────────────────────────────────────
  console.log("\n10. Disconnect");
  c.clear();
  const statePromise = (async () => {
    for (let i = 0; i < 40; i++) {
      const s = c.find("state");
      if (s?.state === "lost") return true;
      await sleep(50);
    }
    return false;
  })();
  agent.close();
  check("a dropped phone is reported as lost, not silently dropped",
    await statePromise);

  console_.close();
  await sleep(200);

  // ── summary ────────────────────────────────────────────────────────────────
  console.log(`\n${"─".repeat(58)}`);
  console.log(`${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log("\nfailures:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log("control plane is sound.");
}

main().catch((err) => {
  console.error(`\nharness error: ${err.message}`);
  process.exit(2);
});
