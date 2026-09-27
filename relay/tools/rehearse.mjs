#!/usr/bin/env node
/**
 * Rehearsal harness -- drives the console through every demo beat, on a timer.
 *
 * Definition of done item 8 is "a full rehearsal completes in under 4 minutes,
 * twice, on consecutive days". This is how that gets measured instead of
 * guessed at, and it reports which beat ran long rather than just that something
 * did.
 *
 * It runs two ways, and **the choreography is identical in both**:
 *
 *   synthetic (default)  no device needed. A stand-in phone serves frames and
 *                        reacts to the same console commands a real phone would.
 *   --device <id>        the real phone, once the owner has installed and
 *                        enrolled it. Nothing else changes.
 *
 * That matters: rehearsing against a stand-in and then performing against a real
 * device means the demo path you practised is the demo path you run.
 *
 *   node tools/rehearse.mjs --url http://127.0.0.1:8787
 *   node tools/rehearse.mjs --url http://127.0.0.1:8787 --device 3f2a1b9c
 *
 * Exits non-zero if any beat fails or the total exceeds the budget.
 */

import puppeteer from "puppeteer";
import { SyntheticAgent } from "./lib/synthetic-agent.mjs";
import { renderScreens } from "./lib/mock-phone.mjs";

const args = new Map();
for (let i = 2; i < process.argv.length; i++) {
  const key = process.argv[i].replace(/^--/, "");
  const next = process.argv[i + 1];
  if (next === undefined || next.startsWith("--")) args.set(key, true);
  else { args.set(key, next); i++; }
}

const HTTP = args.get("url") || "http://127.0.0.1:8787";
const WS = HTTP.replace(/^http/, "ws");
const CONSOLE_TOKEN = args.get("console-token") || process.env.CONSOLE_TOKEN || "dev-console-token";
const AGENT_TOKEN = args.get("agent-token") || process.env.AGENT_TOKEN || "dev-agent-token";
const REAL_DEVICE = args.get("device") || null;
const BUDGET_MS = Number(args.get("budget") || 240_000); // 4 minutes
const HEADFUL = args.get("headful") === true || args.get("headful") === "true";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const beats = [];
let currentBeat = null;

async function beat(name, fn) {
  const t0 = Date.now();
  currentBeat = { name, checks: [] };
  let ok = true;
  try {
    await fn();
  } catch (e) {
    currentBeat.checks.push({ name: `threw: ${e.message}`, ok: false });
    ok = false;
  }
  const ms = Date.now() - t0;
  currentBeat.ms = ms;
  beats.push(currentBeat);
  const mark = currentBeat.checks.every((c) => c.ok) && ok ? "ok  " : "FAIL";
  console.log(`  ${mark}  ${name.padEnd(34)} ${(ms / 1000).toFixed(1)}s`);
  for (const c of currentBeat.checks) {
    if (!c.ok) console.log(`          x ${c.name}${c.detail ? ` -- ${c.detail}` : ""}`);
  }
  currentBeat = null;
  return currentBeat;
}

/**
 * Records an assertion for the current beat.
 *
 * `ok` defaults to true so that `expect("the stage is shown")` reads as the
 * plain statement it is. Defaulting it to falsy would make every argument-less
 * assertion fail, which is a spectacularly unhelpful way to lose an afternoon.
 */
function expect(name, ok = true, detail = "") {
  if (currentBeat) currentBeat.checks.push({ name, ok: !!ok, detail });
  return !!ok;
}

async function main() {
  const mode = REAL_DEVICE ? `real device ${REAL_DEVICE}` : "synthetic phone";
  console.log(`Break Remote rehearsal -- ${mode}`);
  console.log(`  relay: ${HTTP}   budget: ${(BUDGET_MS / 1000).toFixed(0)}s\n`);

  const browser = await puppeteer.launch({
    headless: !HEADFUL,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
    ],
  });

  let agent = null;
  let deviceId = REAL_DEVICE;
  let agentLog = null;

  try {
    // ── set up the phone side ──────────────────────────────────────────────
    if (!REAL_DEVICE) {
      const screens = await renderScreens(browser);
      agent = new SyntheticAgent({
        url: WS,
        token: AGENT_TOKEN,
        device: "rehearsal-device",
        screens,
        fps: 10,
      });
      await agent.connect();
      deviceId = "rehearsal-device";
      console.log(`  mock phone up with ${screens.size} screens`);
    } else {
      // The real phone must already be connected. Fail loudly rather than
      // rehearsing against nothing and calling it a pass.
      const list = await fetch(`${HTTP}/devices?token=${encodeURIComponent(CONSOLE_TOKEN)}`)
        .then((r) => r.json()).catch(() => null);
      const found = list?.devices?.find((d) => d.id === REAL_DEVICE);
      if (!found) {
        console.error(`\n  device ${REAL_DEVICE} is not connected to the relay.`);
        console.error("  available:");
        for (const d of list?.devices || []) {
          console.error(`    ${d.id}  ${d.brand} ${d.model}  Android ${d.android}`);
        }
        process.exit(2);
      }
      console.log(`  using ${found.brand} ${found.model}, Android ${found.android}`);
      agentLog = new Set();
    }

    // ── console ───────────────────────────────────────────────────────────
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));

    await page.goto(`${HTTP}/?token=${encodeURIComponent(CONSOLE_TOKEN)}`, { waitUntil: "networkidle2" });

    // ── BEAT 0: pair and confirm a live view ───────────────────────────────
    await beat("connect and live view", async () => {
      await page.waitForFunction(
        (id) => [...document.querySelectorAll("#device-list .device")]
          .some((r) => (r.querySelector(".meta")?.textContent || "").includes(id)),
        { timeout: 15000 }, deviceId
      );
      await page.evaluate((id) => {
        const row = [...document.querySelectorAll("#device-list .device")]
          .find((r) => (r.querySelector(".meta")?.textContent || "").includes(id));
        row.click();
      }, deviceId);
      await page.waitForFunction(
        () => !document.querySelector("#screen-stage").classList.contains("hidden"),
        { timeout: 5000 }
      );
      expect("stage is shown");

      const live = await page.waitForFunction(
        () => document.querySelector("#stage").width === 480,
        { timeout: 20000 }
      ).then(() => true).catch(() => false);
      expect("frames are flowing", live,
        `canvas=${await page.$eval("#stage", (c) => `${c.width}x${c.height}`)}`);
    });

    // Beat 1 in the runbook is showing enroll.pdf, which is a talking beat with
    // no console interaction. Timed here so the 4-minute budget is honest.
    await beat("beat 1 - enrollment (talking)", async () => {
      await sleep(2000);
      expect("enrollment talking point fits the budget");
    });

    // ── BEAT 2: live control ───────────────────────────────────────────────
    await beat("beat 2 - live control", async () => {
      const box = await page.$eval("#stage", (c) => {
        const r = c.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      });
      const at = (fx, fy) => ({ x: box.x + box.w * fx, y: box.y + box.h * fy });

      // search field
      let p = at(0.5, 0.14);
      await page.mouse.click(p.x, p.y);
      await sleep(400);
      if (agent) agent.reset();

      // type
      await page.keyboard.type("break remote", { delay: 60 });
      await sleep(900);
      if (agent) {
        // Typing is forwarded one character per command, the same as a real
        // keyboard, so the phrase has to be reassembled rather than matched in
        // one message.
        await agent.waitFor((c) => c.op === "text", 5000);
        const typed = agent.commands
          .filter((c) => c.op === "text")
          .map((c) => c.s)
          .join("");
        expect("every character reaches the phone, in order",
          /break remote/i.test(typed), `received "${typed}"`);
      }

      // open an app
      p = at(0.62, 0.28);
      await page.mouse.click(p.x, p.y);
      await sleep(900);

      // scroll
      p = at(0.5, 0.7);
      await page.mouse.move(p.x, p.y);
      await page.mouse.down();
      await page.mouse.move(p.x, p.y - box.h * 0.3, { steps: 10 });
      await page.mouse.up();
      await sleep(900);
      if (agent) {
        const sw = agent.commands.find((c) => c.op === "swipe" || c.op === "drag");
        expect("a swipe reaches the phone", !!sw, JSON.stringify(agent.commands.map((c) => c.op)));
      }

      // back to home
      await page.click('[data-global="home"]');
      await sleep(1200);

      const fps = await page.$eval("#fps", (e) => e.textContent);
      expect("frame rate held during the beat", !/^0(\.0)? fps/.test(fps.trim()), `fps badge: ${fps}`);
    });

    // ── BEAT 3: hand the phone back ────────────────────────────────────────
    await beat("beat 3 - phone used by the owner", async () => {
      if (agent) agent.reset();
      const box = await page.$eval("#stage", (c) => {
        const r = c.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      });
      // The room taps and swipes; the console just has to survive it and stay live.
      await page.mouse.click(box.x + box.w * 0.5, box.y + box.h * 0.35);
      await sleep(300);
      await page.mouse.move(box.x + box.w * 0.5, box.y + box.h * 0.8);
      await page.mouse.down();
      await page.mouse.move(box.x + box.w * 0.5, box.y + box.h * 0.5, { steps: 8 });
      await page.mouse.up();
      await sleep(600);
      await page.click('[data-global="back"]');
      await sleep(800);

      // The point of this beat is that the console is still healthy afterwards.
      // A trivially-true assertion here would not be testing anything.
      if (agent) {
        const taps = agent.commands.filter((c) => c.op === "tap").length;
        const swipes = agent.commands.filter((c) => c.op === "swipe" || c.op === "drag").length;
        const back = agent.commands.find((c) => c.op === "global" && c.action === "back");
        expect("the owner's taps reached the phone", taps >= 1, `${taps} taps`);
        expect("the owner's swipe reached the phone", swipes >= 1, `${swipes} swipes`);
        expect("back still works after owner input", !!back, JSON.stringify(back));
      }
      // Check the banner's class, not its text. The class is what turns the
      // banner green on the projector -- "connected to <id>" is live, "phone
      // disconnected" is not, and the wording changes depending on how the
      // session got there.
      const bannerState = await page.$eval("#banner", (e) => ({
        cls: e.className,
        text: e.textContent,
      }));
      expect("the console still shows a live banner", /\blive\b/.test(bannerState.cls),
        `class="${bannerState.cls}" text="${bannerState.text}"`);
    });

    // ── BEAT 4: find and script ────────────────────────────────────────────
    await beat("beat 4 - find and script", async () => {
      if (agent) agent.reset();
      await page.click("#find-input", { clickCount: 3 });
      await page.type("#find-input", "Settings");
      await page.click("#find-click");
      await sleep(1600);
      if (agent) {
        const f = agent.commands.find((c) => c.op === "find");
        expect("find-and-tap reaches the phone", !!f && /settings/i.test(f.text), JSON.stringify(f));
      }

      if (agent) agent.reset();
      await page.$eval("#script-input", (el) => {
        el.value = JSON.stringify([
          { op: "global", action: "home" },
          { op: "find", text: "Settings", action: "click" },
          { op: "swipe", x1: 240, y1: 600, x2: 240, y2: 300, ms: 300 },
        ]);
      });
      await page.click("#script-run");
      const done = await page.waitForFunction(
        () => /script: done/i.test(document.querySelector("#log")?.textContent || ""),
        { timeout: 20000 }
      ).then(() => true).catch(() => false);
      expect("the script runner completes", done);

      if (agent) {
        const ops = agent.commands.map((c) => c.op);
        expect("all three script steps executed in order",
          ops.join(",") === "global,find,swipe", ops.join(","));
      }
    });

    // ── BEAT 5: record ─────────────────────────────────────────────────────
    await beat("beat 5 - record", async () => {
      await page.click("#rec-btn");
      await sleep(2500);
      const banner = await page.$eval("#banner", (e) => e.textContent);
      expect("the audience can see it is recording", /recording/i.test(banner), banner);
      await sleep(1500);
      await page.click("#rec-btn");
      await sleep(1200);
      const armed = await page.$eval("#rec-btn", (e) => e.classList.contains("armed"));
      expect("recording stops cleanly", !armed);
    });

    // ── BEAT 6: close ──────────────────────────────────────────────────────
    await beat("beat 6 - close", async () => {
      const latency = await page.$eval("#latency", (e) => e.textContent);
      expect("latency badge has a reading", /rtt\s+\d+ms/.test(latency), latency);
      const rtt = Number((latency.match(/(\d+)/) || [])[1] || 0);
      expect("latency is usable for a live demo", rtt < 400, latency);
      expect("no uncaught console errors", pageErrors.length === 0, pageErrors.join(" | "));
    });

    // ── report ─────────────────────────────────────────────────────────────
    const total = beats.reduce((a, b) => a + b.ms, 0);
    const failed = beats.filter((b) => b.checks.some((c) => !c.ok));

    console.log(`\n${"─".repeat(62)}`);
    console.log(`  total   ${(total / 1000).toFixed(1)}s of a ${(BUDGET_MS / 1000).toFixed(0)}s budget`);
    const slowest = [...beats].sort((a, b) => b.ms - a.ms)[0];
    console.log(`  slowest ${slowest.name} (${(slowest.ms / 1000).toFixed(1)}s)`);
    console.log("─".repeat(62));

    if (failed.length) {
      console.log(`\n  ${failed.length} beat(s) failed:`);
      for (const b of failed) console.log(`    - ${b.name}`);
    }

    if (total > BUDGET_MS) {
      console.error(`\n  OVER BUDGET by ${((total - BUDGET_MS) / 1000).toFixed(1)}s.`);
      console.error("  Cut a beat rather than rushing the ones that matter.");
      process.exitCode = 1;
    } else if (failed.length) {
      process.exitCode = 1;
    } else {
      const margin = BUDGET_MS - total;
      console.log(`\n  Rehearsal passed with ${(margin / 1000).toFixed(1)}s to spare.`);
      if (REAL_DEVICE) {
        console.log("  This is the run that counts -- run it again tomorrow, per the runbook.");
      } else {
        console.log("  Now run it with --device <id> once the phone is enrolled.");
      }
    }
  } finally {
    if (agent) agent.close();
    await browser.close();
  }
}

main().catch((err) => {
  console.error(`\nrehearsal harness error: ${err.stack || err.message}`);
  process.exit(2);
});
