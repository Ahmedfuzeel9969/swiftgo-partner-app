import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLiveLocationSourceArbiter } from "../customer-app/js/live-location-source-arbiter.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0;
let fail = 0;

function check(name, ok, detail = "") {
  if (ok) {
    pass += 1;
    console.log(`✓ ${name} — PASS${detail ? `: ${detail}` : ""}`);
  } else {
    fail += 1;
    console.error(`✗ ${name} — FAIL${detail ? `: ${detail}` : ""}`);
  }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

{
  const rendered = [];
  const arbiter = createLiveLocationSourceArbiter({
    p2pFirstGraceMs: 20,
    firebaseBackupReadIntervalMs: 0,
    onRender: (fix) => rendered.push(fix),
  });
  arbiter.beginP2pFirstWindow();
  arbiter.ingestFirebase({ lat: 24.8, lng: 67.1, observedAt: 1 }, arbiter.getGeneration());
  check("p2p-first-holds-firebase-during-negotiation", rendered.length === 0);
  await wait(35);
  check(
    "firebase-renders-deterministically-after-p2p-timeout",
    rendered.length === 1 && rendered[0].source === "firebase"
  );
  arbiter.destroy();
}

{
  const rendered = [];
  const arbiter = createLiveLocationSourceArbiter({
    fallbackAfterMs: 20,
    firebaseBackupReadIntervalMs: 0,
    onRender: (fix) => rendered.push(fix),
  });
  const gen = arbiter.getGeneration();
  arbiter.ingestFirebase({ lat: 24.8, lng: 67.1, observedAt: 1 }, gen);
  arbiter.ingestP2p({ lat: 24.81, lng: 67.11, observedAt: 2 }, gen);
  arbiter.ingestFirebase({ lat: 24.82, lng: 67.12, observedAt: 3 }, gen);
  await wait(35);
  check(
    "silent-p2p-runtime-timeout-renders-latest-firebase",
    rendered.length === 3 && rendered.at(-1)?.source === "firebase"
  );
  arbiter.destroy();
}

{
  const rendered = [];
  const arbiter = createLiveLocationSourceArbiter({
    p2pFirstGraceMs: 30,
    firebaseBackupReadIntervalMs: 0,
    onRender: (fix) => rendered.push(fix),
  });
  arbiter.beginP2pFirstWindow();
  arbiter.ingestFirebase({ lat: 24.8, lng: 67.1, observedAt: 1 }, arbiter.getGeneration());
  arbiter.ingestP2p({ lat: 24.81, lng: 67.11, observedAt: 2 }, arbiter.getGeneration());
  await wait(40);
  check(
    "healthy-p2p-cancels-startup-firebase-fallback",
    rendered.length === 1 && rendered[0].source === "p2p"
  );
  arbiter.destroy();
}

{
  const rendered = [];
  const arbiter = createLiveLocationSourceArbiter({
    p2pFirstGraceMs: 15,
    firebaseFallbackEnabled: false,
    onRender: (fix) => rendered.push(fix),
  });
  arbiter.beginP2pFirstWindow();
  arbiter.ingestFirebase({ lat: 24.8, lng: 67.1, observedAt: 1 }, arbiter.getGeneration());
  await wait(25);
  check("super-admin-can-disable-firebase-fallback", rendered.length === 0);
  arbiter.destroy();
}

const driverApp = fs.readFileSync(path.join(ROOT, "driver-app/js/driver-app.js"), "utf8");
const driverController = fs.readFileSync(
  path.join(ROOT, "driver-app/js/p2p-ride-controller.mjs"),
  "utf8"
);
const adminHtml = fs.readFileSync(path.join(ROOT, "super-admin-panel/index.html"), "utf8");
const adminJs = fs.readFileSync(path.join(ROOT, "super-admin-panel/js/admin-app.js"), "utf8");
const functionsIndex = fs.readFileSync(path.join(ROOT, "functions/index.js"), "utf8");
const reportClient = fs.readFileSync(
  path.join(ROOT, "shared/js/ride-location-report-client.mjs"),
  "utf8"
);

check(
  "assignment-starts-tracking-before-waiting-for-gps",
  driverApp.includes("if (!locationTrackingSessionId) {") &&
    driverApp.includes("beginLocationTrackingSession();")
);
check(
  "driver-p2p-start-has-bounded-retry",
  driverController.includes("MAX_START_RETRIES") &&
    driverController.includes("scheduleStartRetry(failedTarget)")
);
check(
  "super-admin-policy-is-wired-end-to-end",
  adminHtml.includes('id="p2pFallbackAfterSeconds"') &&
    adminHtml.includes('id="firebaseLocationFallbackEnabled"') &&
    adminJs.includes("p2pFallbackAfterSeconds") &&
    functionsIndex.includes("P2P_FALLBACK_OUT_OF_RANGE")
);
check(
  "customer-report-binds-before-config-network-read",
  reportClient.indexOf("const result = store.bind") <
    reportClient.indexOf("await ensureConfig();", reportClient.indexOf("async function bindForRide"))
);

console.log(`\nlive-location-priority: ${pass} PASS / ${fail} FAIL`);
if (fail) process.exitCode = 1;
