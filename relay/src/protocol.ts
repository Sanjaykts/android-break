/**
 * Wire protocol shared with the Android agent. Kept in one place so the Kotlin
 * side (agent/app/src/main/java/dev/breakremote/agent/net/Protocol.kt) and this
 * relay can be diffed against each other.
 *
 * Two frame shapes travel over the same WebSocket:
 *
 *   1. UTF-8 JSON text frames for control traffic. Cheap, human-readable in logs,
 *      and never on the hot path.
 *
 *   2. Binary screen frames, which are the overwhelming majority of the bytes:
 *
 *        0x01 | u16 headerLen (big-endian) | headerJSON (UTF-8) | JPEG bytes
 *
 *      The relay never parses these. It checks the size cap and forwards the
 *      ArrayBuffer untouched, which is the cheapest possible relay and the main
 *      reason the Cloudflare free tier can carry this at all.
 */

export const FRAME_MAGIC = 0x01;

/** Plan section 3 caps a screen frame at 480 KB. We allow a little headroom for
 *  the header and reject anything larger outright rather than let a phone wedge
 *  the Durable Object. */
export const MAX_FRAME_BYTES = 512 * 1024;

export const CLOSE_UNAUTHORIZED = 4401;
export const CLOSE_BAD_REQUEST = 4400;
export const CLOSE_TOO_LARGE = 4409;

/** Storage keys. Deliberately few: every write to Durable Object storage costs
 *  CPU against the free-tier budget, so hot-path data (liveness, pairing) is
 *  held in memory and rebuilt from these sparse keys only when the DO wakes. */
export const KEY_DEVICE = (id: string) => `device:${id}`;
export const KEY_PAIR_PREFIX = "pair:";
export const KEY_PAIR = (consoleId: string) => `${KEY_PAIR_PREFIX}${consoleId}`;
/** One lab session's claim record. Kept per-session so a session id cannot be
 *  silently reused by a different device. */
export const KEY_LAB_SESSION = (sessionId: string) => `lab:session:${sessionId}`;

export interface DeviceMeta {
  id: string;
  model: string;
  brand: string;
  android: string;
  sdk: number;
}

/** Agent -> relay, JSON. */
export type AgentMessage =
  | ({ op: "hello" } & DeviceMeta)
  | { op: "event"; kind: "accessibility" | "connection" | "lifecycle"; [k: string]: unknown }
  | { op: "pong"; t: number }
  | { op: "result"; id?: string; ok: boolean; detail?: string };

/** Console -> relay, JSON. */
export type ConsoleMessage =
  | { op: "connect"; id: string }
  | { op: "disconnect" }
  | { op: "tap"; x: number; y: number }
  | { op: "swipe"; x1: number; y1: number; x2: number; y2: number; ms: number }
  | { op: "drag"; x1: number; y1: number; x2: number; y2: number; ms: number }
  | { op: "longpress"; x: number; y: number; ms: number }
  | { op: "doubleTap"; x: number; y: number }
  | { op: "key"; code: number }
  | { op: "text"; s: string }
  | { op: "global"; action: GlobalAction }
  | { op: "find"; text: string; action: "click" | "settext" }
  | { op: "script"; actions: ConsoleMessage[] }
  | { op: "quality"; fps: number; w: number; q: number }
  | { op: "ping"; t: number }
  | { op: "ime"; enabled: boolean };

export type GlobalAction =
  | "back" | "home" | "recents" | "power" | "notifications" | "appswitch";

/** relay -> console, JSON. */
export type RelayMessage =
  | { op: "devices"; devices: DeviceSummary[] }
  | { op: "paired"; id: string | null }
  | { op: "state"; state: "connecting" | "live" | "lost" | "closed" }
  | { op: "event"; kind: string; [k: string]: unknown }
  | { op: "result"; ok: boolean; detail?: string }
  | { op: "pong"; t: number }
  | { op: "error"; message: string };

export interface DeviceSummary extends DeviceMeta {
  online: boolean;
  paired: boolean;
}

export function isAgentMessage(v: unknown): v is AgentMessage {
  return typeof v === "object" && v !== null && typeof (v as { op?: unknown }).op === "string";
}

export function isConsoleMessage(v: unknown): v is ConsoleMessage {
  return typeof v === "object" && v !== null && typeof (v as { op?: unknown }).op === "string";
}

/**
 * Parses the binary frame header. Only used by tests and tooling -- the relay's
 * hot path deliberately skips this.
 */
export function parseFrameHeader(buf: ArrayBuffer): { header: Record<string, unknown>; jpegBytes: number } | null {
  if (buf.byteLength < 3) return null;
  const view = new DataView(buf);
  if (view.getUint8(0) !== FRAME_MAGIC) return null;
  const headerLen = view.getUint16(1, false);
  if (3 + headerLen > buf.byteLength) return null;
  const headerText = new TextDecoder().decode(new Uint8Array(buf, 3, headerLen));
  try {
    return { header: JSON.parse(headerText) as Record<string, unknown>, jpegBytes: buf.byteLength - 3 - headerLen };
  } catch {
    return null;
  }
}
