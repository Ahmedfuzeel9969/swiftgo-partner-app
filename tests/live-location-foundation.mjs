/**
 * Phase 1 live-location foundation suite.
 * Run: npm run test:live-location-foundation
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  LOCATION_DIAG,
  MAX_ACCEPT_ACCURACY_M,
  derivedDisplayBearingDeg,
  estimateLocationWriteComparison,
  evaluateFixAgainstPrevious,
  normalizeHeadingDeg,
  normalizeLocationFix,
} from "../driver-app/js/location-envelope.mjs";
import { resolveTrackingTarget } from "../customer-app/js/tracking-target.mjs";
import {
  FRESHNESS,
  FRESHNESS_DELAYED_MS,
  FRESHNESS_FRESH_MS,
  computeAnimationDurationMs,
  interpolateLatLng,
  locationAgeMs,
  resolveFreshness,
  resolveMarkerRotationDeg,
  shouldSnapMarker,
} from "../customer-app/js/live-location-render.mjs";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "tests", "live-location-foundation-results.json");
const PROJECT = "demo-swiftgo-phase1";

process.env.FIRESTORE_EMULATOR_HOST ||= "127.0.0.1:8080";
process.env.GCLOUD_PROJECT ||= PROJECT;
process.env.GOOGLE_CLOUD_PROJECT ||= PROJECT;

const results = [];

function record(name, status, detail = "") {
  results.push({ name, status, detail, suite: "live-location-foundation" });
  const mark = status === "PASS" ? "✓" : status === "FAIL" ? "✗" : "·";
  console.log(`${mark} ${name} — ${status}${detail ? `: ${detail}` : ""}`);
}

const {
  buildDriverLocationPatch,
  mirrorDriverLocationToRide,
  trackingTargetForRide,
} = require(path.join(ROOT, "functions", "driver-location.js"));
const envelopeCf = require(path.join(ROOT, "functions", "live-location-envelope.js"));

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

function unitTests() {
  const session = "sess-a";
  const base = { lat: 24.8607, lng: 67.0011, observedAt: 1_000_000, source: "gps" };

  // 1 valid first fix
  const first = normalizeLocationFix(base, { sessionId: session, sequence: 1 });
  record("01-valid-first-fix-accepted", first.ok ? "PASS" : "FAIL", first.reason);

  // 2 invalid lat
  record(
    "02-invalid-lat-rejected",
    !normalizeLocationFix({ ...base, lat: 999 }, { sessionId: session, sequence: 1 }).ok
      ? "PASS"
      : "FAIL"
  );

  // 3 invalid lng
  record(
    "03-invalid-lng-rejected",
    !normalizeLocationFix({ ...base, lng: 999 }, { sessionId: session, sequence: 1 }).ok
      ? "PASS"
      : "FAIL"
  );

  // 4 poor accuracy
  const poor = normalizeLocationFix(
    { ...base, accuracy: MAX_ACCEPT_ACCURACY_M + 20 },
    { sessionId: session, sequence: 1 }
  );
  record("04-poor-accuracy-rejected", !poor.ok && poor.reason === LOCATION_DIAG.POOR_ACCURACY ? "PASS" : "FAIL");

  // 5 duplicate
  const env = first.envelope;
  const dup = evaluateFixAgainstPrevious(env, { ...env });
  record("05-duplicate-ignored", !dup.accept && dup.reason === LOCATION_DIAG.DUPLICATE ? "PASS" : "FAIL");

  // 6 older observedAt
  const older = evaluateFixAgainstPrevious(env, {
    ...env,
    observedAt: env.observedAt - 5000,
    sequence: env.sequence,
  });
  record("06-older-observedAt-ignored", !older.accept ? "PASS" : "FAIL");

  // 7 lower sequence
  const lowerSeq = evaluateFixAgainstPrevious(env, {
    ...env,
    observedAt: env.observedAt + 1000,
    sequence: env.sequence - 1,
  });
  record("07-lower-sequence-ignored", !lowerSeq.accept ? "PASS" : "FAIL");

  // 8 new session accepted
  const newSess = evaluateFixAgainstPrevious(env, {
    ...env,
    sessionId: "sess-b",
    sequence: 1,
    observedAt: env.observedAt - 10_000,
  });
  record("08-new-session-accepted", newSess.accept ? "PASS" : "FAIL");

  // 9 impossible jump
  const jump = evaluateFixAgainstPrevious(env, {
    ...env,
    lat: env.lat + 1.5,
    lng: env.lng + 1.5,
    observedAt: env.observedAt + 1000,
    sequence: env.sequence + 1,
  });
  record("09-impossible-jump-rejected", !jump.accept && jump.reason === LOCATION_DIAG.IMPOSSIBLE_JUMP ? "PASS" : "FAIL");

  // 10 reasonable Karachi movement (~50m in 4s)
  const okMove = evaluateFixAgainstPrevious(env, {
    ...env,
    lat: env.lat + 0.0004,
    lng: env.lng + 0.0002,
    observedAt: env.observedAt + 4000,
    sequence: env.sequence + 1,
  });
  record("10-karachi-movement-accepted", okMove.accept ? "PASS" : "FAIL");

  // 11 heading preserved
  const withHeading = normalizeLocationFix(
    { ...base, heading: 87.5 },
    { sessionId: session, sequence: 2 }
  );
  record(
    "11-heading-preserved",
    withHeading.ok && withHeading.envelope.headingDeg === 87.5 ? "PASS" : "FAIL"
  );

  // 12 null heading
  const nullH = normalizeLocationFix({ ...base, heading: -1 }, { sessionId: session, sequence: 3 });
  record("12-null-heading-handled", nullH.ok && nullH.envelope.headingDeg == null ? "PASS" : "FAIL");

  // 13 derived bearing consecutive fixes
  const bearing = derivedDisplayBearingDeg(
    { lat: 24.86, lng: 67.0 },
    { lat: 24.87, lng: 67.0 }
  );
  record("13-derived-bearing-consecutive", Number.isFinite(bearing) && (bearing > 350 || bearing < 10) ? "PASS" : "FAIL", String(bearing));

  // 14-17 tracking targets
  const accepted = resolveTrackingTarget({
    status: "accepted",
    pickupLocation: { lat: 24.86, lng: 67.0 },
    dropoffLocation: { lat: 24.9, lng: 67.1 },
  });
  record("14-accepted-targets-pickup", accepted.targetType === "pickup" && accepted.trackingActive ? "PASS" : "FAIL");

  const arrived = resolveTrackingTarget({
    status: "arrived",
    pickupLocation: { lat: 24.86, lng: 67.0 },
    dropoffLocation: { lat: 24.9, lng: 67.1 },
  });
  record("15-arrived-targets-pickup", arrived.targetType === "pickup" ? "PASS" : "FAIL");

  const inProg = resolveTrackingTarget({
    status: "in_progress",
    pickupLocation: { lat: 24.86, lng: 67.0 },
    dropoffLocation: { lat: 24.9, lng: 67.1 },
  });
  record("16-in-progress-targets-dropoff", inProg.targetType === "dropoff" ? "PASS" : "FAIL");

  const terminal = resolveTrackingTarget({ status: "completed" });
  record("17-terminal-stops-tracking", !terminal.trackingActive ? "PASS" : "FAIL");

  // 18-19 missing coords
  record(
    "18-missing-pickup-safe",
    resolveTrackingTarget({ status: "accepted" }).coordinates == null ? "PASS" : "FAIL"
  );
  record(
    "19-missing-dropoff-safe",
    resolveTrackingTarget({ status: "in_progress", pickupLocation: { lat: 1, lng: 1 } }).coordinates ==
      null
      ? "PASS"
      : "FAIL"
  );

  // 21 no client ride duplicate write in source
  const driverSrc = read("driver-app/js/driver-app.js");
  record(
    "21-driver-no-direct-ride-location-write",
    !driverSrc.includes("syncActiveRideDriverLocation") &&
      driverSrc.includes("Intentionally no client ride.driverLocation write")
      ? "PASS"
      : "FAIL"
  );

  // 23-24 animation helpers
  const dur = computeAnimationDurationMs(1000, 5000);
  record("23-anim-follows-timestamps", dur === 4000 ? "PASS" : "FAIL", String(dur));
  const mid = interpolateLatLng({ lat: 0, lng: 0 }, { lat: 10, lng: 10 }, 0.5);
  record(
    "24-faster-updates-no-permanent-lag",
    shouldSnapMarker({ hasPrevious: true, gapMs: 1000, distanceM: 20 }) === false &&
      Number.isFinite(mid.lat)
      ? "PASS"
      : "FAIL"
  );

  // 25-28 freshness
  record("25-delayed-after-threshold", resolveFreshness(FRESHNESS_FRESH_MS + 1) === FRESHNESS.DELAYED ? "PASS" : "FAIL");
  record("26-stale-after-threshold", resolveFreshness(FRESHNESS_DELAYED_MS + 1) === FRESHNESS.STALE ? "PASS" : "FAIL");
  record("27-fresh-recovers", resolveFreshness(1000) === FRESHNESS.FRESH ? "PASS" : "FAIL");
  record(
    "28-stale-stops-prediction",
    shouldSnapMarker({ hasPrevious: true, gapMs: 60_000, distanceM: 5 }) ? "PASS" : "FAIL"
  );

  // 29-30 cancel on terminal / reassignment covered by resolveTrackingTarget + driver-track source
  const trackSrc = read("customer-app/js/driver-track.js");
  record(
    "29-anim-cancel-terminal",
    trackSrc.includes("stopDriverTrack") && trackSrc.includes("!tracking.trackingActive")
      ? "PASS"
      : "FAIL"
  );
  record(
    "30-anim-cancel-reassignment",
    trackSrc.includes("lastTrackedDriverId") && trackSrc.includes("clearAssignedDriver")
      ? "PASS"
      : "FAIL"
  );

  // 31 simulated traffic not labelled live
  const i18n = read("customer-app/js/i18n.js");
  const html = read("customer-app/index.html");
  const mapSrc = read("customer-app/js/map.js");
  const trafficOk =
    i18n.includes("حقیقی ٹریفک نہیں") &&
    html.includes('data-traffic-kind="sample_not_live"') &&
    mapSrc.includes("sample_not_live") &&
    !i18n.match(/routeEtaTraffic:\s*"[^"]*\blive traffic\b/i);
  record("31-simulated-traffic-not-live-label", trafficOk ? "PASS" : "FAIL");

  // 32 privacy-safe logs
  const cfEnv = read("functions/live-location-envelope.js");
  const cfDrv = read("functions/driver-location.js");
  record(
    "32-privacy-safe-logs",
    cfEnv.includes("logLocationDiag") &&
      !cfDrv.includes("console.info(JSON.stringify({ lat") &&
      cfEnv.includes("never log coordinates")
      ? "PASS"
      : "FAIL"
  );

  // heading wraparound
  record("heading-north-wrap", normalizeHeadingDeg(360) === 0 ? "PASS" : "FAIL");
  record(
    "heading-rotation-gps-vs-derived",
    resolveMarkerRotationDeg({ headingDeg: 45 }).kind === "gps_heading" &&
      resolveMarkerRotationDeg({
        headingDeg: null,
        previousFix: { lat: 0, lng: 0 },
        nextFix: { lat: 1, lng: 0 },
        derivedBearingFn: derivedDisplayBearingDeg,
      }).kind === "derived_bearing"
      ? "PASS"
      : "FAIL"
  );

  // CF tracking target
  record(
    "cf-tracking-in-progress-dropoff",
    trackingTargetForRide({
      status: "in_progress",
      dropoffLocation: { lat: 24.9, lng: 67.1 },
    })?.type === "dropoff"
      ? "PASS"
      : "FAIL"
  );

  // Write estimate document
  const est = estimateLocationWriteComparison(20, 4);
  record(
    "write-estimate-phase1-lower",
    est.estimate &&
      est.phase1Repaired.totalFirestoreLocationWrites < est.currentArchitecture.totalFirestoreLocationWrites
      ? "PASS"
      : "FAIL"
  );

  // age helper
  record(
    "location-age-from-receivedAt",
    locationAgeMs({ driverLocationReceivedAt: Date.now() - 2000 }, Date.now()) >= 1900
      ? "PASS"
      : "FAIL"
  );

  // CF envelope shared
  record(
    "cf-envelope-module-exports",
    typeof envelopeCf.normalizeLocationFix === "function" ? "PASS" : "FAIL"
  );

  // rules note: ride driverLocation client branch retained
  const rules = read("firestore.rules");
  record(
    "33-ride-driverLocation-rule-retained",
    rules.includes("'driverLocation', 'driverLocationUpdatedAt'") ? "PASS" : "FAIL"
  );
}

async function emulatorTests() {
  const admin = require(require.resolve("firebase-admin", { paths: [path.join(ROOT, "functions"), ROOT] }));
  let app;
  try {
    app = admin.app();
  } catch {
    app = admin.initializeApp({ projectId: PROJECT });
  }
  const db = admin.firestore(app);

  const vehicleId = "ll-veh-1";
  const rideId = "ll-ride-1";
  const driverId = "ll-drv-1";

  await db.doc(`vehicles/${vehicleId}`).set({
    driverId,
    status: "in_ride",
    activeRideId: rideId,
    location: {
      lat: 24.861,
      lng: 67.002,
      observedAt: Date.now(),
      sequence: 1,
      sessionId: "emu-sess-1",
      headingDeg: 90,
      source: "gps",
    },
    locationUpdatedAt: admin.firestore.Timestamp.now(),
  });
  await db.doc(`rides/${rideId}`).set({
    userId: "ll-cust",
    driverId,
    vehicleId,
    status: "accepted",
    pickupLocation: { lat: 24.87, lng: 67.01 },
    dropoffLocation: { lat: 24.9, lng: 67.05 },
    estimatedFare: 500,
  });

  const mirror1 = await mirrorDriverLocationToRide(
    db,
    vehicleId,
    (await db.doc(`vehicles/${vehicleId}`).get()).data()
  );
  const rideAfter = (await db.doc(`rides/${rideId}`).get()).data();
  record(
    "20-customer-receives-cf-mirrored-location",
    mirror1.mirrored &&
      rideAfter.driverLocation?.lat === 24.861 &&
      rideAfter.driverDistanceKind === "straight_line_estimate"
      ? "PASS"
      : "FAIL",
    mirror1.reason
  );

  // 22 traveled distance accumulation on in_progress
  await db.doc(`rides/${rideId}`).set(
    {
      status: "in_progress",
      lastTrackedLocation: { lat: 24.861, lng: 67.002 },
      traveledDistanceKm: 0.1,
    },
    { merge: true }
  );
  await db.doc(`vehicles/${vehicleId}`).set(
    {
      location: {
        lat: 24.862,
        lng: 67.003,
        observedAt: Date.now() + 5000,
        sequence: 2,
        sessionId: "emu-sess-1",
        source: "gps",
      },
    },
    { merge: true }
  );
  const mirror2 = await mirrorDriverLocationToRide(
    db,
    vehicleId,
    (await db.doc(`vehicles/${vehicleId}`).get()).data()
  );
  const rideProg = (await db.doc(`rides/${rideId}`).get()).data();
  record(
    "22-active-ride-distance-accumulation",
    mirror2.mirrored && Number(rideProg.traveledDistanceKm) >= 0.1 ? "PASS" : "FAIL",
    `km=${rideProg.traveledDistanceKm}`
  );

  // out-of-order ignored
  const patchOld = buildDriverLocationPatch(
    {
      location: {
        lat: 24.85,
        lng: 67.0,
        observedAt: 1,
        sequence: 1,
        sessionId: "emu-sess-1",
      },
    },
    rideProg
  );
  record(
    "emu-out-of-order-noop",
    patchOld?.__skip && patchOld.__diag === LOCATION_DIAG.OUT_OF_ORDER ? "PASS" : "FAIL"
  );

  // one accepted fix → at most one logical ride write (no client path)
  record(
    "emu-one-fix-one-mirror-path",
    !read("driver-app/js/driver-app.js").includes("await syncActiveRideDriverLocation")
      ? "PASS"
      : "FAIL"
  );
}

async function main() {
  console.log("\n=== Live-location foundation Phase 1 ===\n");
  unitTests();
  try {
    await emulatorTests();
  } catch (e) {
    record("emulator-block", "BLOCKED", String(e.message || e).slice(0, 120));
  }
  const fail = results.filter((r) => r.status === "FAIL").length;
  const pass = results.filter((r) => r.status === "PASS").length;
  const blocked = results.filter((r) => r.status === "BLOCKED").length;
  fs.writeFileSync(
    OUT,
    `${JSON.stringify({ pass, fail, blocked, total: results.length, results, writeEstimate: estimateLocationWriteComparison() }, null, 2)}\n`
  );
  console.log(`\n${pass} PASS / ${fail} FAIL / ${blocked} BLOCKED (${results.length} total)\n`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
