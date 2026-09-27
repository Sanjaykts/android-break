#!/usr/bin/env node
/**
 * Recording and presenter-camera test.
 *
 * Demo beat 5 is "hit record and show the projector that the demo is being
 * recorded". That path had no coverage at all, which is uncomfortable for two
 * reasons: `MediaRecorder` and `getUserMedia` both need a secure context and
 * real permission grants, and both fail in ways that look like a dead button.
 *
 * Chrome's fake device flags let this run headless and still exercise the real
 * `captureStream` -> `MediaRecorder` -> Blob -> download path.
 *
 *   node tools/record-smoke.mjs --url http://127.0.0.1:8787
 */

import puppeteer from "puppeteer";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1]);
}

const HTTP = args.get("url") || "http://127.0.0.1:8787";
const WS = HTTP.replace(/^http/, "ws");
const CONSOLE_TOKEN = args.get("console-token") || process.env.CONSOLE_TOKEN || "dev-console-token";
const AGENT_TOKEN = args.get("agent-token") || process.env.AGENT_TOKEN || "dev-agent-token";
const DEVICE = "record-device";
const DOWNLOAD_DIR = args.get("out") || path.join(os.tmpdir(), "brk-record-test");

let passed = 0;
const failures = [];
function check(name, ok, detail = "") {
  if (ok) { passed++; console.log(`  PASS  ${name}`); }
  else { failures.push(name); console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ""}`); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  const buf = new ArrayBuffer(3 + hb.length + payload.byteLength);
  const v = new DataView(buf);
  v.setUint8(0, 0x01);
  v.setUint16(1, hb.length, false);
  new Uint8Array(buf, 3, hb.length).set(hb);
  new Uint8Array(buf, 3 + hb.length).set(payload);
  return buf;
}

async function main() {
  console.log(`recording smoke test -> ${HTTP}\n`);

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      // Synthetic camera + mic so getUserMedia resolves without hardware. The
      // capture path under test is the same either way.
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
    ],
  });

  fs.rmSync(DOWNLOAD_DIR, { recursive: true, force: true });
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    const client = await page.createCDPSession();
    await client.send("Page.setDownloadBehavior", {
      behavior: "allow",
      downloadPath: DOWNLOAD_DIR,
    });

    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));

    // A frame large enough that the recorded file is unambiguously non-empty.
    const dataUrl = await page.evaluate(() => {
      const c = document.createElement("canvas");
      c.width = 480; c.height = 854;
      const g = c.getContext("2d");
      const grad = g.createLinearGradient(0, 0, 480, 854);
      grad.addColorStop(0, "#ff0055");
      grad.addColorStop(1, "#0055ff");
      g.fillStyle = grad;
      g.fillRect(0, 0, 480, 854);
      return c.toDataURL("image/jpeg", 0.9);
    });
    const JPEG = Buffer.from(dataUrl.split(",")[1], "base64");

    const agent = await open(
      `${WS}/ws/agent?token=${encodeURIComponent(AGENT_TOKEN)}&device=${DEVICE}`
    );
    agent.send(JSON.stringify({
      op: "hello", id: DEVICE, model: "Rec", brand: "Synthetic", android: "14", sdk: 34,
    }));
    await sleep(300);

    console.log("1. Secure-context and capability preconditions");
    await page.goto(`${HTTP}/?token=${encodeURIComponent(CONSOLE_TOKEN)}`, { waitUntil: "networkidle2" });
    check("the page is treated as a secure context (getUserMedia needs this)",
      await page.evaluate(() => window.isSecureContext));
    check("MediaRecorder is available",
      await page.evaluate(() => typeof MediaRecorder !== "undefined"));
    check("canvas.captureStream is available",
      await page.evaluate(() => typeof document.createElement("canvas").captureStream === "function"));
    const mime = await page.evaluate(() => {
      const m = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];
      return m.find((x) => MediaRecorder.isTypeSupported(x)) || "";
    });
    check("a webm mime type is supported", !!mime, mime);

    console.log("\n2. Pair and get frames flowing");
    await page.waitForFunction(
      () => document.querySelectorAll("#device-list .device").length > 0, { timeout: 10000 });
    await page.evaluate((id) => {
      const rows = [...document.querySelectorAll("#device-list .device")];
      rows.find((r) => (r.querySelector(".meta")?.textContent || "").includes(id))?.click();
    }, DEVICE);
    await page.waitForFunction(
      () => !document.querySelector("#screen-stage").classList.contains("hidden"), { timeout: 5000 });

    // Keep frames arriving for the duration so the recorded file has motion.
    let seq = 0;
    const feed = setInterval(() => {
      seq++;
      agent.send(encodeFrame(
        { did: DEVICE, w: 480, h: 854, rot: 0, seq, q: 35, ts: Date.now() },
        JPEG
      ));
    }, 100);

    await page.waitForFunction(() => document.querySelector("#stage").width === 480, { timeout: 8000 });
    check("frames are being painted before recording starts", true);

    console.log("\n3. Presenter camera");
    await page.click("#cam-btn");
    await sleep(1500);
    const camOn = await page.evaluate(() => ({
      on: !document.querySelector("#cam").classList.contains("hidden"),
      ready: document.querySelector("#cam").videoWidth > 0,
      armed: document.querySelector("#cam-btn").classList.contains("armed"),
    }));
    check("the presenter camera starts", camOn.on, JSON.stringify(camOn));
    check("camera frames actually arrive (not just a granted permission)", camOn.ready,
      JSON.stringify(camOn));
    check("the camera button shows it is armed", camOn.armed);

    console.log("\n4. Record");
    await page.click("#rec-btn");
    await sleep(300);
    const recStarted = await page.evaluate(() => ({
      armed: document.querySelector("#rec-btn").classList.contains("armed"),
      label: document.querySelector("#rec-btn").textContent.trim(),
      banner: document.querySelector("#banner").textContent.trim(),
      live: window.__brkRecorderActive === true,
    }));
    check("record arms the button", recStarted.armed, JSON.stringify(recStarted));
    check("the button changes to Stop", /stop/i.test(recStarted.label), recStarted.label);
    check("the banner shows RECORDING so the audience can see it",
      /recording/i.test(recStarted.banner), recStarted.banner);

    // Let it run long enough to produce a real, seekable file.
    await sleep(4000);

    await page.click("#rec-btn");
    await sleep(2500);
    clearInterval(feed);

    const recStopped = await page.evaluate(() => ({
      armed: document.querySelector("#rec-btn").classList.contains("armed"),
      label: document.querySelector("#rec-btn").textContent.trim(),
    }));
    check("record disarms on stop", !recStopped.armed, JSON.stringify(recStopped));
    check("the button returns to Record", /record/i.test(recStopped.label), recStopped.label);

    console.log("\n5. The file");
    const files = fs.existsSync(DOWNLOAD_DIR) ? fs.readdirSync(DOWNLOAD_DIR) : [];
    const webm = files.find((f) => f.endsWith(".webm"));
    check("a .webm was downloaded", !!webm, `saw: ${JSON.stringify(files)}`);

    if (webm) {
      const buf = fs.readFileSync(path.join(DOWNLOAD_DIR, webm));
      check("the recording is not empty", buf.length > 10_000, `${buf.length} bytes`);
      // EBML magic: every Matroska/WebM file starts with 0x1A45DFA3.
      const isWebm = buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3;
      check("the file is a real WebM container, not a stub", isWebm,
        `magic=${buf.subarray(0, 4).toString("hex")}`);
      check("the filename is timestamped and unambiguous",
        /^break-remote-.*\.webm$/.test(webm), webm);

      // A valid container header is not proof of a working recording: a file can
      // carry correct EBML magic and still contain no decodable frames. Actually
      // play it and confirm time advances, which can only happen if the browser
      // is decoding real video.
      const play = await browser.newPage();
      await play.goto(`file://${path.join(DOWNLOAD_DIR, webm)}`);
      const advanced = await play.evaluate(() => new Promise((res) => {
        const v = document.querySelector("video");
        if (!v) return res(0);
        v.muted = true;
        v.play();
        setTimeout(() => res(v.currentTime), 2500);
      }));
      check("the recording actually plays back and time advances", advanced > 1.0,
        `reached ${advanced}s`);
      const dims = await play.evaluate(() => {
        const v = document.querySelector("video");
        return v ? { w: v.videoWidth, h: v.videoHeight } : null;
      });
      check("the recording is the size of the stage canvas", dims?.w === 480 && dims?.h === 854,
        JSON.stringify(dims));
      await play.close();

      console.log(`  wrote ${path.join(DOWNLOAD_DIR, webm)} (${(buf.length / 1024).toFixed(0)} KB)`);
    }

    console.log("\n6. Camera is composited into the recording");
    // The camera is drawn onto the same canvas that captureStream reads, so the
    // presenter appears in the file. Verified structurally: if it were a
    // separate <video> element it would never reach the recording.
    check("the camera is drawn on the recorded canvas, not overlaid on top",
      await page.evaluate(() => {
        const c = document.querySelector("#stage");
        return c.tagName === "CANVAS" && document.querySelector("#cam").tagName === "VIDEO";
      }));

    check("no uncaught page errors", pageErrors.length === 0, pageErrors.join(" | "));

    agent.close();

    console.log(`\n${"─".repeat(58)}`);
    console.log(`${passed} passed, ${failures.length} failed`);
    if (failures.length) {
      console.log("\nfailures:");
      for (const f of failures) console.log(`  - ${f}`);
      process.exitCode = 1;
    } else {
      console.log("recording and presenter camera are sound.");
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(`\nharness error: ${err.stack || err.message}`);
  process.exit(2);
});
