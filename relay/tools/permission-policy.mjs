#!/usr/bin/env node
/**
 * Permission policy check — proposal sections 5 and 10.
 *
 * The demonstration's central claim is that the lab app holds only minimum
 * permissions and cannot read the screen, inject touches, or restart itself.
 * A claim like that is only worth anything if something enforces it, so this
 * reads the built manifests and fails the build when the claim stops being true.
 *
 * Two apps, deliberately opposite, compared side by side:
 *
 *   dev.breakremote.lab         the benign demonstration app
 *   dev.breakremote.agent       the "Break Remote" teaching artifact
 *
 * The second exists precisely to be the counter-example: it holds
 * BIND_ACCESSIBILITY_SERVICE and continuous MediaProjection, which is the
 * overbroad-permission anti-pattern section 10 asks us to teach. Removing the
 * dangerous permissions from the lab app is only meaningful while the
 * dangerous ones remain visible somewhere for comparison.
 *
 *   node tools/permission-policy.mjs --sdk <android-sdk> [--agent <apk>]
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

const LAB_APK =
  args.get("lab") || path.join(REPO, "agent/labapp/build/outputs/apk/debug/labapp-debug.apk");
const AGENT_APK =
  args.get("agent") || path.join(REPO, "agent/app/build/outputs/apk/release/app-release.apk");

/** Never permitted in the lab app, under any circumstances. */
const FORBIDDEN_IN_LAB = [
  // The anti-pattern the exercise teaches.
  "android.permission.BIND_ACCESSIBILITY_SERVICE",
  "android.permission.FOREGROUND_SERVICE_MEDIA_PROJECTION",
  "android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS",
  // Persistence. Section 3 excludes it.
  "android.permission.RECEIVE_BOOT_COMPLETED",
  "android.permission.REQUEST_INSTALL_PACKAGES",
  // Section 3 excludes camera and microphone outright.
  "android.permission.CAMERA",
  "android.permission.RECORD_AUDIO",
  // Capability grants an app should not hold in a lab.
  "android.permission.SYSTEM_ALERT_WINDOW",
  "android.permission.BIND_DEVICE_ADMIN",
  "android.permission.PACKAGE_USAGE_STATS",
  "android.permission.QUERY_ALL_PACKAGES",
  "android.permission.READ_CALL_LOG",
  "android.permission.WRITE_CALL_LOG",
  "android.permission.BODY_SENSORS",
  "android.permission.READ_CALL_LOG",
];

/** Components that would give the lab app a capability it must not have. */
const FORBIDDEN_COMPONENTS = [
  { type: "service", name: /accessibilityservice/i, why: "an AccessibilityService can read the screen and inject touches" },
  { type: "service", name: /InputMethod/i, why: "an IME can observe and alter all typing" },
  { type: "receiver", name: /BootReceiver|BOOT_COMPLETED/i, why: "a boot receiver is persistence across reboot" },
  { type: "service", name: /DeviceAdmin|DevicePolicyManager/i, why: "device admin is the kiosk/lockout anti-pattern" },
];

let failures = 0;
const pass = (m) => console.log(`  PASS  ${m}`);
const fail = (m) => { console.log(`  FAIL  ${m}`); failures++; };

function aapt2(argsList) {
  return execFileSync(AAPT, argsList, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
}

function usesPermissions(apk) {
  const out = aapt2(["dump", "badging", apk]);
  return [...out.matchAll(/uses-permission: name='([^']+)'/g)].map((m) => m[1]);
}

function manifestText(apk) {
  return aapt2(["dump", "xmltree", "--file", "AndroidManifest.xml", apk]);
}

console.log("Permission policy check");
console.log(`  sdk:    ${SDK || "(unset)"}`);
console.log(`  lab:    ${path.relative(REPO, LAB_APK)}`);
console.log(`  agent:  ${path.relative(REPO, AGENT_APK)}\n`);

if (!SDK || !fs.existsSync(AAPT)) {
  console.error(`aapt2 not found at ${AAPT}\n  set ANDROID_HOME, or pass --sdk`);
  process.exit(2);
}
if (!fs.existsSync(LAB_APK)) {
  console.error(`lab app APK not found: ${LAB_APK}\n  build it first:  cd agent && ./gradlew :labapp:assembleDebug`);
  process.exit(2);
}

const labPerms = new Set(usesPermissions(LAB_APK));
const labManifest = manifestText(LAB_APK);

// ── 1. forbidden permissions ────────────────────────────────────────────────
console.log("1. The lab app must not hold dangerous permissions");
for (const p of FORBIDDEN_IN_LAB) {
  if (labPerms.has(p)) fail(`${p} is declared`);
  else pass(`${p.replace("android.permission.", "")} absent`);
}

// ── 2. forbidden components ──────────────────────────────────────────────────
// Declared in uses-permission or not, a BIND_ACCESSIBILITY_SERVICE on the
// <service> element is what actually grants the capability, so the manifest has
// to be read rather than the permission list.
console.log("\n2. The lab app must not declare capability-granting components");
for (const c of FORBIDDEN_COMPONENTS) {
  // Only flag a match inside the element that grants it, not a comment.
  const re = new RegExp(`<${c.type}[^>]*android:name="([^"]+)"`, "gi");
  let hit = null;
  for (const m of labManifest.matchAll(re)) if (c.name.test(m[1])) hit = m[1];
  if (hit) fail(`${c.type} "${hit}" — ${c.why}`);
  else pass(`no ${c.type} matching ${c.name}`);
}

// ── 3. mediaProjection foreground service ────────────────────────────────────
// aapt2 prints foregroundServiceType as a hex bitmask, not a readable name:
// 0x20 is FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION. Matching on the string
// alone silently passes an app that does have screen capture.
const hasMediaProjection = (xml) =>
  /foregroundServiceType[^>]*=\s*"[^"]*mediaProjection/i.test(xml) ||
  /foregroundServiceType\([^)]*\)\s*=\s*0x0*20\b/i.test(xml);

console.log("\n3. No screen capture");
if (hasMediaProjection(labManifest)) {
  fail("a service declares foregroundServiceType=mediaProjection");
} else {
  pass("no mediaProjection foreground service");
}

// ── 4. the benign app is actually narrow ─────────────────────────────────────
console.log("\n4. The lab app is narrow, not just permissive-but-untidy");
const benign = ["android.permission.INTERNET", "android.permission.ACCESS_NETWORK_STATE"];
const runtimeData = [
  "android.permission.READ_SMS",
  "android.permission.READ_CONTACTS",
  "android.permission.ACCESS_MEDIA_LOCATION",
  "android.permission.READ_EXTERNAL_STORAGE",
  "android.permission.READ_MEDIA_IMAGES",
  // General location, added so the location row can perform a real consented
  // read rather than returning a constant. The app reads only a last-known fix,
  // only after an explicit grant, and falls back to the fixed lab coordinate
  // otherwise -- see SyntheticData.consentedLocation. ACCESS_COARSE_LOCATION is
  // declared alongside it because the emulated lab position usually lives in the
  // coarse provider.
  "android.permission.ACCESS_FINE_LOCATION",
  "android.permission.ACCESS_COARSE_LOCATION",
];
for (const p of benign) {
  if (labPerms.has(p)) pass(`${p.replace("android.permission.", "")} declared`);
  else fail(`${p} missing — the lab app cannot reach its own server`);
}
for (const p of runtimeData) {
  if (labPerms.has(p)) pass(`${p.replace("android.permission.", "")} declared (runtime, user-granted)`);
  else fail(`${p} missing — the permission demonstration has nothing to demonstrate`);
}
const unexpected = [...labPerms].filter(
  (p) => !benign.includes(p) && !runtimeData.includes(p) && p !== "android.permission.POST_NOTIFICATIONS"
);
if (unexpected.length === 0) pass("no permissions outside the documented set");
else fail(`undeclared-in-policy permissions: ${unexpected.join(", ")}`);

// ── 5. the teaching artifact must still hold the anti-pattern ────────────────
// If this app ever lost its Accessibility service, the comparison the
// demonstration is built on would have nothing to compare against.
console.log("\n5. The teaching artifact still demonstrates the anti-pattern");
if (fs.existsSync(AGENT_APK)) {
  const agentManifest = manifestText(AGENT_APK);
  const hasAcc = /BIND_ACCESSIBILITY_SERVICE/.test(agentManifest);
  const hasProj = hasMediaProjection(agentManifest);
  if (hasAcc) pass("teaching artifact holds BIND_ACCESSIBILITY_SERVICE");
  else fail("teaching artifact lost BIND_ACCESSIBILITY_SERVICE — nothing left to compare against");
  if (hasProj) pass("teaching artifact holds mediaProjection capture");
  else fail("teaching artifact lost mediaProjection capture — nothing left to compare against");
} else {
  console.log("  SKIP  teaching artifact APK not built; comparison check skipped");
}

console.log(`\n${"-".repeat(58)}`);
if (failures) {
  console.log(`${failures} policy violation(s). The lab app's safety claim is no longer true.`);
  process.exit(1);
}
console.log("Permission policy holds. The lab app cannot exceed its documented capabilities.");
