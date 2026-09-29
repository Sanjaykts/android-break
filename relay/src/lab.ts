/**
 * Lab telemetry: ingest, validation, session correlation and alerting.
 *
 * This is the server half of the Zion's EQB demonstration (proposal sections 7.6,
 * 8 and 9). It receives only synthetic, authorised telemetry from the lab app.
 *
 * ## The one rule that matters
 *
 * Every payload must carry `data_class: "TEST_ONLY"` (proposal section 9). That
 * single field is the difference between a lab and a data breach, so it is
 * enforced on **ingest**, not trusted from the client: a payload missing it is
 * rejected, stored as a control failure, and raises an alert. If this check were
 * client-side only, the demonstration's central safety claim would be unfalsifiable
 * -- which is precisely what proposal section 12 asks us to avoid.
 *
 * ## Why this lives in the Hub Durable Object
 *
 * Sessions must be correlated across restarts, and the dashboard polls. The DO
 * already provides a single addressable stateful instance with hibernation, so
 * reusing it avoids a second store and a second failure mode. Events are held in
 * a capped ring: a lab exercise is bounded, and an unbounded log in a Durable
 * Object is a memory leak with a deadline.
 */

import {
  KEY_LAB_SESSION,
  type RelayMessage,
} from "./protocol";

/** Section 9's schema. Anything outside this is rejected. */
export interface LabEvent {
  session_id: string;
  device_id: string;
  event: string;
  timestamp: string;
  data_class: "TEST_ONLY";
  value?: string;
  app_version?: string;
}

export const REQUIRED_EVENT_TYPES = [
  "SESSION_START",
  "PERMISSION_PROMPT",
  "PERMISSION_GRANTED",
  "PERMISSION_DENIED",
  "SYNTHETIC_MEDIA_ACCESS",
  "SYNTHETIC_SMS_ACCESS",
  "SYNTHETIC_CONTACTS_ACCESS",
  "SYNTHETIC_LOCATION_ACCESS",
  "SYNTHETIC_FILE_ACCESS",
  "APP_LAUNCH",
  "HEARTBEAT",
] as const;

const ALLOWED = new Set<string>(REQUIRED_EVENT_TYPES);
const MAX_VALUE_LEN = 200;

/** Cap stored events. A lab run is bounded; the DO is not. */
const MAX_EVENTS = 5000;
const MAX_SESSIONS = 200;
/** How long a session stays claimable, in ms. */
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

const KEY_EVENTS = "lab:events";
const KEY_INDEX = "lab:sessions";
const KEY_FAILURES = "lab:control-failures";

export type Validation =
  | { ok: true; event: LabEvent }
  | { ok: false; reason: string; field?: string };

/**
 * Validates an inbound payload against section 9.
 *
 * Deliberately strict and deliberately server-side. Rejecting an unexpected
 * `event` type is not pedantry: it is how the demonstration proves that the
 * device cannot inject arbitrary content into the analyst's evidence.
 */
export function validateEvent(raw: unknown): Validation {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: "payload is not a JSON object" };
  }
  const o = raw as Record<string, unknown>;

  for (const f of ["session_id", "device_id", "event", "timestamp"] as const) {
    if (typeof o[f] !== "string" || (o[f] as string).trim() === "") {
      return { ok: false, reason: `missing or empty '${f}'`, field: f };
    }
  }

  // The safety field. Checked before anything else is trusted.
  if (o.data_class !== "TEST_ONLY") {
    return {
      ok: false,
      reason:
        "data_class must be exactly 'TEST_ONLY'. A payload without it is not " +
        "synthetic data and is refused. This is the control that keeps the " +
        "exercise from handling real personal data.",
      field: "data_class",
    };
  }

  if (!ALLOWED.has(o.event as string)) {
    return {
      ok: false,
      reason: `unknown event type '${String(o.event).slice(0, 40)}'`,
      field: "event",
    };
  }

  const ts = Date.parse(o.timestamp as string);
  if (Number.isNaN(ts)) {
    return { ok: false, reason: "timestamp is not ISO-8601", field: "timestamp" };
  }

  // Clock skew is normal in a lab; a wildly wrong clock is not. Generous on
  // purpose so the demo does not fail on a technicality, but bounded so a
  // device with no valid time cannot forge a plausible timeline.
  if (Math.abs(Date.now() - ts) > 7 * 24 * 60 * 60 * 1000) {
    return { ok: false, reason: "timestamp is more than 7 days from now", field: "timestamp" };
  }

  if (o.value != null) {
    if (typeof o.value !== "string") {
      return { ok: false, reason: "value must be a string", field: "value" };
    }
    if (o.value.length > MAX_VALUE_LEN) {
      return {
        ok: false,
        reason: `value exceeds ${MAX_VALUE_LEN} characters`,
        field: "value",
      };
    }
  }

  return {
    ok: true,
    event: {
      session_id: (o.session_id as string).slice(0, 64),
      device_id: (o.device_id as string).slice(0, 64),
      event: o.event as string,
      timestamp: new Date(ts).toISOString(),
      data_class: "TEST_ONLY",
      ...(o.value != null ? { value: (o.value as string).slice(0, MAX_VALUE_LEN) } : {}),
      ...(o.app_version != null ? { app_version: String(o.app_version).slice(0, 32) } : {}),
    },
  };
}

export interface LabStore {
  append(ev: LabEvent): Promise<void>;
  recordFailure(f: { at: string; reason: string; field?: string; raw: unknown }): Promise<void>;
  events(sessionId?: string, limit?: number): Promise<LabEvent[]>;
  failures(): Promise<Array<{ at: string; reason: string; field?: string }>>;
  sessions(): Promise<LabSession[]>;
  claimSession(sessionId: string, deviceId: string): Promise<{ created: boolean; known: boolean }>;
  alerts(): Promise<LabAlert[]>;
  clear(): Promise<void>;
}

export interface LabSession {
  session_id: string;
  device_id: string;
  first_seen: string;
  last_seen: string;
  event_count: number;
  by_type: Record<string, number>;
}

export interface LabAlert {
  id: string;
  severity: "info" | "warning" | "critical";
  rule: string;
  message: string;
  at: string;
  session_id?: string;
}

/**
 * Alert rules. Proposal section 7.9 asks for alerts on unusual link activity,
 * unexpected app installation, repeated permission requests and unexpected
 * outbound connections. Four of those are visible from telemetry; the fifth
 * (outbound connections) is the analyst workstation's job and is documented in
 * `tools/lab/`.
 */
export function evaluateAlerts(
  events: LabEvent[],
  failures: Array<{ at: string; reason: string; field?: string }>,
): LabAlert[] {
  const alerts: LabAlert[] = [];
  const now = new Date().toISOString();

  // Rule 1 -- a payload that is not synthetic data. Critical, always.
  for (const f of failures) {
    if (f.field === "data_class") {
      alerts.push({
        id: `data-class-${f.at}`,
        severity: "critical",
        rule: "NON_SYNTHETIC_PAYLOAD",
        message: `Rejected a payload that was not marked TEST_ONLY: ${f.reason}`,
        at: f.at,
      });
    }
  }

  const bySession = new Map<string, LabEvent[]>();
  for (const e of events) {
    const list = bySession.get(e.session_id) ?? [];
    list.push(e);
    bySession.set(e.session_id, list);
  }

  for (const [sessionId, evs] of bySession) {
    // Rule 2 -- repeated permission prompts. Section 7.9.
    const prompts = evs.filter((e) => e.event === "PERMISSION_PROMPT");
    if (prompts.length > 5) {
      alerts.push({
        id: `perm-loop-${sessionId}`,
        severity: "warning",
        rule: "REPEATED_PERMISSION_PROMPTS",
        message: `${prompts.length} permission prompts in one session. May indicate a permission loop or a confused user.`,
        at: prompts[prompts.length - 1]!.timestamp,
        session_id: sessionId,
      });
    }

    // Rule 3 -- a permission granted for something never prompted for.
    const prompted = new Set(
      evs.filter((e) => e.event === "PERMISSION_PROMPT").map((e) => e.value ?? "")
    );
    for (const g of evs.filter((e) => e.event === "PERMISSION_GRANTED")) {
      const what = g.value ?? "";
      if (what && !prompted.has(what)) {
        alerts.push({
          id: `unprompted-${sessionId}-${what}`,
          severity: "warning",
          rule: "UNPROMPTED_PERMISSION",
          message: `Permission '${what}' was granted with no corresponding prompt event.`,
          at: g.timestamp,
          session_id: sessionId,
        });
      }
    }

    // Rule 4 -- a device_id changing inside one session. Attribution failure.
    const devices = new Set(evs.map((e) => e.device_id));
    if (devices.size > 1) {
      alerts.push({
        id: `device-swap-${sessionId}`,
        severity: "critical",
        rule: "SESSION_ATTRIBUTION_BROKEN",
        message: `Session ${sessionId} reported ${devices.size} different device ids. Events cannot be attributed to one device.`,
        at: now,
        session_id: sessionId,
      });
    }
  }

  return alerts;
}

export function makeStore(ctx: DurableObjectState): LabStore {
  return {
    async append(ev) {
      const all = (await ctx.storage.get<LabEvent[]>(KEY_EVENTS)) ?? [];
      all.push(ev);
      // Ring buffer: drop the oldest rather than growing without bound.
      if (all.length > MAX_EVENTS) all.splice(0, all.length - MAX_EVENTS);
      await ctx.storage.put(KEY_EVENTS, all);
    },

    async recordFailure(f) {
      const all = (await ctx.storage.get<typeof f[]>(KEY_FAILURES)) ?? [];
      all.push(f);
      if (all.length > 200) all.splice(0, all.length - 200);
      await ctx.storage.put(KEY_FAILURES, all);
    },

    async events(sessionId, limit = 500) {
      const all = (await ctx.storage.get<LabEvent[]>(KEY_EVENTS)) ?? [];
      const filtered = sessionId ? all.filter((e) => e.session_id === sessionId) : all;
      return filtered.slice(-limit);
    },

    async failures() {
      return (await ctx.storage.get<Array<{ at: string; reason: string; field?: string }>>(
        KEY_FAILURES
      )) ?? [];
    },

    async sessions() {
      const index = (await ctx.storage.get<Record<string, { device_id: string; first_seen: string }>>(
        KEY_INDEX
      )) ?? {};
      const all = (await ctx.storage.get<LabEvent[]>(KEY_EVENTS)) ?? [];
      const now = Date.now();
      const out: LabSession[] = [];

      for (const [id, meta] of Object.entries(index)) {
        if (now - Date.parse(meta.first_seen) > SESSION_TTL_MS) continue;
        const evs = all.filter((e) => e.session_id === id);
        const byType: Record<string, number> = {};
        for (const e of evs) byType[e.event] = (byType[e.event] ?? 0) + 1;
        out.push({
          session_id: id,
          device_id: meta.device_id,
          first_seen: meta.first_seen,
          last_seen: evs.length ? evs[evs.length - 1]!.timestamp : meta.first_seen,
          event_count: evs.length,
          by_type: byType,
        });
      }
      return out.sort((a, b) => b.last_seen.localeCompare(a.last_seen)).slice(0, MAX_SESSIONS);
    },

    async claimSession(sessionId, deviceId) {
      const index = (await ctx.storage.get<Record<string, { device_id: string; first_seen: string }>>(
        KEY_INDEX
      )) ?? {};

      // The index is the single source of truth. An earlier version read a
      // per-session key that was never written, so this check was always vacuous
      // and a second device could post into someone else's session -- which is
      // exactly the attribution failure proposal section 12 forbids.
      const existing = index[sessionId];
      if (existing) {
        return { created: false, known: existing.device_id === deviceId };
      }

      index[sessionId] = { device_id: deviceId, first_seen: new Date().toISOString() };
      const keys = Object.keys(index);
      for (const k of keys.slice(0, Math.max(0, keys.length - MAX_SESSIONS))) delete index[k];

      // Also keep a targeted record, so a session can be resolved without
      // reading the whole index.
      await ctx.storage.put(KEY_LAB_SESSION(sessionId), {
        device_id: deviceId,
        first_seen: index[sessionId]!.first_seen,
      });
      await ctx.storage.put(KEY_INDEX, index);
      return { created: true, known: true };
    },

    async alerts() {
      return evaluateAlerts(await this.events(undefined, MAX_EVENTS), await this.failures());
    },

    async clear() {
      const index = (await ctx.storage.get<Record<string, unknown>>(KEY_INDEX)) ?? {};
      const keys = Object.keys(index).map((id) => KEY_LAB_SESSION(id));
      await ctx.storage.delete([KEY_EVENTS, KEY_INDEX, KEY_FAILURES, ...keys]);
    },
  };
}

export { MAX_EVENTS, ALLOWED as ALLOWED_EVENT_TYPES };

/** A small shape the Hub can satisfy without importing the whole LabStore. */
export type LabRoute = (
  request: Request,
  store: LabStore
) => Promise<{ status: number; body: unknown; msg?: RelayMessage }>;
