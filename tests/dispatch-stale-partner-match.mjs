/**
 * Stale partner.activeRideId must not hide an otherwise online driver from matching.
 * Run: npm run test:dispatch-stale-partner-match
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROJECT = "demo-swiftgo-phase1";
const OUT = path.join(ROOT, "tests", "dispatch-stale-partner-match-results.json");

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080";
}

const admin = require(require.resolve("firebase-admin", { paths: [path.join(ROOT, "functions"), ROOT] }));
let adminApp;
try {
  adminApp = admin.app();
} catch {
  adminApp = admin.initializeApp({ projectId: PROJECT });
}
const db = admin.firestore(adminApp);
const Timestamp = admin.firestore.Timestamp;
const { matchRideCandidates, createCustomerBooking, acceptCustomerInitialFareAsDriver } = require(path.join(ROOT, "functions", "bargaining.js"));
const { locationGeoFields } = require(path.join(ROOT, "functions", "geo-cells.js"));

const pickup = { lat: 24.8607, lng: 67.0011, address: "Pickup" };
const dropoff = { lat: 24.87, lng: 67.01, address: "Dropoff" };
const near = { lat: pickup.lat + 0.002, lng: pickup.lng + 0.002 };

const results = [];
function record(name, status, detail = "") {
  results.push({ name, status, detail, suite: "dispatch-stale-partner-match" });
  const mark = status === "PASS" ? "✓" : status === "FAIL" ? "✗" : "·";
  console.log(`${mark} ${name} — ${status}${detail ? `: ${detail}` : ""}`);
}

async function main() {
  await db.doc("settings/dispatch").set({
    candidateDriverLimit: 10,
    maxSearchRadiusKm: 3,
    searchRingsKm: [1, 2, 3],
  });

  const prefix = `spm${Date.now().toString(36)}`;
  const driverUid = `${prefix}-drv`;
  const customerUid = `${prefix}-cust`;
  const vehicleId = `${prefix}-veh`;
  const staleRideId = `${prefix}-stale`;
  const geo = locationGeoFields(near.lat, near.lng);

  await db.doc(`partners/${driverUid}`).set({
    uid: driverUid,
    role: "driver",
    accountStatus: "active",
    currentVehicleId: vehicleId,
    activeRideId: staleRideId,
  });
  await db.doc(`rides/${staleRideId}`).set({
    userId: customerUid,
    driverId: driverUid,
    vehicleId,
    status: "completed",
  });
  await db.doc(`vehicles/${vehicleId}`).set({
    ownerId: `${prefix}-owner`,
    plate: "SPM-1",
    driverId: driverUid,
    status: "online",
    location: { lat: near.lat, lng: near.lng, sessionId: "s_spm_1" },
    locationUpdatedAt: Timestamp.now(),
    ...geo,
  });

  const created = await createCustomerBooking(db, {
    customerUid,
    confirmedExtraBooking: true,
    dispatchTraceId: "dt_spm_test1",
    ridePayload: {
      pickupLocation: pickup,
      dropoffLocation: dropoff,
      vehicleType: "Go",
      vehicleTypeKey: "go",
      farePkr: 250,
      estimatedFare: 250,
    },
  });
  const createdSnap = await db.doc(`rides/${created.id}`).get();
  record(
    "create-sets-matching-pending",
    createdSnap.data()?.matchingStatus === "pending" && createdSnap.data()?.status === "searching_driver"
      ? "PASS"
      : "FAIL",
    `matchingStatus=${createdSnap.data()?.matchingStatus || "∅"}`
  );

  const matched = await matchRideCandidates(db, {
    rideId: created.id,
    pickup,
  });

  const invited = (matched.candidates || []).some((c) => c.driverId === driverUid);
  const candSnap = await db.doc(`ride_candidates/${created.id}_${driverUid}`).get();
  const cand = candSnap.exists ? candSnap.data() : null;
  const ok =
    invited &&
    cand?.status === "invited" &&
    Number(matched.candidateCount || 0) >= 1;
  record(
    "stale-partner-pointer-still-invited",
    ok ? "PASS" : "FAIL",
    ok ? `source=${matched.metrics?.source || ""}` : `count=${matched.candidateCount} invited=${invited}`
  );

  let accepted = false;
  let acceptError = "";
  try {
    const result = await acceptCustomerInitialFareAsDriver(db, {
      rideId: created.id,
      driverUid,
      vehicleId,
      ownerId: `${prefix}-owner`,
      driverName: "Stale Pointer Driver",
      vehiclePlate: "SPM-1",
    });
    accepted = Boolean(result?.assigned || result?.driverId === driverUid);
  } catch (err) {
    acceptError = String(err?.message || err);
  }
  const assignedRide = (await db.doc(`rides/${created.id}`).get()).data() || {};
  const partnerAfter = (await db.doc(`partners/${driverUid}`).get()).data() || {};
  const vehicleAfter = (await db.doc(`vehicles/${vehicleId}`).get()).data() || {};
  const acceptOk =
    accepted &&
    assignedRide.status === "accepted" &&
    assignedRide.driverId === driverUid &&
    partnerAfter.activeRideId === created.id &&
    vehicleAfter.activeRideId === created.id;
  record(
    "stale-partner-pointer-accept-completes-assignment",
    acceptOk ? "PASS" : "FAIL",
    acceptOk ? `ride=${created.id}` : acceptError || `status=${assignedRide.status || "∅"}`
  );

  const createdBusy = await createCustomerBooking(db, {
    customerUid: `${customerUid}-2`,
    confirmedExtraBooking: true,
    dispatchTraceId: "dt_spm_test2",
    ridePayload: {
      pickupLocation: pickup,
      dropoffLocation: dropoff,
      vehicleType: "Go",
      vehicleTypeKey: "go",
      farePkr: 250,
      estimatedFare: 250,
    },
  });
  const matchedBusy = await matchRideCandidates(db, {
    rideId: createdBusy.id,
    pickup,
  });
  const invitedBusy = (matchedBusy.candidates || []).some((c) => c.driverId === driverUid);
  record(
    "genuine-active-ride-still-excluded",
    !invitedBusy ? "PASS" : "FAIL",
    invitedBusy ? "busy driver was invited" : ""
  );

  writeOut(results.some((r) => r.status === "FAIL") ? 1 : 0);
}

function writeOut(code) {
  const summary = {
    pass: results.filter((r) => r.status === "PASS").length,
    fail: results.filter((r) => r.status === "FAIL").length,
    total: results.length,
  };
  fs.writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), summary, results }, null, 2));
  console.log("\nSummary:", summary);
  process.exitCode = code;
}

main().catch((err) => {
  console.error(err);
  writeOut(1);
});
