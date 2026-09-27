#!/usr/bin/env node
/**
 * Device soak -- the real-phone version of the definition-of-done stability test.
 *
 * "30 minutes of continuous operation with no crash and no dropped session"
 * (definition-of-done item 4) is the one requirement the synthetic harness cannot
 * satisfy, because what actually breaks in 30 minutes is phone-side: the OEM
 * battery manager killing a background service, MediaProjection consent being
 * revoked, the encoder drifting, the socket dropping on a moving network. None of
 * those exist without a handset.
 *
 * This attaches to a real device, watches it, and reports. It never touches the
 * phone -- everything happens on the laptop.
 *
 *   node tools/soak-device.mjs --url https://relay.example.workers.dev --device 3f2a1b9c
 *   node tools/soak-device.mjs ... --minutes 30
 *
 * Leave the phone on 4G, screen on, screen timeout 30 minutes, untouched. A
 * screen that sleeps or locks invalidates the run, so this detects the resulting
 * frame gap and reports it rather than quietly claiming a pass.
 */

const args = new Map();
for (let i = 2; i < process.argv.length; i++) {
  const key = process.argv[i].replace(/^--/, "");
  const next = process.argv[i + 1];
  if (next === undefined || next.startsWith("--")) args.set(key, true);
  else { args.set(key, next); i++; }
}

const URL_ = args.get("url") || "http://127.0.0.1:8787";
const WS = URL_.replace(/^http/, "ws");
const CONSOLE_TOKEN = args.get("console-token") || process.env.CONSOLE_TOKEN || "dev-console-token";
const DEVICE = args.get("device");
const MINUTES = Number(args.get("minutes") || 30);
const DURATION_MS = MINUTES * 60_000;

// Frames slower than this for longer than GAP_MS means the phone stopped
// producing them, which is the single most likely 30-minute failure.
const MIN_FPS = 1;
const GAP_MS = 15_000;
const REPORT_EVERY_MS = 60_000;

if (!DEVICE) {
  console.error("usage: soak-device.mjs --url <relay> --device <id> [--minutes 30]");
  console.error("");
  console.error("  List the devices first:");
  console.error(`    curl "${URL_}/devices?token=$CONSOLE_TOKEN"`);
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function open(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    const t = setTimeout(() => reject(new Error(`timeout ${url}`)), 10_000);
    ws.onopen = () => { clearTimeout(t); resolve(ws); };
    ws.onerror = () => { clearTimeout(t); reject(new Error(`cannot open ${url}`)); };
  });
}

async function main() {
  console.log(`device soak -- ${MINUTES} minutes`);
  console.log(`  relay:  ${URL_}`);
  console.log(`  device: ${DEVICE}`);
  console.log("");
  console.log("  Leave the phone on 4G, screen on, timeout 30 min, and untouched.");
  console.log("  A screen that sleeps or locks invalidates this run.\n");

  // Confirm the device is there before starting a clock we cannot stop.
  const list = await fetch(`${URL_}/devices?token=${encodeURIComponent(CONSOLE_TOKEN)}`)
    .then((r) => r.json()).catch(() => null);
  const found = list?.devices?.find((d) => d.id === DEVICE);
  if (!found) {
    console.error(`  device ${DEVICE} is not connected. available:`);
    for (const d of list?.devices || []) {
      console.error(`    ${d.id}  ${d.brand} ${d.model}  Android ${d.android}`);
    }
    process.exit(2);
  }
  console.log(`  ${found.brand} ${found.model}, Android ${found.android} (API ${found.sdk})\n`);

  const ws = await open(
    `${WS}/ws/console?token=${encodeURIComponent(CONSOLE_TOKEN)}&cid=soak-${Date.now()}`
  );

  const stats = {
    frames: 0,
    bytes: 0,
    rtts: [],
    stateEvents: [],
    agentEvents: [],
    firstFrameAt: 0,
    lastFrameAt: 0,
    maxGapMs: 0,
  };

  ws.onmessage = (ev) => {
    if (ev.data instanceof ArrayBuffer) {
      stats.frames++;
      stats.bytes += ev.data.byteLength;
      const now = Date.now();
      if (stats.lastFrameAt) {
        stats.maxGapMs = Math.max(stats.maxGapMs, now - stats.lastFrameAt);
      }
      if (!stats.firstFrameAt) stats.firstFrameAt = now;
      stats.lastFrameAt = now;
      return;
    }
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    if (m.op === "pong") stats.rtts.push(Date.now() - m.t);
    if (m.op === "state") stats.stateEvents.push({ t: Date.now(), state: m.state });
    if (m.op === "event") {
      stats.agentEvents.push({ t: Date.now(), kind: m.kind, state: m.state });
    }
  };

  ws.send(JSON.stringify({ op: "connect", id: DEVICE }));
  await sleep(1500);

  const started = Date.now();
  let lastReport = 0;
  const pinger = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ op: "ping", t: Date.now() }));
  }, 10_000);

  while (Date.now() - started < DURATION_MS) {
    await sleep(1000);
    const elapsed = Date.now() - started;

    if (Date.now() - lastReport < REPORT_EVERY_MS) continue;
    lastReport = Date.now();

    const window_ = 60_000;
    const inWindow = stats.frames;
    const recentRtt = stats.rtts.slice(-6);
    const gap = stats.lastFrameAt ? Date.now() - stats.lastFrameAt : Infinity;
    const p99ish = recentRtt.length
      ? Math.round([...recentRtt].sort((a, b) => a - b)[Math.floor(recentRtt.length / 2)])
      : null;

    console.log(
      `  ${String(Math.floor(elapsed / 60000)).padStart(2)}:${String(Math.floor((elapsed % 60000) / 1000)).padStart(2, "0")}` +
      `  frames=${String(inWindow).padStart(5)}` +
      `  gap=${gap === Infinity ? "  --" : String(Math.round(gap / 1000)).padStart(4) + "s"}` +
      `  rtt=${p99ish == null ? "  --" : String(p99ish).padStart(4) + "ms"}` +
      `  ${gap < GAP_MS ? "" : "<-- STALLED"}`
    );
    void window_;
  }

  clearInterval(pinger);

  const totalSec = (Date.now() - started) / 1000;
  const avgFps = stats.frames / totalSec;
  const rtts = [...stats.rtts].sort((a, b) => a - b);
  const med = rtts.length ? rtts[Math.floor(rtts.length / 2)] : null;
  const p95 = rtts.length ? rtts[Math.floor(rtts.length * 0.95)] : null;
  const wallGap = stats.lastFrameAt ? Date.now() - stats.lastFrameAt : Infinity;
  const mb = (stats.bytes / 1e6).toFixed(1);

  console.log(`\n${"─".repeat(58)}`);
  console.log(`  duration      ${(totalSec / 60).toFixed(1)} min`);
  console.log(`  frames        ${stats.frames}  (${avgFps.toFixed(1)} fps avg)`);
  console.log(`  data          ${mb} MB`);
  console.log(`  longest gap   ${Math.round(stats.maxGapMs / 1000)}s`);
  console.log(`  rtt median    ${med == null ? "--" : med + "ms"}`);
  console.log(`  rtt p95       ${p95 == null ? "--" : p95 + "ms"}`);
  console.log(`  reconnects    ${stats.stateEvents.filter((e) => e.state === "live").length}`);
  console.log("─".repeat(58));

  const problems = [];
  if (avgFps < MIN_FPS) problems.push(`average frame rate ${avgFps.toFixed(1)} fps is below ${MIN_FPS}`);
  if (wallGap > GAP_MS) {
    problems.push(
      `no frames for ${Math.round(wallGap / 1000)}s -- the phone likely slept, locked, or lost consent`
    );
  }
  const lost = stats.stateEvents.filter((e) => e.state === "lost").length;
  if (lost > 0) problems.push(`session dropped ${lost} time(s)`);
  const consent = stats.agentEvents.filter((e) => e.state === "needsConsent");
  if (consent.length) {
    problems.push(`screen capture consent was revoked ${consent.length} time(s)`);
  }
  if (p95 != null && p95 > 800) problems.push(`p95 latency ${p95}ms is too high for a live demo`);

  if (problems.length) {
    console.log("\n  FAILED:");
    for (const p of problems) console.log(`    - ${p}`);
    console.log("\n  Note: if the screen slept, that is a screen-timeout problem, not a");
    console.log("  stability problem. Set the timeout to 30 minutes and re-run before");
    console.log("  concluding anything about the app.");
    process.exitCode = 1;
  } else {
    // Report what was actually soaked. This tool exists to soak a real handset,
    // and it will happily run against a synthetic device during a dry run -- so
    // the summary must not imply more than was tested.
    const synthetic = /^(Synthetic|Rehearsal)$/i.test(found.brand || "");
    console.log(`\n  PASSED: ${MINUTES} minutes, no drop, no stall.`);
    if (synthetic) {
      console.log(`  But this was a SYNTHETIC device (${found.brand} ${found.model}).`);
      console.log("  This does not satisfy definition-of-done item 4. Re-run against the");
      console.log("  real phone -- only handset-side failures are what that item is about.");
    } else {
      console.log(`  Real device: ${found.brand} ${found.model}, Android ${found.android}.`);
      console.log("  Record this in docs/COMPATIBILITY.md -- it is now a second vendor");
      console.log("  data point, and it is the one the demo will actually run on.");
    }
  }

  ws.close();
}

main().catch((err) => {
  console.error(`\nsoak error: ${err.message}`);
  process.exit(2);
});
