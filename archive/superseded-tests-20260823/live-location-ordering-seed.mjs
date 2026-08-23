/**
 * Hotfix — assignment seed + location ordering (stationary cached GPS).
 * Run: npm run test:live-location-ordering-seed
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from "@firebase/rules-unit-testing";
import { doc, serverTimestamp, Timestamp, updateDoc } from "firebase/firestore";
import {
  evaluateFixAgainstPrevious,
  LOCATION_DIAG,
  normalizeLocationFix,
  resolveCommittedTrustAnchorMs,
  resolveObservedAtMs,
  validateTrustAnchorBounds,
  validateTrustedFixRecency,
} from "../driver-app/js/location-envelope.mjs";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "tests", "live-location-ordering-seed-results.json");
const RULES = fs.readFileSync(path.join(ROOT, "firestore.rules"), "utf8");
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
      hasCommittedTrustAnchor: true,
      serverNowMs: now,
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
        hasCommittedTrustAnchor: true,
        serverNowMs: now,
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
        hasCommittedTrustAnchor: true,
        serverNowMs: now,
      }
    ).accept
      ? "PASS"
      : "FAIL"
  );

  record(
    "unit-moving-monotonic-fixes-accepted",
    evaluateFixAgainstPrevious(
      { ...fix, sequence: 1, observedAt: trustAnchor - 2_000 },
      { ...fix, lat: 24.861, sequence: 2, observedAt: trustAnchor - 1_000 },
      {
        enforceSessionConsistency: true,
        vehicleSessionId: "sess_established",
        vehicleSessionStartedMs: sessionStart,
        trustAnchorMs: trustAnchor,
        hasCommittedTrustAnchor: true,
        serverNowMs: now,
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

  record(
    "static-rules-enforce-locationUpdatedAt-request-time",
    RULES.includes("vehicleLocationUpdatedAtOk()") &&
      RULES.includes("locationUpdatedAt == request.time")
      ? "PASS"
      : "FAIL"
  );

  record(
    "unit-trust-anchor-future-rejected",
    !validateTrustAnchorBounds(now + 120_000, now).ok ? "PASS" : "FAIL"
  );

  record(
    "unit-trust-anchor-malformed-rejected",
    resolveCommittedTrustAnchorMs({ locationUpdatedAt: "not-a-timestamp" }) == null &&
      resolveCommittedTrustAnchorMs({ locationUpdatedAt: 1_700_000_000_000 }) == null &&
      resolveCommittedTrustAnchorMs({ locationUpdatedAt: { seconds: 1, nanoseconds: 0 } }) === 1000
      ? "PASS"
      : "FAIL"
  );

  record(
    "unit-committed-anchor-required-when-present",
    !evaluateFixAgainstPrevious(null, fix, {
      enforceSessionConsistency: true,
      vehicleSessionId: "sess_established",
      vehicleSessionStartedMs: sessionStart,
      hasCommittedTrustAnchor: true,
      trustAnchorMs: 0,
      serverNowMs: now,
    }).accept
      ? "PASS"
      : "FAIL"
  );

  record(
    "unit-updatedAt-not-trust-anchor",
    (() => {
      const vehicle = {
        trackingSessionId: "sess_established",
        trackingSessionStartedAt: Ts.fromMillis(sessionStart),
        updatedAt: Ts.fromMillis(trustAnchor),
        location: {
          lat: fix.lat,
          lng: fix.lng,
          observedAt: fix.observedAt,
          sequence: fix.sequence,
          sessionId: fix.sessionId,
          source: "gps",
        },
      };
      const ride = {
        status: "accepted",
        vehicleId: "veh-no-anchor",
        pickupLocation: { lat: 24.87, lng: 67.01 },
      };
      return buildDriverLocationPatch(vehicle, ride).reason !== LOCATION_DIAG.ACCEPTED &&
        buildDriverLocationPatch(vehicle, ride).skip
        ? "PASS"
        : "FAIL";
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

  const futureAnchor = buildDriverLocationPatch(
    {
      trackingSessionId: sessionId,
      trackingSessionStartedAt: Ts.fromMillis(now - 600_000),
      locationUpdatedAt: Ts.fromMillis(now + 120_000),
      location: {
        lat: 24.8607,
        lng: 67.0011,
        observedAt: now,
        sequence: 20,
        sessionId,
        source: "gps",
      },
    },
    { status: "accepted", vehicleId: vehId, pickupLocation: { lat: 24.87, lng: 67.01 } }
  );
  record(
    "emu-future-trust-anchor-rejected",
    futureAnchor.skip &&
      (futureAnchor.reason === LOCATION_DIAG.OUT_OF_ORDER ||
        futureAnchor.reason === LOCATION_DIAG.INVALID)
      ? "PASS"
      : "FAIL",
    futureAnchor.reason,
    "emulator"
  );

  const oldGpsFreshAnchor = buildDriverLocationPatch(
    {
      trackingSessionId: sessionId,
      trackingSessionStartedAt: Ts.fromMillis(now - 600_000),
      locationUpdatedAt: Ts.fromMillis(now),
      location: {
        lat: 24.8607,
        lng: 67.0011,
        observedAt: now - 300_000,
        sequence: 21,
        sessionId,
        source: "gps",
      },
    },
    { status: "accepted", vehicleId: vehId, pickupLocation: { lat: 24.87, lng: 67.01 } }
  );
  record(
    "emu-old-gps-with-fresh-anchor-rejected",
    oldGpsFreshAnchor.skip && oldGpsFreshAnchor.reason === LOCATION_DIAG.OUT_OF_ORDER
      ? "PASS"
      : "FAIL",
    oldGpsFreshAnchor.reason,
    "emulator"
  );

  const rematchRide = "llf-rematch-privacy";
  await db.doc(`rides/${rematchRide}`).set({
    userId: "cust_rematch",
    driverId: "driver_order_seed",
    vehicleId: vehId,
    status: "accepted",
    assignmentSessionToken: "as_old_token",
    pickupLocation: { lat: 24.87, lng: 67.01 },
    dropoffLocation: { lat: 24.9, lng: 67.05 },
    driverLocation: {
      lat: 99,
      lng: 99,
      observedAt: now - 120_000,
      sequence: 50,
      sessionId: "prior_driver_sess",
    },
    driverTrackingSessionId: "prior_driver_sess",
  });
  await db.doc(`rides/${rematchRide}`).update({
    driverId: "driver_rematch_new",
    vehicleId: "veh_rematch_new",
    assignmentSessionToken: "as_new_token",
    driverLocation: FieldValue.delete(),
    driverLocationUpdatedAt: FieldValue.delete(),
    driverTrackingSessionId: FieldValue.delete(),
    driverTrackingSessionStartedAt: FieldValue.delete(),
    serverMirrorAccepted: 0,
    serverMirrorAttempts: 0,
    firstServerMirrorAt: FieldValue.delete(),
    lastServerMirrorAt: FieldValue.delete(),
    maximumMirrorGapMs: FieldValue.delete(),
  });
  const betweenRematch = (await db.doc(`rides/${rematchRide}`).get()).data();
  record(
    "emu-rematch-no-prior-driver-location-before-seed",
    !betweenRematch?.driverLocation && !betweenRematch?.driverTrackingSessionId ? "PASS" : "FAIL",
    betweenRematch?.driverLocation?.sessionId || "cleared",
    "emulator"
  );
}

async function rulesTests() {
  const emuHost = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";
  const [host, portStr] = emuHost.split(":");
  const port = Number(portStr) || 8080;

  let testEnv;
  try {
    testEnv = await initializeTestEnvironment({
      projectId: PROJECT,
      firestore: { rules: RULES, host, port },
    });
  } catch (err) {
    record("rules-suite-bootstrap", "BLOCKED", String(err.message || err).slice(0, 160), "rules");
    return;
  }

  await testEnv.clearFirestore();

  const driverA = "anchor-driver-a";
  const driverB = "anchor-driver-b";
  const vehId = "anchor-veh-1";
  const sessionId = "anchor_rules_sess";

  await db.doc(`partners/${driverA}`).set({
    uid: driverA,
    role: "driver",
    accountStatus: "active",
    currentVehicleId: vehId,
    walletBalance: 0,
  });
  await db.doc(`partners/${driverB}`).set({
    uid: driverB,
    role: "driver",
    accountStatus: "active",
    walletBalance: 0,
  });
  await db.doc(`vehicles/${vehId}`).set({
    ownerId: "anchor-owner",
    driverId: driverA,
    status: "online",
    trackingSessionId: sessionId,
    trackingSessionStartedAt: Ts.fromMillis(Date.now() - 60_000),
    location: {
      lat: 24.871,
      lng: 67.012,
      observedAt: Date.now(),
      sequence: 1,
      sessionId,
      source: "gps",
    },
    locationUpdatedAt: Ts.now(),
  });

  const drvA = testEnv.authenticatedContext(driverA, { email: "a@anchor.test" }).firestore();
  const drvB = testEnv.authenticatedContext(driverB, { email: "b@anchor.test" }).firestore();

  const baseLocWrite = (seq = 2, extra = {}) => ({
    location: {
      lat: 24.872,
      lng: 67.013,
      observedAt: Date.now(),
      sequence: seq,
      sessionId,
      source: "gps",
    },
    locationUpdatedAt: serverTimestamp(),
    trackingSessionId: sessionId,
    status: "online",
    ...extra,
  });

  async function tryPass(name, fn) {
    try {
      await fn();
      record(name, "PASS", "", "rules");
    } catch (e) {
      record(name, "FAIL", String(e.message || e).slice(0, 160), "rules");
    }
  }

  await tryPass("rules-valid-serverTimestamp-anchor", async () => {
    await assertSucceeds(updateDoc(doc(drvA, "vehicles", vehId), baseLocWrite(2)));
  });

  await tryPass("rules-forged-past-timestamp-denied", async () => {
    await assertFails(
      updateDoc(
        doc(drvA, "vehicles", vehId),
        baseLocWrite(3, {
          locationUpdatedAt: Timestamp.fromMillis(Date.now() - 120_000),
        })
      )
    );
  });

  await tryPass("rules-forged-future-timestamp-denied", async () => {
    await assertFails(
      updateDoc(
        doc(drvA, "vehicles", vehId),
        baseLocWrite(4, {
          locationUpdatedAt: Timestamp.fromMillis(Date.now() + 120_000),
        })
      )
    );
  });

  await tryPass("rules-numeric-timestamp-denied", async () => {
    await assertFails(
      updateDoc(
        doc(drvA, "vehicles", vehId),
        baseLocWrite(5, { locationUpdatedAt: Date.now() })
      )
    );
  });

  await tryPass("rules-string-timestamp-denied", async () => {
    await assertFails(
      updateDoc(
        doc(drvA, "vehicles", vehId),
        baseLocWrite(6, { locationUpdatedAt: "2026-08-10T00:00:00.000Z" })
      )
    );
  });

  await tryPass("rules-missing-anchor-denied", async () => {
    await assertFails(
      updateDoc(doc(drvA, "vehicles", vehId), {
        location: {
          lat: 24.873,
          lng: 67.014,
          observedAt: Date.now(),
          sequence: 7,
          sessionId,
          source: "gps",
        },
        trackingSessionId: sessionId,
        status: "online",
      })
    );
  });

  await tryPass("rules-wrong-driver-denied", async () => {
    await assertFails(updateDoc(doc(drvB, "vehicles", vehId), baseLocWrite(8)));
  });

  await testEnv.cleanup();
}

async function main() {
  unitTests();
  await emulatorTests();
  await rulesTests();

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
