/**
 * A synthetic stand-in for the phone, for rehearsing without one.
 *
 * Two jobs:
 *
 *  1. Rehearse the console and the relay end to end before the device exists.
 *     Every demo beat can be exercised and timed, so the first run on real
 *     hardware is not also the first run of the code.
 *
 *  2. Generate the fallback `demo.mp4`. A prerecorded video is mandatory
 *     (definition-of-done item 10), and it has to look like a demo rather than
 *     like a test -- a flat grey screen moving at 10fps does not sell the
 *     product, and a video that does not sell the product is worse than no
 *     video, because the audience will notice.
 *
 * It reacts to real console commands, so the choreography in `rehearse.mjs` is
 * genuinely the same sequence a presenter performs.
 *
 * It is a rehearsal aid, not a demo. `record-demo.mjs` labels its output
 * accordingly, and the real `demo.mp4` must be recorded with the real phone.
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** How a console command moves the mock phone's state machine. */
const REACTIONS = [
  { match: (c) => c.op === "find" && /settings/i.test(c.text || ""), screen: "settings", dwell: 2200 },
  { match: (c) => c.op === "find" && /sign in|search|photos|messages/i.test(c.text || ""), screen: "results", dwell: 2000 },
  { match: (c) => c.op === "text", screen: "results", dwell: 1800 },
  { match: (c) => c.op === "key" && c.code === 4, screen: "home", dwell: 1600 },   // back
  { match: (c) => c.op === "key" && c.code === 66, screen: "chat", dwell: 1800 },  // enter
  { match: (c) => c.op === "global" && c.action === "home", screen: "home", dwell: 1800 },
  { match: (c) => c.op === "global" && c.action === "recents", screen: "recents", dwell: 1800 },
  { match: (c) => c.op === "global" && c.action === "notifications", screen: "notifications", dwell: 2000 },
  { match: (c) => c.op === "swipe", screen: "scroll", dwell: 1400 },
  { match: (c) => c.op === "drag", screen: "scroll", dwell: 1600 },
  { match: (c) => c.op === "longpress", screen: "context", dwell: 1600 },
  { match: (c) => c.op === "doubleTap", screen: "zoom", dwell: 1400 },
  { match: (c) => c.op === "tap", screen: null, dwell: 0 },  // tap alone just highlights
];

export class SyntheticAgent {
  /**
   * @param {object} opts
   * @param {string} opts.url        relay base, e.g. ws://127.0.0.1:8787
   * @param {string} opts.token     agent token
   * @param {string} opts.device    device id to register as
   * @param {Map}    opts.screens   name -> JPEG buffer, from mock-phone.mjs
   * @param {number} opts.fps
   * @param {boolean} opts.quiet
   */
  constructor({ url, token, device, screens, fps = 10, quality = 60, quiet = false }) {
    this.url = url;
    this.token = token;
    this.device = device;
    this.screens = screens;
    this.fps = fps;
    this.quality = quality;
    this.quiet = quiet;
    this.ws = null;
    this.timer = null;
    this.seq = 0;
    this.current = "home";
    this.pending = "home";
    this.dwellUntil = 0;
    this.commands = [];
    this.tapMark = null;
    this.closed = false;
  }

  async connect() {
    this.ws = await openSocket(
      `${this.url}/ws/agent?token=${encodeURIComponent(this.token)}&device=${encodeURIComponent(this.device)}`
    );
    this.ws.onMessage = (data) => this.#onText(data);
    this.ws.send(JSON.stringify({
      op: "hello", id: this.device,
      model: "Rehearsal", brand: "Synthetic",
      android: "15", sdk: 35,
    }));
    this.start();
    return this;
  }

  #onText(data) {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (msg.op === "connected" || msg.op === "state") return;
    this.commands.push(msg);

    // React, the way a real app would.
    for (const r of REACTIONS) {
      if (!r.match(msg)) continue;
      if (r.screen) { this.pending = r.screen; this.dwellUntil = Date.now() + r.dwell; }
      break;
    }
    if (msg.op === "tap") this.tapMark = { x: msg.x, y: msg.y, until: Date.now() + 500 };
  }

  start() {
    const interval = Math.max(1, Math.round(1000 / this.fps));
    this.timer = setInterval(() => this.#tick(), interval);
  }

  #tick() {
    if (this.closed || !this.ws) return;
    if (this.dwellUntil && Date.now() >= this.dwellUntil) {
      this.current = this.pending;
      this.dwellUntil = 0;
    }
    const shot = this.screens.get(this.current) || this.screens.get("home");
    if (!shot) return;
    this.ws.sendBinary(this.#frame(shot));
  }

  #frame(jpeg) {
    const header = Buffer.from(JSON.stringify({
      did: this.device,
      w: 480, h: 854,
      rot: 0, seq: this.seq++, q: this.quality,
      ts: Date.now(),
    }));
    const buf = Buffer.alloc(3 + header.length + jpeg.length);
    buf[0] = 0x01;
    buf[1] = (header.length >> 8) & 0xff;
    buf[2] = header.length & 0xff;
    header.copy(buf, 3);
    jpeg.copy(buf, 3 + header.length);
    return buf;
  }

  /** Jump to a screen directly, for choreography that needs it. */
  setScreen(name, dwellMs = 0) {
    this.current = name;
    this.pending = name;
    this.dwellUntil = dwellMs ? Date.now() + dwellMs : 0;
  }

  /** Wait for a console command matching `pred`, so beats are not time-based. */
  async waitFor(pred, timeoutMs = 8000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const hit = this.commands.find(pred);
      if (hit) return hit;
      await sleep(25);
    }
    return null;
  }

  reset() { this.commands.length = 0; }

  close() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    try { this.ws?.close(); } catch { /* already gone */ }
  }
}

/**
 * Uses Node's global WebSocket (v22+, which is what CI runs) and wraps it in a
 * single shape -- onMessage(string) and sendBinary(Buffer) -- so the agent code
 * above never has to branch on how binary messages arrive.
 */
function openSocket(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    const timer = setTimeout(() => reject(new Error(`timeout opening ${url}`)), 8000);
    ws.onopen = () => { clearTimeout(timer); resolve(ws); };
    ws.onerror = () => { clearTimeout(timer); reject(new Error(`cannot open ${url}`)); };
    ws.onmessage = (ev) => {
      if (ws.onMessage) {
        ws.onMessage(typeof ev.data === "string" ? ev.data : Buffer.from(ev.data).toString());
      }
    };
    ws.sendBinary = (buf) => ws.send(new Uint8Array(buf));
  });
}
