import { DurableObject } from "cloudflare:workers";

import { makeStore, validateEvent, type LabStore } from "./lab";
import {
  CLOSE_BAD_REQUEST,
  CLOSE_TOO_LARGE,
  KEY_DEVICE,
  MAX_FRAME_BYTES,
  type ConsoleMessage,
  type DeviceMeta,
  type DeviceSummary,
  type RelayMessage,
  isAgentMessage,
  isConsoleMessage,
} from "./protocol";

/**
 * Hub Durable Object: the whole rendezvous.
 *
 * ## Why this survives the free tier
 *
 * The relay is a byte pipe, so the only thing that matters per frame is doing as
 * little as possible. Three decisions do the work:
 *
 *  1. **Hibernation.** Sockets are accepted with `ctx.acceptWebSocket()`, so an
 *     idle relay costs nothing. An active relay only bills while bytes move.
 *
 *  2. **Identity lives in tags and attachments, never in storage reads.** Tags
 *     (`agent` + `device:<id>`, `console` + `console:<id>`) are in-memory and let
 *     us address sockets with `getWebSockets(tag)`. A console's pairing lives in
 *     `serializeAttachment`, which also survives hibernation. Net effect: the
 *     frame path and the command path perform **zero** storage operations.
 *
 *  3. **Frames are never parsed.** An inbound screen frame is size-checked and
 *     forwarded as the same ArrayBuffer. The console filters by the `did` field
 *     in the frame header, which it has to read anyway to map tap coordinates.
 *
 * Storage is therefore written at most once per agent connection (device
 * metadata) and read only by the `/devices` endpoint, which a human triggers.
 */
const TAG_AGENT = "agent";
const TAG_CONSOLE = "console";
const DEVICE_TAG = (id: string) => `device:${id}`;
const CONSOLE_TAG = (id: string) => `console:${id}`;

interface ConsoleAttachment {
  consoleId: string;
  deviceId: string | null;
}

function deviceIdFrom(tags: string[]): string | null {
  const t = tags.find((x) => x.startsWith("device:"));
  return t ? t.slice("device:".length) : null;
}

function consoleIdFrom(tags: string[]): string | null {
  const t = tags.find((x) => x.startsWith("console:"));
  return t ? t.slice("console:".length) : null;
}

const DEVICE_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

export class Hub extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    switch (url.pathname) {
      case "/connect-agent":
        return this.connectAgent(url);
      case "/connect-console":
        return this.connectConsole(url);
      case "/lab/session":
        return this.issueSession();
      case "/lab/event":
        return this.ingest(request);
      case "/lab/events":
        return Response.json({ events: await this.store.events(url.searchParams.get("session") ?? undefined) });
      case "/lab/sessions":
        return Response.json({ sessions: await this.store.sessions() });
      case "/lab/failures":
        return Response.json({ failures: await this.store.failures() });
      case "/lab/alerts":
        return Response.json({ alerts: await this.store.alerts() });
      case "/lab/reset":
        return this.labReset(request);
      case "/lab/health":
        return Response.json({ ok: true, service: "lab-telemetry" });
      case "/devices":
        // The cache must be warmed before collecting. `collectDevices` is
        // synchronous and reads `metaCache`, which hibernation resets to null
        // while leaving the sockets open -- so without this the Hub reports every
        // device as model "unknown", sdk 0 after a wake. `broadcastDevices`
        // already warms first for the same reason; this is the HTTP twin of it.
        // The data is in storage either way, so this is a read path, not a write.
        await this.warmMeta();
        return Response.json({ devices: this.collectDevices() });
      default:
        return new Response("not found", { status: 404 });
    }
  }

  // ---------------------------------------------------------------- lifecycle

  private connectAgent(url: URL): Response {
    const deviceId = url.searchParams.get("device")?.trim() ?? "";
    if (!DEVICE_ID_RE.test(deviceId)) {
      return new Response("bad device id", { status: 400 });
    }
    return this.accept([TAG_AGENT, DEVICE_TAG(deviceId)], () => {
      // A reconnect writes nothing: the cached metadata is still valid and the
      // console just needs to see the device flip back to online. Metadata is
      // only written on `hello`.
      this.metaCache = null;
      this.broadcastDevices();
    });
  }

  private connectConsole(url: URL): Response {
    const consoleId = url.searchParams.get("cid")?.trim() || crypto.randomUUID();
    if (!DEVICE_ID_RE.test(consoleId)) {
      return new Response("bad console id", { status: 400 });
    }
    return this.accept([TAG_CONSOLE, CONSOLE_TAG(consoleId)], (server) => {
      server.serializeAttachment({ consoleId, deviceId: null } satisfies ConsoleAttachment);
      // A console that connects *after* the phone is already enrolled would
      // otherwise sit on an empty list forever, because the only other trigger
      // for a device list is an agent connecting. That is precisely the demo-day
      // ordering: phone enrolled hours earlier, laptop opened at talk time.
      this.metaCache = null;
      this.broadcastDevices();
    });
  }

  /**
   * Accepts a hibernatable socket. `onAccepted` runs after the socket is attached
   * so it can seed the attachment before any message can arrive.
   */
  private accept(tags: string[], onAccepted: (server: WebSocket) => void): Response {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server, tags);
    onAccepted(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  // ------------------------------------------------------------- device list

  private collectDevices(): DeviceSummary[] {
    const out: DeviceSummary[] = [];
    const paired = new Set(
      this.ctx
        .getWebSockets(TAG_CONSOLE)
        .map((c) => (c.deserializeAttachment() as ConsoleAttachment | null)?.deviceId)
        .filter((x): x is string => typeof x === "string")
    );

    for (const ws of this.ctx.getWebSockets(TAG_AGENT)) {
      const id = deviceIdFrom(this.ctx.getTags(ws));
      if (!id) continue;
      // Only the /devices path reaches storage. Everything else is tag-driven.
      const meta = this.readDeviceMeta(id);
      out.push({
        id,
        model: meta?.model ?? "unknown",
        brand: meta?.brand ?? "unknown",
        android: meta?.android ?? "unknown",
        sdk: meta?.sdk ?? 0,
        online: true,
        paired: paired.has(id),
      });
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
  }

  /**
   * Durable Object storage is async, but `collectDevices` needs to stay
   * synchronous to be called from a non-async path. The cache is rebuilt once per
   * activation, which is correct: hibernation resets memory and the next
   * activation re-reads the handful of device records.
   */
  private metaCache: Map<string, DeviceMeta> | null = null;

  /** Lazily built so the relay path never pays for the lab half. */
  private labStore: LabStore | null = null;

  private get store(): LabStore {
    if (!this.labStore) this.labStore = makeStore(this.ctx);
    return this.labStore;
  }

  /**
   * Issues a lab session id (proposal sections 4.1-4.2 and 7.6).
   *
   * Generated server-side so it cannot be forged by the page, and so attribution
   * in section 12 rests on something the analyst controls.
   */
  private issueSession(): Response {
    const id = `LAB-${new Date().getUTCFullYear()}-${crypto.randomUUID()
      .slice(0, 8)
      .toUpperCase()}`;
    return Response.json({
      session_id: id,
      issued_at: new Date().toISOString(),
      data_class: "TEST_ONLY",
    });
  }

  /**
   * Telemetry ingest (proposal section 7.6).
   *
   * Validation is server-side and a rejected payload is stored as a *control
   * failure*, not just discarded. A payload that arrives without
   * `data_class: TEST_ONLY` is evidence that something in the lab is wrong, and
   * silently dropping it would hide the one event the analyst most needs to see.
   */
  private async ingest(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return Response.json({ error: "use POST" }, { status: 405 });
    }

    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return Response.json({ error: "body is not valid JSON" }, { status: 400 });
    }

    const result = validateEvent(payload);
    if (!result.ok) {
      await this.store.recordFailure({
        at: new Date().toISOString(),
        reason: result.reason,
        field: result.field,
        raw: typeof payload === "object" ? summarizeRaw(payload) : String(payload).slice(0, 120),
      });
      return Response.json(
        { error: "rejected", reason: result.reason, field: result.field },
        { status: 422 }
      );
    }

    const ev = result.event;
    const claim = await this.store.claimSession(ev.session_id, ev.device_id);
    if (!claim.known) {
      await this.store.recordFailure({
        at: new Date().toISOString(),
        reason: `session ${ev.session_id} was already claimed by a different device`,
        field: "session_id",
        raw: ev.device_id,
      });
      return Response.json(
        { error: "rejected", reason: "session id already belongs to another device" },
        { status: 409 }
      );
    }

    await this.store.append(ev);
    return Response.json({ accepted: true, session_id: ev.session_id });
  }

  /**
   * Lab reset (proposal section 7.10 and section 12: "the lab can be reset to a
   * known-clean state"). Deliberately a separate route from the agent/console
   * auth, so wiping the evidence store cannot be triggered by a stray console
   * frame, and it requires its own confirmation parameter.
   */
  private async labReset(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return Response.json({ error: "use POST" }, { status: 405 });
    }
    const body = (await request.json().catch(() => ({}))) as { confirm?: string };
    if (body.confirm !== "RESET_LAB") {
      return Response.json(
        { error: "confirmation required", expected: { confirm: "RESET_LAB" } },
        { status: 400 }
      );
    }
    await this.store.clear();
    this.metaCache = null;
    return Response.json({ reset: true, at: new Date().toISOString() });
  }

  private async warmMeta(): Promise<Map<string, DeviceMeta>> {
    if (this.metaCache) return this.metaCache;
    const cache = new Map<string, DeviceMeta>();
    for (const ws of this.ctx.getWebSockets(TAG_AGENT)) {
      const id = deviceIdFrom(this.ctx.getTags(ws));
      if (!id || cache.has(id)) continue;
      const raw = await this.ctx.storage.get<DeviceMeta>(KEY_DEVICE(id));
      if (raw) cache.set(id, raw);
    }
    this.metaCache = cache;
    return cache;
  }

  private readDeviceMeta(id: string): DeviceMeta | undefined {
    return this.metaCache?.get(id);
  }

  // ------------------------------------------------------- hibernation events

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    // ── hot path: a screen frame. No parse, no storage, no JSON. ──
    if (message instanceof ArrayBuffer) {
      if (message.byteLength > MAX_FRAME_BYTES) {
        ws.close(CLOSE_TOO_LARGE, "frame too large");
        return;
      }
      for (const c of this.ctx.getWebSockets(TAG_CONSOLE)) {
        try {
          c.send(message);
        } catch {
          // A console that cannot keep up is removed by its own close handler.
        }
      }
      return;
    }

    if (message.length > 64 * 1024) {
      ws.close(CLOSE_BAD_REQUEST, "control message too large");
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(message);
    } catch {
      ws.close(CLOSE_BAD_REQUEST, "malformed json");
      return;
    }

    const tags = this.ctx.getTags(ws);
    if (tags.includes(TAG_AGENT)) await this.onAgentMessage(ws, parsed);
    else if (tags.includes(TAG_CONSOLE)) await this.onConsoleMessage(ws, parsed);
    else ws.close(CLOSE_BAD_REQUEST, "unrecognised socket");
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    const tags = this.ctx.getTags(ws);
    if (tags.includes(TAG_AGENT)) {
      const id = deviceIdFrom(tags);
      if (id) await this.broadcast({ op: "state", state: "lost" }, id);
    }
    // Device metadata is intentionally left behind so the console can show the
    // device as offline instead of dropping it off the list entirely.
    this.metaCache = null;
    this.broadcastDevices();
    void code;
    void reason;
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : "socket error";
    try {
      ws.close(1011, message.slice(0, 120));
    } catch {
      // Already closed.
    }
  }

  // -------------------------------------------------------------- agent side

  private async onAgentMessage(ws: WebSocket, raw: unknown): Promise<void> {
    if (!isAgentMessage(raw)) {
      ws.close(CLOSE_BAD_REQUEST, "bad message");
      return;
    }
    const id = deviceIdFrom(this.ctx.getTags(ws));
    if (!id) return;

    if (raw.op === "hello") {
      const meta: DeviceMeta = {
        id,
        model: String(raw.model ?? "unknown").slice(0, 64),
        brand: String(raw.brand ?? "unknown").slice(0, 64),
        android: String(raw.android ?? "unknown").slice(0, 32),
        sdk: Number(raw.sdk ?? 0) || 0,
      };
      await this.ctx.storage.put(KEY_DEVICE(id), meta);
      this.metaCache?.set(id, meta);
      await this.warmMeta();
      this.broadcastDevices();
      await this.broadcast({ op: "state", state: "live" }, id);
      return;
    }

    if (raw.op === "pong") {
      // The agent echoes back the timestamp the console generated, so the latency
      // badge is a true round trip measured on one clock. Neither side ever
      // compares its own clock to the other's -- phone and laptop will disagree.
      await this.broadcast({ op: "pong", t: raw.t }, id);
      return;
    }

    if (raw.op === "event" || raw.op === "result") {
      await this.broadcast(raw as unknown as RelayMessage, id);
    }
  }

  // ------------------------------------------------------------ console side

  private async onConsoleMessage(ws: WebSocket, raw: unknown): Promise<void> {
    if (!isConsoleMessage(raw)) {
      ws.close(CLOSE_BAD_REQUEST, "bad message");
      return;
    }
    const attachment = (ws.deserializeAttachment() as ConsoleAttachment | null) ?? null;

    if (raw.op === "connect") {
      const target = String(raw.id ?? "").slice(0, 64);
      if (!DEVICE_ID_RE.test(target)) {
        this.send(ws, { op: "error", message: "bad device id" });
        return;
      }
      ws.serializeAttachment({ consoleId: attachment?.consoleId ?? "?", deviceId: target } satisfies ConsoleAttachment);
      this.send(ws, { op: "paired", id: target });
      this.broadcastDevices();
      return;
    }

    if (raw.op === "disconnect") {
      ws.serializeAttachment({ consoleId: attachment?.consoleId ?? "?", deviceId: null } satisfies ConsoleAttachment);
      this.send(ws, { op: "paired", id: null });
      this.broadcastDevices();
      return;
    }

    if (raw.op === "ping") {
      this.send(ws, { op: "pong", t: raw.t });
      return;
    }

    const deviceId = attachment?.deviceId;
    if (!deviceId) {
      this.send(ws, { op: "error", message: "not connected to a device" });
      return;
    }

    const text = JSON.stringify(raw);
    for (const a of this.ctx.getWebSockets(DEVICE_TAG(deviceId))) {
      try {
        a.send(text);
      } catch {
        // Agent socket is going away; its close handler cleans up.
      }
    }
  }

  // ----------------------------------------------------------------- fan-out

  private send(ws: WebSocket, msg: RelayMessage): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // Ignore: the close handler will clean up.
    }
  }

  /** Sends a JSON message to whichever consoles are paired with `deviceId`. */
  private async broadcast(msg: RelayMessage, deviceId: string): Promise<void> {
    const text = JSON.stringify(msg);
    for (const c of this.ctx.getWebSockets(TAG_CONSOLE)) {
      const a = c.deserializeAttachment() as ConsoleAttachment | null;
      if (a?.deviceId === deviceId) {
        try {
          c.send(text);
        } catch {
          // Ignore.
        }
      }
    }
  }

  private broadcastDevices(): void {
    void this.warmMeta()
      .then(() => {
        const text = JSON.stringify({ op: "devices", devices: this.collectDevices() });
        for (const c of this.ctx.getWebSockets(TAG_CONSOLE)) {
          try {
            c.send(text);
          } catch {
            // Ignore.
          }
        }
      })
      .catch(() => {
        // Ignore.
      });
  }
}

export interface Env {
  HUB: DurableObjectNamespace<Hub>;
  ASSETS: Fetcher;
  AGENT_TOKEN: string;
  CONSOLE_TOKEN: string;
}

/**
 * Keeps a rejected payload safe to store and safe to display in the dashboard.
 * The raw body could contain anything, so only shape and a short prefix survive.
 */
function summarizeRaw(v: unknown): Record<string, unknown> {
  if (typeof v !== "object" || v === null) return { value: String(v).slice(0, 120) };
  const o = v as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(o).slice(0, 12)) {
    const val = o[k];
    out[k] = typeof val === "string" ? val.slice(0, 120) : typeof val;
  }
  return out;
}
