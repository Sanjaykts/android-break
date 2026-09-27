#!/usr/bin/env node
/**
 * record-demo.mjs -- produce the prerecorded fallback video.
 *
 * The plan is unambiguous that `demo.mp4` is mandatory, not optional
 * (definition-of-done item 10, risk #10, and the first rung of the fallback
 * ladder). The runbook's hard rule is that anything wrong in the first 60
 * seconds means playing this instead of debugging live.
 *
 * It reuses the rehearsal choreography, so the video shows the same sequence the
 * presenter runs. The console's own record button drives the capture, which means
 * this also exercises the recording path rather than trusting it.
 *
 *   # with the real phone -- this is the real fallback video
 *   node tools/record-demo.mjs --url https://relay.example.workers.dev --device 3f2a1b9c
 *
 *   # without a phone -- a clearly-labelled rehearsal capture, NOT the fallback
 *   node tools/record-demo.mjs --url http://127.0.0.1:8787 --rehearsal
 *
 * The --rehearsal output is deliberately written to a different filename with a
 * banner burned in. Putting a mock-phone video at demo.mp4 is how a team ends up
 * presenting a fake on stage believing it is a backup of the real thing.
 */

import puppeteer from "puppeteer";
import fs from "node:fs";
import path from "node:path";
import { SyntheticAgent } from "./lib/synthetic-agent.mjs";
import { renderScreens } from "./lib/mock-phone.mjs";

const args = new Map();
for (let i = 2; i < process.argv.length; i++) {
  const key = process.argv[i].replace(/^--/, "");
  const next = process.argv[i + 1];
  // A valueless flag must not swallow the next one. Pairwise parsing silently ate
  // `--out` as the value of `--rehearsal` and then wrote to the wrong directory.
  if (next === undefined || next.startsWith("--")) args.set(key, true);
  else { args.set(key, next); i++; }
}

const HTTP = args.get("url") || "http://127.0.0.1:8787";
const WS = HTTP.replace(/^http/, "ws");
const CONSOLE_TOKEN = args.get("console-token") || process.env.CONSOLE_TOKEN || "dev-console-token";
const AGENT_TOKEN = args.get("agent-token") || process.env.AGENT_TOKEN || "dev-agent-token";
const DEVICE = args.get("device") || null;
const IS_REHEARSAL = args.get("rehearsal") === "true" || !DEVICE;
const OUT_DIR = args.get("out") || path.resolve(process.cwd());
const RES = { width: 1920, height: 1080 };

// A 4-minute demo with no room for dead air.
const SCRIPT = [
  { at: 0,    do: "goto" },
  { at: 1.5,  do: "pair" },
  { at: 5,    do: "speak", text: "Break Remote. One APK, three permissions, and the phone is drivable from a laptop." },
  { at: 11,   do: "speak", text: "This phone is on 4G. This laptop is on the venue wifi. They have never met." },
  { at: 18,   do: "speak", text: "Three permissions. Accessibility turns laptop input into real touch events." },
  { at: 25,   do: "speak", text: "Screen capture shows you this screen. Notifications make that unavoidable." },
  { at: 33,   do: "search" },
  { at: 38,   do: "speak", text: "Typing into a search field, from the laptop, over cellular." },
  { at: 45,   do: "openApp" },
  { at: 50,   do: "scroll" },
  { at: 55,   do: "speak", text: "Tap, swipe, and the screen is live the whole time." },
  { at: 63,   do: "back" },
  { at: 67,   do: "speak", text: "Hand it back. This is your phone. It still works." },
  { at: 76,   do: "ownerInteract" },
  { at: 83,   do: "speak", text: "Find by label. No coordinates." },
  { at: 89,   do: "find" },
  { at: 94,   do: "speak", text: "Three steps, zero manual input." },
  { at: 100,  do: "script" },
  { at: 110,  do: "speak", text: "And the whole thing is being recorded." },
  { at: 116,  do: "speak", text: "Consent-based. Not invisible, not root, uninstalls in two taps." },
  { at: 126,  do: "speak", text: "Enterprise MDM is the real boundary, on managed hardware." },
  { at: 136,  do: "end" },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const at = (s) => s * 1000;

function stamp(text) {
  const div = document.createElement("div");
  div.id = "brk-caption";
  div.textContent = text;
  div.style.cssText =
    "position:fixed;left:0;right:0;bottom:0;padding:18px 28px;background:rgba(8,11,14,.86);" +
    "color:#e6edf3;font:22px/1.4 -apple-system,'Segoe UI',Roboto,sans-serif;z-index:9999;" +
    "border-top:1px solid #232c35;min-height:28px";
  document.body.appendChild(div);
}
function clearStamp() { document.getElementById("brk-caption")?.remove(); }

function stampRec(on) {
  document.getElementById("brk-rec")?.remove();
  if (!on) return;
  const d = document.createElement("div");
  d.id = "brk-rec";
  d.textContent = "REC";
  d.style.cssText =
    "position:fixed;top:14px;right:18px;z-index:9999;display:flex;align-items:center;gap:9px;" +
    "padding:8px 14px;border-radius:8px;background:rgba(8,11,14,.85);color:#fff;" +
    "font:600 15px/1 -apple-system,'Segoe UI',Roboto,sans-serif;letter-spacing:.09em;" +
    "border:1px solid #3a2020";
  d.insertAdjacentHTML("afterbegin",
    '<span style="width:12px;height:12px;border-radius:50%;background:#ef4444;' +
    'display:inline-block"></span>');
  document.body.appendChild(d);
}

async function main() {
  const mode = IS_REHEARSAL ? "REHEARSAL (mock phone)" : `real device ${DEVICE}`;
  console.log(`recording demo -- ${mode}`);

  if (IS_REHEARSAL) {
    console.log("");
    console.log("  This will NOT be a usable fallback video. A mock phone on stage is");
    console.log("  worse than no video, because the audience will notice. Use it only");
    console.log("  to check the capture pipeline works, then re-record with --device.");
    console.log("");
  }

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
    ],
  });

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outPath = path.join(
    OUT_DIR,
    IS_REHEARSAL ? "console-rehearsal.webm" : "demo.mp4"
  );
  if (fs.existsSync(outPath)) fs.rmSync(outPath);

  let agent = null;
  let deviceId = DEVICE;

  try {
    if (IS_REHEARSAL) {
      const screens = await renderScreens(browser);
      agent = new SyntheticAgent({
        url: WS, token: AGENT_TOKEN, device: "rehearsal-device", screens, fps: 12,
      });
      await agent.connect();
      deviceId = "rehearsal-device";
    } else {
      const list = await fetch(`${HTTP}/devices?token=${encodeURIComponent(CONSOLE_TOKEN)}`)
        .then((r) => r.json()).catch(() => null);
      if (!list?.devices?.some((d) => d.id === DEVICE)) {
        console.error(`device ${DEVICE} is not connected. available:`);
        for (const d of list?.devices || []) console.error(`  ${d.id}  ${d.brand} ${d.model}`);
        process.exit(2);
      }
    }

    const page = await browser.newPage();
    await page.setViewport({ ...RES, deviceScaleFactor: 1 });

    const downloads = path.join(OUT_DIR, ".capture");
    fs.rmSync(downloads, { recursive: true, force: true });
    fs.mkdirSync(downloads, { recursive: true });
    const client = await page.createCDPSession();
    await client.send("Page.setDownloadBehavior", { behavior: "allow", downloadPath: downloads });

    // Overlays are injected into the console page rather than drawn on a second
    // page. A second page becomes the active tab, and a backgrounded page stops
    // firing requestAnimationFrame -- which silently hangs every waitForFunction,
    // including ones whose condition is already true.

    const t0 = Date.now();
    const box = { x: 0, y: 0, w: 1, h: 1 };
    const stageBox = async () => page.$eval("#stage", (c) => {
      const r = c.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    });

    let recording = false;

    for (const step of SCRIPT) {
      const wait = at(step.at) - (Date.now() - t0);
      if (wait > 0) await sleep(wait);

      switch (step.do) {
        case "goto":
          // domcontentloaded, not networkidle: the console holds a WebSocket open
          // for the whole session, so "network idle" is not a state this page
          // ever reaches. Wait for the console's own readiness signal instead.
          await page.goto(`${HTTP}/?token=${encodeURIComponent(CONSOLE_TOKEN)}`,
            { waitUntil: "domcontentloaded" });
          await page.waitForFunction(
            () => /connected/.test(document.querySelector("#relay-status")?.textContent || ""),
            { timeout: 20000 });
          break;

        case "pair": {
          await page.waitForFunction(
            (id) => [...document.querySelectorAll("#device-list .device")]
              .some((r) => (r.querySelector(".meta")?.textContent || "").includes(id)),
            { timeout: 20000 }, deviceId);
          // No optional chaining here. A silent no-op click would leave the page
          // on the device list while the recorder waits 25s for frames that can
          // never arrive, and the failure would point at the wrong thing.
          const clicked = await page.evaluate((id) => {
            const row = [...document.querySelectorAll("#device-list .device")]
              .find((r) => (r.querySelector(".meta")?.textContent || "").includes(id));
            if (!row) return false;
            row.click();
            return true;
          }, deviceId);
          if (!clicked) throw new Error(`device ${deviceId} was in the list but could not be clicked`);

          const live = await page.waitForFunction(
            () => document.querySelector("#stage").width === 480,
            { timeout: 25000 },
          ).then(() => true).catch(() => false);
          if (!live) {
            const state = await page.evaluate(() => ({
              stageHidden: document.querySelector("#screen-stage").classList.contains("hidden"),
              canvas: `${document.querySelector("#stage").width}x${document.querySelector("#stage").height}`,
              banner: document.querySelector("#banner")?.textContent,
              log: document.querySelector("#log")?.textContent?.slice(-300),
            }));
            throw new Error(`no frames after pairing: ${JSON.stringify(state)}`);
          }
          Object.assign(box, await stageBox());
          // Record the entire take. Beat 5 is a demonstration of the record
          // button; the *fallback* video is a capture of the whole demo, and
          // starting the recorder only for the last few seconds would produce a
          // 17-second clip that shows nothing.
          await page.click("#rec-btn");
          recording = true;
          await page.evaluate(stampRec, true);
          break;
        }

        case "speak":
          await page.evaluate(stamp, step.text);
          // Also set the caption inside the recording. DOM overlays are outside
          // the captured canvas, so a caption that is only in the page never
          // reaches the file.
          await page.evaluate((t) => window.brkCaption?.(t), step.text);
          break;

        case "search": {
          const b = await stageBox(); Object.assign(box, b);
          await page.mouse.click(b.x + b.w * 0.5, b.y + b.h * 0.14);
          await page.keyboard.type("break remote", { delay: 70 });
          if (agent) { agent.reset(); }
          break;
        }

        case "openApp": {
          const b = await stageBox();
          await page.mouse.click(b.x + b.w * 0.62, b.y + b.h * 0.28);
          if (agent) agent.setScreen("chat", 6000);
          break;
        }

        case "scroll": {
          const b = await stageBox();
          await page.mouse.move(b.x + b.w * 0.5, b.y + b.h * 0.7);
          await page.mouse.down();
          await page.mouse.move(b.x + b.w * 0.5, b.y + b.h * 0.35, { steps: 12 });
          await page.mouse.up();
          break;
        }

        case "back":
          await page.click('[data-global="back"]');
          if (agent) agent.setScreen("home", 5000);
          break;

        case "ownerInteract": {
          const b = await stageBox();
          await page.mouse.click(b.x + b.w * 0.5, b.y + b.h * 0.35);
          await page.mouse.move(b.x + b.w * 0.5, b.y + b.h * 0.8);
          await page.mouse.down();
          await page.mouse.move(b.x + b.w * 0.5, b.y + b.h * 0.45, { steps: 10 });
          await page.mouse.up();
          if (agent) agent.setScreen("feed", 6000);
          break;
        }

        case "find":
          await page.click("#find-input", { clickCount: 3 });
          await page.type("#find-input", "Settings");
          await page.click("#find-click");
          if (agent) agent.setScreen("settings", 7000);
          break;

        case "script":
          await page.$eval("#script-input", (el) => {
            el.value = JSON.stringify([
              { op: "global", action: "home" },
              { op: "find", text: "Settings", action: "click" },
              { op: "swipe", x1: 240, y1: 600, x2: 240, y2: 320, ms: 300 },
            ]);
          });
          await page.click("#script-run");
          break;

        case "end":
          if (recording) { await page.click("#rec-btn"); recording = false; }
          await page.evaluate(stampRec, false);
          await page.evaluate(clearStamp);
          await page.evaluate(() => window.brkCaption?.(""));
          // Hold a beat on the closing frame instead of cutting to black.
          await sleep(1500);
          break;
      }
    }

    // Let the recorder flush and the download land.
    await sleep(3000);
    const files = fs.readdirSync(downloads).filter((f) => f.endsWith(".webm"));
    if (!files.length) {
      console.error("\nno recording was produced.");
      process.exitCode = 1;
    } else {
      const src = path.join(downloads, files[0]);
      fs.copyFileSync(src, outPath);
      const kb = (fs.statSync(outPath).size / 1024).toFixed(0);
      console.log(`\nwrote ${outPath} (${kb} KB)`);
      if (IS_REHEARSAL) {
        console.log("\n  This is a REHEARSAL capture with a mock phone.");
        console.log("  It is not the fallback video. Re-record with --device <id>.");
      } else {
        console.log("\n  Play it once, end to end, before you rely on it.");
      }
    }
  } finally {
    if (agent) agent.close();
    await browser.close();
  }
}

main().catch((err) => {
  console.error(`\nrecorder error: ${err.stack || err.message}`);
  process.exit(2);
});
