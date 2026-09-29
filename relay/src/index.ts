import { Hub, type Env } from "./hub";

export { Hub };

/**
 * Relay edge.
 *
 * Everything except the two WebSocket routes is served from Workers Static
 * Assets. This Worker does no relaying -- it authenticates and hands the upgrade
 * to the Hub Durable Object, which owns all connection state. Keeping auth at the
 * edge means a bad token never wakes a hibernating Durable Object.
 *
 * The two tokens are separate on purpose. CONSOLE_TOKEN can be rotated in a
 * Worker secret at any time without touching the phone. AGENT_TOKEN is baked into
 * the APK, so rotating it needs a new release; after the demo, rotate the console
 * token immediately and treat the agent token as spent.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    switch (url.pathname) {
      case "/health":
        return Response.json({ ok: true, service: "android-break-relay" });

      case "/devices":
        return handleDevices(request, url, env);

      // Lab telemetry. Proxied to the Hub Durable Object exactly like the
      // WebSocket routes; the two auth tiers differ per route (see handleLab).
      case "/lab/session":
      case "/lab/event":
      case "/lab/events":
      case "/lab/sessions":
      case "/lab/failures":
      case "/lab/alerts":
      case "/lab/reset":
      case "/lab/health":
        return handleLab(request, url, env);

      case "/ws/agent":
        return handleWs(request, url, env, env.AGENT_TOKEN, "agent");

      case "/ws/console":
        return handleWs(request, url, env, env.CONSOLE_TOKEN, "console");

      default:
        return env.ASSETS.fetch(request);
    }
  },
};

/**
 * Device list, also used by demo-preflight. Takes the console token as ?token=
 * (simplest from a shell script) or as a bearer header.
 */
async function handleDevices(request: Request, url: URL, env: Env): Promise<Response> {
  const misconfiguredResponse = misconfigured(env, "CONSOLE_TOKEN");
  if (misconfiguredResponse) return misconfiguredResponse;

  const bearer = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const supplied = url.searchParams.get("token") ?? bearer;
  if (!secretsEqual(supplied, env.CONSOLE_TOKEN)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const res = await hubStub(env).fetch("https://hub/devices");
  return new Response(await res.text(), {
    status: res.status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
    },
  });
}

async function handleWs(
  request: Request,
  url: URL,
  env: Env,
  expectedToken: string,
  kind: "agent" | "console"
): Promise<Response> {
  const misconfiguredResponse = misconfigured(
    env,
    kind === "agent" ? "AGENT_TOKEN" : "CONSOLE_TOKEN"
  );
  if (misconfiguredResponse) return misconfiguredResponse;

  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return new Response("expected websocket upgrade", { status: 426 });
  }
  if (!secretsEqual(url.searchParams.get("token") ?? "", expectedToken)) {
    // The protocol's 4401 close code cannot be used here: at the HTTP layer the
    // socket does not exist yet. Refusing the handshake is strictly stronger.
    return new Response("unauthorized", { status: 401 });
  }

  const target = new URL(`https://hub/connect-${kind}`);
  const device = url.searchParams.get("device");
  const cid = url.searchParams.get("cid");
  if (device) target.searchParams.set("device", device);
  if (cid) target.searchParams.set("cid", cid);
  if (kind === "agent" && !device) {
    return new Response("missing device id", { status: 400 });
  }

  return hubStub(env).fetch(new Request(target.toString(), request));
}

/**
 * Lab routes.
 *
 * Three tiers, and the split is deliberate:
 *
 *   - `/lab/session` is unauthenticated. The landing page is what *issues* the
 *     session, so requiring a token here would mean handing the analyst's
 *     credential to a page that any lab participant can load. It returns nothing
 *     sensitive -- just a fresh id and a timestamp.
 *
 *   - `/lab/event` requires the AGENT token, because only the lab app may write
 *     telemetry. An unauthenticated ingest endpoint is an open log-injection
 *     target and would let an attendee forge evidence.
 *
 *   - reads and `/lab/reset` require the CONSOLE token, so only the analyst can
 *     read evidence or wipe it.
 */
async function handleLab(request: Request, url: URL, env: Env): Promise<Response> {
  const path = url.pathname;

  if (path === "/lab/health") {
    return Response.json({ ok: true, service: "lab-telemetry" });
  }

  if (path === "/lab/session") {
    if (request.method !== "POST") {
      return Response.json({ error: "use POST" }, { status: 405 });
    }
    return proxyLab(request, env, path);
  }

  const needsAgentToken = path === "/lab/event";
  const expected = needsAgentToken ? env.AGENT_TOKEN : env.CONSOLE_TOKEN;

  const misconfiguredResponse = misconfigured(
    env,
    needsAgentToken ? "AGENT_TOKEN" : "CONSOLE_TOKEN"
  );
  if (misconfiguredResponse) return misconfiguredResponse;

  const bearer = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const supplied = url.searchParams.get("token") ?? bearer;
  if (!secretsEqual(supplied, expected)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  return proxyLab(request, env, path);
}

function proxyLab(request: Request, env: Env, path: string): Promise<Response> {
  const target = new URL(`https://hub${path}`);
  const token = new URL(request.url).searchParams.get("token");
  if (token) target.searchParams.set("token", token);
  return hubStub(env).fetch(new Request(target.toString(), request));
}

function hubStub(env: Env): DurableObjectStub<Hub> {
  return env.HUB.get(env.HUB.idFromName("global"));
}

/**
 * Length-independent comparison of a supplied token against a Worker secret.
 *
 * **Fails closed.** `TextEncoder.encode(undefined)` yields `""`, so a naive
 * comparison returns *true* for "no token supplied" against "no secret
 * configured" -- which means a Worker deployed before its secrets are set accepts
 * every request that simply omits the token. That is a real open-relay bug, and
 * it was found by CI rather than by review.
 */
function secretsEqual(supplied: string, expected: string | undefined): boolean {
  if (!expected) return false;
  const enc = new TextEncoder();
  const ab = enc.encode(supplied);
  const bb = enc.encode(expected);
  let diff = ab.length ^ bb.length;
  const n = Math.max(ab.length, bb.length);
  for (let i = 0; i < n; i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}

/**
 * Surfaces an unconfigured Worker as an explicit 503 rather than a puzzling 401,
 * so a missing `wrangler secret put` is obvious in the first minute of a demo
 * rather than halfway through it.
 */
function misconfigured(env: Env, which: string): Response | null {
  if (env.AGENT_TOKEN && env.CONSOLE_TOKEN) return null;
  return Response.json(
    {
      error: "relay is not configured",
      detail: `missing Worker secret: ${which}`,
      fix: "wrangler secret put AGENT_TOKEN && wrangler secret put CONSOLE_TOKEN",
    },
    { status: 503 }
  );
}
