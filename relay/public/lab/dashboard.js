/**
 * Analyst dashboard (proposal sections 7.9, 8 and 11).
 *
 * Read-only by design. The only write action is the lab reset, which is gated
 * behind a typed confirmation so it cannot be triggered by a stray click during
 * a demonstration -- losing the evidence stream mid-demo would be as damaging as
 * a crash.
 */

const $ = (s) => document.querySelector(s);
const token = new URLSearchParams(location.search).get("token") || "";
let sessionFilter = null;

async function api(path) {
  const sep = path.includes("?") ? "&" : "?";
  const r = await fetch(`${path}${sep}token=${encodeURIComponent(token)}`);
  if (!r.ok) throw new Error(`${path} -> ${r.status}`);
  return r.json();
}

function h(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function renderAlerts(alerts) {
  const box = $("#alerts");
  box.textContent = "";
  if (!alerts.length) { box.appendChild(h("p", "muted", "none")); return; }
  for (const a of alerts.slice().reverse()) {
    const row = h("div", "row");
    row.appendChild(h("span", `badge ${a.severity}`, a.rule));
    const body = h("div");
    body.appendChild(h("div", null, a.message));
    body.appendChild(h("div", "muted", a.session_id ? `${a.session_id} · ${a.at}` : a.at));
    row.appendChild(body);
    box.appendChild(row);
  }
}

function renderSessions(sessions) {
  const box = $("#sessions");
  box.textContent = "";
  if (!sessions.length) { box.appendChild(h("p", "muted", "none — open the landing page to start one")); return; }
  for (const s of sessions) {
    const row = h("div", "row");
    const b = h("button", null, s.session_id);
    b.style.border = "none";
    b.style.background = "none";
    b.style.padding = "0";
    b.style.color = "#e6edf3";
    b.style.cursor = "pointer";
    b.style.font = "inherit";
    b.onclick = () => { sessionFilter = sessionFilter === s.session_id ? null : s.session_id; load(); };
    row.appendChild(b);
    const detail = h("div");
    detail.appendChild(h("div", null, `${s.device_id} · ${s.event_count} events`));
    detail.appendChild(h("div", "muted",
      Object.entries(s.by_type).map(([k, v]) => `${k.replace(/_/g, " ").toLowerCase()} ${v}`).join(" · ")));
    row.appendChild(detail);
    if (sessionFilter === s.session_id) row.style.borderColor = "#4ade80";
    box.appendChild(row);
  }
}

function renderEvents(events) {
  const body = $("#events");
  body.textContent = "";
  $("#filter-label").textContent = sessionFilter ? `filtered: ${sessionFilter}` : "all sessions";
  if (!events.length) {
    const tr = h("tr");
    const td = h("td", "muted", "no events yet");
    td.colSpan = 6;
    tr.appendChild(td);
    body.appendChild(tr);
    return;
  }
  for (const e of events.slice().reverse()) {
    const tr = h("tr");
    if (e.event === "PERMISSION_PROMPT" || e.event === "PERMISSION_GRANTED") tr.className = "perm";
    if (e.event === "PERMISSION_DENIED") tr.className = "fail";
    tr.appendChild(h("td", "mono", e.timestamp.slice(11, 19)));
    tr.appendChild(h("td", "mono", e.session_id));
    tr.appendChild(h("td", "mono", e.device_id));
    tr.appendChild(h("td", null, e.event.toLowerCase().replace(/_/g, " ")));
    tr.appendChild(h("td", "mono", e.value || ""));
    tr.appendChild(h("td", null, "")).appendChild(h("span", "tag", e.data_class));
    body.appendChild(tr);
  }
}

async function renderFailures() {
  const box = $("#failures");
  box.textContent = "";
  let failures = [];
  try {
    const r = await fetch(`/lab/failures?token=${encodeURIComponent(token)}`);
    if (r.ok) failures = (await r.json()).failures || [];
  } catch { /* leave empty */ }
  if (!failures.length) { box.appendChild(h("p", "muted", "none — every payload was well-formed")); return; }
  for (const f of failures.slice().reverse()) {
    const row = h("div", "row");
    row.appendChild(h("span", "badge critical", f.field || "rejected"));
    const body = h("div");
    body.appendChild(h("div", null, f.reason));
    body.appendChild(h("div", "muted", f.at));
    row.appendChild(body);
    box.appendChild(row);
  }
}

async function load() {
  try {
    const [alerts, sessions, events] = await Promise.all([
      api("/lab/alerts"),
      api("/lab/sessions"),
      api(`/lab/events${sessionFilter ? `?session=${encodeURIComponent(sessionFilter)}` : ""}`),
    ]);
    $("#status").textContent = "live";
    $("#status").className = "pill ok";
    renderAlerts(alerts.alerts || []);
    renderSessions(sessions.sessions || []);
    renderEvents(events.events || []);
    await renderFailures();
  } catch (e) {
    $("#status").textContent = String(e.message).slice(0, 40);
    $("#status").className = "pill bad";
  }
}

$("#refresh").onclick = load;

$("#reset").onclick = async () => {
  // Typed confirmation. A demonstration should never be able to wipe its own
  // evidence by an errant click.
  const typed = prompt(
    "This wipes all lab telemetry and cannot be undone.\n\nType RESET_LAB to confirm:"
  );
  if (typed !== "RESET_LAB") return;
  const r = await fetch("/lab/reset", {
    method: "POST",
    // The reset route is console-gated like every other control. Without this
    // header the button silently 401s and the analyst is left resetting by hand.
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ confirm: "RESET_LAB" }),
  });
  if (r.ok) { sessionFilter = null; load(); }
  else alert(`reset refused: ${r.status}`);
};

load();
setInterval(load, 3000);
