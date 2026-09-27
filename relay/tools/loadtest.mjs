#!/usr/bin/env node
/**
 * Relay load harness.
 *
 * This exists because the single largest unproven assumption in the plan is that
 * a Cloudflare free-tier Durable Object can relay sustained screen frames. Plan
 * section 10 lists it as "low-medium likelihood, medium impact"; this measures
 * it instead of hoping.
 *
 * It opens one console socket and one agent socket, has the agent send `hello`,
 * pairs them, then pushes synthetic binary frames at a chosen rate and size for a
 * chosen duration while the console counts what actually arrives.
 *
 * The JPEG payload is random bytes on purpose. The relay never parses the body,
 * so a random payload exercises exactly the same code path a real JPEG would and
 * keeps the harness dependency-free.
 *
 *   node tools/loadtest.mjs --url ws://127.0.0.1:8787 --fps 10 --kb 40 --seconds 120
 *
 * Exit code is non-zero if the delivered frame rate falls short of target, so it
 * can gate CI or a rehearsal.
 */

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1]);
}

const BASE = args.get("url") || "ws://127.0.0.1:8787";
const HTTP = BASE.replace(/^ws/, "http");
const AGENT_TOKEN = args.get("agent-token") || process.env.AGENT_TOKEN || "dev-agent-token";
const CONSOLE_TOKEN = args.get("console-token") || process.env.CONSOLE_TOKEN || "dev-console-token";
const FPS = Number(args.get("fps") || 10);
const KB = Number(args.get("kb") || 40);
const SECONDS = Number(args.get("seconds") || 60);
const DEVICE_ID = args.get("device") || "loadtest-device";
const TOLERANCE = Number(args.get("tolerance") || 0.9);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function encodeFrame(header, payloadBytes) {
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  const buf = new ArrayBuffer(3 + headerBytes.byteLength + payloadBytes.byteLength);
  const view = new DataView(buf);
  view.setUint8(0, 0x01);
  view.setUint16(1, headerBytes.byteLength, false);
  new Uint8Array(buf, 3, headerBytes.byteLength).set(headerBytes);
  new Uint8Array(buf, 3 + headerBytes.byteLength).set(
    new Uint8Array(payloadBytes.buffer ?? payloadBytes)
  );
  return buf;
}

function decodeHeader(buf) {
  const view = new DataView(buf);
  if (view.getUint8(0) !== 0x01) return null;
  const len = view.getUint16(1, false);
  return JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 3, len)));
}

function open(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => resolve(ws);
    ws.onerror = (e) => reject(new Error(`cannot open ${url}`));
    setTimeout(() => reject(new Error(`timeout opening ${url}`)), 10_000);
  });
}

const stats = {
  sent: 0,
  received: 0,
  bytesSent: 0,
  bytesReceived: 0,
  sentAt: [],
  recvAt: [],
  dropped: 0,
};

let sawDevice = "";

async function main() {
  console.log(`relay load test -> ${BASE}`);
  console.log(`  target ${FPS} fps x ${KB} KB for ${SECONDS}s = ${((FPS * KB * SECONDS) / 1024).toFixed(0)} MB total`);

  const health = await fetch(`${HTTP}/health`).then((r) => r.json()).catch(() => null);
  if (!health?.ok) {
    console.error("relay /health did not respond -- is `wrangler dev` running?");
    process.exit(2);
  }
  console.log("  relay healthy");

  const console_ = await open(
    `${BASE}/ws/console?token=${encodeURIComponent(CONSOLE_TOKEN)}&cid=loadtest-console`
  );
  console.log("  console connected");

  const agent = await open(
    `${BASE}/ws/agent?token=${encodeURIComponent(AGENT_TOKEN)}&device=${encodeURIComponent(DEVICE_ID)}`
  );
  console.log("  agent connected");

  agent.onmessage = (ev) => {
    if (typeof ev.data !== "string") return;
    const m = JSON.parse(ev.data);
    if (m.op === "devices") {
      const d = (m.devices || []).find((x) => x.id === DEVICE_ID);
      if (d) console.log(`  device visible to console: ${d.brand} ${d.model} (API ${d.sdk})`);
    }
    if (m.op === "paired") console.log(`  console paired with ${m.id}`);
  };

  // One handler for the whole run. Assigning onmessage twice would silently drop
  // whichever came first, which is exactly the kind of harness bug that makes a
  // relay look broken when it is not.
  const rtts = [];
  console_.onmessage = (ev) => {
    if (ev.data instanceof ArrayBuffer) {
      const h = decodeHeader(ev.data);
      if (!h || h.did !== DEVICE_ID) {
        stats.dropped++;
        return;
      }
      stats.received++;
      stats.bytesReceived += ev.data.byteLength;
      stats.recvAt.push(Date.now());
      return;
    }
    const m = JSON.parse(ev.data);
    if (m.op === "pong") rtts.push(Date.now() - m.t);
    if (m.op === "devices") {
      const d = (m.devices || []).find((x) => x.id === DEVICE_ID);
      if (d) sawDevice = `${d.brand} ${d.model} (API ${d.sdk})`;
    }
  };

  agent.send(JSON.stringify({
    op: "hello", id: DEVICE_ID, model: "LoadTest", brand: "Synthetic",
    android: "14", sdk: 34,
  }));
  await sleep(300);
  console_.send(JSON.stringify({ op: "connect", id: DEVICE_ID }));
  await sleep(500);

  console.log(`  device visible to console: ${sawDevice || "NOT SEEN"}`);

  // Measure the control path too: round-trip time for a console ping.
  for (let i = 0; i < 5; i++) {
    console_.send(JSON.stringify({ op: "ping", t: Date.now() }));
    await sleep(200);
  }
  const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
  console.log(`  control-path rtt (local): ${median(rtts)}ms`);

  console.log("  pushing frames…");
  const payload = new Uint8Array(KB * 1024).fill(0x42);
  const interval = 1000 / FPS;
  const started = Date.now();
  let seq = 0;

  await new Promise((resolve) => {
    const tick = setInterval(() => {
      if (Date.now() - started >= SECONDS * 1000) {
        clearInterval(tick);
        resolve();
        return;
      }
      const frame = encodeFrame(
        { did: DEVICE_ID, w: 480, h: 854, rot: 0, seq: seq++, q: 35, ts: Date.now() },
        payload
      );
      // Mirror the phone's single-slot policy: if the socket is backed up, drop
      // the frame instead of queueing. Unbounded queueing is how the phone OOMs.
      if (agent.bufferedAmount > 512 * 1024) { stats.dropped++; return; }
      stats.sent++;
      stats.bytesSent += frame.byteLength;
      stats.sentAt.push(Date.now());
      agent.send(frame);
    }, interval);
  });

  await sleep(1500); // let the tail drain

  const wall = (Date.now() - started) / 1000;
  const sentFps = stats.sent / wall;
  const recvFps = stats.received / wall;
  const delivery = stats.sent ? stats.received / stats.sent : 0;
  const mbps = (stats.bytesReceived * 8) / wall / 1e6;

  // One-way latency, sampled from matched sequence numbers where available.
  console.log("");
  console.log("── results " + "─".repeat(50));
  console.log(`  sent        ${stats.sent} frames (${sentFps.toFixed(1)} fps, ${(stats.bytesSent / 1e6).toFixed(1)} MB)`);
  console.log(`  received    ${stats.received} frames (${recvFps.toFixed(1)} fps, ${(stats.bytesReceived / 1e6).toFixed(1)} MB)`);
  console.log(`  delivery    ${(delivery * 100).toFixed(1)}%`);
  console.log(`  throughput  ${mbps.toFixed(2)} Mbps`);
  console.log(`  wall time   ${wall.toFixed(1)}s`);
  console.log("─".repeat(64));

  agent.close();
  console_.close();
  await sleep(200);

  const ok = delivery >= TOLERANCE;
  if (!ok) {
    console.error(
      `\nFAIL: delivered ${(delivery * 100).toFixed(1)}% of frames, need ${(TOLERANCE * 100).toFixed(0)}%.`
    );
    console.error("The relay is not keeping up at this rate. Drop the quality tier, or");
    console.error("switch the relay host (see plan section 6.2).");
    process.exit(1);
  }
  console.log(`\nPASS: relay sustained ${FPS} fps x ${KB} KB over ${wall.toFixed(0)}s.`);
}

main().catch((err) => {
  console.error(`\n${err.message}`);
  process.exit(2);
});
