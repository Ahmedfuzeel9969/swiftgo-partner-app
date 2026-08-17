/**
 * Static policy contract: customer background keeps P2P, not Firebase listeners.
 * Run: node tests/customer-p2p-background.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const results = [];

function check(name, ok, detail = "") {
  results.push({ name, status: ok ? "PASS" : "FAIL", detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

const flow = fs.readFileSync(path.join(root, "customer-app/js/ride-flow.js"), "utf8");
const controller = fs.readFileSync(
  path.join(root, "customer-app/js/p2p-ride-controller.mjs"),
  "utf8"
);
const bridge = fs.readFileSync(
  path.join(root, "customer-app/js/p2p-background-keepalive.mjs"),
  "utf8"
);
const manifest = fs.readFileSync(
  path.join(root, "mobile/customer/android/app/src/main/AndroidManifest.xml"),
  "utf8"
);
const service = fs.readFileSync(
  path.join(
    root,
    "mobile/customer/android/app/src/main/java/com/swiftgo/customer/CustomerP2pKeepAliveForegroundService.java"
  ),
  "utf8"
);
const main = fs.readFileSync(
  path.join(root, "mobile/customer/android/app/src/main/java/com/swiftgo/customer/MainActivity.java"),
  "utf8"
);

check(
  "background-detaches-firebase-listeners",
  flow.includes("clearLiveSubscriptions({ preserveP2p: true })"),
  "lifecycle detaches live Firestore subscriptions"
);
check(
  "background-preserves-p2p-session",
  controller.includes("screen hidden/background must not suspend or stop P2P"),
  "customer P2P controller keeps signaling/session attached"
);
check(
  "foreground-firebase-policy-unchanged",
  flow.includes("startPresenceHeartbeat") && flow.includes("customerP2p?.syncForRide(activeRide, { isVisible: true })"),
  "visible path remains the existing P2P/Firebase policy"
);
check(
  "active-ride-starts-native-keepalive",
  flow.includes("customerP2pBackgroundKeepalive.syncForRide(activeRide)") &&
    flow.includes("customerP2pBackgroundKeepalive.syncForRide(ride)"),
  "Android service starts only for trackable ride statuses"
);
check(
  "terminal-ride-stops-native-keepalive",
  flow.includes("customerP2pBackgroundKeepalive.stop()"),
  "terminal/session teardown stops service"
);
check("native-bridge-is-android-only", bridge.includes('getNativePlatform() !== "android"'));
check(
  "manifest-declares-foreground-service",
  manifest.includes("CustomerP2pKeepAliveForegroundService") &&
    manifest.includes('foregroundServiceType="dataSync"') &&
    manifest.includes("FOREGROUND_SERVICE_DATA_SYNC")
);
check(
  "service-survives-task-removal",
  service.includes("START_STICKY") && service.includes("onTaskRemoved")
);
check("mainactivity-registers-customer-plugin", main.includes("CustomerP2pKeepAlivePlugin"));

const failed = results.filter((r) => r.status === "FAIL");
const out = {
  suite: "customer-p2p-background",
  generatedAt: new Date().toISOString(),
  pass: results.length - failed.length,
  fail: failed.length,
  results,
};
fs.writeFileSync(
  path.join(root, "tests/customer-p2p-background-results.json"),
  JSON.stringify(out, null, 2)
);
console.log(`\nCustomer background P2P: ${out.pass} PASS / ${out.fail} FAIL`);
if (failed.length) process.exitCode = 1;
