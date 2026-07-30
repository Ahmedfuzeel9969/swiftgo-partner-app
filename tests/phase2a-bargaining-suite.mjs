/**
 * Phase 2A bargaining / matching / booking-slot tests (Admin SDK).
 * Run via phase2a-run-all.mjs inside firestore emulator.
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
  results.push({ name, status, detail, rules: "bargaining" });
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
  validateCandidateDriverLimit,
  selectCandidatesProgressive,
} = require(path.join(ROOT, "functions", "matching.js"));
const {
  createCustomerBooking,
  evaluateCustomerBookingGate,
  matchRideCandidates,
  submitRideOffer,
  finalizeAssignmentFromOffer,
  counterRideOffer,
} = require(path.join(ROOT, "functions", "bargaining.js"));

function kmOffset(lat, lng, dKmNorth, dKmEast) {
  return {
    lat: lat + dKmNorth / 111,
    lng: lng + dKmEast / (111 * Math.cos((lat * Math.PI) / 180)),
  };
}

const pickup = { lat: 24.86, lng: 67.01 };

async function seedPartner(id, extra = {}) {
  await db.doc(`partners/${id}`).set({
    role: "driver",
    accountStatus: "active",
    walletBalance: 0,
    totalEarnings: 0,
    ...extra,
  });
}

async function main() {
  // Candidate limit validation
  try {
    validateCandidateDriverLimit(10);
    validateCandidateDriverLimit(20);
    let rejected = false;
    try {
      validateCandidateDriverLimit(15);
    } catch {
      rejected = true;
    }
    record(
      "B01-candidate-limit-10-20-only",
      rejected ? "PASS" : "FAIL",
      "10/20 ok; 15 rejected"
    );
  } catch (e) {
    record("B01-candidate-limit-10-20-only", "FAIL", String(e.message));
  }

  // Progressive rings + limit 10
  const drivers = [];
  for (let i = 0; i < 25; i++) {
    const ring = i < 5 ? 0.5 : i < 12 ? 1.5 : 2.5;
    const pos = kmOffset(pickup.lat, pickup.lng, ring, 0.05 * i);
    drivers.push({
      driverId: `d${i}`,
      lat: pos.lat,
      lng: pos.lng,
      status: "online",
    });
  }
  const sel10 = selectCandidatesProgressive(pickup, drivers, 10);
  const sel20 = selectCandidatesProgressive(pickup, drivers, 20);
  record(
    "B02-candidate-limit-10-works",
    sel10.length === 10 ? "PASS" : "FAIL",
    `n=${sel10.length}`
  );
  record(
    "B03-candidate-limit-20-works",
    sel20.length === 20 ? "PASS" : "FAIL",
    `n=${sel20.length}`
  );
  record(
    "B04-progressive-rings-1-2-3",
    sel10.every((c) => [1, 2, 3].includes(c.ringKm)) && sel10[0].ringKm === 1
      ? "PASS"
      : "FAIL",
    JSON.stringify(sel10.slice(0, 3).map((c) => c.ringKm))
  );

  await db.doc("settings/dispatch").set({ candidateDriverLimit: 10 });

  // Match writes candidates
  await seedPartner("match-d0");
  await seedPartner("match-d1");
  await db.doc("rides/match-ride").set({
    userId: "cust-match",
    status: "searching_driver",
    pickupLocation: { ...pickup, address: "P" },
    dropoffLocation: { lat: 24.9, lng: 67.05, address: "D" },
    vehicleType: "go",
    distanceKm: 3,
    timeMins: 10,
    farePkr: 200,
    createdAt: admin.firestore.Timestamp.now(),
  });
  const matched = await matchRideCandidates(db, {
    rideId: "match-ride",
    pickup,
    onlineDrivers: [
      { driverId: "match-d0", lat: pickup.lat + 0.002, lng: pickup.lng, status: "online" },
      { driverId: "match-d1", lat: pickup.lat + 0.01, lng: pickup.lng, status: "online" },
    ],
    candidateDriverLimit: 10,
  });
  const candSnap = await db.collection("ride_candidates").where("rideId", "==", "match-ride").get();
  record(
    "B05-match-writes-candidates",
    matched.candidates.length === candSnap.size && candSnap.size >= 1 ? "PASS" : "FAIL",
    `candidates=${candSnap.size}`
  );

  // Invalid limit rejected by matching
  try {
    await matchRideCandidates(db, {
      rideId: "match-ride",
      pickup,
      onlineDrivers: [],
      candidateDriverLimit: 7,
    });
    record("B06-invalid-candidate-limit-rejected", "FAIL", "accepted 7");
  } catch (e) {
    record(
      "B06-invalid-candidate-limit-rejected",
      e.message === "INVALID_CANDIDATE_LIMIT" ? "PASS" : "FAIL",
      e.message
    );
  }

  // Customer booking gate + race-safe create
  await db.doc("booking_slots/cust-book").set({ count: 0 });
  const gate0 = await evaluateCustomerBookingGate(db, "cust-book", {});
  record("B07-first-booking-allowed", gate0.allowed ? "PASS" : "FAIL", JSON.stringify(gate0));

  const b1 = await createCustomerBooking(db, {
    customerUid: "cust-book",
    confirmedExtraBooking: false,
    ridePayload: {
      pickupLocation: { ...pickup, address: "P" },
      dropoffLocation: { lat: 24.9, lng: 67.05, address: "D" },
      vehicleType: "go",
      distanceKm: 2,
      timeMins: 8,
      farePkr: 150,
      estimatedFare: 150,
    },
  });
  const gate1 = await evaluateCustomerBookingGate(db, "cust-book", { confirmedExtraBooking: false });
  record(
    "B08-second-needs-confirmation",
    !gate1.allowed && gate1.needsConfirmation ? "PASS" : "FAIL",
    JSON.stringify(gate1)
  );

  let cancelledCreate = false;
  try {
    await createCustomerBooking(db, {
      customerUid: "cust-book",
      confirmedExtraBooking: false,
      ridePayload: {
        pickupLocation: { ...pickup, address: "P" },
        dropoffLocation: { lat: 24.9, lng: 67.05, address: "D" },
        vehicleType: "go",
        distanceKm: 2,
        timeMins: 8,
        farePkr: 150,
        estimatedFare: 150,
      },
    });
  } catch (e) {
    cancelledCreate = e.message === "CONFIRM_EXTRA_BOOKING";
  }
  record("B09-cancel-confirm-no-create", cancelledCreate ? "PASS" : "FAIL", "CONFIRM_EXTRA_BOOKING");

  for (let i = 0; i < 3; i++) {
    await createCustomerBooking(db, {
      customerUid: "cust-book",
      confirmedExtraBooking: true,
      ridePayload: {
        pickupLocation: { ...pickup, address: "P" },
        dropoffLocation: { lat: 24.9, lng: 67.05, address: "D" },
        vehicleType: "go",
        distanceKm: 2,
        timeMins: 8,
        farePkr: 150 + i,
        estimatedFare: 150 + i,
      },
    });
  }
  const slot = (await db.doc("booking_slots/cust-book").get()).data();
  record("B10-four-bookings-ok", slot?.count === 4 ? "PASS" : "FAIL", `count=${slot?.count}`);

  let fifthDenied = false;
  try {
    await createCustomerBooking(db, {
      customerUid: "cust-book",
      confirmedExtraBooking: true,
      ridePayload: {
        pickupLocation: { ...pickup, address: "P" },
        dropoffLocation: { lat: 24.9, lng: 67.05, address: "D" },
        vehicleType: "go",
        distanceKm: 2,
        timeMins: 8,
        farePkr: 160,
        estimatedFare: 160,
      },
    });
  } catch (e) {
    fifthDenied = e.message === "MAX_ACTIVE_BOOKINGS";
  }
  record("B11-fifth-booking-rejected", fifthDenied ? "PASS" : "FAIL", "MAX_ACTIVE_BOOKINGS");

  // Race: two concurrent creates when customer already has 3 live non-terminal rides.
  // Slot counter alone must not invent a block; live rides are authority after reconcile.
  // Expect exactly one create to reach 4, the other to hit MAX_ACTIVE_BOOKINGS.
  const racePayload = {
    pickupLocation: { ...pickup, address: "P" },
    dropoffLocation: { lat: 24.9, lng: 67.05, address: "D" },
    vehicleType: "go",
    distanceKm: 1,
    timeMins: 5,
    farePkr: 100,
    estimatedFare: 100,
  };
  for (let i = 0; i < 3; i += 1) {
    await createCustomerBooking(db, {
      customerUid: "cust-race",
      confirmedExtraBooking: true,
      ridePayload: racePayload,
    });
  }
  const raceResults = await Promise.allSettled([
    createCustomerBooking(db, {
      customerUid: "cust-race",
      confirmedExtraBooking: true,
      ridePayload: racePayload,
    }),
    createCustomerBooking(db, {
      customerUid: "cust-race",
      confirmedExtraBooking: true,
      ridePayload: racePayload,
    }),
  ]);
  const raceOk = raceResults.filter((r) => r.status === "fulfilled").length;
  const raceFail = raceResults.filter((r) => r.status === "rejected").length;
  const raceSlot = (await db.doc("booking_slots/cust-race").get()).data();
  const raceActive = await db
    .collection("rides")
    .where("userId", "==", "cust-race")
    .where("status", "in", ["searching_driver", "accepted", "arrived", "in_progress"])
    .get();
  record(
    "B12-four-booking-race-safe",
    raceOk === 1 && raceFail === 1 && raceSlot?.count === 4 && raceActive.size === 4
      ? "PASS"
      : "FAIL",
    `ok=${raceOk} fail=${raceFail} count=${raceSlot?.count} live=${raceActive.size}`
  );

  // Terminal bookings excluded: reset via completed not counting — use fresh user
  await db.doc("booking_slots/cust-term").set({ count: 0 });
  await createCustomerBooking(db, {
    customerUid: "cust-term",
    ridePayload: racePayload,
  });
  // Simulate cancel releasing slot
  const { cancelCustomerBooking } = require(path.join(ROOT, "functions", "bargaining.js"));
  const openRides = await db
    .collection("rides")
    .where("userId", "==", "cust-term")
    .where("status", "==", "searching_driver")
    .get();
  const firstOpen = openRides.docs[0];
  if (firstOpen) {
    await cancelCustomerBooking(db, { customerUid: "cust-term", rideId: firstOpen.id });
  }
  const afterCancel = (await db.doc("booking_slots/cust-term").get()).data();
  const gateAfter = await evaluateCustomerBookingGate(db, "cust-term", {});
  record(
    "B13-cancelled-excluded-from-limit",
    afterCancel?.count === 0 && gateAfter.allowed ? "PASS" : "FAIL",
    `count=${afterCancel?.count}`
  );

  // Bargaining: multi-offer, privacy, limits, atomic assign
  await seedPartner("barg-d1");
  await seedPartner("barg-d2");
  await db.doc("rides/barg-ride").set({
    userId: "cust-barg",
    status: "searching_driver",
    pickupLocation: { ...pickup, address: "P" },
    dropoffLocation: { lat: 24.9, lng: 67.05, address: "D" },
    vehicleType: "go",
    distanceKm: 3,
    timeMins: 10,
    farePkr: 250,
    createdAt: admin.firestore.Timestamp.now(),
  });
  await matchRideCandidates(db, {
    rideId: "barg-ride",
    pickup,
    onlineDrivers: [
      { driverId: "barg-d1", lat: pickup.lat + 0.001, lng: pickup.lng, status: "online" },
      { driverId: "barg-d2", lat: pickup.lat + 0.002, lng: pickup.lng, status: "online" },
    ],
    candidateDriverLimit: 10,
  });

  const o1 = await submitRideOffer(db, {
    rideId: "barg-ride",
    driverUid: "barg-d1",
    fare: 280,
    vehicleId: "v1",
    ownerId: "own1",
    driverName: "D1",
    vehiclePlate: "AAA",
  });
  const o2 = await submitRideOffer(db, {
    rideId: "barg-ride",
    driverUid: "barg-d2",
    fare: 270,
    vehicleId: "v2",
    ownerId: "own1",
    driverName: "D2",
    vehiclePlate: "BBB",
  });
  const rideAfterOffers = (await db.doc("rides/barg-ride").get()).data();
  record(
    "B14-bargaining-not-assigned",
    rideAfterOffers?.status === "searching_driver" && !rideAfterOffers?.driverId
      ? "PASS"
      : "FAIL",
    `status=${rideAfterOffers?.status}`
  );
  record(
    "B15-multi-driver-offers",
    o1.offerId && o2.offerId && o1.offerId !== o2.offerId ? "PASS" : "FAIL",
    `${o1.offerId},${o2.offerId}`
  );

  // Expired offer cannot finalize
  await db.doc(`ride_offers/${o2.offerId}`).update({ status: "expired" });
  let expiredBlocked = false;
  try {
    await finalizeAssignmentFromOffer(db, {
      offerId: o2.offerId,
      actorUid: "cust-barg",
      actorRole: "customer",
    });
  } catch (e) {
    expiredBlocked = e.message === "OFFER_CLOSED";
  }
  record("B16-expired-offer-not-accepted", expiredBlocked ? "PASS" : "FAIL", "OFFER_CLOSED");

  // Simultaneous finalize → one winner
  await db.doc("rides/race-ride").set({
    userId: "cust-race2",
    status: "searching_driver",
    pickupLocation: { ...pickup, address: "P" },
    dropoffLocation: { lat: 24.9, lng: 67.05, address: "D" },
    vehicleType: "go",
    distanceKm: 3,
    timeMins: 10,
    farePkr: 250,
    createdAt: admin.firestore.Timestamp.now(),
  });
  await seedPartner("race-d1");
  await seedPartner("race-d2");
  await matchRideCandidates(db, {
    rideId: "race-ride",
    pickup,
    onlineDrivers: [
      { driverId: "race-d1", lat: pickup.lat + 0.001, lng: pickup.lng, status: "online" },
      { driverId: "race-d2", lat: pickup.lat + 0.002, lng: pickup.lng, status: "online" },
    ],
  });
  await submitRideOffer(db, {
    rideId: "race-ride",
    driverUid: "race-d1",
    fare: 300,
    vehicleId: "rv1",
    ownerId: "o",
    driverName: "R1",
    vehiclePlate: "R1",
  });
  await submitRideOffer(db, {
    rideId: "race-ride",
    driverUid: "race-d2",
    fare: 290,
    vehicleId: "rv2",
    ownerId: "o",
    driverName: "R2",
    vehiclePlate: "R2",
  });
  const [f1, f2] = await Promise.allSettled([
    finalizeAssignmentFromOffer(db, {
      offerId: "race-ride_race-d1",
      actorUid: "cust-race2",
      actorRole: "customer",
    }),
    finalizeAssignmentFromOffer(db, {
      offerId: "race-ride_race-d2",
      actorUid: "cust-race2",
      actorRole: "customer",
    }),
  ]);
  const raceRide = (await db.doc("rides/race-ride").get()).data();
  const winners = [f1, f2].filter((r) => r.status === "fulfilled" && !r.value?.alreadyAssigned);
  const assignedOk =
    raceRide?.status === "accepted" &&
    Boolean(raceRide?.driverId) &&
    winners.length === 1 &&
    [f1, f2].filter((r) => r.status === "fulfilled").length >= 1;
  record(
    "B17-simultaneous-assign-one-winner",
    assignedOk ? "PASS" : "FAIL",
    `driver=${raceRide?.driverId} fulfilled=${[f1, f2].map((r) => r.status).join(",")}`
  );

  // Driver with active ride cannot accept another
  let secondBlocked = false;
  await db.doc("rides/second-ride").set({
    userId: "cust-barg",
    status: "searching_driver",
    pickupLocation: { ...pickup, address: "P" },
    dropoffLocation: { lat: 24.9, lng: 67.05, address: "D" },
    vehicleType: "go",
    distanceKm: 2,
    timeMins: 8,
    farePkr: 180,
    createdAt: admin.firestore.Timestamp.now(),
  });
  await matchRideCandidates(db, {
    rideId: "second-ride",
    pickup,
    onlineDrivers: [
      { driverId: raceRide.driverId, lat: pickup.lat + 0.001, lng: pickup.lng, status: "online" },
    ],
  });
  try {
    await submitRideOffer(db, {
      rideId: "second-ride",
      driverUid: raceRide.driverId,
      fare: 200,
      vehicleId: "x",
      ownerId: "o",
      driverName: "X",
      vehiclePlate: "X",
    });
  } catch (e) {
    secondBlocked = e.message === "DRIVER_HAS_ACTIVE_RIDE";
  }
  record(
    "B18-active-driver-cannot-bargain-another",
    secondBlocked ? "PASS" : "FAIL",
    `driver=${raceRide.driverId}`
  );

  // Sibling offers closed after assign
  const siblingOffers = await db.collection("ride_offers").where("rideId", "==", "race-ride").get();
  const openLeft = siblingOffers.docs.filter((d) =>
    ["open", "countered"].includes(d.data()?.status)
  );
  record(
    "B19-sibling-offers-closed",
    openLeft.length === 0 ? "PASS" : "FAIL",
    `openLeft=${openLeft.length}`
  );

  // Max 10 open bargains
  await seedPartner("limit-d");
  const limitOffers = [];
  for (let i = 0; i < 10; i++) {
    const rid = `lim-ride-${i}`;
    await db.doc(`rides/${rid}`).set({
      userId: "cust-lim",
      status: "searching_driver",
      pickupLocation: { ...pickup, address: "P" },
      dropoffLocation: { lat: 24.9, lng: 67.05, address: "D" },
      vehicleType: "go",
      distanceKm: 1,
      timeMins: 5,
      farePkr: 100,
      createdAt: admin.firestore.Timestamp.now(),
    });
    await db.doc(`ride_candidates/${rid}_limit-d`).set({
      rideId: rid,
      driverId: "limit-d",
      status: "invited",
      distanceKm: 0.5,
      ringKm: 1,
    });
    await submitRideOffer(db, {
      rideId: rid,
      driverUid: "limit-d",
      fare: 110,
      vehicleId: "lv",
      ownerId: "o",
      driverName: "L",
      vehiclePlate: "L",
    });
    limitOffers.push(rid);
  }
  await db.doc("rides/lim-ride-11").set({
    userId: "cust-lim",
    status: "searching_driver",
    pickupLocation: { ...pickup, address: "P" },
    dropoffLocation: { lat: 24.9, lng: 67.05, address: "D" },
    vehicleType: "go",
    distanceKm: 1,
    timeMins: 5,
    farePkr: 100,
    createdAt: admin.firestore.Timestamp.now(),
  });
  await db.doc("ride_candidates/lim-ride-11_limit-d").set({
    rideId: "lim-ride-11",
    driverId: "limit-d",
    status: "invited",
    distanceKm: 0.5,
    ringKm: 1,
  });
  let eleventhBlocked = false;
  try {
    await submitRideOffer(db, {
      rideId: "lim-ride-11",
      driverUid: "limit-d",
      fare: 120,
      vehicleId: "lv",
      ownerId: "o",
      driverName: "L",
      vehiclePlate: "L",
    });
  } catch (e) {
    eleventhBlocked = e.message === "MAX_OPEN_BARGAINS";
  }
  record("B20-eleventh-bargain-rejected", eleventhBlocked ? "PASS" : "FAIL", "MAX_OPEN_BARGAINS");

  // Counter then accept
  await counterRideOffer(db, {
    offerId: o1.offerId,
    customerUid: "cust-barg",
    fare: 260,
  });
  const countered = (await db.doc(`ride_offers/${o1.offerId}`).get()).data();
  record(
    "B21-customer-counter-offer",
    countered?.status === "countered" && countered?.customerCounterFare === 260 ? "PASS" : "FAIL",
    JSON.stringify({ status: countered?.status, fare: countered?.customerCounterFare })
  );

  const passed = results.filter((r) => r.status === "PASS").length;
  const failed = results.filter((r) => r.status === "FAIL").length;
  const blocked = results.filter((r) => r.status === "BLOCKED").length;
  const out = {
    generatedAt: new Date().toISOString(),
    results,
    passed,
    failed,
    blocked,
    total: results.length,
  };
  fs.writeFileSync(
    path.join(ROOT, "tests", "phase2a-bargaining-results.json"),
    JSON.stringify(out, null, 2)
  );
  console.log(`[phase2a-bargaining] passed=${passed} failed=${failed} blocked=${blocked}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
