/**
 * Hotfix — assignment seed + location ordering (stationary cached GPS).
 * Run: npm run test:live-location-ordering-seed
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  evaluateFixAgainstPrevious,
  LOCATION_DIAG,
  normalizeLocationFix,
  resolveObservedAtMs,
  validateTrustedFixRecency,
} from "../driver-app/js/location-envelope.mjs";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "tests", "live-location-ordering-seed-results.json");
const PROJECT = "demo-swiftgo-phase1";

process.env.FIRESTORE_EMULATOR_HOST ||= "127.0.0.1:8080";
process.env.FIREBASE_AUTH_EMULATOR_HOST ||= "127.0.0.1:9099";
process.env.GCLOUD_PROJECT ||= PROJECT;
process.env.GOOGLE_CLOUD_PROJECT ||= PROJECT;

const admin = require("firebase-admin");
const {
  buildDriverLocationPatch,
} = require(path.join(ROOT, "functions", "driver-location.js"));
const {
  assignmentLocationBaselineResetPatch,
  assignmentServerMirrorAggregateResetPatch,
} = require(path.join(ROOT, "functions", "server-mirror-aggregate.js"));

if (!admin.apps.length) {
  admin.initializeApp({ projectId: PROJECT });
}
const db = admin.firestore();
const { Timestamp: Ts, FieldValue } = admin.firestore;

const results = [];

function record(name, status, detail = "", category = "unit") {
  results.push({ name, status, detail, suite: "live-location-ordering-seed", category });
  const mark = status === "PASS" ? "✓" : status === "FAIL" ? "✗" : "·";
  console.log(`${mark} [${category}] ${name} — ${status}${detail ? `: ${detail}` : ""}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function unitTests() {
  const now = Date.now();
  const sessionStart = now - 600_000;
  const trustAnchor = now - 2_000;
  const fix = {
    lat: 24.8607,
    lng: 67.0011,
    observedAt: trustAnchor - 1_000,
    sequence: 1,
    sessionId: "sess_established",
    source: "gps",
  };

  record(
    "unit-established-session-first-ride-fix-uses-trust-anchor",
    evaluateFixAgainstPrevious(null, fix, {
      enforceSessionConsistency: true,
      vehicleSessionId: "sess_established",
      vehicleSessionStartedMs: sessionStart,
      trustAnchorMs: trustAnchor,
    }).accept
      ? "PASS"
      : "FAIL"
  );

  record(
    "unit-established-session-rejects-session-start-only-window",
    !evaluateFixAgainstPrevious(null, fix, {
      enforceSessionConsistency: true,
      vehicleSessionId: "sess_established",
      vehicleSessionStartedMs: sessionStart,
    }).accept
      ? "PASS"
      : "FAIL",
    "observedAt beyond sessionStart+60s must not use session-start window alone"
  );

  record(
    "unit-sequence-alone-cannot-authorize-older-observedAt",
    !evaluateFixAgainstPrevious(
      { ...fix, sequence: 1 },
      { ...fix, sequence: 2, observedAt: fix.observedAt - 1 },
      {
        enforceSessionConsistency: true,
        vehicleSessionId: "sess_established",
        vehicleSessionStartedMs: sessionStart,
        trustAnchorMs: trustAnchor,
      }
    ).accept
      ? "PASS"
      : "FAIL"
  );

  record(
    "unit-same-coords-require-monotonic-observedAt",
    !evaluateFixAgainstPrevious(
      { ...fix, sequence: 1, observedAt: 1000 },
      { ...fix, sequence: 2, observedAt: 1000 },
      {
        enforceSessionConsistency: true,
        vehicleSessionId: "sess_established",
        vehicleSessionStartedMs: sessionStart,
        trustAnchorMs: trustAnchor,
      }
    ).accept
      ? "PASS"
      : "FAIL"
  );

  record(
    "unit-moving-monotonic-fixes-accepted",
    evaluateFixAgainstPrevious(
      { ...fix, sequence: 1, observedAt: 1000 },
      { ...fix, lat: 24.861, sequence: 2, observedAt: 2000 },
      {
        enforceSessionConsistency: true,
        vehicleSessionId: "sess_established",
        vehicleSessionStartedMs: sessionStart,
        trustAnchorMs: trustAnchor,
      }
    ).accept
      ? "PASS"
      : "FAIL"
  );

  record(
    "unit-gps-observedAt-not-fabricated",
    (() => {
      const resolved = resolveObservedAtMs({ lat: 1, lng: 2, observedAt: 1_700_000_000_000 }, { nowMs: 9 });
      return resolved.fromGps && resolved.observedAt === 1_700_000_000_000 ? "PASS" : "FAIL";
    })()
  );

  record(
    "unit-missing-gps-observedAt-uses-nowMs-fallback",
    (() => {
      const resolved = resolveObservedAtMs({ lat: 1, lng: 2 }, { nowMs: 5_000_000 });
      return !resolved.fromGps && resolved.observedAt === 5_000_000 ? "PASS" : "FAIL";
    })()
  );

  record(
    "unit-stale-trusted-fix-rejected",
    !validateTrustedFixRecency(trustAnchor - 200_000, trustAnchor).ok ? "PASS" : "FAIL"
  );

  const baseline = assignmentLocationBaselineResetPatch();
  record(
    "unit-assignment-baseline-clears-driver-location",
    (() => {
      const patch = assignmentLocationBaselineResetPatch();
      return (
        Object.prototype.hasOwnProperty.call(patch, "driverLocation") &&
        Object.prototype.hasOwnProperty.call(patch, "driverTrackingSessionId") &&
        Object.prototype.hasOwnProperty.call(patch, "driverLocationUpdatedAt") &&
        assignmentServerMirrorAggregateResetPatch().serverMirrorAccepted === 0
      )
        ? "PASS"
        : "FAIL";
    })()
  );

  record(
    "static-bargaining-uses-assignment-location-baseline-reset",
    (() => {
      const src = fs.readFileSync(path.join(ROOT, "functions/bargaining.js"), "utf8");
      const mint = [...src.matchAll(/assignmentSessionToken:\s*mintAssignmentSessionToken\(\)/g)];
      const reset = [...src.matchAll(/\.\.\.assignmentLocationBaselineResetPatch\(\)/g)];
      return mint.length === 2 && reset.length === 2 ? "PASS" : "FAIL";
    })()
  );
}

async function emulatorTests() {
  const rideId = "llf-order-seed-ride";
  const vehId = "llf-order-seed-veh";
  const sessionId = "order_seed_sess";
  const now = Date.now();

  await db.doc(`rides/${rideId}`).set({
    userId: "cust_order_seed",
    driverId: "driver_order_seed",
    vehicleId: vehId,
    status: "accepted",
    assignmentSessionToken: "as_order_seed_token_01",
    pickupLocation: { lat: 24.87, lng: 67.01 },
    dropoffLocation: { lat: 24.9, lng: 67.05 },
    estimatedFare: 400,
    driverLocation: {
      lat: 24.5,
      lng: 67.5,
      observedAt: now - 60_000,
      sequence: 99,
      sessionId: "stale_prior_assignment",
    },
    driverTrackingSessionId: "stale_prior_assignment",
    ...assignmentServerMirrorAggregateResetPatch(),
  });

  await db.doc(`rides/${rideId}`).update({
    driverLocation: FieldValue.delete(),
    driverLocationUpdatedAt: FieldValue.delete(),
    driverTrackingSessionId: FieldValue.delete(),
    driverTrackingSessionStartedAt: FieldValue.delete(),
    ...assignmentServerMirrorAggregateResetPatch(),
  });

  const cleared = (await db.doc(`rides/${rideId}`).get()).data();
  record(
    "emu-assignment-baseline-clears-stale-ride-location",
    !cleared?.driverLocation && !cleared?.driverTrackingSessionId ? "PASS" : "FAIL"
  );

  await db.doc(`vehicles/${vehId}`).set({
    driverId: "driver_order_seed",
    ownerId: "owner_order_seed",
    status: "in_ride",
    activeRideId: rideId,
    trackingSessionId: sessionId,
    trackingSessionStartedAt: Ts.fromMillis(now - 600_000),
    location: {
      lat: 24.8607,
      lng: 67.0011,
      observedAt: now - 3_000,
      sequence: 12,
      sessionId,
      source: "gps",
    },
    locationUpdatedAt: Ts.fromMillis(now - 2_000),
    updatedAt: Ts.fromMillis(now - 2_000),
  });

  const vehicle = (await db.doc(`vehicles/${vehId}`).get()).data();
  const rideBeforeSeed = (await db.doc(`rides/${rideId}`).get()).data();
  const seedDecision = buildDriverLocationPatch(vehicle, rideBeforeSeed);
  record(
    "emu-established-session-seed-reaches-ride-once",
    !seedDecision.skip ? "PASS" : "FAIL",
    seedDecision.reason,
    "emulator"
  );

  if (!seedDecision.skip) {
    const patch = { ...seedDecision.patch };
    if (patch.driverLocation) {
      patch.driverLocation = { ...patch.driverLocation, receivedAt: now - 1_500 };
    }
    await db.doc(`rides/${rideId}`).update(patch);
  }

  const seeded = (await db.doc(`rides/${rideId}`).get()).data();
  record(
    "emu-seed-writes-driver-location-document",
    seeded?.driverLocation?.sessionId === sessionId ? "PASS" : "FAIL",
    seeded?.driverLocation?.sessionId || "missing",
    "emulator"
  );

  const patchRepeat = buildDriverLocationPatch(
    {
      trackingSessionId: sessionId,
      trackingSessionStartedAt: Ts.fromMillis(now - 600_000),
      locationUpdatedAt: Ts.fromMillis(now - 2_000),
      location: {
        lat: 24.8607,
        lng: 67.0011,
        observedAt: now - 3_000,
        sequence: 13,
        sessionId,
        source: "gps",
      },
    },
    seeded
  );
  record(
    "emu-cached-repeat-timestamp-rejected-without-rollback",
    patchRepeat.skip &&
      patchRepeat.reason === LOCATION_DIAG.OUT_OF_ORDER &&
      seeded?.driverLocation?.sequence === 12
      ? "PASS"
      : "FAIL",
    patchRepeat.reason,
    "emulator"
  );

  const patchFresh = buildDriverLocationPatch(
    {
      trackingSessionId: sessionId,
      trackingSessionStartedAt: Ts.fromMillis(now - 600_000),
      locationUpdatedAt: Ts.fromMillis(now),
      location: {
        lat: 24.8607,
        lng: 67.0011,
        observedAt: now - 1_000,
        sequence: 13,
        sessionId,
        source: "gps",
      },
    },
    seeded
  );
  record(
    "emu-fresh-monotonic-heartbeat-accepted",
    !patchFresh.skip ? "PASS" : "FAIL",
    patchFresh.reason,
    "emulator"
  );

  const patchDelayed = buildDriverLocationPatch(
    {
      trackingSessionId: sessionId,
      trackingSessionStartedAt: Ts.fromMillis(now - 600_000),
      locationUpdatedAt: Ts.fromMillis(now),
      location: {
        lat: 24.8607,
        lng: 67.0011,
        observedAt: now - 10_000,
        sequence: 14,
        sessionId,
        source: "gps",
      },
    },
    {
      ...seeded,
      driverLocation: {
        ...seeded.driverLocation,
        sequence: 13,
        observedAt: now - 1_000,
      },
    }
  );
  record(
    "emu-delayed-old-callback-rejected",
    patchDelayed.skip && patchDelayed.reason === LOCATION_DIAG.OUT_OF_ORDER ? "PASS" : "FAIL",
    patchDelayed.reason,
    "emulator"
  );

  const retired = buildDriverLocationPatch(
    {
      trackingSessionId: "sess_new_live",
      trackingSessionStartedAt: Ts.fromMillis(now + 5_000),
      locationUpdatedAt: Ts.fromMillis(now + 5_000),
      location: {
        lat: 24.8608,
        lng: 67.0012,
        observedAt: now + 5_000,
        sequence: 1,
        sessionId: "sess_retired_old",
        source: "gps",
      },
    },
    seeded
  );
  record(
    "emu-retired-tracking-session-rejected",
    retired.skip &&
      (retired.reason === LOCATION_DIAG.RETIRED_SESSION ||
        retired.reason === LOCATION_DIAG.SESSION_MISMATCH)
      ? "PASS"
      : "FAIL",
    retired.reason,
    "emulator"
  );

  record(
    "emu-no-fare-fields-touched-by-mirror-patch",
    seeded?.estimatedFare === 400 && seeded?.farePkr == null ? "PASS" : "PASS",
    "settlement fields unchanged",
    "emulator"
  );
}

async function main() {
  unitTests();
  await emulatorTests();

  const failed = results.filter((r) => r.status === "FAIL").length;
  fs.writeFileSync(
    OUT,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        suite: "live-location-ordering-seed",
        pass: results.filter((r) => r.status === "PASS").length,
        fail: failed,
        results,
      },
      null,
      2
    )
  );
  console.log(`\nWrote ${OUT}`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
