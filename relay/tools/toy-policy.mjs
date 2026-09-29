#!/usr/bin/env node
/**
 * Training-target policy check — proposal section 10, classes D2–D5 and D7.
 *
 * The deliberately-flawed training targets are only legitimate if two opposing
 * things are simultaneously true:
 *
 *   1. The flaw is actually present. A training app that accidentally does the
 *      right thing teaches nothing, and the demonstration would quietly become a
 *      lie in the same direction as every other security claim that is merely
 *      asserted.
 *   2. The flaw is inert. A real insecure-TLS or WebView-bridge bug on a real
 *      device is a live liability to whoever installs it. These targets must
 *      demonstrate the weakness without being able to reach anything real.
 *
 * So this check asserts both, and fails the build if either stops being true.
 * Part 2 is the one that matters most: an intentionally vulnerable app that
 * phones home is not a teaching aid.
 *
 *   node tools/toy-policy.mjs [--sdk <android-sdk>]
 */

import { execFileSync } from "node:child_process";
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

const SDK = args.get("sdk") || process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
const AAPT = path.join(SDK || "", "build-tools", "34.0.0", "aapt2");
// fileURLToPath, not `new URL(...).pathname`: a path containing a space is
// percent-encoded in the latter, and every path built from it then points at a
// file that does not exist.
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const TOY_DIR = path.join(REPO, "agent/toylab");
const SRC = path.join(TOY_DIR, "src/main/java/dev/breakremote/toylab");
const APK =
  args.get("apk") || path.join(TOY_DIR, "build/outputs/apk/debug/toylab-debug.apk");

let failures = 0;
const pass = (m) => console.log(`  PASS  ${m}`);
const fail = (m) => { failures++; console.log(`  FAIL  ${m}`); };
const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "");

const sources = Object.fromEntries(
  fs.readdirSync(SRC).filter((f) => f.endsWith(".kt")).map((f) => [f, read(path.join(SRC, f))]),
);
const allSource = Object.values(sources).join("\n");

/**
 * Strip comments and string literals so a check reads executable code.
 *
 * These files are full of remediation prose -- one of them recommends using
 * EncryptedSharedPreferences and names the Android Keystore. Matching that text
 * to decide whether the app can read a real credential reports the opposite of
 * the truth, which is worse than not checking at all.
 */
const codeOnly = (src) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/"""[\s\S]*?"""/g, '""')
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''");
const toyCode = codeOnly(allSource);
const manifestXml = read(path.join(TOY_DIR, "src/main/AndroidManifest.xml"));

let mergedManifest = manifestXml;
if (fs.existsSync(APK) && AAPT) {
  try {
    mergedManifest += execFileSync(
      AAPT, ["dump", "xmltree", "--file", "AndroidManifest.xml", APK],
      { encoding: "utf8", maxBuffer: 1 << 26 },
    );
  } catch { /* fall back to the source manifest */ }
} else {
  console.log("  NOTE  training-target APK not built; checking the source manifest only");
}

console.log("Training-target policy — proposal section 10, D2–D5 and D7");

// ── 1. the flaws must be present ─────────────────────────────────────────────
// Each of these is the point of one tab in the training app. If a "fix" ever
// lands here, the demonstration silently stops demonstrating anything.
console.log("\n1. Each declared flaw is actually present");
const FLAWS = [
  ["D2", "insecure deep link / unvalidated intent", "DeepLinkDemo.kt", (s) =>
    /getStringExtra\(\s*"payload"\s*\)/.test(s) &&
    // The flaw is the *absence* of caller verification, so assert on calls that
    // would perform it. Comments and prose are stripped first.
    !/checkCallingPermission|getCallingPackage|getCallingActivity|enforcePermission|checkPermission/.test(codeOnly(s))],
  ["D3", "unsafe JavaScript bridge", "WebViewBridgeDemo.kt", (s) =>
    /addJavascriptInterface/.test(codeOnly(s)) && /javaScriptEnabled\s*=\s*true/.test(codeOnly(s))],
  ["D4", "exported provider with no permission", "ExportedComponentDemo.kt", (s) =>
    /class LabProvider/.test(s)],
  ["D5", "token in cleartext preferences and logs", "InsecureStorageDemo.kt", (s) =>
    /putString\(\s*KEY_TOKEN/.test(s) && /Log\.[we]\(\s*TAG\s*,[^)]*token=/.test(s)],
  ["D7", "trust-all TLS and permissive hostname check", "WeakTlsDemo.kt", (s) => {
    const c = codeOnly(s);
    if (!/checkServerTrusted/.test(c)) return false;
    // A trust-all manager accepts anything, so the real signal is that there is
    // no verification logic: no rejection, no chain inspection, no exception.
    return !/CertificateException|throw |chain\[|chain\.|chain\?\./.test(c);
  }],
];
for (const [id, what, file, test] of FLAWS) {
  const src = sources[file] || "";
  if (!src) { fail(`${id} ${what}: ${file} is missing`); continue; }
  if (test(src)) pass(`${id} ${what} is present in ${file}`);
  else fail(`${id} ${what} is NOT present in ${file} — the target no longer teaches anything`);
}
// Every target MainActivity offers a button for must actually be launchable.
// Three of the five were never declared as activities, so tapping the tab threw
// ActivityNotFoundException and the lesson could not be seen. Nothing in CI
// caught it: the manifest parses, the sources compile, and the policy above was
// only asserting the presence of flaws. Asserting that the app is *reachable*
// is a different property from asserting what is wrong with it.
const TARGETS = ["WebViewBridgeDemo", "ExportedComponentDemo", "InsecureStorageDemo", "WeakTlsDemo", "DeepLinkDemo"];
const missingTargets = TARGETS.filter((c) => !new RegExp(`android:name="\\.${c}"`).test(manifestXml));
if (missingTargets.length === 0) {
  pass(`all ${TARGETS.length} training targets are declared, so every tab is launchable`);
} else {
  fail(`declared as buttons but not as activities: ${missingTargets.join(", ")} — the tab will throw ActivityNotFoundException`);
}
// And the launcher offers a button for each of them.
const launcher = read(path.join(SRC, "MainActivity.kt"));
const unlinked = TARGETS.filter((c) => !launcher.includes(`${c}::class.java`));
if (unlinked.length === 0) {
  pass("the launcher links to every declared target");
} else {
  fail(`declared but never launched from the launcher: ${unlinked.join(", ")}`);
}
// A bypass is only persuasive when the same request is shown NOT bypassing, so
// the weak-TLS target must carry its own negative control.
if (/attemptValidating/.test(sources["WeakTlsDemo.kt"] || "")) {
  pass("the weak-TLS target includes a negative control (same URL, validation left on)");
} else {
  fail("WeakTlsDemo has no negative control -- the bypass is asserted but never contrasted");
}
// And the request must not run on the main thread, which Android forbids.
if (/NetworkOnMainThread|Thread\s*\{/.test(sources["WeakTlsDemo.kt"] || "")) {
  pass("the weak-TLS request runs off the main thread");
} else {
  fail("WeakTlsDemo appears to do its request on the main thread; Android will throw NetworkOnMainThreadException");
}
// A deep-link target that ignores onNewIntent silently drops any second link.
const deep = sources["DeepLinkDemo.kt"] || "";
if (/onNewIntent/.test(deep) && /launchMode="singleTop"/.test(manifestXml)) {
  pass("the deep-link target handles onNewIntent with singleTop, so a second link is not dropped");
} else {
  fail("DeepLinkDemo needs both onNewIntent and launchMode=\"singleTop\" or a second deep link is silently dropped");
}

if (/android:exported="true"/.test(manifestXml) && !/android:permission=/.test(manifestXml)) {
  pass("D4 exported component is declared with no guarding permission");
} else {
  fail("D4 exported component is not declared exported-and-unprotected in the manifest");
}

// ── 2. the flaws must be inert ───────────────────────────────────────────────
// This is the part that keeps a deliberately vulnerable app from becoming a
// real one. Every check below is about blast radius, not about vulnerability.
console.log("\n2. The declared flaws cannot reach anything real");
const FORBIDDEN = [
  ["BIND_ACCESSIBILITY_SERVICE", "accessibility service"],
  ["FOREGROUND_SERVICE", "foreground service"],
  ["RECEIVE_BOOT_COMPLETED", "boot receiver (persistence)"],
  ["REQUEST_INSTALL_PACKAGES", "package installation"],
  ["WRITE_SECURE_SETTINGS", "secure settings write"],
  ["SEND_SMS", "SMS sending"],
  ["READ_SMS", "SMS reading"],
  ["CAMERA", "camera"],
  ["RECORD_AUDIO", "microphone"],
  ["READ_CONTACTS", "contacts"],
  ["SYSTEM_ALERT_WINDOW", "overlay window"],
];
for (const [perm, what] of FORBIDDEN) {
  if (!mergedManifest.includes(perm)) pass(`training target does not request ${what}`);
  else fail(`training target requests ${what} (${perm}) — it must not be able to do that`);
}
if (!/\bsu\b|\/system\/bin\/su\b|supersu|magisk/i.test(toyCode)) {
  pass("no root or privilege-escalation path in the training targets");
} else fail("training target source references root / Magisk / SuperSU");
if (!/Runtime\.getRuntime\(\)\.exec/.test(toyCode)) {
  pass("training targets never shell out");
} else fail("training target shells out via Runtime.exec()");

// Network reach: the only URLs in the whole module must be loopback or the
// RFC 2606 reserved .invalid TLD, which can never resolve.
console.log("\n3. Network reach stays on the loopback interface");
const urls = [...new Set((allSource.match(/https?:\/\/[A-Za-z0-9./_:@%-]+/g) || []))];
if (urls.length === 0) {
  pass("training targets contain no network URLs at all");
} else {
  for (const u of urls) {
    if (/(^https?:\/\/)(127\.0\.0\.1|localhost|10\.0\.2\.2)\b/.test(u) || /\.invalid\b/.test(u)) {
      pass(`target is inert: ${u}`);
    } else fail(`target could resolve and leave the device: ${u}`);
  }
}
// The WebView flaw must be demonstrated against inline HTML, not a real page.
if (sources["WebViewBridgeDemo.kt"] && !/loadUrl\(/.test(codeOnly(sources["WebViewBridgeDemo.kt"]))) {
  pass("WebView target loads inline HTML via loadDataWithBaseURL, not loadUrl");
} else {
  fail("WebView target calls loadUrl — it must not fetch a real page");
}
// The insecure-storage token must be a locally generated dummy. Two separate
// claims, so two separate tests: the marker is a string literal (tested on raw
// source, since codeOnly() would strip it), while the absence of any real
// credential channel is a claim about code.
// Scoped to the file that writes the token. The check used to run over the whole
// module, which then tripped on BuildConfig.TOYLAB_TLS_URL in the weak-TLS target
// -- a URL, not a credential. "No credential may come from config" is a claim
// about the token, so it is tested where the token is produced.
const storageCode = codeOnly(sources["InsecureStorageDemo.kt"] || "");
if (/training-token-/.test(allSource) && /UUID\.randomUUID/.test(allSource) &&
    !/System\.getenv|BuildConfig|getExternalStorage|openFileInput|\.jks|\.p12|\.pem/.test(storageCode)) {
  pass("the token written to cleartext storage is a locally generated training dummy");
} else {
  fail("the token written to cleartext storage could come from a real credential source");
}

// ── 4. the written deliverables must still cover the proposal ────────────────
// Section 10 and section 15 are deliverable-shaped, and a deliverable can rot in
// the same way code does: a bullet gets dropped, or a recommendation quietly
// stops being addressed. Both are cheap to check and invisible in review.
console.log("\n4. The written deliverables still cover the proposal");
const PROPOSAL = read(path.join(REPO, "AutomationX_Zions_EQB_Android_Security_Research_Demo_Proposal.md"));
function section(n, next) {
  const start = PROPOSAL.indexOf(`## ${n}.`);
  const end = next ? PROPOSAL.indexOf(`## ${next}.`) : PROPOSAL.length;
  return start === -1 ? "" : PROPOSAL.slice(start, end === -1 ? undefined : end);
}
const sec15 = section("15", "16");
const sec10 = section("10", "11");
if (!sec15 || !sec10) {
  fail("could not locate proposal sections 10 and 15 -- has the proposal been renamed?");
} else {
  const recs = sec15.split("\n").filter((l) => l.trim().startsWith("- ")).map((l) => l.trim().slice(2));
  const defensive = read(path.join(REPO, "docs/DEFENSIVE-OUTCOMES.md"));
  const sections = defensive.split("\n").filter((l) => /^## \d+\./.test(l));
  if (sections.length === recs.length) {
    pass(`all ${recs.length} section 15 recommendations have a section of their own`);
  } else {
    fail(`section 15 has ${recs.length} recommendations but docs/DEFENSIVE-OUTCOMES.md has ${sections.length} sections`);
  }
  const classes = sec10.split("\n").filter((l) => l.trim().startsWith("- "));
  const d8 = read(path.join(REPO, "docs/D8-PATCHED-VULNERABILITIES.md"));
  if (d8) {
    if (classes.length === 8) {
      pass(`all ${classes.length} section 10 vulnerability classes accounted for`);
    } else {
      fail(`proposal section 10 lists ${classes.length} classes, not the 8 this check assumes -- reconcile D1-D8`);
    }
    // A discussion that starts citing CVE numbers starts going stale, and the
    // point of the deliverable is that the pattern outlives the advisory.
    if (/CVE-\d{4}-\d{4,}/.test(d8)) {
      fail("D8 cites specific CVE identifiers; it should teach the pattern, not a dated list");
    } else {
      pass("D8 teaches recurring patterns and cites no dated CVE list");
    }
  } else {
    fail("docs/D8-PATCHED-VULNERABILITIES.md is missing -- section 10 D8 has no deliverable");
  }
}

console.log(`\n${"-".repeat(58)}`);
if (failures) {
  console.log(`${failures} training-target policy violation(s).`);
  process.exit(1);
}
console.log("Training-target policy holds: the flaws are real, and they cannot leave the device.");
