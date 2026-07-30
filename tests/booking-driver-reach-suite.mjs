/**
 * Booking → Driver reach: probe-when-geo-empty-selected, rematch static,
 * declined-not-resurrected, driver geoCell/radar contract.
 *
 * Run: firebase emulators:exec --only firestore --project demo-swiftgo-phase1 \
 *        "node tests/booking-driver-reach-suite.mjs"
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const require = createRequire(import.meta.url);

const results = [];
function record(name, status, detail = "") {
  results.push({ name, status, detail });
  const mark = status === "PASS" ? "✓" : status === "FAIL" ? "✗" : "·";
  console.log(`${mark} ${name} — ${status}${detail ? `: ${detail}` : ""}`);
}

function read(rel) {
  return readFileSync(join(root, rel), "utf8");
}

function staticChecks() {
  const bargaining = read("functions/bargaining.js");
  const rideFlow = read("customer-app/js/ride-flow.js");
  const driverApp = read("driver-app/js/driver-app.js");
  const radar = read("driver-app/js/ride-radar-service.js");

  record(
    "S01-probe-when-selected-empty",
    /if\s*\(\s*!selected\s*\|\|\s*selected\.length\s*===\s*0\s*\)/.test(bargaining) &&
      bargaining.includes("geo_selected_empty") &&
      !/selected\.length === 0\) && \(metrics\.vehicleDocsRead \|\| 0\) === 0/.test(bargaining)
      ? "PASS"
      : "FAIL",
    "probe must run even when vehicleDocsRead > 0"
  );
  record(
    "S02-matching-metrics-on-ride",
    bargaining.includes("matchingUsedProbe") &&
      bargaining.includes("matchingProbeReason") &&
      bargaining.includes("matchingVehicleDocsRead")
      ? "PASS"
      : "FAIL"
  );
  record(
    "S03-declined-not-resurrected",
    bargaining.includes('prevStatus !== "invited"') ||
      bargaining.includes("prevStatus && prevStatus !== \"invited\"")
      ? "PASS"
      : "FAIL"
  );
  record(
    "S04-customer-periodic-rematch",
    rideFlow.includes("SEARCH_REMATCH_MS") &&
      rideFlow.includes("rematchWhileSearching") &&
      /30_000|30000/.test(rideFlow)
      ? "PASS"
      : "FAIL"
  );
  record(
    "S05-driver-match-geocell-write",
    driverApp.includes("matchCellChanged") && driverApp.includes("lastMatchGeoCell")
      ? "PASS"
      : "FAIL"
  );
  record(
    "S06-soft-gps-offline",
    driverApp.includes("TRANSIENT_GPS_FAIL_LIMIT") &&
      driverApp.includes("FRESH_GPS_MS") &&
      driverApp.includes("آخری مقام استعمال ہو رہا ہے")
      ? "PASS"
      : "FAIL"
  );
  record(
    "S07-radar-listen-off-home",
    driverApp.includes("canListen") &&
      driverApp.includes("showFab") &&
      /canListen\s*&&\s*partnerView\s*===\s*"home"/.test(driverApp)
      ? "PASS"
      : "FAIL"
  );
  record(
    "S08-radar-fetch-errors-surfaced",
    radar.includes("rideFetchErrors") && radar.includes("invitedCandidateCount")
      ? "PASS"
      : "FAIL"
  );
  record(
    "S09-matching-ready-diag",
    driverApp.includes("matching_ready") || driverApp.includes("matchingReady")
      ? "PASS"
      : "FAIL"
  );
}

async function emulatorChecks() {
  const admin = require(
    require.resolve("firebase-admin", { paths: [join(root, "functions"), root] })
  );
  process.env.FIRESTORE_EMULATOR_HOST =
    process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";

  let app;
  try {
    app = admin.app();
  } catch {
    app = admin.initializeApp({ projectId: "demo-swiftgo-phase1" });
  }
  const db = admin.firestore(app);
  const { FieldValue, Timestamp } = admin.firestore;
  const { matchRideCandidates } = require(join(root, "functions/bargaining.js"));
  const { gridCellId } = require(join(root, "functions/geo-cells.js"));

  const pickup = { lat: 24.8607, lng: 67.0011 };
  const prefix = `bdr${Date.now().toString(36)}`;
  await db.doc("settings/dispatch").set({ candidateDriverLimit: 10, searchRingsKm: [1, 2, 3] });

  // Stale vehicle IN pickup cell (geo reads > 0) + fresh nearby vehicle WITHOUT geoCell.
  const cell = gridCellId(pickup.lat, pickup.lng);
  const staleTs = Timestamp.fromMillis(Date.now() - 60 * 60 * 1000);
  await db.collection("vehicles").doc(`${prefix}-stale`).set({
    ownerId: `${prefix}-own`,
    plate: "STALE",
    status: "online",
    driverId: `${prefix}-stale-d`,
    location: { lat: pickup.lat + 0.001, lng: pickup.lng },
    locationUpdatedAt: staleTs,
    geoCell: cell,
  });
  await db.collection("partners").doc(`${prefix}-stale-d`).set({ accountStatus: "active" });

  await db.collection("vehicles").doc(`${prefix}-fresh`).set({
    ownerId: `${prefix}-own`,
    plate: "FRESH",
    status: "online",
    driverId: `${prefix}-fresh-d`,
    location: { lat: pickup.lat + 0.002, lng: pickup.lng + 0.001 },
    locationUpdatedAt: FieldValue.serverTimestamp(),
    // intentionally missing geoCell — invisible to geo query, visible to probe
  });
  await db.collection("partners").doc(`${prefix}-fresh-d`).set({ accountStatus: "active" });

  const rideRef = db.collection("rides").doc();
  await rideRef.set({
    userId: `${prefix}-cust`,
    status: "searching_driver",
    pickupLocation: { ...pickup, address: "P" },
    dropoffLocation: { lat: 24.87, lng: 67.01, address: "D" },
    createdAt: FieldValue.serverTimestamp(),
  });

  const matched = await matchRideCandidates(db, {
    rideId: rideRef.id,
    pickup,
    candidateDriverLimit: 10,
  });

  const invitedFresh = (matched.candidates || []).some((c) => c.driverId === `${prefix}-fresh-d`);
  const usedProbe = Boolean(matched.metrics?.usedCappedOnlineProbe);
  const probeReason = matched.metrics?.probeReason;
  const rideAfter = (await rideRef.get()).data() || {};

  record(
    "E01-probe-despite-stale-cell-docs",
    usedProbe && invitedFresh ? "PASS" : "FAIL",
    JSON.stringify({
      usedProbe,
      probeReason,
      vehicleDocsRead: matched.metrics?.vehicleDocsRead,
      candidates: (matched.candidates || []).map((c) => c.driverId),
      matchingUsedProbe: rideAfter.matchingUsedProbe,
    })
  );

  // Decline fresh, rematch must not resurrect.
  const candId = `${rideRef.id}_${prefix}-fresh-d`;
  await db.collection("ride_candidates").doc(candId).set(
    { rideId: rideRef.id, driverId: `${prefix}-fresh-d`, status: "declined" },
    { merge: true }
  );
  const rematched = await matchRideCandidates(db, {
    rideId: rideRef.id,
    pickup,
    candidateDriverLimit: 10,
  });
  const resurrected = (rematched.candidates || []).some((c) => c.driverId === `${prefix}-fresh-d`);
  const candAfter = (await db.collection("ride_candidates").doc(candId).get()).data();
  record(
    "E02-declined-not-resurrected-on-rematch",
    !resurrected && candAfter?.status === "declined" ? "PASS" : "FAIL",
    JSON.stringify({ resurrected, status: candAfter?.status })
  );
}

async function main() {
  staticChecks();
  await emulatorChecks();
  const failed = results.filter((r) => r.status === "FAIL").length;
  const passed = results.filter((r) => r.status === "PASS").length;
  console.log(`\n[booking-driver-reach] ${passed} passed / ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
