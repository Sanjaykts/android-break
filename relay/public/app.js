/**
 * Break Remote console.
 *
 * Three states: devices -> paired -> stage. The relay is a byte pipe, so all the
 * intelligence about what a frame means lives here.
 *
 * Frame wire format (see relay/src/protocol.ts and the Kotlin Protocol.kt):
 *   0x01 | u16 headerLen (big-endian) | headerJSON (UTF-8) | JPEG bytes
 *
 * The agent already rotates and scales each frame into display space, so the
 * header's w/h ARE the tap coordinate space and no client-side rotation is
 * needed. `did` lets several phones share one relay without the console having
 * to ask the Durable Object who is paired with whom on every frame.
 */

const $ = (sel) => document.querySelector(sel);

const el = {
  screenDevices: $("#screen-devices"),
  screenStage: $("#screen-stage"),
  token: $("#token-input"),
  deviceList: $("#device-list"),
  relayStatus: $("#relay-status"),
  banner: $("#banner"),
  canvas: $("#stage"),
  overlay: $("#stage-overlay"),
  cam: $("#cam"),
  latency: $("#latency"),
  fps: $("#fps"),
  res: $("#res"),
  qualityBtn: $("#quality-btn"),
  findInput: $("#find-input"),
  findClick: $("#find-click"),
  findType: $("#find-type"),
  textInput: $("#text-input"),
  textSend: $("#text-send"),
  scriptInput: $("#script-input"),
  scriptRun: $("#script-run"),
  recBtn: $("#rec-btn"),
  camBtn: $("#cam-btn"),
  fsBtn: $("#fs-btn"),
  backBtn: $("#back-btn"),
  log: $("#log"),
  logClear: $("#log-clear"),
};

const ctx = el.canvas.getContext("2d", { alpha: false });

const state = {
  ws: null,
  token: localStorage.getItem("brk.token") || new URLSearchParams(location.search).get("token") || "",
  cid: sessionStorage.getItem("brk.cid") || crypto.randomUUID(),
  pairedId: null,
  frame: null,        // { w, h, rot, seq }
  lastBitmap: null,   // most recently decoded ImageBitmap
  pendingBuf: null,   // newest frame awaiting decode
  decoding: false,
  connected: false,
  rtt: null,
  lastFrameAt: 0,
  frameTimes: [],
  qualityMode: "auto",
  qualityIdx: 0,
  lastQualityChange: 0,
  cameraOn: false,
  recorder: null,
  recChunks: [],
  sendQueue: Promise.resolve(),
};

// Quality ladder for the manual button; index 0 is what "auto" starts from.
const QUALITY_LADDER = [
  { label: "auto", fps: 10, w: 480, q: 35 },
  { label: "480p/10", fps: 10, w: 480, q: 35 },
  { label: "360p/8", fps: 8, w: 360, q: 30 },
  { label: "360p/5", fps: 5, w: 360, q: 25 },
  { label: "240p/4", fps: 4, w: 240, q: 22 },
];

// Android keycodes for keys that are not plain text.
const KEYCODE = {
  Enter: 66, Backspace: 67, Tab: 61, Escape: 111, Space: 62,
  ArrowUp: 19, ArrowDown: 20, ArrowLeft: 21, ArrowRight: 22,
  Home: 3, Back: 4, Menu: 82, Search: 84,
  Delete: 112, PageUp: 92, PageDown: 93,
};

// ─────────────────────────────────────────────────────────────── logging ──

function log(msg, cls = "") {
  const t = new Date();
  const stamp = `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}:${String(t.getSeconds()).padStart(2, "0")}`;
  const div = document.createElement("div");
  div.innerHTML = `<span class="t">${stamp}</span> <span class="${cls}"></span>`;
  div.lastChild.textContent = msg;
  el.log.appendChild(div);
  while (el.log.childElementCount > 300) el.log.firstChild.remove();
  el.log.scrollTop = el.log.scrollHeight;
}

el.logClear.onclick = () => { el.log.textContent = ""; };

// ────────────────────────────────────────────────────────────── transport ──

function wsUrl(path) {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const q = new URLSearchParams({ token: state.token, cid: state.cid });
  if (path === "/ws/agent") q.set("device", state.pairedId || "");
  return `${proto}//${location.host}${path}?${q}`;
}

function setBanner(text, cls) {
  el.banner.textContent = text;
  el.banner.className = `banner ${cls || ""}`;
}

function setRelayStatus(text, cls) {
  el.relayStatus.textContent = `relay: ${text}`;
  el.relayStatus.className = `relay-status ${cls || ""}`;
}

function connect() {
  if (!state.token) {
    setRelayStatus("enter console token", "bad");
    return;
  }
  setRelayStatus("connecting", "");
  const ws = new WebSocket(wsUrl("/ws/console"));
  ws.binaryType = "arraybuffer";
  state.ws = ws;

  ws.onopen = () => {
    state.connected = true;
    setRelayStatus("connected", "ok");
    // Re-assert the pairing after a reconnect so a dropped socket does not need
    // the operator to re-pick the device. This is fallback step 3 in the ladder.
    if (state.pairedId) send({ op: "connect", id: state.pairedId }, true);
  };

  ws.onclose = (ev) => {
    state.connected = false;
    setRelayStatus(`disconnected (${ev.code})`, "bad");
    if (state.pairedId) setBanner("relay connection lost — reconnecting…", "lost");
    setTimeout(connect, 1000);
  };

  ws.onerror = () => setRelayStatus("error", "bad");

  ws.onmessage = (ev) => {
    if (ev.data instanceof ArrayBuffer) onFrame(ev.data);
    else onJson(ev.data);
  };
}

/** Serialised so the wire never sees two commands interleaved, which the phone's
 *  gesture serialiser would otherwise have to unpick. */
function send(msg, immediate = false) {
  const go = () => {
    if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(msg));
  };
  if (immediate) { go(); return; }
  state.sendQueue = state.sendQueue.then(go, go);
}

function onJson(text) {
  let m;
  try { m = JSON.parse(text); } catch { return; }

  switch (m.op) {
    case "devices":
      renderDevices(m.devices || []);
      break;

    case "paired":
      if (m.id) {
        state.pairedId = m.id;
        setBanner(`connected to ${m.id}`, "live");
        el.overlay.textContent = "";
        log(`paired with ${m.id}`, "ok");
      } else {
        state.pairedId = null;
        setBanner("not connected to a device", "");
      }
      break;

    case "state":
      if (m.state === "live") setBanner(`live — ${state.pairedId}`, "live");
      else if (m.state === "lost") setBanner("phone disconnected — waiting for it to come back", "lost");
      else if (m.state === "closed") setBanner("phone closed the session", "closed");
      else setBanner("connecting…", "connecting");
      break;

    case "pong":
      state.rtt = performance.now() - m.t;
      updateLatencyBadge();
      break;

    case "event":
      log(`event ${m.kind} ${summarise(m)}`, "evt");
      break;

    case "result":
      log(`${m.ok ? "ok" : "fail"} ${m.detail || ""}`, m.ok ? "ok" : "err");
      break;

    case "error":
      log(`relay: ${m.message}`, "err");
      setBanner(m.message, "error");
      break;
  }
}

function summarise(m) {
  const { op, kind, ...rest } = m;
  const parts = Object.entries(rest).slice(0, 4).map(([k, v]) => `${k}=${v}`);
  return parts.join(" ");
}

// ───────────────────────────────────────────────────────────────── devices ──

function renderDevices(devices) {
  el.deviceList.textContent = "";
  if (!devices.length) {
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = "No devices yet. Is the app running on the phone?";
    el.deviceList.appendChild(p);
    return;
  }
  for (const d of devices) {
    const btn = document.createElement("button");
    btn.className = `device ${d.online ? "online" : ""}`;
    btn.innerHTML = `<span class="dot"></span><span><span class="name"></span><br><span class="meta"></span></span>`;
    btn.querySelector(".name").textContent = `${d.brand} ${d.model}`;
    btn.querySelector(".meta").textContent =
      `Android ${d.android} (API ${d.sdk}) · ${d.id}${d.paired ? " · in use" : ""}`;
    btn.onclick = () => pairWith(d.id);
    el.deviceList.appendChild(btn);
  }
}

function pairWith(id) {
  state.pairedId = id;
  localStorage.setItem("brk.token", state.token);
  send({ op: "connect", id }, true);
  el.screenDevices.classList.add("hidden");
  el.screenStage.classList.remove("hidden");
  setBanner(`connecting to ${id}…`, "connecting");
  log(`requesting ${id}`, "sys");
  requestFullscreenOnDemand();
}

el.backBtn.onclick = () => {
  send({ op: "disconnect" }, true);
  state.pairedId = null;
  stopRecording();
  stopCamera();
  el.screenStage.classList.add("hidden");
  el.screenDevices.classList.remove("hidden");
  setBanner("", "");
};

el.token.value = state.token;
el.token.oninput = () => { state.token = el.token.value.trim(); };

// ────────────────────────────────────────────────────────────────── frames ──

function onFrame(buf) {
  if (buf.byteLength < 3) return;
  const view = new DataView(buf);
  if (view.getUint8(0) !== 0x01) return;
  const headerLen = view.getUint16(1, false);
  if (3 + headerLen > buf.byteLength) return;

  let header;
  try {
    header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 3, headerLen)));
  } catch { return; }

  // The relay fans frames out to every console; drop anything not ours.
  if (header.did && header.did !== state.pairedId) return;

  state.frame = { w: header.w | 0, h: header.h | 0, rot: header.rot | 0, seq: header.seq | 0 };
  state.lastFrameAt = performance.now();
  el.res.textContent = `${state.frame.w}x${state.frame.h}${state.frame.rot ? ` r${state.frame.rot * 90}` : ""}`;
  el.overlay.textContent = "";

  state.pendingBuf = buf.slice(3 + headerLen);
  if (!state.decoding) decodeLoop();
}

async function decodeLoop() {
  state.decoding = true;
  try {
    while (state.pendingBuf) {
      // Latest-frame-wins: if the decoder fell behind, the stale frame is dropped
      // rather than queued. Backlogged frames are worthless during a live demo.
      const bytes = state.pendingBuf;
      state.pendingBuf = null;
      const blob = new Blob([bytes], { type: "image/jpeg" });
      const bmp = await createImageBitmap(blob);
      if (state.lastBitmap) state.lastBitmap.close();
      state.lastBitmap = bmp;
      if (el.canvas.width !== bmp.width || el.canvas.height !== bmp.height) {
        el.canvas.width = bmp.width;
        el.canvas.height = bmp.height;
      }
      trackFps();
    }
  } catch (err) {
    log(`frame decode failed: ${err}`, "err");
  } finally {
    state.decoding = false;
  }
}

function trackFps() {
  const now = performance.now();
  state.frameTimes.push(now);
  while (state.frameTimes.length && now - state.frameTimes[0] > 2000) state.frameTimes.shift();
  const span = state.frameTimes.length > 1
    ? (state.frameTimes[state.frameTimes.length - 1] - state.frameTimes[0]) / 1000
    : 0;
  const fps = span > 0 ? (state.frameTimes.length - 1) / span : 0;
  el.fps.textContent = `${fps.toFixed(1)} fps`;
  el.fps.className = `badge ${fps >= 7 ? "good" : fps >= 3 ? "warn" : "bad"}`;
  maybeAdaptQuality(fps);
}

function updateLatencyBadge() {
  const r = state.rtt;
  if (r == null) { el.latency.textContent = "rtt —"; return; }
  el.latency.textContent = `rtt ${Math.round(r)}ms`;
  el.latency.className = `badge ${r < 200 ? "good" : r < 400 ? "warn" : "bad"}`;
}

setInterval(() => {
  if (state.ws?.readyState === WebSocket.OPEN) send({ op: "ping", t: performance.now() });
}, 2000);

setInterval(() => {
  if (state.pairedId && state.lastFrameAt && performance.now() - state.lastFrameAt > 4000) {
    setBanner("no frames arriving from the phone", "lost");
  }
}, 2000);

/**
 * Adaptive quality. Two triggers, one shared cooldown, and a floor of 4fps --
 * below that the live view stops being legible, which is worse than being slow.
 */
function maybeAdaptQuality(fps) {
  if (state.qualityMode !== "auto") return;
  if (performance.now() - state.lastQualityChange < 8000) return;
  const bad = (state.rtt != null && state.rtt > 400) || (fps > 0 && fps < 5);
  const idx = state.qualityIdx;
  if (bad && idx < QUALITY_LADDER.length - 1) applyQuality(idx + 1, true);
  else if (!bad && idx > 1) applyQuality(idx - 1, true);
}

function applyQuality(idx, auto) {
  state.qualityIdx = idx;
  state.lastQualityChange = performance.now();
  const q = QUALITY_LADDER[idx];
  el.qualityBtn.textContent = `quality: ${q.label}${auto ? " (auto)" : ""}`;
  send({ op: "quality", fps: q.fps, w: q.w, q: q.q });
  log(`quality -> ${q.label}${auto ? " (auto)" : ""}`, "sys");
}

el.qualityBtn.onclick = () => {
  if (state.qualityMode === "auto") {
    state.qualityMode = "manual";
    log("quality: manual — the console will no longer change this for you", "sys");
  }
  applyQuality((state.qualityIdx + 1) % QUALITY_LADDER.length, false);
};

// ────────────────────────────────────────────────────────────────── render ──

function renderLoop() {
  // One loop drives both the screen and the presenter camera, so the camera ends
  // up inside the recorded file rather than floating over it.
  if (state.lastBitmap) ctx.drawImage(state.lastBitmap, 0, 0);

  if (state.cameraOn && el.cam.videoWidth) {
    const w = Math.round(el.canvas.width * 0.26);
    const h = Math.round((w * el.cam.videoHeight) / el.cam.videoWidth);
    const x = el.canvas.width - w - 10;
    const y = el.canvas.height - h - 10;
    ctx.save();
    ctx.translate(x + w, y);
    ctx.scale(-1, 1);
    ctx.drawImage(el.cam, 0, 0, w, h);
    ctx.restore();
    ctx.strokeStyle = "rgba(255,255,255,0.35)";
    ctx.strokeRect(x + 0.5, y + 0.5, w, h);
  }
  requestAnimationFrame(renderLoop);
}
requestAnimationFrame(renderLoop);

// ─────────────────────────────────────────────────────────────────── input ──

/** Maps a DOM pointer event into device coordinates using the current frame's
 *  declared size. The canvas is laid out by CSS, so the bounding rect is the
 *  authoritative scale factor -- not the canvas's intrinsic pixel size. */
function toDevice(ev) {
  const r = el.canvas.getBoundingClientRect();
  const f = state.frame;
  if (!f || !r.width || !r.height) return null;
  const x = ((ev.clientX - r.left) / r.width) * f.w;
  const y = ((ev.clientY - r.top) / r.height) * f.h;
  return {
    x: Math.max(0, Math.min(f.w, Math.round(x))),
    y: Math.max(0, Math.min(f.h, Math.round(y))),
  };
}

const TAP_SLOP = 12;         // css px
const LONGPRESS_MS = 550;
const DOUBLETAP_MS = 300;

let drag = null;
let lastTap = { t: 0, x: 0, y: 0 };
let longpressTimer = null;

el.canvas.addEventListener("pointerdown", (ev) => {
  if (!state.frame) return;
  const p = toDevice(ev);
  if (!p) return;
  el.canvas.setPointerCapture(ev.pointerId);
  drag = { id: ev.pointerId, start: p, last: p, t0: performance.now(), moved: false, fired: false };
  clearTimeout(longpressTimer);
  longpressTimer = setTimeout(() => {
    if (drag && !drag.moved) {
      drag.fired = true;
      send({ op: "longpress", x: drag.start.x, y: drag.start.y, ms: 700 });
      log(`longpress ${drag.start.x},${drag.start.y}`, "sys");
    }
  }, LONGPRESS_MS);
});

el.canvas.addEventListener("pointermove", (ev) => {
  if (!drag || ev.pointerId !== drag.id) return;
  const p = toDevice(ev);
  if (!p) return;
  drag.last = p;
  const dx = p.x - drag.start.x;
  const dy = p.y - drag.start.y;
  if (Math.hypot(dx, dy) > (TAP_SLOP * state.frame.w) / el.canvas.getBoundingClientRect().width) {
    drag.moved = true;
    clearTimeout(longpressTimer);
  }
});

el.canvas.addEventListener("pointerup", (ev) => {
  clearTimeout(longpressTimer);
  if (!drag || ev.pointerId !== drag.id) return;
  const d = drag;
  drag = null;
  if (d.fired) return;

  const dt = performance.now() - d.t0;
  const dx = d.last.x - d.start.x;
  const dy = d.last.y - d.start.y;

  if (d.moved) {
    const ms = Math.max(120, Math.min(1500, Math.round(dt)));
    send({ op: "swipe", x1: d.start.x, y1: d.start.y, x2: d.last.x, y2: d.last.y, ms });
    log(`swipe ${d.start.x},${d.start.y} -> ${d.last.x},${d.last.y} (${ms}ms)`, "sys");
    return;
  }

  const now = performance.now();
  const isDouble =
    now - lastTap.t < DOUBLETAP_MS &&
    Math.hypot(d.start.x - lastTap.x, d.start.y - lastTap.y) < 40;

  if (isDouble) {
    lastTap = { t: 0, x: 0, y: 0 };
    send({ op: "doubleTap", x: d.start.x, y: d.start.y });
    log(`doubleTap ${d.start.x},${d.start.y}`, "sys");
    return;
  }

  lastTap = { t: now, x: d.start.x, y: d.start.y };
  send({ op: "tap", x: d.start.x, y: d.start.y });
  log(`tap ${d.start.x},${d.start.y}`, "sys");
});

el.canvas.addEventListener("pointercancel", () => { clearTimeout(longpressTimer); drag = null; });

// Wheel becomes a vertical swipe anchored at the cursor, which is what a trackpad
// gesture means on a phone anyway.
el.canvas.addEventListener("wheel", (ev) => {
  const p = toDevice(ev);
  if (!p) return;
  ev.preventDefault();
  const dist = Math.max(60, Math.min(400, Math.abs(ev.deltaY) * 1.5));
  const dir = ev.deltaY > 0 ? 1 : -1;
  const y2 = Math.max(0, Math.min(state.frame.h, p.y + dir * dist));
  send({ op: "swipe", x1: p.x, y1: p.y, x2: p.x, y2, ms: 260 });
  log(`wheel swipe at ${p.x},${p.y}`, "sys");
}, { passive: false });

// Keyboard. Typing in the console's own fields is handled by those fields; every
// other key is forwarded to the phone.
document.addEventListener("keydown", (ev) => {
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
  const tag = ev.target?.tagName;
  const typing = tag === "INPUT" || tag === "TEXTAREA";

  if (!typing && ev.key.toLowerCase() === "f") {
    ev.preventDefault();
    toggleFullscreen();
    return;
  }
  if (typing) return;

  if (ev.key === "Enter") { ev.preventDefault(); send({ op: "key", code: KEYCODE.Enter }); return; }
  if (ev.key === "Backspace") { ev.preventDefault(); send({ op: "key", code: KEYCODE.Backspace }); return; }
  if (ev.key === "Escape") { ev.preventDefault(); send({ op: "key", code: KEYCODE.Escape }); return; }
  if (ev.key === "Tab") { ev.preventDefault(); send({ op: "key", code: KEYCODE.Tab }); return; }
  if (ev.key.startsWith("Arrow")) { ev.preventDefault(); send({ op: "key", code: KEYCODE[ev.key] }); return; }

  if (ev.key.length === 1) {
    ev.preventDefault();
    send({ op: "text", s: ev.key });
  }
});

// ──────────────────────────────────────────────── find, text, script, nav ──

document.querySelectorAll("[data-global]").forEach((btn) => {
  btn.onclick = () => {
    const action = btn.dataset.global;
    send({ op: "global", action });
    log(`global ${action}`, "sys");
  };
});

function runFind(action) {
  const text = el.findInput.value.trim();
  if (!text) { el.findInput.focus(); return; }
  send({ op: "find", text, action });
  log(`find "${text}" -> ${action}`, "sys");
}
el.findClick.onclick = () => runFind("click");
el.findType.onclick = () => runFind("settext");
el.findInput.onkeydown = (ev) => { if (ev.key === "Enter") runFind("click"); };

// Live typing: send only the characters that were appended, so this behaves like
// a keyboard attached to the phone rather than a paste button.
let textSent = "";
el.textInput.oninput = () => {
  const v = el.textInput.value;
  if (v.startsWith(textSent)) {
    const delta = v.slice(textSent.length);
    if (delta) send({ op: "text", s: delta });
  } else {
    // Edited in the middle: fall back to replacing the field wholesale.
    send({ op: "key", code: KEYCODE.Backspace });
    for (let i = textSent.length; i > 0; i--) send({ op: "key", code: KEYCODE.Backspace });
    if (v) send({ op: "text", s: v });
  }
  textSent = v;
};
el.textSend.onclick = () => {
  if (el.textInput.value) send({ op: "text", s: el.textInput.value });
  textSent = el.textInput.value;
  el.textInput.value = "";
  textSent = "";
};

const VALID_SCRIPT_OPS = new Set([
  "tap", "swipe", "longpress", "doubleTap", "key", "text",
  "global", "find", "script", "quality", "ime",
]);

function validateScript(actions) {
  if (!Array.isArray(actions)) return "not a JSON array";
  if (actions.length === 0) return "array is empty";
  if (actions.length > 50) return "more than 50 actions";
  for (const [i, a] of actions.entries()) {
    if (typeof a !== "object" || a === null) return `action ${i} is not an object`;
    if (!VALID_SCRIPT_OPS.has(a.op)) return `action ${i} has unknown op "${a.op}"`;
  }
  return null;
}

el.scriptRun.onclick = async () => {
  let actions;
  try {
    actions = JSON.parse(el.scriptInput.value);
  } catch (err) {
    log(`script: invalid JSON — ${err.message}`, "err");
    return;
  }
  const problem = validateScript(actions);
  if (problem) { log(`script: ${problem}`, "err"); return; }

  log(`script: running ${actions.length} action(s)`, "sys");
  for (const [i, action] of actions.entries()) {
    send(action);
    log(`  ${i + 1}/${actions.length} ${action.op}`, "sys");
    // A gap between actions so the phone can settle; dispatchGesture refuses to
    // start while one is in flight and would otherwise drop the next one.
    await new Promise((r) => setTimeout(r, 700));
  }
  log("script: done", "ok");
};

// ────────────────────────────────────────────────── camera and recording ──

async function startCamera() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480 },
      audio: false,
    });
    el.cam.srcObject = stream;
    await el.cam.play();
    state.cameraOn = true;
    el.cam.classList.remove("hidden");
    el.camBtn.classList.add("armed");
    log("presenter camera on", "ok");
  } catch (err) {
    log(`camera: ${err.message} — was the page opened over https?`, "err");
  }
}

function stopCamera() {
  el.cam?.srcObject?.getTracks?.().forEach((t) => t.stop());
  el.cam.srcObject = null;
  state.cameraOn = false;
  el.cam.classList.add("hidden");
  el.camBtn.classList.remove("armed");
}

el.camBtn.onclick = () => (state.cameraOn ? (stopCamera(), log("presenter camera off", "sys")) : startCamera());

function pickMime() {
  const candidates = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm",
  ];
  return candidates.find((m) => MediaRecorder.isTypeSupported(m)) || "";
}

function startRecording() {
  if (!state.lastBitmap) { log("record: no frames yet", "err"); return; }
  try {
    const stream = el.canvas.captureStream(30);
    const mime = pickMime();
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 4_000_000 } : undefined);
    state.recChunks = [];
    rec.ondataavailable = (e) => { if (e.data.size) state.recChunks.push(e.data); };
    rec.onstop = () => {
      const blob = new Blob(state.recChunks, { type: mime || "video/webm" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `break-remote-${new Date().toISOString().replace(/[:.]/g, "-")}.webm`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
      log(`recording saved (${(blob.size / 1e6).toFixed(1)} MB)`, "ok");
    };
    rec.start(1000);
    state.recorder = rec;
    el.recBtn.classList.add("armed");
    el.recBtn.innerHTML = "&#9632; Stop";
    setBanner("RECORDING", "closed");
    log("recording started", "sys");
  } catch (err) {
    log(`record: ${err.message}`, "err");
  }
}

function stopRecording() {
  if (!state.recorder) return;
  state.recorder.stop();
  state.recorder = null;
  el.recBtn.classList.remove("armed");
  el.recBtn.innerHTML = "&#9679; Record";
  if (state.lastFrameAt && performance.now() - state.lastFrameAt < 4000) {
    setBanner(`connected to ${state.pairedId}`, "live");
  }
  log("recording stopped", "sys");
}

el.recBtn.onclick = () => (state.recorder ? stopRecording() : startRecording());

// ─────────────────────────────────────────────────────────────── fullscreen ──

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.().catch((e) => log(`fullscreen: ${e.message}`, "err"));
}
el.fsBtn.onclick = toggleFullscreen;

function requestFullscreenOnDemand() {
  // Browsers require a user gesture, and pairing is one. Failure is not fatal.
  el.screenStage.requestFullscreen?.().catch(() => {});
}

document.addEventListener("fullscreenchange", () => {
  log(document.fullscreenElement ? "fullscreen on" : "fullscreen off", "sys");
});

// ──────────────────────────────────────────────────────────────────── boot ──

if (!state.token) {
  setRelayStatus("enter console token", "bad");
  el.token.focus();
} else {
  connect();
}
log("console ready");
