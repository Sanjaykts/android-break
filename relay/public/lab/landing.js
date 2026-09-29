/**
 * Landing page script. Issues a session id and hands it to the lab app.
 *
 * The session id is generated **server-side**. That is deliberate: proposal
 * section 12 requires every test event to be attributable to a laboratory
 * session, and a client-generated id would be trivially forgeable, which would
 * make attribution meaningless.
 */
const $ = (s) => document.querySelector(s);

async function issueSession() {
  const res = await fetch("/lab/session", { method: "POST" });
  if (!res.ok) {
    $(".banner").textContent = "Lab server unreachable — the exercise cannot start.";
    return;
  }
  const body = await res.json();
  // The device id is supplied by the app on first run, not here, so the page
  // records only what the server issued.
  localStorage.setItem("lab.session", body.session_id);
  $("#sid").textContent = body.session_id;
  $("#iat").textContent = body.issued_at;
  document.title = `Lab ${body.session_id}`;
}

$("#regen").addEventListener("click", issueSession);
issueSession();
