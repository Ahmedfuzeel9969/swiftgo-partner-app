/**
 * Stale activeRideId pointer heal tests — server authoritative.
 * Run: npm run test:driver-active-ride-pointer-heal
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  classifyPointerRide,
  evaluateDriverAvailability,
} from "../functions/active-ride-reconcile.js";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROJECT = "demo-swiftgo-phase1";
const OUT = path.join(ROOT, "tests", "driver-active-ride-pointer-heal-results.json");

process.env.FIRESTORE_EMULATOR_HOST ||= "127.0.0.1:8080";
process.env.FIREBASE_AUTH_EMULATOR_HOST ||= "127.0.0.1:9099";
process.env.FIREBASE_FUNCTIONS_EMULATOR_HOST ||= "127.0.0.1:5001";
process.env.GCLOUD_PROJECT ||= PROJECT;
process.env.GOOGLE_CLOUD_PROJECT ||= PROJECT;

const results = [];

function record(name, status, detail = "") {
  results.push({ name, status, detail, suite: "driver-active-ride-pointer-heal" });
  const mark = status === "PASS" ? "✓" : status === "FAIL" ? "✗" : "·";
  console.log(`${mark} ${name} — ${status}${detail ? `: ${detail}` : ""}`);
}

const admin = require(require.resolve("firebase-admin", { paths: [path.join(ROOT, "functions"), ROOT] }));
let app;
try {
  app = admin.app();
} catch {
  app = admin.initializeApp({ projectId: PROJECT });
}
const db = admin.firestore(app);

const {
  submitRideOffer,
  acceptCustomerInitialFareAsDriver,
  finalizeAssignmentFromOffer,
  matchRideCandidates,
  rematchNearbySearchingRidesForVehicle,
} = require(path.join(ROOT, "functions", "bargaining.js"));
const { linkVehicleByPin } = require(path.join(ROOT, "functions", "pin-link.js"));
const { hashVehiclePin } = require(path.join(ROOT, "functions", "pin-security.js"));
const { settleRide } = require(path.join(ROOT, "functions", "settlement.js"));
const {
  validateRideForDriverRestore,
  STALE_POINTER_RECOVERY_URDU,
} = require(path.join(ROOT, "driver-app/js/active-ride-reconcile.mjs"));

function mockSnap(id, data) {
  return {
    id,
    exists: data != null,
    data: () => data,
  };
}

function unitTests() {
  record(
    "U01-classify-completed-stale",
    classifyPointerRide(mockSnap("r1", { status: "completed", driverId: "d1" }), {
      driverUid: "d1",
      pointerSource: "partner",
    }).stale
      ? "PASS"
      : "FAIL"
  );
  record(
    "U02-classify-genuine-active-blocks",
    classifyPointerRide(mockSnap("r1", { status: "in_progress", driverId: "d1" }), {
      driverUid: "d1",
      pointerSource: "partner",
    }).block
      ? "PASS"
      : "FAIL"
  );
  record(
    "U03-vehicle-wrong-vehicle-stale",
    classifyPointerRide(
      mockSnap("r1", { status: "in_progress", driverId: "d1", vehicleId: "v-old" }),
      { driverUid: "d1", vehicleId: "v-new", pointerSource: "vehicle" }
    ).stale && !classifyPointerRide(
      mockSnap("r1", { status: "in_progress", driverId: "d1", vehicleId: "v-old" }),
      { driverUid: "d1", vehicleId: "v-new", pointerSource: "vehicle" }
    ).block
      ? "PASS"
      : "FAIL"
  );
  record(
    "U04-evaluate-partner-stale-heals",
    evaluateDriverAvailability({
      driverUid: "d1",
      vehicleId: "v1",
      partner: { activeRideId: "r-done" },
      vehicle: {},
      rideSnaps: new Map([
        ["r-done", mockSnap("r-done", { status: "completed", driverId: "d1" })],
      ]),
      activeRideSnap: { empty: true, docs: [] },
    }).heals.some((h) => h.target === "partner") &&
      !evaluateDriverAvailability({
        driverUid: "d1",
        partner: { activeRideId: "r-done" },
        vehicle: {},
        rideSnaps: new Map([
          ["r-done", mockSnap("r-done", { status: "completed", driverId: "d1" })],
        ]),
        activeRideSnap: { empty: true, docs: [] },
      }).blocked
      ? "PASS"
      : "FAIL"
  );
  record(
    "U05-client-stale-urdu-constant",
    STALE_POINTER_RECOVERY_URDU.includes("پرانی") ? "PASS" : "FAIL"
  );
  record(
    "U06-restore-rejects-terminal",
    !validateRideForDriverRestore({ status: "completed", driverId: "d1" }, "d1").ok
      ? "PASS"
      : "FAIL"
  );
}

async function seedSearchingRide(rideId, customerId = "cust-heal") {
  await db.doc(`rides/${rideId}`).set({
    userId: customerId,
    status: "searching_driver",
    estimatedFare: 500,
    farePkr: 500,
    pickupLocation: { lat: 24.86, lng: 67.01, address: "A" },
    dropoffLocation: { lat: 24.87, lng: 67.02, address: "B" },
    createdAt: admin.firestore.Timestamp.now(),
  });
}

async function seedCandidate(rideId, driverUid) {
  await db.doc(`ride_candidates/${rideId}_${driverUid}`).set({
    rideId,
    driverId: driverUid,
    status: "invited",
    createdAt: admin.firestore.Timestamp.now(),
  });
}

/** Clear open offers so MAX_OPEN_BARGAINS does not mask DRIVER_HAS_ACTIVE_RIDE tests. */
async function withdrawOpenOffersForDriver(driverUid) {
  const snap = await db
    .collection("ride_offers")
    .where("driverId", "==", driverUid)
    .where("status", "in", ["open", "countered"])
    .get();
  const batch = db.batch();
  for (const doc of snap.docs) {
    batch.set(doc.ref, { status: "withdrawn", updatedAt: admin.firestore.Timestamp.now() }, { merge: true });
  }
  if (!snap.empty) await batch.commit();
}

async function seedDriverVehicle(driverUid, vehicleId, ownerId = "owner-heal") {
  await db.doc(`partners/${driverUid}`).set({
    role: "driver",
    accountStatus: "active",
    walletBalance: 0,
    totalEarnings: 0,
    totalRidesCompleted: 0,
    currentVehicleId: vehicleId,
  });
  await db.doc(`vehicles/${vehicleId}`).set({
    driverId: driverUid,
    ownerId,
    status: "online",
    plate: "HEAL-1",
    location: { lat: 24.86, lng: 67.01 },
    geoCell: "g_6900_2300",
    locationUpdatedAt: admin.firestore.Timestamp.now(),
  });
}

async function emulatorTests() {
  const driverA = "heal-driver-a";
  const driverB = "heal-driver-b";
  const vehicleA = "heal-vehicle-a";
  const vehicleB = "heal-vehicle-b";
  const staleRide = "heal-stale-completed";
  const newRide = "heal-new-searching";

  await seedDriverVehicle(driverA, vehicleA);
  await db.doc(`rides/${staleRide}`).set({
    userId: "cust-old",
    driverId: driverA,
    vehicleId: vehicleB,
    status: "completed",
    estimatedFare: 400,
    farePkr: 400,
  });
  await seedSearchingRide(newRide);
  await seedCandidate(newRide, driverA);

  // 1 partner-only stale
  await db.doc(`partners/${driverA}`).set({ activeRideId: staleRide }, { merge: true });
  try {
    await submitRideOffer(db, {
      rideId: newRide,
      driverUid: driverA,
      fare: 480,
      vehicleId: vehicleA,
      ownerId: "owner-heal",
      driverName: "Heal Driver",
      vehiclePlate: "HEAL-1",
    });
    const partnerAfter = (await db.doc(`partners/${driverA}`).get()).data();
    record(
      "E01-partner-stale-completed-offer-succeeds",
      !partnerAfter.activeRideId ? "PASS" : "FAIL",
      `activeRideId=${partnerAfter.activeRideId || "cleared"}`
    );
  } catch (e) {
    record("E01-partner-stale-completed-offer-succeeds", "FAIL", e.message);
  }

  // 2 vehicle-only stale
  const ride2 = "heal-new-2";
  await seedSearchingRide(ride2);
  await seedCandidate(ride2, driverA);
  await db.doc(`vehicles/${vehicleA}`).set({ activeRideId: staleRide }, { merge: true });
  try {
    await submitRideOffer(db, {
      rideId: ride2,
      driverUid: driverA,
      fare: 470,
      vehicleId: vehicleA,
      ownerId: "owner-heal",
      driverName: "Heal Driver",
      vehiclePlate: "HEAL-1",
    });
    const vehicleAfter = (await db.doc(`vehicles/${vehicleA}`).get()).data();
    record(
      "E02-vehicle-stale-completed-offer-succeeds",
      !vehicleAfter.activeRideId ? "PASS" : "FAIL"
    );
  } catch (e) {
    record("E02-vehicle-stale-completed-offer-succeeds", "FAIL", e.message);
  }

  // 3 both stale
  const ride3 = "heal-new-3";
  await seedSearchingRide(ride3);
  await seedCandidate(ride3, driverA);
  await db.doc(`partners/${driverA}`).set({ activeRideId: staleRide }, { merge: true });
  await db.doc(`vehicles/${vehicleA}`).set({ activeRideId: staleRide }, { merge: true });
  try {
    await submitRideOffer(db, {
      rideId: ride3,
      driverUid: driverA,
      fare: 460,
      vehicleId: vehicleA,
      ownerId: "owner-heal",
      driverName: "Heal Driver",
      vehiclePlate: "HEAL-1",
    });
    const p = (await db.doc(`partners/${driverA}`).get()).data();
    const v = (await db.doc(`vehicles/${vehicleA}`).get()).data();
    record(
      "E03-both-pointers-stale-healed",
      !p.activeRideId && !v.activeRideId ? "PASS" : "FAIL"
    );
  } catch (e) {
    record("E03-both-pointers-stale-healed", "FAIL", e.message);
  }

  // 4 missing referenced ride
  const ride4 = "heal-new-4";
  await seedSearchingRide(ride4);
  await seedCandidate(ride4, driverA);
  await db.doc(`partners/${driverA}`).set({ activeRideId: "heal-missing-ride" }, { merge: true });
  try {
    await submitRideOffer(db, {
      rideId: ride4,
      driverUid: driverA,
      fare: 450,
      vehicleId: vehicleA,
      ownerId: "owner-heal",
      driverName: "Heal Driver",
      vehiclePlate: "HEAL-1",
    });
    const p = (await db.doc(`partners/${driverA}`).get()).data();
    record("E04-missing-ride-pointer-healed", !p.activeRideId ? "PASS" : "FAIL");
  } catch (e) {
    record("E04-missing-ride-pointer-healed", "FAIL", e.message);
  }

  // 5 terminal statuses
  for (const [idx, status] of ["cancelled", "cancelled_by_user", "expired", "searching_driver"].entries()) {
    const rid = `heal-term-${status}`;
    const offerRide = `heal-offer-term-${idx}`;
    await db.doc(`rides/${rid}`).set({
      userId: "cust-t",
      driverId: driverA,
      status,
      estimatedFare: 300,
    });
    await seedSearchingRide(offerRide);
    await seedCandidate(offerRide, driverA);
    await db.doc(`partners/${driverA}`).set({ activeRideId: rid }, { merge: true });
    let ok = false;
    try {
      await submitRideOffer(db, {
        rideId: offerRide,
        driverUid: driverA,
        fare: 440,
        vehicleId: vehicleA,
        ownerId: "owner-heal",
        driverName: "Heal Driver",
        vehiclePlate: "HEAL-1",
      });
      ok = !(await db.doc(`partners/${driverA}`).get()).data().activeRideId;
    } catch {
      ok = false;
    }
    record(`E05-terminal-${status}-heals`, ok ? "PASS" : "FAIL");
  }

  // 6 old ride previous vehicle — partner heals, current vehicle safe
  await seedDriverVehicle(driverA, vehicleA);
  await db.doc(`partners/${driverA}`).set({ activeRideId: staleRide }, { merge: true });
  await db.doc(`vehicles/${vehicleA}`).set({ activeRideId: null }, { merge: true });
  const ride6 = "heal-new-6";
  await seedSearchingRide(ride6);
  await seedCandidate(ride6, driverA);
  try {
    await submitRideOffer(db, {
      rideId: ride6,
      driverUid: driverA,
      fare: 430,
      vehicleId: vehicleA,
      ownerId: "owner-heal",
      driverName: "Heal Driver",
      vehiclePlate: "HEAL-1",
    });
    const p = (await db.doc(`partners/${driverA}`).get()).data();
    const v = (await db.doc(`vehicles/${vehicleA}`).get()).data();
    record(
      "E06-old-vehicle-partner-heals-current-safe",
      !p.activeRideId && !v.activeRideId ? "PASS" : "FAIL"
    );
  } catch (e) {
    record("E06-old-vehicle-partner-heals-current-safe", "FAIL", e.message);
  }

  // 7 wrong driver on referenced ride
  await db.doc(`rides/wrong-driver-ride`).set({
    userId: "cust-w",
    driverId: driverB,
    status: "completed",
  });
  const ride7 = "heal-new-7";
  await seedSearchingRide(ride7);
  await seedCandidate(ride7, driverA);
  await db.doc(`partners/${driverA}`).set({ activeRideId: "wrong-driver-ride" }, { merge: true });
  const otherBefore = (await db.doc(`partners/${driverB}`).get()).data();
  try {
    await submitRideOffer(db, {
      rideId: ride7,
      driverUid: driverA,
      fare: 420,
      vehicleId: vehicleA,
      ownerId: "owner-heal",
      driverName: "Heal Driver",
      vehiclePlate: "HEAL-1",
    });
    const p = (await db.doc(`partners/${driverA}`).get()).data();
    const rideUnchanged = (await db.doc(`rides/wrong-driver-ride`).get()).data().driverId === driverB;
    record(
      "E07-wrong-driver-pointer-clears-no-cross-mutation",
      !p.activeRideId && rideUnchanged ? "PASS" : "FAIL"
    );
  } catch (e) {
    record("E07-wrong-driver-pointer-clears-no-cross-mutation", "FAIL", e.message);
  }

  await withdrawOpenOffersForDriver(driverA);

  // 8-10 genuine active blocks
  for (const [label, status] of [
    ["E08-genuine-accepted-blocks", "accepted"],
    ["E09-genuine-arrived-blocks", "arrived"],
    ["E10-genuine-in-progress-blocks", "in_progress"],
  ]) {
    const activeId = `heal-active-${status}`;
    const offerId = `heal-block-${status}`;
    await db.doc(`rides/${activeId}`).set({
      userId: "cust-live",
      driverId: driverA,
      vehicleId: vehicleA,
      status,
      estimatedFare: 500,
    });
    await db.doc(`partners/${driverA}`).set({ activeRideId: activeId }, { merge: true });
    await seedSearchingRide(offerId);
    await seedCandidate(offerId, driverA);
    let blocked = false;
    try {
      await submitRideOffer(db, {
        rideId: offerId,
        driverUid: driverA,
        fare: 410,
        vehicleId: vehicleA,
        ownerId: "owner-heal",
        driverName: "Heal Driver",
        vehiclePlate: "HEAL-1",
      });
    } catch (e) {
      blocked = String(e.message).includes("DRIVER_HAS_ACTIVE_RIDE");
    }
    record(label, blocked ? "PASS" : "FAIL");
  }

  // 11 active query blocks without pointers
  for (const status of ["accepted", "arrived", "in_progress"]) {
    await db.doc(`rides/heal-active-${status}`).delete().catch(() => {});
  }
  const liveRide = "heal-live-no-pointer";
  await db.doc(`rides/${liveRide}`).set({
    userId: "cust-live2",
    driverId: driverA,
    vehicleId: vehicleA,
    status: "accepted",
    estimatedFare: 500,
  });
  await db.doc(`partners/${driverA}`).set({ activeRideId: admin.firestore.FieldValue.delete() }, { merge: true });
  await db.doc(`vehicles/${vehicleA}`).set({ activeRideId: admin.firestore.FieldValue.delete() }, { merge: true });
  const offer11 = "heal-offer-no-pointer";
  await seedSearchingRide(offer11);
  await seedCandidate(offer11, driverA);
  let blocked11 = false;
  try {
    await submitRideOffer(db, {
      rideId: offer11,
      driverUid: driverA,
      fare: 405,
      vehicleId: vehicleA,
      ownerId: "owner-heal",
      driverName: "Heal Driver",
      vehiclePlate: "HEAL-1",
    });
  } catch (e) {
    blocked11 = String(e.message).includes("DRIVER_HAS_ACTIVE_RIDE");
  }
  record("E11-unreferenced-active-query-blocks", blocked11 ? "PASS" : "FAIL");

  // 12 duplicate offer retry idempotent
  await withdrawOpenOffersForDriver(driverA);
  await db.doc(`partners/${driverA}`).set({ activeRideId: staleRide }, { merge: true });
  await db.doc(`rides/${liveRide}`).delete().catch(() => {});
  const ride12 = "heal-dup-offer";
  await seedSearchingRide(ride12);
  await seedCandidate(ride12, driverA);
  try {
    await submitRideOffer(db, {
      rideId: ride12,
      driverUid: driverA,
      fare: 400,
      vehicleId: vehicleA,
      ownerId: "owner-heal",
      driverName: "Heal Driver",
      vehiclePlate: "HEAL-1",
    });
    await submitRideOffer(db, {
      rideId: ride12,
      driverUid: driverA,
      fare: 395,
      vehicleId: vehicleA,
      ownerId: "owner-heal",
      driverName: "Heal Driver",
      vehiclePlate: "HEAL-1",
    });
    const offers = await db.collection("ride_offers").where("rideId", "==", ride12).get();
    record("E12-duplicate-offer-after-heal-idempotent", offers.size === 1 ? "PASS" : "FAIL");
  } catch (e) {
    record("E12-duplicate-offer-after-heal-idempotent", "FAIL", e.message);
  }

  // 13 concurrent assignment — one wins
  const raceRide = "heal-race-ride";
  await db.doc(`partners/${driverA}`).set({ activeRideId: admin.firestore.FieldValue.delete() }, { merge: true });
  await seedSearchingRide(raceRide);
  await seedCandidate(raceRide, driverA);
  await submitRideOffer(db, {
    rideId: raceRide,
    driverUid: driverA,
    fare: 500,
    vehicleId: vehicleA,
    ownerId: "owner-heal",
    driverName: "Heal Driver",
    vehiclePlate: "HEAL-1",
  });
  const offerId = `${raceRide}_${driverA}`;
  let success = 0;
  let fail = 0;
  await Promise.all([
    finalizeAssignmentFromOffer(db, { offerId, actorUid: driverA, actorRole: "driver" }).then(() => {
      success += 1;
    }).catch(() => {
      fail += 1;
    }),
    finalizeAssignmentFromOffer(db, { offerId, actorUid: driverA, actorRole: "driver" }).then(() => {
      success += 1;
    }).catch(() => {
      fail += 1;
    }),
  ]);
  const assigned = (await db.doc(`rides/${raceRide}`).get()).data();
  record(
    "E13-concurrent-finalize-one-outcome",
    assigned.status === "accepted" && success >= 1 ? "PASS" : "FAIL",
    `success=${success} fail=${fail}`
  );

  // 14-15 settlement idempotent partner+vehicle heal, no double earnings
  const settleRideId = "heal-settle-idem";
  const ledgerId = `settle_rides_${settleRideId}`;
  await db.doc(`partners/${driverA}`).set({
    activeRideId: settleRideId,
    totalEarnings: 1000,
    totalRidesCompleted: 2,
    walletBalance: -100,
  }, { merge: true });
  await db.doc(`rides/${settleRideId}`).set({
    userId: "cust-s",
    driverId: driverA,
    vehicleId: vehicleA,
    status: "completed",
    settlementId: ledgerId,
    farePkr: 500,
    estimatedFare: 500,
  });
  await db.doc(`ledger_transactions/${ledgerId}`).set({
    rideId: settleRideId,
    driverId: driverA,
    grossFare: 500,
    commissionAmount: 50,
    driverEarnings: 450,
    type: "ride_settlement",
    status: "posted",
  });
  await db.doc(`vehicles/${vehicleA}`).set({
    activeRideId: settleRideId,
    status: "in_ride",
  }, { merge: true });
  const partnerBefore = (await db.doc(`partners/${driverA}`).get()).data();
  await settleRide(db, { rideId: settleRideId, collectionName: "rides", callerUid: driverA });
  const partnerAfter = (await db.doc(`partners/${driverA}`).get()).data();
  const vehicleAfter = (await db.doc(`vehicles/${vehicleA}`).get()).data();
  record(
    "E14-settlement-idempotent-clears-partner-vehicle",
    !partnerAfter.activeRideId && !vehicleAfter.activeRideId ? "PASS" : "FAIL"
  );
  record(
    "E15-settlement-idempotent-no-double-earnings",
    partnerAfter.totalEarnings === partnerBefore.totalEarnings &&
      partnerAfter.totalRidesCompleted === partnerBefore.totalRidesCompleted
      ? "PASS"
      : "FAIL",
    `earn=${partnerAfter.totalEarnings} rides=${partnerAfter.totalRidesCompleted}`
  );

  // 16 PIN relink preserves genuine active
  const activePin = "heal-pin-active";
  await db.doc(`rides/${activePin}`).set({
    userId: "cust-pin",
    driverId: driverA,
    vehicleId: vehicleA,
    status: "in_progress",
    estimatedFare: 600,
  });
  await db.doc(`partners/${driverA}`).set({ activeRideId: activePin }, { merge: true });
  const pinCode = "1234";
  await db.doc(`vehicles/${vehicleA}`).set({
    pinHash: hashVehiclePin(pinCode),
    ownerId: "owner-heal",
    status: "online",
  }, { merge: true });
  let pinBlocked = false;
  try {
    await linkVehicleByPin(db, {
      driverUid: driverA,
      pin: pinCode,
      driverName: "Heal Driver",
    });
  } catch (e) {
    pinBlocked = String(e.message).includes("DRIVER_HAS_ACTIVE_RIDE");
  }
  const partnerPin = (await db.doc(`partners/${driverA}`).get()).data();
  record(
    "E16-pin-relink-blocks-genuine-active",
    pinBlocked && partnerPin.activeRideId === activePin ? "PASS" : "FAIL"
  );

  // Tear down genuine active rides so later heal-path tests are not blocked.
  await db.doc(`rides/${activePin}`).delete().catch(() => {});
  await db.doc(`rides/heal-race-ride`).delete().catch(() => {});
  await db.doc(`partners/${driverA}`).set(
    { activeRideId: admin.firestore.FieldValue.delete() },
    { merge: true }
  );
  await db.doc(`vehicles/${vehicleA}`).set(
    { activeRideId: admin.firestore.FieldValue.delete() },
    { merge: true }
  );
  await withdrawOpenOffersForDriver(driverA);

  // 17 no financial changes on heal path
  const finRide = "heal-fin-check";
  await db.doc(`partners/${driverA}`).set({
    activeRideId: staleRide,
    totalEarnings: 777,
    walletBalance: -50,
    totalRidesCompleted: 5,
  }, { merge: true });
  await seedSearchingRide(finRide);
  await seedCandidate(finRide, driverA);
  try {
    await submitRideOffer(db, {
      rideId: finRide,
      driverUid: driverA,
      fare: 500,
      vehicleId: vehicleA,
      ownerId: "owner-heal",
      driverName: "Heal Driver",
      vehiclePlate: "HEAL-1",
    });
    const finAfter = (await db.doc(`partners/${driverA}`).get()).data();
    record(
      "E17-heal-no-financial-mutation",
      finAfter.totalEarnings === 777 &&
        finAfter.walletBalance === -50 &&
        finAfter.totalRidesCompleted === 5
        ? "PASS"
        : "FAIL"
    );
  } catch (e) {
    record("E17-heal-no-financial-mutation", "FAIL", e.message);
  }

  // 18 other driver doc unchanged
  await db.doc(`partners/${driverB}`).set({ totalEarnings: 999, walletBalance: 0 });
  const ride18 = "heal-new-18";
  await db.doc(`partners/${driverA}`).set({ activeRideId: staleRide }, { merge: true });
  await seedSearchingRide(ride18);
  await seedCandidate(ride18, driverA);
  await submitRideOffer(db, {
    rideId: ride18,
    driverUid: driverA,
    fare: 500,
    vehicleId: vehicleA,
    ownerId: "owner-heal",
    driverName: "Heal Driver",
    vehiclePlate: "HEAL-1",
  });
  const bAfter = (await db.doc(`partners/${driverB}`).get()).data();
  record("E18-no-other-driver-mutation", bAfter.totalEarnings === 999 ? "PASS" : "FAIL");

  // 19 rematch after heal
  await db.doc(`partners/${driverA}`).set({ activeRideId: staleRide }, { merge: true });
  await db.doc(`vehicles/${vehicleA}`).set({
    driverId: driverA,
    status: "online",
    location: { lat: 24.86, lng: 67.01 },
    geoCell: "g_6900_2300",
  }, { merge: true });
  const rematchRide = "heal-rematch-target";
  await seedSearchingRide(rematchRide);
  const rematchResult = await rematchNearbySearchingRidesForVehicle(
    db,
    (await db.doc(`vehicles/${vehicleA}`).get()).data(),
    vehicleA
  );
  record(
    "E19-rematch-after-stale-heal",
    rematchResult.rematched >= 0 && !(await db.doc(`partners/${driverA}`).get()).data().activeRideId
      ? "PASS"
      : "FAIL",
    `rematched=${rematchResult.rematched}`
  );

  // 20 client restore validates genuine vs terminal
  const genuine = validateRideForDriverRestore({ status: "accepted", driverId: driverA }, driverA);
  const terminal = validateRideForDriverRestore({ status: "completed", driverId: driverA }, driverA);
  record(
    "E20-client-restore-genuine-vs-terminal",
    genuine.ok && !terminal.ok ? "PASS" : "FAIL"
  );
}

async function main() {
  console.log("\n=== Driver active-ride pointer heal suite ===\n");
  unitTests();
  await emulatorTests();
  const fail = results.filter((r) => r.status === "FAIL").length;
  const pass = results.filter((r) => r.status === "PASS").length;
  fs.writeFileSync(OUT, `${JSON.stringify({ pass, fail, total: results.length, results }, null, 2)}\n`);
  console.log(`\n${pass} PASS / ${fail} FAIL (${results.length} total)\n`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
