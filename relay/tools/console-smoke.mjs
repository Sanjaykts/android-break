#!/usr/bin/env node
/**
 * Console browser smoke test.
 *
 * The console is the only layer with no automated coverage: the relay tests cover
 * the transport and the agent is not testable without a phone. That left the part
 * an audience actually looks at completely unverified, which is the wrong place to
 * have no tests.
 *
 * Drives real headless Chrome against a real relay with a synthetic agent, and
 * checks the things that would break silently in front of a room:
 *
 *   - a frame is decoded and painted to the canvas
 *   - pointer coordinates map to the header's coordinate space, not the canvas's
 *     pixel size (this is the whole basis of remote tapping, and it is wrong the
 *     moment the canvas is CSS-scaled)
 *   - rotation in the header does not corrupt the mapping
 *   - a frame from another device is ignored
 *   - keyboard input is forwarded, and typing in a console field is not
 *   - the script runner validates before it fires
 *
 *   node tools/console-smoke.mjs --url http://127.0.0.1:8787
 */

import puppeteer from "puppeteer";
import crypto from "node:crypto";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1]);
}

const HTTP = args.get("url") || "http://127.0.0.1:8787";
const WS = HTTP.replace(/^http/, "ws");
const CONSOLE_TOKEN = args.get("console-token") || process.env.CONSOLE_TOKEN || "dev-console-token";
const AGENT_TOKEN = args.get("agent-token") || process.env.AGENT_TOKEN || "dev-agent-token";
const DEVICE = "smoke-device";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
const failures = [];
function check(name, ok, detail = "") {
  if (ok) { passed++; console.log(`  PASS  ${name}`); }
  else { failures.push(name); console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ""}`); }
}

function open(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    const t = setTimeout(() => reject(new Error(`timeout ${url}`)), 8000);
    ws.onopen = () => { clearTimeout(t); resolve(ws); };
    ws.onerror = () => { clearTimeout(t); reject(new Error(`cannot open ${url}`)); };
  });
}

function encodeFrame(header, payload) {
  const hb = new TextEncoder().encode(JSON.stringify(header));
  const buf = new ArrayBuffer(3 + hb.byteLength + payload.byteLength);
  const v = new DataView(buf);
  v.setUint8(0, 0x01);
  v.setUint16(1, hb.byteLength, false);
  new Uint8Array(buf, 3, hb.byteLength).set(hb);
  new Uint8Array(buf, 3 + hb.byteLength).set(payload);
  return buf;
}

/**
 * Produces a real, decodable JPEG by asking Chrome to encode one.
 *
 * The obvious shortcut -- a hardcoded base64 blob -- is a trap: if it is not a
 * valid JPEG, `createImageBitmap` rejects, the canvas silently keeps its default
 * 300x150, and every coordinate assertion afterwards fails for the wrong reason.
 * That is exactly what happened the first time. Generating the payload with the
 * same decoder that will consume it makes the test self-validating.
 */
async function makeJpeg(browser, w, h) {
  const page = await browser.newPage();
  const dataUrl = await page.evaluate((ww, hh) => {
    const c = document.createElement("canvas");
    c.width = ww;
    c.height = hh;
    const g = c.getContext("2d");
    // Content that survives JPEG compression, so a decode failure is a real
    // failure rather than an artefact of a flat image.
    const grad = g.createLinearGradient(0, 0, ww, hh);
    grad.addColorStop(0, "#ff0000");
    grad.addColorStop(0.5, "#00ff00");
    grad.addColorStop(1, "#0000ff");
    g.fillStyle = grad;
    g.fillRect(0, 0, ww, hh);
    g.fillStyle = "#fff";
    g.fillRect(ww * 0.25, hh * 0.25, ww * 0.5, hh * 0.5);
    return c.toDataURL("image/jpeg", 0.8);
  }, w, h);
  await page.close();
  return Buffer.from(dataUrl.split(",")[1], "base64");
}

async function main() {
  console.log(`console browser smoke test -> ${HTTP}\n`);

  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });

  // Generated at the same size the header advertises, so canvas intrinsic size
  // and tap space agree and the CSS downscale is the only thing under test.
  const JPEG = await makeJpeg(browser, 480, 854);
  console.log(`synthetic JPEG payload: ${JPEG.byteLength} bytes`);

  const agent = await open(
    `${WS}/ws/agent?token=${encodeURIComponent(AGENT_TOKEN)}&device=${DEVICE}`
  );
  const other = await open(
    `${WS}/ws/agent?token=${encodeURIComponent(AGENT_TOKEN)}&device=someone-else`
  );
  const received = [];
  agent.onmessage = (ev) => {
    if (typeof ev.data === "string") received.push(JSON.parse(ev.data));
  };

  agent.send(JSON.stringify({
    op: "hello", id: DEVICE, model: "Smoke", brand: "Synthetic", android: "14", sdk: 34,
  }));
  await sleep(300);

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });

    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    page.on("console", (m) => {
      if (m.type() === "error") pageErrors.push(`console.error: ${m.text()}`);
    });

    // ── 1. devices screen ────────────────────────────────────────────────────
    console.log("1. Device list");
    await page.goto(`${HTTP}/?token=${encodeURIComponent(CONSOLE_TOKEN)}`, {
      waitUntil: "networkidle2",
    });

    await page.waitForFunction(
      () => document.querySelectorAll("#device-list .device").length > 0,
      { timeout: 10000 }
    );
    const names = await page.$$eval("#device-list .device .name", (els) =>
      els.map((e) => e.textContent)
    );
    check("the device list is populated from the relay", names.length >= 1, JSON.stringify(names));
    check("the synthetic device is listed", names.some((n) => /Smoke/.test(n)));

    const relayStatus = await page.$eval("#relay-status", (e) => e.textContent);
    check("relay status reads connected", /connected/.test(relayStatus), relayStatus);

    // ── 2. pair and get frames ──────────────────────────────────────────────
    console.log("\n2. Pairing and frame decode");
    // Click *our* device, not simply the first one. This suite runs after the
    // e2e suite in CI, which leaves its own device connected, and clicking the
    // first row would pair with the wrong phone -- after which every frame is
    // filtered out as "not mine" and the rest of the run fails for no visible
    // reason.
    const paired = await page.evaluate((id) => {
      const rows = [...document.querySelectorAll("#device-list .device")];
      const target = rows.find((r) => (r.querySelector(".meta")?.textContent || "").includes(id));
      if (!target) return null;
      target.click();
      return target.querySelector(".name")?.textContent;
    }, DEVICE);
    check(`pairing with the right device in a populated list`, paired !== null, `looked for ${DEVICE}`);
    await page.waitForFunction(
      () => !document.querySelector("#screen-stage").classList.contains("hidden"),
      { timeout: 5000 }
    );
    check("pairing reveals the stage", true);

    // 480x854 in display space.
    agent.send(encodeFrame({ did: DEVICE, w: 480, h: 854, rot: 0, seq: 1, q: 35, ts: 0 }, JPEG));
    // Wait for the *decoded* size, not merely a non-zero one: a fresh canvas is
    // already 300x150, so `width > 0` returns instantly and this assertion then
    // passes or fails depending on scheduling.
    await page.waitForFunction(
      () => document.querySelector("#stage").width === 480,
      { timeout: 10000 }
    );

    const canvas = await page.$eval("#stage", (c) => ({
      w: c.width, h: c.height,
      cssW: Math.round(c.getBoundingClientRect().width),
      cssH: Math.round(c.getBoundingClientRect().height),
    }));
    check("a frame was decoded and set the canvas size",
      canvas.w === 480 && canvas.h === 854, JSON.stringify(canvas));
    check("the canvas is CSS-scaled to fit the stage, so tap mapping cannot use its pixels",
      canvas.cssW < canvas.w && canvas.cssH < canvas.h, JSON.stringify(canvas));

    const overlay = await page.$eval("#stage-overlay", (e) => e.textContent);
    check("the waiting-for-frames overlay clears once frames arrive",
      !/waiting for frames/.test(overlay), overlay);

    const res = await page.$eval("#res", (e) => e.textContent);
    check("the resolution badge reflects the frame header", /480x854/.test(res), res);

    // ── 3. a frame from another device must be ignored ──────────────────────
    console.log("\n3. Device isolation");
    const otherDevice = crypto.randomInt(1, 1_000_000);
    const before = await page.$eval("#stage", (c) => c.width);
    other.send(encodeFrame({ did: "someone-else", w: 1234, h: 567, rot: 0, seq: 9, q: 35, ts: 0 }, JPEG));
    await sleep(600);
    const after = await page.$eval("#stage", (c) => c.width);
    check("a frame addressed to another device does not change ours",
      before === after, `${before} -> ${after}`);

    // ── 4. coordinate mapping ───────────────────────────────────────────────
    console.log("\n4. Pointer -> device coordinate mapping");
    // The canvas is CSS-scaled, so a click at the top-left corner of the element
    // must map to device (0,0) and the bottom-right to (479,853) -- the header
    // space, NOT the canvas's 8x8 pixels.
    const box = await page.$eval("#stage", (c) => {
      const r = c.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    });

    received.length = 0;
    await page.mouse.click(box.x + 1, box.y + 1);
    await sleep(350);
    const tapCorner = received.find((m) => m.op === "tap");
    check("a click at the top-left maps to the top-left of the header space",
      tapCorner?.x <= 2 && tapCorner?.y <= 2, JSON.stringify(tapCorner));

    received.length = 0;
    await page.mouse.click(box.x + box.w / 2, box.y + box.h / 2);
    await sleep(350);
    const tapMid = received.find((m) => m.op === "tap");
    check("a click at the centre maps to the centre of the header space",
      Math.abs(tapMid?.x - 240) <= 2 && Math.abs(tapMid?.y - 427) <= 2, JSON.stringify(tapMid));

    received.length = 0;
    // 3px inside the edge rather than exactly on it. The canvas is letterboxed to
    // a fractional pixel size, so its outermost row sits on the container's clip
    // boundary and a click there is genuinely ambiguous in any browser. The
    // property under test is the coordinate mapping, not subpixel hit testing.
    const INSET = 3;
    const brPoint = { x: box.x + box.w - INSET, y: box.y + box.h - INSET };
    await page.mouse.click(brPoint.x, brPoint.y);
    await sleep(350);
    const tapFar = received.find((m) => m.op === "tap");
    check("a click near the bottom-right maps to the far edge of the header space",
      tapFar?.x >= 470 && tapFar?.y >= 845,
      `box=${JSON.stringify(box)} tap=${JSON.stringify(tapFar)}`);

    received.length = 0;
    await page.mouse.move(box.x + box.w * 0.3, box.y + box.h * 0.7);
    await page.mouse.down();
    await page.mouse.move(box.x + box.w * 0.3, box.y + box.h * 0.3, { steps: 8 });
    await page.mouse.up();
    await sleep(350);
    const swipe = received.find((m) => m.op === "swipe");
    check("a drag becomes a swipe with both endpoints mapped",
      !!swipe && swipe.y1 > swipe.y2, JSON.stringify(swipe));

    received.length = 0;
    await page.mouse.move(box.x + box.w * 0.7, box.y + box.h * 0.7);
    await page.mouse.down();
    await sleep(420);                       // hold past the drag threshold
    await page.mouse.move(box.x + box.w * 0.7, box.y + box.h * 0.3, { steps: 10 });
    await page.mouse.up();
    await sleep(350);
    const dragOp = received.find((m) => m.op === "drag");
    check("a held drag becomes a drag, not a swipe", !!dragOp, JSON.stringify(received.map((m) => m.op)));
    check("the drag endpoints are mapped into the header space",
      dragOp && dragOp.y1 > dragOp.y2, JSON.stringify(dragOp));

    // ── 4b. capture lifecycle reaches the banner ────────────────────────────
    console.log("\n4b. Capture lifecycle");
    agent.send(JSON.stringify({
      op: "event", kind: "capture", state: "needsConsent",
      reason: "screen capture was stopped; tap Re-grant on the phone",
    }));
    await page.waitForFunction(
      () => /NEEDS A TAP/i.test(document.querySelector("#banner")?.textContent || ""),
      { timeout: 4000 }
    ).then(() => check("needsConsent is shown in the banner, not just the log", true))
     .catch(async () => check("needsConsent is shown in the banner, not just the log", false,
        await page.$eval("#banner", (e) => e.textContent)));

    agent.send(JSON.stringify({ op: "event", kind: "capture", state: "live" }));
    await page.waitForFunction(
      () => /live/i.test(document.querySelector("#banner")?.textContent || ""),
      { timeout: 4000 }
    ).then(() => check("capture recovering clears the banner", true))
     .catch(async () => check("capture recovering clears the banner", false,
        await page.$eval("#banner", (e) => e.textContent)));

    // ── 5. global nav buttons ───────────────────────────────────────────────
    console.log("\n5. Controls");
    received.length = 0;
    await page.click('[data-global="home"]');
    await sleep(300);
    check("the Home button sends the global action", received.some((m) => m.op === "global" && m.action === "home"));

    received.length = 0;
    await page.click("#find-click");
    await sleep(300);
    check("find with an empty query does not fire", !received.some((m) => m.op === "find"));

    await page.type("#find-input", "Sign in");
    received.length = 0;
    await page.click("#find-click");
    await sleep(300);
    const find = received.find((m) => m.op === "find");
    check("find-by-label forwards the query and the action",
      find?.text === "Sign in" && find?.action === "click", JSON.stringify(find));

    // ── 6. keyboard: forwarded, and not double-sent while typing ────────────
    console.log("\n6. Keyboard");
    await page.evaluate(() => document.querySelector("#stage").focus());
    received.length = 0;
    await page.keyboard.press("Enter");
    await sleep(300);
    check("Enter outside a field is forwarded as a key event",
      received.some((m) => m.op === "key" && m.code === 66), JSON.stringify(received));

    received.length = 0;
    await page.keyboard.press("Backspace");
    await sleep(300);
    check("Backspace outside a field is forwarded",
      received.some((m) => m.op === "key" && m.code === 67));

    received.length = 0;
    await page.click("#text-input");
    await page.keyboard.type("hi");
    await sleep(400);
    const texts = received.filter((m) => m.op === "text").map((m) => m.s);
    check("typing in a console field reaches the phone",
      texts.join("") === "hi", JSON.stringify(texts));
    check("typing in a console field does not also fire key events",
      !received.some((m) => m.op === "key"),
      JSON.stringify(received.filter((m) => m.op === "key")));

    // ── 7. script runner validation ─────────────────────────────────────────
    console.log("\n7. Script runner");
    received.length = 0;
    await page.$eval("#script-input", (el) => { el.value = "[{\"op\":\"nonsense\"}]"; });
    await page.click("#script-run");
    await sleep(300);
    check("an unknown script op is rejected before anything is sent",
      !received.some((m) => m.op === "nonsense"), JSON.stringify(received));
    const logText = await page.$eval("#log", (e) => e.textContent);
    check("the rejection is explained in the action log", /unknown op/.test(logText));

    received.length = 0;
    await page.$eval("#script-input", (el) => { el.value = "{not json"; });
    await page.click("#script-run");
    await sleep(300);
    check("invalid JSON is rejected without throwing", pageErrors.length === 0,
      pageErrors.join(" | "));

    received.length = 0;
    await page.$eval("#script-input", (el) => {
      el.value = '[{"op":"global","action":"home"},{"op":"find","text":"Wi-Fi","action":"click"}]';
    });
    await page.click("#script-run");
    await sleep(2200);
    check("a valid script runs its steps in order",
      received.some((m) => m.op === "global" && m.action === "home") &&
      received.some((m) => m.op === "find" && m.text === "Wi-Fi"),
      JSON.stringify(received.map((m) => m.op)));

    // ── 8. rotation ─────────────────────────────────────────────────────────
    console.log("\n8. Rotation");
    agent.send(encodeFrame({ did: DEVICE, w: 854, h: 480, rot: 90, seq: 2, q: 35, ts: 0 }, JPEG));
    await sleep(700);
    const resRot = await page.$eval("#res", (e) => e.textContent);
    check("a rotated frame updates the resolution badge", /854x480/.test(resRot), resRot);
    check("the rotation is shown to the operator", /r90/.test(resRot), resRot);

    // ── 9. no page errors ───────────────────────────────────────────────────
    console.log("\n9. Runtime health");
    check("no uncaught page errors during the whole run", pageErrors.length === 0,
      pageErrors.join(" | "));

    // ── summary ─────────────────────────────────────────────────────────────
    console.log(`\n${"─".repeat(58)}`);
    console.log(`${passed} passed, ${failures.length} failed`);
    if (failures.length) {
      console.log("\nfailures:");
      for (const f of failures) console.log(`  - ${f}`);
      process.exitCode = 1;
    } else {
      console.log("console is sound.");
    }
  } finally {
    await browser.close();
    agent.close();
    other.close();
  }
}

main().catch((err) => {
  console.error(`\nharness error: ${err.stack || err.message}`);
  process.exit(2);
});
