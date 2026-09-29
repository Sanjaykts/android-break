#!/usr/bin/env node
/**
 * A local HTTPS endpoint for the weak-TLS training target (proposal section 10,
 * class D7).
 *
 * The problem this solves: `agent/toylab/.../WeakTlsDemo.kt` installs a
 * trust-all trust manager and a hostname verifier that accepts every name. That
 * code is correct and is enforced by `toy-policy.mjs` -- but the lab server runs
 * plain HTTP under `wrangler dev`, so there was nothing for the flaw to defeat.
 * The demonstration could only be asserted, never observed.
 *
 * So this serves HTTPS with a deliberately self-signed certificate on loopback.
 * A correctly validating client rejects it; `WeakTlsDemo` accepts it. The
 * difference between those two outcomes *is* the lesson.
 *
 * Constraints, because this is deliberately weak:
 *   - binds to 127.0.0.1 only, never 0.0.0.0;
 *   - serves one fixed JSON document and nothing else;
 *   - the certificate is generated locally and never leaves the lab;
 *   - `toy-policy.mjs` still requires the app's own URLs to be loopback or
 *     .invalid, so this can only ever be reached over the loopback interface.
 *
 *   node tools/lab-tls-endpoint.mjs [--port 8443] [--cert lab-evidence/tls]
 */

import { execFileSync } from "node:child_process";
import { createServer } from "node:https";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";

const args = new Map();
for (let i = 2; i < process.argv.length; i++) {
  const k = process.argv[i].replace(/^--/, "");
  const n = process.argv[i + 1];
  if (n === undefined || n.startsWith("--")) args.set(k, true);
  else { args.set(k, n); i++; }
}

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = Number(args.get("port") || 8443);
const CERT_DIR = path.resolve(REPO, String(args.get("cert") || "lab-evidence/tls"));
const KEY = path.join(CERT_DIR, "lab-selfsigned.key");
const CRT = path.join(CERT_DIR, "lab-selfsigned.crt");

// The one document this serves. Nothing user-supplied, nothing dynamic: the
// endpoint must not become a general-purpose listener.
const BODY = JSON.stringify({
  lab: "weak-tls-demonstration",
  note: "self-signed on purpose; a validating client must reject this",
  data_class: "TEST_ONLY",
}, null, 2);

function ensureCert() {
  if (fs.existsSync(KEY) && fs.existsSync(CRT)) return false;
  fs.mkdirSync(CERT_DIR, { recursive: true });
  // A CN that is not the address anyone connects to. If the demo ever appeared
  // to work only because the name matched, it would be proving the wrong thing.
  const cnf = path.join(CERT_DIR, "openssl.cnf");
  fs.writeFileSync(cnf, [
    "[req]", "distinguished_name=dn", "x509_extensions=v3", "prompt=no",
    "[dn]", "CN=untrusted-training-endpoint.invalid",
    "[v3]", "subjectAltName=DNS:untrusted-training-endpoint.invalid",
    "basicConstraints=critical,CA:FALSE",
    "keyUsage=critical,digitalSignature,keyEncipherment",
    "extendedKeyUsage=serverAuth",
  ].join("\n") + "\n");
  try {
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", KEY, "-out", CRT, "-days", "365", "-config", cnf,
    ], { stdio: "ignore" });
  } catch {
    console.error("openssl is required to generate the lab certificate.");
    console.error("  apt install openssl   # Kali/Debian");
    process.exit(1);
  }
  console.log(`  generated a self-signed certificate in ${path.relative(REPO, CERT_DIR)}`);
  return true;
}

const fresh = ensureCert();
const server = createServer({ key: fs.readFileSync(KEY), cert: fs.readFileSync(CRT) }, (req, res) => {
  res.writeHead(200, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  res.end(BODY);
});

// Loopback only. Not 0.0.0.0 -- an unauthenticated HTTPS listener on every
// interface, even with a self-signed cert, is not something to hand a lab.
server.listen(PORT, "127.0.0.1", () => {
  const where = fresh ? "generated" : "reusing";
  console.log(`  lab TLS endpoint on https://127.0.0.1:${PORT}  (${where} certificate)`);
  console.log("");
  console.log("  A correctly validating client rejects this certificate.");
  console.log("  WeakTlsDemo accepts it. That difference is the demonstration.");
  console.log("");
  console.log("  Prove both halves:");
  console.log(`    curl -sS https://127.0.0.1:${PORT}            # expect a certificate error`);
  console.log(`    curl -skS https://127.0.0.1:${PORT}           # expect the JSON body`);
  console.log("");
  console.log(`  The training target should read: https://127.0.0.1:${PORT}/lab/health`);
  console.log("  Ctrl-C to stop.");
});
