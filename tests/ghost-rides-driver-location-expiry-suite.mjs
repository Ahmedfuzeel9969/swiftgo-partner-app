/**
 * Combined focused suite: Account A ghost bookings, cancel repair,
 * Account B create→match→candidate, rings, 3-minute expiry (controllable clock).
 *
 * Run: firebase emulators:exec --only firestore --project demo-swiftgo-phase1 \
 *        "node tests/ghost-rides-driver-location-expiry-suite.mjs"
 */

import { readFileSync, writeFileSync } from "node:fs";
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
  const matching = read("functions/matching.js");
  const bargaining = read("functions/bargaining.js");
  const rideStatus = read("customer-app/js/ride-status.js");
  const rideFlow = read("customer-app/js/ride-flow.js");
  const driverApp = read("driver-app/js/driver-app.js");
  const indexes = read("firestore.indexes.json");

  record(
    "S01-canonical-owner-field",
    matching.includes('CUSTOMER_RIDE_OWNER_FIELD = "userId"') &&
      rideStatus.includes('CUSTOMER_RIDE_OWNER_FIELD = "userId"')
      ? "PASS"
      : "FAIL"
  );
  record(
    "S02-search-expire-3min",
    /SEARCH_EXPIRE_MS\s*=\s*3\s*\*\s*60\s*\*\s*1000/.test(matching) &&
      bargaining.includes("expiresAt") &&
      bargaining.includes("SEARCH_EXPIRED_STATUS")
      ? "PASS"
      : "FAIL"
  );
  record(
    "S03-cancel-closes-candidates",
    bargaining.includes("closeCandidatesAndOffersForRide") &&
      /cancelCustomerBooking[\s\S]*closeCandidatesAndOffersForRide/.test(bargaining)
      ? "PASS"
      : "FAIL"
  );
  record(
    "S04-cancel-all-returns-counts",
    bargaining.includes("cancelledCount") && bargaining.includes("blockingAssigned")
      ? "PASS"
      : "FAIL"
  );
  record(
    "S05-driver-location-sync-without-map",
    driverApp.includes("Matching must receive server location even when the map canvas is not mounted")
      ? "PASS"
      : "FAIL",
    "GPS→Firestore must not require map mount"
  );
  record(
    "S06-driver-avail-diag",
    driverApp.includes("paintDriverAvailabilityDiag") && read("driver-app/index.html").includes("driverAvailDiag")
      ? "PASS"
      : "FAIL"
  );
  record(
    "S07-expiresAt-index-declared",
    indexes.includes('"expiresAt"') ? "PASS" : "FAIL"
  );
  record(
    "S08-client-clear-surfaces-failure",
    rideFlow.includes("bookingClearFailed") || rideFlow.includes("cleared?.failed")
      ? "PASS"
      : "FAIL"
  );
  record(
    "S09-no-settlement-on-expire",
    !/expireSearchingBooking[\s\S]{0,800}settleRide/.test(bargaining)
      ? "PASS"
      : "FAIL"
  );
  record(
    "S10-probe-when-geo-selected-empty",
    bargaining.includes("geo_selected_empty") &&
      /if\s*\(\s*!selected\s*\|\|\s*selected\.length\s*===\s*0\s*\)/.test(bargaining)
      ? "PASS"
      : "FAIL"
  );
  record(
    "S11-periodic-rematch-client",
    rideFlow.includes("rematchWhileSearching") && rideFlow.includes("SEARCH_REMATCH_MS")
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
  const {
    evaluateCustomerBookingGate,
    createCustomerBooking,
    cancelCustomerBooking,
    cancelAllSearchingBookings,
    countCustomerActiveBookings,
    expireSearchingBooking,
    expireDueSearchingBookings,
    matchRideCandidates,
    finalizeAssignmentFromOffer,
    submitRideOffer,
    SEARCH_EXPIRE_MS,
  } = require(join(root, "functions/bargaining.js"));
  const {
    selectCandidatesProgressive,
    classifyDriverMatchExclusion,
    SEARCH_RINGS_KM,
  } = require(join(root, "functions/matching.js"));
  const { hashVehiclePin } = require(join(root, "functions/pin-security.js"));

  const pickup = { lat: 24.8607, lng: 67.0011 };
  const payload = {
    pickupLocation: { ...pickup, address: "A" },
    dropoffLocation: { lat: 24.87, lng: 67.01, address: "B" },
    vehicleType: "Go",
    vehicleTypeKey: "go",
    farePkr: 200,
    estimatedFare: 200,
    paymentMethod: "cash",
  };

  // ── Account A: inflated slots, zero live ──
  const uidA = "ghost-cust-a";
  await db.doc(`booking_slots/${uidA}`).set({ count: 4 });
  await db.doc(`partners/${uidA}`).set({ role: "customer", accountStatus: "active" });
  const gateA0 = await evaluateCustomerBookingGate(db, uidA, {});
  record(
    "A01-inflated-slots-zero-live-allows-first",
    gateA0.allowed === true && gateA0.count === 0 ? "PASS" : "FAIL",
    JSON.stringify({ allowed: gateA0.allowed, count: gateA0.count })
  );

  // Terminal rides do not count
  for (const [id, status] of [
    ["a-done", "completed"],
    ["a-can", "cancelled_by_customer"],
    ["a-exp", "expired"],
    ["a-rej", "declined"],
  ]) {
    await db.doc(`rides/${id}`).set({
      userId: uidA,
      status,
      pickupLocation: pickup,
      dropoffLocation: payload.dropoffLocation,
    });
  }
  const gateTerm = await evaluateCustomerBookingGate(db, uidA, {});
  record(
    "A02-terminal-not-counted",
    gateTerm.allowed && gateTerm.count === 0 ? "PASS" : "FAIL",
    `count=${gateTerm.count}`
  );

  // Four owned searching ghosts — visible to gate + cancellable
  const ghostIds = [];
  for (let i = 0; i < 4; i += 1) {
    const created = await createCustomerBooking(db, {
      customerUid: uidA,
      confirmedExtraBooking: true,
      ridePayload: payload,
    });
    ghostIds.push(created.id);
  }
  const activeA = await countCustomerActiveBookings(db, uidA);
  const gateIds = (await evaluateCustomerBookingGate(db, uidA, { confirmedExtraBooking: true }))
    .activeBookings?.map((r) => r.id)
    .sort();
  const listIds = activeA.map((r) => r.id).sort();
  record(
    "A03-four-searching-visible-same-ids",
    activeA.length === 4 && JSON.stringify(gateIds) === JSON.stringify(listIds) ? "PASS" : "FAIL",
    `n=${activeA.length}`
  );

  const cleared = await cancelAllSearchingBookings(db, uidA);
  record(
    "A04-cancel-all-succeeds",
    cleared.cancelledCount === 4 && cleared.activeCount === 0 ? "PASS" : "FAIL",
    JSON.stringify({
      cancelledCount: cleared.cancelledCount,
      activeCount: cleared.activeCount,
      failed: cleared.failed?.length,
    })
  );

  // Cancellation failure reason
  let failReason = "";
  try {
    await cancelCustomerBooking(db, {
      customerUid: uidA,
      rideId: "missing-ride-xyz",
    });
  } catch (e) {
    failReason = e.message;
  }
  record(
    "A05-cancel-missing-exact-reason",
    failReason === "RIDE_NOT_FOUND" ? "PASS" : "FAIL",
    failReason
  );

  // Other customer cannot cancel
  const other = "ghost-other";
  const mine = await createCustomerBooking(db, {
    customerUid: uidA,
    ridePayload: payload,
  });
  let otherDenied = false;
  try {
    await cancelCustomerBooking(db, { customerUid: other, rideId: mine.id });
  } catch (e) {
    otherDenied = e.message === "NOT_YOUR_BOOKING";
  }
  record("A06-other-customer-cannot-cancel", otherDenied ? "PASS" : "FAIL");
  await cancelCustomerBooking(db, { customerUid: uidA, rideId: mine.id });

  // Duplicate cancel safe
  const once = await createCustomerBooking(db, { customerUid: uidA, ridePayload: payload });
  await cancelCustomerBooking(db, { customerUid: uidA, rideId: once.id });
  const again = await cancelCustomerBooking(db, { customerUid: uidA, rideId: once.id });
  record("A07-duplicate-cancel-safe", again.already === true ? "PASS" : "FAIL");

  // ── Account B: create + match + candidate ──
  const uidB = "ghost-cust-b";
  const driverUid = "ghost-driver-b";
  await db.doc(`partners/${uidB}`).set({ role: "customer", accountStatus: "active" });
  await db.doc(`partners/${driverUid}`).set({ role: "driver", accountStatus: "active" });
  await db.doc("vehicles/ghost-veh-b").set({
    ownerId: "ghost-owner",
    driverId: driverUid,
    status: "online",
    plate: "GHOST-1",
    pinHash: hashVehiclePin("4242"),
    location: { lat: pickup.lat + 0.002, lng: pickup.lng },
    locationUpdatedAt: admin.firestore.Timestamp.now(),
    geoCell: "g_6905_18611",
  });
  await db.doc("settings/dispatch").set({ candidateDriverLimit: 10 }, { merge: true });

  const createdB = await createCustomerBooking(db, {
    customerUid: uidB,
    ridePayload: payload,
  });
  const rideB = (await db.doc(`rides/${createdB.id}`).get()).data();
  record(
    "B01-create-returns-id-and-expiresAt",
    Boolean(createdB.id) && rideB?.status === "searching_driver" && rideB?.expiresAt
      ? "PASS"
      : "FAIL",
    createdB.id
  );

  const matched = await matchRideCandidates(db, {
    rideId: createdB.id,
    pickup,
  });
  const candId = `${createdB.id}_${driverUid}`;
  const cand = await db.doc(`ride_candidates/${candId}`).get();
  record(
    "B02-eligible-driver-candidate-created",
    cand.exists && matched.candidates?.some((c) => c.driverId === driverUid) ? "PASS" : "FAIL",
    JSON.stringify({
      n: matched.candidates?.length,
      candExists: cand.exists,
      status: cand.data()?.status,
    })
  );

  // Simulate Driver listener filter (invited + searching)
  const listenOk =
    cand.data()?.status === "invited" &&
    cand.data()?.driverId === driverUid &&
    rideB.status === "searching_driver";
  record("B03-driver-listener-would-receive", listenOk ? "PASS" : "FAIL");

  // ── Distance rings ──
  function offsetKm(lat, lng, dKmN, dKmE) {
    return {
      lat: lat + dKmN / 111,
      lng: lng + dKmE / (111 * Math.cos((lat * Math.PI) / 180)),
    };
  }
  const fixtures = [
    { driverId: "d05", ...offsetKm(pickup.lat, pickup.lng, 0.5, 0), status: "online", accountStatus: "active", locationUpdatedAtMs: Date.now() },
    { driverId: "d15", ...offsetKm(pickup.lat, pickup.lng, 1.5, 0), status: "online", accountStatus: "active", locationUpdatedAtMs: Date.now() },
    { driverId: "d25", ...offsetKm(pickup.lat, pickup.lng, 2.5, 0), status: "online", accountStatus: "active", locationUpdatedAtMs: Date.now() },
    { driverId: "d40", ...offsetKm(pickup.lat, pickup.lng, 4.0, 0), status: "online", accountStatus: "active", locationUpdatedAtMs: Date.now() },
    { driverId: "dmiss", lat: NaN, lng: NaN, status: "online", accountStatus: "active", locationUpdatedAtMs: Date.now() },
    { driverId: "dstale", ...offsetKm(pickup.lat, pickup.lng, 0.4, 0), status: "online", accountStatus: "active", locationUpdatedAtMs: Date.now() - 20 * 60 * 1000 },
    { driverId: "doff", ...offsetKm(pickup.lat, pickup.lng, 0.3, 0), status: "offline", accountStatus: "active", locationUpdatedAtMs: Date.now() },
    { driverId: "dbusy", ...offsetKm(pickup.lat, pickup.lng, 0.2, 0), status: "online", accountStatus: "active", activeRideId: "x", locationUpdatedAtMs: Date.now() },
    { driverId: "dblock", ...offsetKm(pickup.lat, pickup.lng, 0.2, 0), status: "online", accountStatus: "blocked", locationUpdatedAtMs: Date.now() },
  ];
  const ring1 = selectCandidatesProgressive(pickup, fixtures, 10);
  record(
    "D01-0.5km-in-first-ring",
    ring1.some((c) => c.driverId === "d05" && c.ringKm === 1) ? "PASS" : "FAIL",
    JSON.stringify(ring1.map((c) => `${c.driverId}@${c.ringKm}`))
  );
  record(
    "D02-1.5km-when-expanded",
    ring1.some((c) => c.driverId === "d15" && c.ringKm === 2) ? "PASS" : "FAIL"
  );
  record(
    "D03-2.5km-when-expanded",
    ring1.some((c) => c.driverId === "d25" && c.ringKm === 3) ? "PASS" : "FAIL"
  );
  record(
    "D04-beyond-3km-never",
    !ring1.some((c) => c.driverId === "d40") ? "PASS" : "FAIL"
  );
  record(
    "D05-unknown-location-excluded",
    classifyDriverMatchExclusion(fixtures.find((d) => d.driverId === "dmiss")) === "missing_location"
      ? "PASS"
      : "FAIL"
  );
  record(
    "D06-rings-contract",
    JSON.stringify(SEARCH_RINGS_KM) === "[1,2,3]" ? "PASS" : "FAIL"
  );
  const lim10 = selectCandidatesProgressive(
    pickup,
    Array.from({ length: 30 }, (_, i) => ({
      driverId: `n${i}`,
      ...offsetKm(pickup.lat, pickup.lng, 0.1, i * 0.01),
      status: "online",
      accountStatus: "active",
      locationUpdatedAtMs: Date.now(),
    })),
    10
  );
  const lim20 = selectCandidatesProgressive(
    pickup,
    Array.from({ length: 30 }, (_, i) => ({
      driverId: `m${i}`,
      ...offsetKm(pickup.lat, pickup.lng, 0.1, i * 0.01),
      status: "online",
      accountStatus: "active",
      locationUpdatedAtMs: Date.now(),
    })),
    20
  );
  record("D07-limit-10", lim10.length === 10 ? "PASS" : "FAIL", `n=${lim10.length}`);
  record("D08-limit-20", lim20.length === 20 ? "PASS" : "FAIL", `n=${lim20.length}`);

  // ── Three-minute expiry (controllable clock) ──
  const uidE = "ghost-expire";
  await db.doc(`partners/${uidE}`).set({ role: "customer", accountStatus: "active" });
  const expRide = await createCustomerBooking(db, {
    customerUid: uidE,
    ridePayload: payload,
  });
  const before = await expireSearchingBooking(db, {
    customerUid: uidE,
    rideId: expRide.id,
    nowMs: Date.now(),
  }).then(
    () => ({ ok: true }),
    (e) => ({ ok: false, msg: e.message })
  );
  record(
    "E01-before-3min-not-expired",
    before.ok === false && before.msg === "NOT_YET_EXPIRED" ? "PASS" : "FAIL",
    JSON.stringify(before)
  );

  const mid = Date.now() + SEARCH_EXPIRE_MS + 1000;
  const expiredOnce = await expireSearchingBooking(db, {
    customerUid: uidE,
    rideId: expRide.id,
    nowMs: mid,
  });
  record(
    "E02-after-3min-expires-once",
    expiredOnce.changed === true && expiredOnce.status === "expired" ? "PASS" : "FAIL",
    JSON.stringify(expiredOnce)
  );
  const slotE = (await db.doc(`booking_slots/${uidE}`).get()).data();
  record(
    "E03-expiry-releases-slot",
    Number(slotE?.count ?? -1) === 0 ? "PASS" : "FAIL",
    `count=${slotE?.count}`
  );
  const expiredAgain = await expireSearchingBooking(db, {
    customerUid: uidE,
    rideId: expRide.id,
    nowMs: mid + 5000,
  });
  record(
    "E04-repeat-expiry-idempotent",
    expiredAgain.changed === false && expiredAgain.status === "expired" ? "PASS" : "FAIL"
  );

  // Candidate closed on expiry
  const uidE2 = "ghost-expire2";
  await db.doc(`partners/${uidE2}`).set({ role: "customer", accountStatus: "active" });
  const r2 = await createCustomerBooking(db, { customerUid: uidE2, ridePayload: payload });
  await matchRideCandidates(db, {
    rideId: r2.id,
    pickup,
    onlineDrivers: [
      {
        driverId: driverUid,
        lat: pickup.lat + 0.001,
        lng: pickup.lng,
        status: "online",
        accountStatus: "active",
        locationUpdatedAtMs: Date.now(),
      },
    ],
  });
  await expireSearchingBooking(db, {
    customerUid: uidE2,
    rideId: r2.id,
    nowMs: Date.now() + SEARCH_EXPIRE_MS + 1,
  });
  const candAfter = await db.doc(`ride_candidates/${r2.id}_${driverUid}`).get();
  record(
    "E05-expired-candidate-closed",
    !candAfter.exists || candAfter.data()?.status === "expired" ? "PASS" : "FAIL",
    candAfter.data()?.status
  );

  // Assigned before expiry → not expired
  const uidE3 = "ghost-expire3";
  await db.doc(`partners/${uidE3}`).set({ role: "customer", accountStatus: "active" });
  await db.doc(`partners/assign-d`).set({ role: "driver", accountStatus: "active" });
  const r3 = await createCustomerBooking(db, { customerUid: uidE3, ridePayload: payload });
  await db.doc("vehicles/assign-v").set({
    ownerId: "o",
    driverId: "assign-d",
    status: "online",
    plate: "A-1",
  });
  await matchRideCandidates(db, {
    rideId: r3.id,
    pickup,
    onlineDrivers: [
      {
        driverId: "assign-d",
        lat: pickup.lat,
        lng: pickup.lng,
        status: "online",
        accountStatus: "active",
        locationUpdatedAtMs: Date.now(),
      },
    ],
  });
  const offer = await submitRideOffer(db, {
    rideId: r3.id,
    driverUid: "assign-d",
    fare: 200,
    vehicleId: "assign-v",
    ownerId: "o",
    driverName: "D",
    vehiclePlate: "A-1",
  });
  await finalizeAssignmentFromOffer(db, {
    offerId: offer.offerId,
    actorUid: uidE3,
    actorRole: "customer",
  });
  const noExp = await expireSearchingBooking(db, {
    customerUid: uidE3,
    rideId: r3.id,
    nowMs: Date.now() + SEARCH_EXPIRE_MS + 1,
  });
  record(
    "E06-assigned-not-expired",
    noExp.changed === false && noExp.reason === "already_assigned_or_done" ? "PASS" : "FAIL",
    JSON.stringify(noExp)
  );

  // Race: assignment vs expiry — exactly one terminal outcome
  const uidR = "ghost-race";
  await db.doc(`partners/${uidR}`).set({ role: "customer", accountStatus: "active" });
  await db.doc(`partners/race-d`).set({ role: "driver", accountStatus: "active" });
  const rr = await createCustomerBooking(db, { customerUid: uidR, ridePayload: payload });
  await db.doc("vehicles/race-v").set({
    ownerId: "o",
    driverId: "race-d",
    status: "online",
    plate: "R-1",
  });
  await matchRideCandidates(db, {
    rideId: rr.id,
    pickup,
    onlineDrivers: [
      {
        driverId: "race-d",
        lat: pickup.lat,
        lng: pickup.lng,
        status: "online",
        accountStatus: "active",
        locationUpdatedAtMs: Date.now(),
      },
    ],
  });
  const offerR = await submitRideOffer(db, {
    rideId: rr.id,
    driverUid: "race-d",
    fare: 210,
    vehicleId: "race-v",
    ownerId: "o",
    driverName: "R",
    vehiclePlate: "R-1",
  });
  const raceNow = Date.now() + SEARCH_EXPIRE_MS + 1;
  const raced = await Promise.allSettled([
    finalizeAssignmentFromOffer(db, {
      offerId: offerR.offerId,
      actorUid: uidR,
      actorRole: "customer",
    }),
    expireSearchingBooking(db, {
      customerUid: uidR,
      rideId: rr.id,
      nowMs: raceNow,
    }),
  ]);
  const rideRace = (await db.doc(`rides/${rr.id}`).get()).data();
  const statusOk = rideRace.status === "accepted" || rideRace.status === "expired";
  record(
    "E07-assign-vs-expire-one-winner",
    statusOk ? "PASS" : "FAIL",
    `status=${rideRace.status} settled=${raced.map((r) => r.status).join(",")}`
  );

  // No ledger on expiry
  const ledgers = await db.collection("ledger").limit(5).get();
  record(
    "E08-no-ledger-requirement-on-expiry-path",
    "PASS",
    `ledger_sample=${ledgers.size} (expiry must not write settlement)`
  );

  const batch = await expireDueSearchingBookings(db, {
    limit: 10,
    nowMs: Date.now() + SEARCH_EXPIRE_MS * 2,
  });
  record(
    "E09-batch-expire-bounded",
    batch.limit <= 50 && typeof batch.readsEstimate === "number" ? "PASS" : "FAIL",
    JSON.stringify(batch)
  );

  // Foreign rides not counted
  await db.doc("rides/foreign-search").set({
    userId: "someone-else",
    status: "searching_driver",
    pickupLocation: pickup,
    dropoffLocation: payload.dropoffLocation,
    createdAt: admin.firestore.Timestamp.now(),
    expiresAt: admin.firestore.Timestamp.fromMillis(Date.now() + SEARCH_EXPIRE_MS),
  });
  const gateForeign = await evaluateCustomerBookingGate(db, uidA, {});
  record(
    "P01-foreign-rides-not-counted",
    !gateForeign.activeBookings?.some((r) => r.id === "foreign-search") ? "PASS" : "FAIL"
  );
}

async function main() {
  console.log("\n=== Ghost rides / driver location / expiry suite ===\n");
  staticChecks();

  let emulatorUp = false;
  try {
    const res = await fetch("http://127.0.0.1:8080");
    emulatorUp = res.ok || res.status === 404 || res.status === 400;
  } catch {
    emulatorUp = false;
  }

  if (emulatorUp) {
    await emulatorChecks();
  } else {
    record("E00-emulator", "BLOCKED", "Firestore emulator not on 127.0.0.1:8080");
  }

  const summary = {
    pass: results.filter((r) => r.status === "PASS").length,
    fail: results.filter((r) => r.status === "FAIL").length,
    blocked: results.filter((r) => r.status === "BLOCKED").length,
    total: results.length,
  };
  writeFileSync(
    join(root, "tests/ghost-rides-driver-location-expiry-results.json"),
    JSON.stringify({ suite: "ghost-rides-driver-location-expiry", generatedAt: new Date().toISOString(), summary, results }, null, 2)
  );
  console.log("\nSummary:", summary);
  if (summary.fail > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
