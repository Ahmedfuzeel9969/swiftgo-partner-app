/**
 * Phase 5 — final audit gates for P2P Communication Module.
 * Static + focused regressions: location protocol, Firebase traffic surface, ride-flow.
 * Run: node tests/p2p-comm-final-audit.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "tests", "p2p-comm-phase5-report.json");
const results = [];

function record(name, status, detail = "") {
  results.push({ name, status, detail });
  console.log(`${status === "PASS" ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

function exists(rel) {
  return fs.existsSync(path.join(ROOT, rel));
}

// --- Comm module completeness ---
{
  const files = [
    "shared/js/p2p-comm-protocol.mjs",
    "shared/js/p2p-comm-session.mjs",
    "shared/js/p2p-comm-router.mjs",
    "shared/js/p2p-comm-voice.mjs",
    "shared/js/p2p-comm-call.mjs",
    "shared/js/p2p-comm-panel.mjs",
    "shared/js/p2p-comm-module.mjs",
  ];
  record(
    "comm_shared_modules_present",
    files.every((f) => exists(f)) ? "PASS" : "FAIL",
    files.filter((f) => !exists(f)).join(",") || "all"
  );
}

// --- Location protocol untouched by comm types ---
{
  const locDrv = read("driver-app/js/p2p-location-envelope.mjs");
  const locCust = read("customer-app/js/p2p-location-envelope.mjs");
  const proto = read("driver-app/js/p2p-protocol.mjs");
  record(
    "location_envelope_no_comm_types",
    !locDrv.includes("comm_text") &&
      !locCust.includes("comm_text") &&
      !proto.includes("comm_text")
      ? "PASS"
      : "FAIL"
  );
  record(
    "location_types_still_loc_ack_hb",
    proto.includes('LOC: "loc"') && proto.includes('ACK: "ack"') && proto.includes('HB: "hb"')
      ? "PASS"
      : "FAIL"
  );
}

// --- Peer session still multiplexes without invalidating location ---
{
  const peer = read("driver-app/js/p2p-peer-session.mjs");
  record(
    "peer_multiplexes_comm_prefix",
    peer.includes("commHandlers") && peer.includes('startsWith("comm_")') ? "PASS" : "FAIL"
  );
  record(
    "peer_keeps_location_validate_path",
    peer.includes("validateP2pMessage") && peer.includes("createCommTransport") ? "PASS" : "FAIL"
  );
  record(
    "media_bridge_does_not_replace_dc",
    peer.includes("createMediaBridge") && peer.includes("P2P_DATA_CHANNEL_LABEL") ? "PASS" : "FAIL"
  );
}

// --- No Firebase message/media storage for chat/voice/call ---
{
  const suspects = [
    "shared/js/p2p-comm-session.mjs",
    "shared/js/p2p-comm-voice.mjs",
    "shared/js/p2p-comm-call.mjs",
    "shared/js/p2p-comm-panel.mjs",
    "shared/js/p2p-comm-module.mjs",
  ];
  const bad = [];
  for (const f of suspects) {
    const s = read(f);
    if (
      /firebase\/(firestore|storage)/i.test(s) ||
      s.includes("uploadBytes") ||
      s.includes("addDoc(") ||
      s.includes("setDoc(") ||
      s.includes("collection(")
    ) {
      bad.push(f);
    }
  }
  record("no_firebase_comm_storage", bad.length === 0 ? "PASS" : "FAIL", bad.join(",") || "clean");
}

// --- Ride flow / matching / billing not rewritten by comm (spot checks) ---
{
  const rideFlow = read("customer-app/js/ride-flow.js");
  const driverApp = read("driver-app/js/driver-app.js");
  record(
    "customer_still_has_booking_and_p2p",
    rideFlow.includes("createCustomerBookingClient") &&
      rideFlow.includes("createCustomerP2pController") &&
      rideFlow.includes("createRideCommChat")
      ? "PASS"
      : "FAIL"
  );
  record(
    "driver_still_has_settlement_and_p2p",
    driverApp.includes("requestRideSettlement") &&
      driverApp.includes("createDriverP2pController") &&
      driverApp.includes("createRideCommChat")
      ? "PASS"
      : "FAIL"
  );
  record(
    "both_apps_contact_host",
    read("customer-app/index.html").includes("activeRideContactHost") &&
      read("driver-app/index.html").includes("activeRideContactHost")
      ? "PASS"
      : "FAIL"
  );
}

// --- Signaling still Firebase-only for location peer session (not for chat body) ---
{
  const sig = read("driver-app/js/p2p-signaling-client.mjs");
  record(
    "signaling_client_unchanged_role",
    sig.includes("createRidePeerOfferClient") || sig.includes("watchRidePeerSession")
      ? "PASS"
      : "FAIL"
  );
  const call = read("shared/js/p2p-comm-call.mjs");
  record(
    "call_signaling_is_datachannel_not_firebase",
    call.includes("CALL_OFFER") && !call.includes("watchRidePeerSession") && !call.includes("httpsCallable")
      ? "PASS"
      : "FAIL"
  );
}

// --- Build list includes all comm modules ---
{
  const build = read("tools/build-hosting.mjs");
  const needed = [
    "p2p-comm-protocol.mjs",
    "p2p-comm-session.mjs",
    "p2p-comm-router.mjs",
    "p2p-comm-voice.mjs",
    "p2p-comm-call.mjs",
    "p2p-comm-panel.mjs",
    "p2p-comm-module.mjs",
  ];
  record(
    "build_hosting_lists_comm_modules",
    needed.every((n) => build.includes(n)) ? "PASS" : "FAIL"
  );
}

// --- Prior phase reports all PASS ---
{
  for (const [label, file] of [
    ["phase1_report", "tests/p2p-comm-phase1-report.json"],
    ["phase2_report", "tests/p2p-comm-phase2-report.json"],
    ["phase3_report", "tests/p2p-comm-phase3-report.json"],
    ["phase4_report", "tests/p2p-comm-phase4-report.json"],
  ]) {
    if (!exists(file)) {
      record(label, "FAIL", "missing");
      continue;
    }
    const j = JSON.parse(read(file));
    const failed = Number(j.summary?.failed ?? j.fail ?? 1);
    const passed = Number(j.summary?.passed ?? j.pass ?? 0);
    const total = Number(j.summary?.total ?? (passed + failed));
    record(label, failed === 0 ? "PASS" : "FAIL", `${passed}/${total}`);
  }
}

// --- Runtime consistency suite if present ---
{
  const runtimePath = path.join(ROOT, "tests", "runtime-consistency.mjs");
  if (!fs.existsSync(runtimePath)) {
    record("runtime_consistency_suite", "PASS", "skipped_missing");
  } else {
    try {
      // Execute as child for isolation
      const { spawnSync } = require("node:child_process");
      const r = spawnSync(process.execPath, [runtimePath], {
        cwd: ROOT,
        encoding: "utf8",
        timeout: 120_000,
      });
      record(
        "runtime_consistency_suite",
        r.status === 0 ? "PASS" : "FAIL",
        r.status === 0 ? "exit0" : (r.stderr || r.stdout || "").slice(0, 200)
      );
    } catch (err) {
      record("runtime_consistency_suite", "FAIL", String(err?.message || err));
    }
  }
}

const passed = results.filter((r) => r.status === "PASS").length;
const failed = results.filter((r) => r.status === "FAIL").length;
const report = {
  phase: 5,
  title: "P2P Communication — Final Audit",
  generatedAt: new Date().toISOString(),
  summary: { passed, failed, total: results.length },
  results,
  deployGate: failed === 0 ? "ALLOW_DEPLOY" : "BLOCK_DEPLOY",
};
fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log(`\nPhase 5 audit: ${passed}/${results.length} PASS → gate=${report.deployGate}`);
process.exit(failed ? 1 : 0);
