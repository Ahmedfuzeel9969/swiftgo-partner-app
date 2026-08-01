/**
 * Driver active-ride cache / restore / completion reconciliation tests.
 * Run: npm run test:driver-active-ride-reconcile
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  ACTIVE_RIDE_CACHE_KEY,
  ACTIVE_RIDE_RECOVERY_URDU,
  clearActiveRideCache,
  classifySettlementFailure,
  collectActiveRideCandidateIds,
  persistActiveRideCache,
  readActiveRideCache,
  validateRideForDriverRestore,
} from "../driver-app/js/active-ride-reconcile.mjs";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROJECT = "demo-swiftgo-phase1";
const OUT = path.join(ROOT, "tests", "driver-active-ride-reconcile-results.json");

process.env.FIRESTORE_EMULATOR_HOST ||= "127.0.0.1:8080";
process.env.FIREBASE_AUTH_EMULATOR_HOST ||= "127.0.0.1:9099";
process.env.FIREBASE_FUNCTIONS_EMULATOR_HOST ||= "127.0.0.1:5001";
process.env.GCLOUD_PROJECT ||= PROJECT;
process.env.GOOGLE_CLOUD_PROJECT ||= PROJECT;

const results = [];

function record(name, status, detail = "") {
  results.push({ name, status, detail, suite: "driver-active-ride-reconcile" });
  const mark = status === "PASS" ? "✓" : status === "FAIL" ? "✗" : "·";
  console.log(`${mark} ${name} — ${status}${detail ? `: ${detail}` : ""}`);
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

class MemoryStorage {
  constructor() {
    this.map = new Map();
  }
  setItem(k, v) {
    this.map.set(k, String(v));
  }
  getItem(k) {
    return this.map.has(k) ? this.map.get(k) : null;
  }
  removeItem(k) {
    this.map.delete(k);
  }
}

function staticChecks() {
  const driverApp = read("driver-app/js/driver-app.js");
  const reconcile = read("driver-app/js/active-ride-reconcile.mjs");

  record(
    "S01-never-trust-cache-alone",
    driverApp.includes("validateRideForDriverRestore") &&
      driverApp.includes("collectActiveRideCandidateIds") &&
      reconcile.includes("validateRideForDriverRestore")
      ? "PASS"
      : "FAIL"
  );
  record(
    "S02-clear-cache-terminal-missing",
    driverApp.includes("clearActiveRideCache()") &&
      reconcile.includes("terminal_or_inactive") &&
      driverApp.includes("dismissStaleActiveRide")
      ? "PASS"
      : "FAIL"
  );
  record(
    "S03-recovery-urdu-no-vehicle",
    driverApp.includes("ACTIVE_RIDE_RECOVERY_URDU") &&
      driverApp.includes("probeActiveRideRecovery") &&
      driverApp.includes("activeRideRecoveryPending")
      ? "PASS"
      : "FAIL",
    ACTIVE_RIDE_RECOVERY_URDU.slice(0, 40)
  );
  record(
    "S04-completion-finalize-cleanup",
    driverApp.includes("finalizeSuccessfulRideCompletion") &&
      driverApp.includes("markVehicleRideId(null)") &&
      driverApp.includes("reactivateOnlineAfterRideEnd")
      ? "PASS"
      : "FAIL"
  );
  record(
    "S05-settlement-failure-retryable",
    driverApp.includes("classifySettlementFailure") &&
      driverApp.includes("activeRideActionBtn.disabled = false") &&
      driverApp.includes('console.error("[SwiftGo Driver] advance ride status failed"')
      ? "PASS"
      : "FAIL"
  );
  record(
    "S06-prevent-duplicate-completion",
    driverApp.includes("activeRideCompletionInFlight") ? "PASS" : "FAIL"
  );
}

function unitChecks() {
  const storage = new MemoryStorage();
  persistActiveRideCache("ride-stale", "rides", storage);
  record(
    "U01-stale-cache-completed-ride-rejected",
    !validateRideForDriverRestore({ driverId: "d1", status: "completed" }, "d1").ok
      ? "PASS"
      : "FAIL"
  );
  clearActiveRideCache(storage);
  record(
    "U02-cache-cleared",
    readActiveRideCache(storage) === null ? "PASS" : "FAIL"
  );

  persistActiveRideCache("ride-missing", "rides", storage);
  record(
    "U03-cache-read-roundtrip",
    readActiveRideCache(storage)?.rideId === "ride-missing" ? "PASS" : "FAIL"
  );
  clearActiveRideCache(storage);
  record(
    "U04-missing-doc-cache-clear-simulated",
    readActiveRideCache(storage) === null ? "PASS" : "FAIL",
    "cache cleared when doc absent"
  );

  record(
    "U05-wrong-driver-rejected",
    validateRideForDriverRestore({ driverId: "other", status: "in_progress" }, "d1").reason ===
      "wrong_driver"
      ? "PASS"
      : "FAIL"
  );

  const ids = collectActiveRideCandidateIds(
    { activeRideId: "p1" },
    { activeRideId: "v1" },
    { rideId: "c1" }
  );
  record(
    "U06-candidate-id-dedupe-order",
    ids.length === 3 && ids[0] === "p1" ? "PASS" : "FAIL",
    ids.join(",")
  );

  record(
    "U07-recovery-message-constant",
    ACTIVE_RIDE_RECOVERY_URDU.includes("گاڑی منسلک نہیں") ? "PASS" : "FAIL"
  );

  const settlementErr = classifySettlementFailure({
    code: "functions/failed-precondition",
    message: "INVALID_STATUS",
  });
  record(
    "U08-settlement-failure-category",
    settlementErr.category === "invalid_state" && settlementErr.userMessageUrdu.includes("حالت")
      ? "PASS"
      : "FAIL",
    settlementErr.category
  );

  record(
    "U09-cache-key-stable",
    ACTIVE_RIDE_CACHE_KEY === "swiftgo_driver_active_ride_v1" ? "PASS" : "FAIL"
  );
}

async function emulatorChecks() {
  const admin = require(require.resolve("firebase-admin", { paths: [path.join(ROOT, "functions"), ROOT] }));
  let app;
  try {
    app = admin.app();
  } catch {
    app = admin.initializeApp({ projectId: PROJECT });
  }
  const db = admin.firestore(app);
  const FieldValue = admin.firestore.FieldValue;
  const { settleRide } = require(path.join(ROOT, "functions", "settlement.js"));

  const driverUid = "reconcile-driver";
  const vehicleId = "reconcile-veh";
  const rideOkId = "reconcile-ride-ok";
  const rideBadId = "reconcile-ride-bad";

  await db.doc("settings/pricing").set(
    { commissionPercent: 10, vehicles: { go: { commissionPercent: 10 } } },
    { merge: true }
  );

  await db.doc(`partners/${driverUid}`).set({
    role: "driver",
    accountStatus: "active",
    currentVehicleId: vehicleId,
    activeRideId: rideOkId,
    walletBalance: 0,
    totalEarnings: 0,
    totalRidesCompleted: 0,
  });

  await db.doc(`vehicles/${vehicleId}`).set({
    ownerId: "owner-reconcile",
    plate: "REC-1",
    driverId: driverUid,
    status: "in_ride",
    activeRideId: rideOkId,
    location: { lat: 24.86, lng: 67.0 },
    geoCell: "g_6900_18611",
    locationUpdatedAt: admin.firestore.Timestamp.now(),
  });

  const rideBase = {
    userId: "cust-reconcile",
    pickupLocation: { lat: 24.86, lng: 67.0, address: "A" },
    dropoffLocation: { lat: 24.87, lng: 67.01, address: "B" },
    vehicleType: "Go",
    vehicleTypeKey: "go",
    farePkr: 400,
    estimatedFare: 400,
    driverId: driverUid,
    vehicleId,
    ownerId: "owner-reconcile",
  };

  await db.doc(`rides/${rideOkId}`).set({ ...rideBase, status: "in_progress" });
  await db.doc(`rides/${rideBadId}`).set({
    ...rideBase,
    status: "in_progress",
    farePkr: -1,
    estimatedFare: -1,
  });

  record(
    "E01-active-ride-valid-for-restore",
    validateRideForDriverRestore(
      (await db.doc(`rides/${rideOkId}`).get()).data(),
      driverUid
    ).ok
      ? "PASS"
      : "FAIL"
  );

  const partnerNoVehicle = (
    await db.doc(`partners/${driverUid}`).get()
  ).data();
  record(
    "E02-partner-has-activeRideId-with-vehicle",
    partnerNoVehicle.activeRideId === rideOkId && partnerNoVehicle.currentVehicleId === vehicleId
      ? "PASS"
      : "FAIL"
  );

  await db.doc(`partners/${driverUid}`).set({ currentVehicleId: null }, { merge: true });
  const partnerUnlinked = (await db.doc(`partners/${driverUid}`).get()).data();
  const liveRide = (await db.doc(`rides/${rideOkId}`).get()).data();
  record(
    "E03-active-ride-without-currentVehicleId",
    validateRideForDriverRestore(liveRide, driverUid).ok &&
      !partnerUnlinked.currentVehicleId
      ? "PASS"
      : "FAIL",
    "Firestore ride active; partner.currentVehicleId cleared"
  );

  await db.doc(`partners/${driverUid}`).set({ currentVehicleId: vehicleId }, { merge: true });

  const settlement = await settleRide(db, {
    rideId: rideOkId,
    collectionName: "rides",
    callerUid: driverUid,
  });
  const rideAfter = (await db.doc(`rides/${rideOkId}`).get()).data();
  const partnerAfter = (await db.doc(`partners/${driverUid}`).get()).data();
  record(
    "E04-successful-settlement-completes-ride",
    settlement?.driverEarnings === 360 &&
      rideAfter.status === "completed" &&
      !partnerAfter.activeRideId
      ? "PASS"
      : "FAIL",
    `earnings=${settlement?.driverEarnings}`
  );

  record(
    "E05-settlement-clears-partner-activeRideId",
    partnerAfter.activeRideId === undefined || partnerAfter.activeRideId === null ? "PASS" : "FAIL"
  );

  let settlementFailed = false;
  try {
    await settleRide(db, {
      rideId: rideBadId,
      collectionName: "rides",
      callerUid: driverUid,
    });
  } catch (err) {
    settlementFailed = true;
    const classified = classifySettlementFailure(err);
    record(
      "E06-settlement-failure-invalid-fare-or-status",
      settlementFailed &&
        (String(err.message).includes("INVALID") || err.code === "failed-precondition")
        ? "PASS"
        : "FAIL",
      classified.category
    );
  }
  if (!settlementFailed) {
    record("E06-settlement-failure-invalid-fare-or-status", "FAIL", "expected throw");
  }

  const rideBadAfter = (await db.doc(`rides/${rideBadId}`).get()).data();
  record(
    "E07-settlement-failure-leaves-ride-visible",
    rideBadAfter.status === "in_progress" ? "PASS" : "FAIL",
    rideBadAfter.status
  );

  await db.doc(`vehicles/${vehicleId}`).set(
    { activeRideId: FieldValue.delete(), status: "online" },
    { merge: true }
  );
  const vehicleAfter = (await db.doc(`vehicles/${vehicleId}`).get()).data();
  record(
    "E08-vehicle-activeRideId-clearable",
    !vehicleAfter.activeRideId && vehicleAfter.status === "online" ? "PASS" : "FAIL"
  );
}

async function main() {
  staticChecks();
  unitChecks();
  await emulatorChecks();

  const failed = results.filter((r) => r.status === "FAIL").length;
  fs.writeFileSync(OUT, JSON.stringify({ failed, total: results.length, results }, null, 2));
  console.log(`\nDriver active-ride reconcile: ${results.length - failed}/${results.length} passed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
