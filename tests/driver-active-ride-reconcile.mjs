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
  ORPHANED_RIDE_COMPLETE_URDU,
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
      driverApp.includes("probeOrphanedActiveRide") &&
      driverApp.includes("activeRideRecoveryPending")
      ? "PASS"
      : "FAIL",
    ACTIVE_RIDE_RECOVERY_URDU.slice(0, 40)
  );
  record(
    "S03b-orphaned-complete-urdu-pin",
    driverApp.includes("ORPHANED_RIDE_COMPLETE_URDU") &&
      driverApp.includes("showPinGate(ORPHANED_RIDE_COMPLETE_URDU)") &&
      !/nextStatus === "completed"[\s\S]{0,800}VEHICLE_NOT_LINKED/.test(driverApp)
      ? "PASS"
      : "FAIL",
    ORPHANED_RIDE_COMPLETE_URDU.slice(0, 40)
  );
  record(
    "S04-completion-finalize-cleanup",
    driverApp.includes("finalizeSuccessfulRideCompletion") &&
      driverApp.includes("orphanedCompletion") &&
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
  record(
    "S07-settlement-no-client-vehicle-gate",
    read("functions/settlement.js").includes("vehicleRef") &&
      read("functions/settlement.js").includes('status: "offline"') &&
      !read("functions/settlement.js").includes('status: "online"')
      ? "PASS"
      : "FAIL"
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
  const otherDriverUid = "reconcile-other-driver";
  const vehicleId = "reconcile-veh";
  const rideOrphanId = "reconcile-ride-orphan";
  const rideOkId = "reconcile-ride-linked";
  const rideBadId = "reconcile-ride-bad";

  await db.doc("settings/pricing").set(
    { commissionPercent: 10, vehicles: { go: { commissionPercent: 10 } } },
    { merge: true }
  );

  await db.doc(`partners/${driverUid}`).set({
    role: "driver",
    accountStatus: "active",
    currentVehicleId: null,
    activeRideId: rideOrphanId,
    walletBalance: 0,
    totalEarnings: 0,
    totalRidesCompleted: 0,
  });
  await db.doc(`partners/${otherDriverUid}`).set({
    role: "driver",
    accountStatus: "active",
    walletBalance: 0,
    totalEarnings: 0,
    totalRidesCompleted: 0,
  });

  await db.doc(`vehicles/${vehicleId}`).set({
    ownerId: "owner-reconcile",
    plate: "REC-1",
    driverId: driverUid,
    status: "in_ride",
    activeRideId: rideOrphanId,
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

  await db.doc(`rides/${rideOrphanId}`).set({ ...rideBase, status: "in_progress" });
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
      (await db.doc(`rides/${rideOrphanId}`).get()).data(),
      driverUid
    ).ok
      ? "PASS"
      : "FAIL"
  );

  const partnerUnlinked = (await db.doc(`partners/${driverUid}`).get()).data();
  record(
    "E03-active-ride-without-currentVehicleId",
    validateRideForDriverRestore(
      (await db.doc(`rides/${rideOrphanId}`).get()).data(),
      driverUid
    ).ok && !partnerUnlinked.currentVehicleId
      ? "PASS"
      : "FAIL",
    "Firestore ride active; partner.currentVehicleId null"
  );

  let wrongDriverDenied = false;
  try {
    await settleRide(db, {
      rideId: rideOrphanId,
      collectionName: "rides",
      callerUid: otherDriverUid,
    });
  } catch (err) {
    wrongDriverDenied =
      String(err.message).includes("NOT_ASSIGNED_DRIVER") || err.code === "permission-denied";
  }
  record(
    "E09-wrong-driver-denied",
    wrongDriverDenied ? "PASS" : "FAIL"
  );

  const orphanSettlement = await settleRide(db, {
    rideId: rideOrphanId,
    collectionName: "rides",
    callerUid: driverUid,
  });
  const orphanRideAfter = (await db.doc(`rides/${rideOrphanId}`).get()).data();
  const orphanPartnerAfter = (await db.doc(`partners/${driverUid}`).get()).data();
  const orphanVehicleAfter = (await db.doc(`vehicles/${vehicleId}`).get()).data();

  record(
    "E10-orphan-settlement-succeeds",
    orphanSettlement?.driverEarnings === 360 ? "PASS" : "FAIL",
    `earnings=${orphanSettlement?.driverEarnings}`
  );
  record(
    "E11-orphan-ride-completed",
    orphanRideAfter.status === "completed" ? "PASS" : "FAIL"
  );
  record(
    "E12-orphan-partner-activeRideId-cleared",
    orphanPartnerAfter.activeRideId === undefined || orphanPartnerAfter.activeRideId === null
      ? "PASS"
      : "FAIL"
  );
  record(
    "E13-orphan-vehicle-activeRideId-cleared",
    !orphanVehicleAfter.activeRideId ? "PASS" : "FAIL"
  );
  record(
    "E14-orphan-vehicle-offline-not-online",
    orphanVehicleAfter.status === "offline" ? "PASS" : "FAIL",
    orphanVehicleAfter.status
  );

  const [retryA, retryB] = await Promise.all([
    settleRide(db, { rideId: rideOrphanId, collectionName: "rides", callerUid: driverUid }),
    settleRide(db, { rideId: rideOrphanId, collectionName: "rides", callerUid: driverUid }),
  ]);
  const orphanPartnerRetry = (await db.doc(`partners/${driverUid}`).get()).data();
  const orphanLedgerQ = await db
    .collection("ledger_transactions")
    .where("rideId", "==", rideOrphanId)
    .get();
  record(
    "E15-orphan-retry-idempotent",
    retryA?.alreadySettled && retryB?.alreadySettled && orphanLedgerQ.size === 1 ? "PASS" : "FAIL",
    `ledger=${orphanLedgerQ.size} rides=${orphanPartnerRetry.totalRidesCompleted}`
  );
  record(
    "E16-orphan-no-double-earnings",
    orphanPartnerRetry.totalEarnings === 360 && orphanPartnerRetry.totalRidesCompleted === 1
      ? "PASS"
      : "FAIL",
    `earn=${orphanPartnerRetry.totalEarnings}`
  );

  await db.doc(`partners/${driverUid}`).set({
    currentVehicleId: vehicleId,
    activeRideId: rideOkId,
    walletBalance: orphanPartnerRetry.walletBalance ?? -40,
    totalEarnings: orphanPartnerRetry.totalEarnings ?? 360,
    totalRidesCompleted: orphanPartnerRetry.totalRidesCompleted ?? 1,
  }, { merge: true });
  await db.doc(`vehicles/${vehicleId}`).set({
    driverId: driverUid,
    status: "in_ride",
    activeRideId: rideOkId,
  }, { merge: true });
  await db.doc(`rides/${rideOkId}`).set({ ...rideBase, status: "in_progress" });

  const linkedSettlement = await settleRide(db, {
    rideId: rideOkId,
    collectionName: "rides",
    callerUid: driverUid,
  });
  const linkedRideAfter = (await db.doc(`rides/${rideOkId}`).get()).data();
  const linkedPartnerAfter = (await db.doc(`partners/${driverUid}`).get()).data();
  const linkedVehicleAfter = (await db.doc(`vehicles/${vehicleId}`).get()).data();

  record(
    "E04-linked-settlement-completes-ride",
    linkedSettlement?.driverEarnings === 360 &&
      linkedRideAfter.status === "completed" &&
      !linkedPartnerAfter.activeRideId
      ? "PASS"
      : "FAIL",
    `earnings=${linkedSettlement?.driverEarnings}`
  );
  record(
    "E05-linked-partner-activeRideId-cleared",
    linkedPartnerAfter.activeRideId === undefined || linkedPartnerAfter.activeRideId === null
      ? "PASS"
      : "FAIL"
  );
  record(
    "E08-linked-vehicle-cleared-offline",
    !linkedVehicleAfter.activeRideId && linkedVehicleAfter.status === "offline" ? "PASS" : "FAIL",
    linkedVehicleAfter.status
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
      "E06-settlement-failure-invalid-fare",
      settlementFailed &&
        (String(err.message).includes("INVALID") || err.code === "failed-precondition")
        ? "PASS"
        : "FAIL",
      classified.category
    );
  }
  if (!settlementFailed) {
    record("E06-settlement-failure-invalid-fare", "FAIL", "expected throw");
  }

  const rideBadAfter = (await db.doc(`rides/${rideBadId}`).get()).data();
  record(
    "E07-settlement-failure-leaves-ride-visible",
    rideBadAfter.status === "in_progress" ? "PASS" : "FAIL",
    rideBadAfter.status
  );

  const healRideId = "reconcile-ride-heal-stale-vehicle";
  const healLedgerId = `settle_rides_${healRideId}`;
  const healPartnerBefore = (await db.doc(`partners/${driverUid}`).get()).data();
  await db.doc(`rides/${healRideId}`).set({
    ...rideBase,
    status: "completed",
    settlementId: healLedgerId,
    commissionAmount: 40,
    driverEarnings: 360,
    commissionPercent: 10,
  });
  await db.doc(`ledger_transactions/${healLedgerId}`).set({
    rideId: healRideId,
    collectionName: "rides",
    customerId: "cust-reconcile",
    driverId: driverUid,
    grossFare: 400,
    commissionAmount: 40,
    driverEarnings: 360,
    commissionPercent: 10,
    type: "ride_settlement",
    idempotencyKey: healLedgerId,
    trustedCreator: "completeRideSettlement",
    status: "posted",
    createdAt: admin.firestore.Timestamp.now(),
  });
  await db.doc(`vehicles/${vehicleId}`).set({
    driverId: driverUid,
    status: "in_ride",
    activeRideId: healRideId,
  }, { merge: true });

  const healRetry = await settleRide(db, {
    rideId: healRideId,
    collectionName: "rides",
    callerUid: driverUid,
  });
  const healVehicleAfter = (await db.doc(`vehicles/${vehicleId}`).get()).data();
  const healPartnerAfter = (await db.doc(`partners/${driverUid}`).get()).data();

  record(
    "E17-idempotent-heal-stale-vehicle-activeRideId",
    healRetry?.alreadySettled === true &&
      !healVehicleAfter.activeRideId &&
      healVehicleAfter.status === "offline"
      ? "PASS"
      : "FAIL",
    `status=${healVehicleAfter.status}`
  );
  record(
    "E17b-idempotent-heal-stale-partner-activeRideId",
    healRetry?.alreadySettled === true &&
      (healPartnerAfter.activeRideId === undefined || healPartnerAfter.activeRideId === null)
      ? "PASS"
      : "FAIL"
  );
  record(
    "E18-idempotent-heal-no-double-earnings",
    healPartnerAfter.totalEarnings === healPartnerBefore.totalEarnings &&
      healPartnerAfter.totalRidesCompleted === healPartnerBefore.totalRidesCompleted
      ? "PASS"
      : "FAIL",
    `earn=${healPartnerAfter.totalEarnings} rides=${healPartnerAfter.totalRidesCompleted}`
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
