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

function hubStub(env: Env): DurableObjectStub<Hub> {
  return env.HUB.get(env.HUB.idFromName("global"));
}

/**
 * Length-independent comparison. These are demo-scale shared secrets rather than
 * per-device credentials, but there is no reason to leak length via an early
 * return.
 */
function secretsEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  let diff = ab.length ^ bb.length;
  const n = Math.max(ab.length, bb.length);
  for (let i = 0; i < n; i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}
