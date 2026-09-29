#!/usr/bin/env node
/**
 * Lab telemetry end-to-end test.
 *
 * Covers the controls that make the demonstration's safety claims falsifiable
 * rather than asserted (proposal sections 9, 12, 13). Every check here is one an
 * analyst would otherwise have to verify by hand, during a demonstration, while
 * being watched.
 *
 *   node tools/lab-e2e.mjs --url http://127.0.0.1:8787
 */
import crypto from "node:crypto";

const args = new Map();
for (let i = 2; i < process.argv.length; i++) {
  const k = process.argv[i].replace(/^--/, "");
  const n = process.argv[i + 1];
  if (n === undefined || n.startsWith("--")) args.set(k, true);
  else { args.set(k, n); i++; }
}
const HTTP = args.get("url") || "http://127.0.0.1:8787";
const AGENT = args.get("agent-token") || process.env.AGENT_TOKEN || "dev-agent-token";
const CONSOLE = args.get("console-token") || process.env.CONSOLE_TOKEN || "dev-console-token";

let passed = 0; const failures = [];
const check = (n, ok, d = "") => {
  if (ok) { passed++; console.log(`  PASS  ${n}`); }
  else { failures.push(n); console.log(`  FAIL  ${n}${d ? ` -- ${d}` : ""}`); }
};
const ts = () => new Date().toISOString();

async function issue() {
  const r = await fetch(`${HTTP}/lab/session`, { method: "POST" });
  return (await r.json()).session_id;
}
// dataClass: omit the field entirely with null. Using `undefined` would trigger
// the default parameter, so the field would still be sent and the "absent" case
// would silently test nothing.
async function post(sid, device, event, value, dataClass = "TEST_ONLY", token = AGENT) {
  const body = { session_id: sid, device_id: device, event, timestamp: ts() };
  if (dataClass !== null) body.data_class = dataClass;
  if (value != null) body.value = value;
  const r = await fetch(`${HTTP}/lab/event`, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}
const get = async (p, token = CONSOLE) => {
  const r = await fetch(`${HTTP}${p}${p.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`);
  return { status: r.status, body: await r.json().catch(() => null) };
};

console.log(`lab telemetry e2e -> ${HTTP}\n`);

console.log("1. Session issuance");
const sid = await issue();
check("server issues a session id", /^LAB-\d{4}-[A-Z0-9]{8}$/.test(sid), sid);
const sid2 = await issue();
check("each session id is unique", sid !== sid2);
{
  const r = await fetch(`${HTTP}/lab/session`);
  check("GET /lab/session is refused", r.status === 405, `got ${r.status}`);
}

console.log("\n2. The data_class control (proposal sections 9, 12, 13)");
check("a well-formed TEST_ONLY event is accepted", (await post(sid, "TEST-ANDROID-01", "HEARTBEAT")).status === 200);
check("data_class absent is rejected",
  (await post(sid, "TEST-ANDROID-01", "HEARTBEAT", null, null)).status === 422);
check("data_class set to something else is rejected",
  (await post(sid, "TEST-ANDROID-01", "HEARTBEAT", null, "REAL_USER_DATA")).status === 422);
{
  const f = await get("/lab/failures");
  const n = (f.body?.failures || []).filter((x) => x.field === "data_class").length;
  check("rejections are recorded as control failures, not silently dropped", n >= 2, `${n} recorded`);
}
{
  const a = await get("/lab/alerts");
  check("a non-synthetic payload raises a critical alert",
    (a.body?.alerts || []).some((x) => x.severity === "critical" && x.rule === "NON_SYNTHETIC_PAYLOAD"));
}

console.log("\n3. Schema validation");
check("an unknown event type is rejected",
  (await post(sid, "TEST-ANDROID-01", "EXFILTRATE_EVERYTHING")).status === 422);
{
  const r = await fetch(`${HTTP}/lab/event`, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${AGENT}` },
    body: JSON.stringify({ session_id: sid, device_id: "D", event: "HEARTBEAT", timestamp: "not-a-date", data_class: "TEST_ONLY" }),
  });
  check("a non-ISO timestamp is rejected", r.status === 422, `got ${r.status}`);
}
{
  const r = await fetch(`${HTTP}/lab/event`, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${AGENT}` },
    body: JSON.stringify({ session_id: sid, device_id: "D", event: "HEARTBEAT", timestamp: "2001-01-01T00:00:00Z", data_class: "TEST_ONLY" }),
  });
  check("a timestamp years out is rejected as implausible", r.status === 422, `got ${r.status}`);
}
{
  const r = await fetch(`${HTTP}/lab/event`, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${AGENT}` },
    body: JSON.stringify({ session_id: sid, device_id: "D", event: "HEARTBEAT", timestamp: ts(), data_class: "TEST_ONLY", value: "x".repeat(500) }),
  });
  check("an oversized value is rejected", r.status === 422, `got ${r.status}`);
}
check("malformed JSON is refused", (await fetch(`${HTTP}/lab/event`, {
  method: "POST", headers: { "content-type": "application/json", Authorization: `Bearer ${AGENT}` },
  body: "{not json",
})).status === 400);

console.log("\n4. Attribution (proposal section 12)");
check("the first device may post", (await post(sid, "TEST-ANDROID-01", "HEARTBEAT")).status === 200);
check("the same device may post again", (await post(sid, "TEST-ANDROID-01", "HEARTBEAT")).status === 200);
check("a different device cannot post into that session",
  (await post(sid, "SOMEONE-ELSE", "HEARTBEAT")).status === 409);

console.log("\n5. Authentication");
check("an unauthenticated write is refused",
  (await post(sid, "TEST-ANDROID-01", "HEARTBEAT", null, "TEST_ONLY", "wrong-token")).status === 401);
check("reads require the console token", (await get("/lab/sessions", "wrong-token")).status === 401);
check("the console token may read", (await get("/lab/sessions")).status === 200);
check("the agent token may not read the evidence store", (await get("/lab/sessions", AGENT)).status === 401);

console.log("\n6. Alert rules (proposal section 7.9)");
{
  const s2 = await issue();
  for (let i = 0; i < 7; i++) await post(s2, "TEST-ANDROID-02", "PERMISSION_PROMPT", "READ_SMS");
  const a = await get("/lab/alerts");
  check("repeated permission prompts raise a warning",
    (a.body?.alerts || []).some((x) => x.rule === "REPEATED_PERMISSION_PROMPTS"));
}
{
  const s3 = await issue();
  await post(s3, "TEST-ANDROID-03", "PERMISSION_GRANTED", "READ_CONTACTS");
  const a = await get("/lab/alerts");
  check("a grant with no matching prompt raises a warning",
    (a.body?.alerts || []).some((x) => x.rule === "UNPROMPTED_PERMISSION"));
}

console.log("\n7. Reset (proposal sections 7.10, 12)");
{
  const r = await fetch(`${HTTP}/lab/reset`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ confirm: "WRONG_WORD" }),
  });
  check("reset without the right confirmation is refused", r.status !== 200, `got ${r.status}`);
}
{
  const r = await fetch(`${HTTP}/lab/reset`, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${CONSOLE}` },
    body: JSON.stringify({ confirm: "RESET_LAB" }),
  });
  check("reset succeeds with the confirmation and the console token", r.status === 200, `got ${r.status}`);
  const s = await get("/lab/sessions");
  check("the evidence store is empty afterwards", (s.body?.sessions || []).length === 0,
    JSON.stringify(s.body?.sessions));
  const f = await get("/lab/failures");
  check("control failures are cleared too", (f.body?.failures || []).length === 0);
}

console.log(`\n${"-".repeat(58)}`);
console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log("\nfailures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log("Lab telemetry controls hold. The safety claims are falsifiable.");
