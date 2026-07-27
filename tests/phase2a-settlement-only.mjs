/**
 * Phase 2A settlement tests — Admin SDK only (trusted CF path).
 * Run after rules suite, same emulator:
 *   firebase emulators:exec --only firestore --project demo-swiftgo-phase1 "node tests/phase2a-settlement-only.mjs"
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROJECT = "demo-swiftgo-phase1";

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080";
}

const results = [];
function record(name, status, detail) {
  results.push({ name, status, detail, rules: "settlement" });
}

const admin = require(require.resolve("firebase-admin", { paths: [path.join(ROOT, "functions"), ROOT] }));
const app = admin.initializeApp({ projectId: PROJECT });
const db = admin.firestore(app);
const { settleRide } = require(path.join(ROOT, "functions", "settlement.js"));

const rideBase = {
  userId: "customer-a",
  pickupLocation: { lat: 24.86, lng: 67.0, address: "A" },
  dropoffLocation: { lat: 24.9, lng: 67.05, address: "B" },
  vehicleType: "go",
  vehicleTypeKey: "go",
  distanceKm: 5,
  timeMins: 15,
  farePkr: 350,
  estimatedFare: 350,
  createdAt: admin.firestore.Timestamp.now(),
};

async function main() {
  await db.doc("settings/pricing").set({
    commissionPercent: 10,
    vehicles: { go: { commissionPercent: 10 } },
  });
  await db.doc("partners/driver-1").set({
    role: "driver",
    accountStatus: "active",
    walletBalance: 0,
    totalEarnings: 0,
    totalRidesCompleted: 0,
  });
  await db.doc("rides/settle-1").set({
    ...rideBase,
    status: "in_progress",
    driverId: "driver-1",
    vehicleId: "veh-1",
    ownerId: "owner-1",
  });

  const first = await settleRide(db, {
    rideId: "settle-1",
    collectionName: "rides",
    callerUid: "driver-1",
  });
  record(
    "F22-trusted-completion-consistent",
    first?.settlementId && first.commissionAmount === 35 && first.driverEarnings === 315
      ? "PASS"
      : "FAIL",
    JSON.stringify(first)
  );

  const [a, b] = await Promise.all([
    settleRide(db, { rideId: "settle-1", collectionName: "rides", callerUid: "driver-1" }),
    settleRide(db, { rideId: "settle-1", collectionName: "rides", callerUid: "driver-1" }),
  ]);
  const ledgerQ = await db.collection("ledger_transactions").where("rideId", "==", "settle-1").get();
  const partner = (await db.doc("partners/driver-1").get()).data();
  record(
    "F15-simultaneous-completion-one-settlement",
    a && b && ledgerQ.size === 1 ? "PASS" : "FAIL",
    `ledgerCount=${ledgerQ.size}`
  );
  record(
    "F16-repeat-completion-no-duplicate-commission",
    partner?.walletBalance === -35 ? "PASS" : "FAIL",
    `wallet=${partner?.walletBalance}`
  );
  record(
    "F17-repeat-completion-no-duplicate-earnings",
    partner?.totalEarnings === 315 && partner?.totalRidesCompleted === 1 ? "PASS" : "FAIL",
    `earn=${partner?.totalEarnings} rides=${partner?.totalRidesCompleted}`
  );
  record(
    "F18-repeat-completion-no-duplicate-ledger",
    ledgerQ.size === 1 ? "PASS" : "FAIL",
    `ledgerCount=${ledgerQ.size}`
  );

  await db.doc("rides/bad-fare").set({
    ...rideBase,
    farePkr: -10,
    estimatedFare: -10,
    status: "in_progress",
    driverId: "driver-1",
  });
  try {
    await settleRide(db, { rideId: "bad-fare", collectionName: "rides", callerUid: "driver-1" });
    record("F19-invalid-fare-rejected", "FAIL", "unexpected success");
  } catch (e) {
    record("F19-invalid-fare-rejected", e.message === "INVALID_FARE" ? "PASS" : "FAIL", e.message);
  }

  await db.doc("rides/cancelled-1").set({
    ...rideBase,
    status: "cancelled_by_user",
    driverId: "driver-1",
  });
  try {
    await settleRide(db, { rideId: "cancelled-1", collectionName: "rides", callerUid: "driver-1" });
    record("F20-cancelled-cannot-complete", "FAIL", "unexpected success");
  } catch (e) {
    record("F20-cancelled-cannot-complete", e.message === "RIDE_CANCELLED" ? "PASS" : "FAIL", e.message);
  }

  const again = await settleRide(db, {
    rideId: "settle-1",
    collectionName: "rides",
    callerUid: "driver-1",
  });
  const partner2 = (await db.doc("partners/driver-1").get()).data();
  record(
    "F21-completed-not-re-settled",
    again.alreadySettled === true &&
      partner2.walletBalance === -35 &&
      partner2.totalEarnings === 315
      ? "PASS"
      : "FAIL",
    JSON.stringify({ alreadySettled: again.alreadySettled, wallet: partner2.walletBalance })
  );

  await db.doc("rides/wrong-driver").set({
    ...rideBase,
    status: "in_progress",
    driverId: "driver-1",
  });
  try {
    await settleRide(db, { rideId: "wrong-driver", collectionName: "rides", callerUid: "driver-2" });
    record("F23-wrong-driver-denied", "FAIL", "unexpected success");
  } catch (e) {
    record("F23-wrong-driver-denied", e.message === "NOT_ASSIGNED_DRIVER" ? "PASS" : "FAIL", e.message);
  }

  const audits = await db.collection("audit_logs").where("rideId", "==", "settle-1").get();
  const ledger = (await db.doc("ledger_transactions/settle_rides_settle-1").get()).data();
  record(
    "F24-server-timestamp-and-audit",
    audits.size >= 1 && ledger?.trustedCreator === "completeRideSettlement" ? "PASS" : "FAIL",
    `audits=${audits.size} creator=${ledger?.trustedCreator}`
  );

  const out = {
    generatedAt: new Date().toISOString(),
    results,
    passed: results.filter((r) => r.status === "PASS").length,
    failed: results.filter((r) => r.status === "FAIL").length,
    blocked: results.filter((r) => r.status === "BLOCKED").length,
  };
  fs.writeFileSync(path.join(ROOT, "tests", "phase2a-settlement-results.json"), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
  process.exit(out.failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
