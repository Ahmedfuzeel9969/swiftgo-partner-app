/**
 * Cancellation contract suite: Customer / Driver / Admin / expiry / rematch.
 * Run via: firebase emulators:exec --only firestore --project demo-swiftgo-phase1 \
 *   "node tests/booking-cancellation-contract-suite.mjs"
 */

import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const require = createRequire(import.meta.url);

const results = [];
function record(name, status, detail = "") {
  results.push({ name, status, detail });
  console.log(`${status === "PASS" ? "✓" : status === "FAIL" ? "✗" : "·"} ${name} — ${status}${detail ? `: ${detail}` : ""}`);
}

async function main() {
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
    createCustomerBooking,
    cancelCustomerBooking,
    evaluateCustomerBookingGate,
    matchRideCandidates,
    submitRideOffer,
    finalizeAssignmentFromOffer,
    expireSearchingBooking,
    SEARCH_EXPIRE_MS,
  } = require(join(root, "functions/bargaining.js"));
  const {
    declineRideCandidate,
    withdrawRideOffer,
    cancelAssignedRideByDriver,
    cancelRideByAdmin,
  } = require(join(root, "functions/ride-cancellation.js"));
  const { CANCELLABLE_RIDE_STATUSES } = require(join(root, "functions/matching.js"));

  const pickup = { lat: 24.8607, lng: 67.0011 };
  const payload = {
    pickupLocation: { ...pickup, address: "A" },
    dropoffLocation: { lat: 24.87, lng: 67.01, address: "B" },
    vehicleType: "Go",
    farePkr: 200,
    estimatedFare: 200,
    paymentMethod: "cash",
  };

  record(
    "C00-cancellable-includes-pre-start",
    CANCELLABLE_RIDE_STATUSES.includes("searching_driver") &&
      CANCELLABLE_RIDE_STATUSES.includes("accepted") &&
      CANCELLABLE_RIDE_STATUSES.includes("arrived") &&
      CANCELLABLE_RIDE_STATUSES.includes("in_progress")
      ? "PASS"
      : "FAIL",
    JSON.stringify(CANCELLABLE_RIDE_STATUSES)
  );

  const cust = "cc-cust";
  const other = "cc-other";
  const drv = "cc-drv";
  await db.doc(`partners/${cust}`).set({ role: "customer", accountStatus: "active" });
  await db.doc(`partners/${other}`).set({ role: "customer", accountStatus: "active" });
  await db.doc(`partners/${drv}`).set({ role: "driver", accountStatus: "active" });
  await db.doc("vehicles/cc-v").set({
    ownerId: "o",
    driverId: drv,
    status: "online",
    plate: "CC-1",
    location: { lat: pickup.lat + 0.001, lng: pickup.lng },
    locationUpdatedAt: admin.firestore.Timestamp.now(),
  });

  // Customer own searching cancel
  const r1 = await createCustomerBooking(db, { customerUid: cust, ridePayload: payload });
  const cancelStartMs = performance.now();
  const c1 = await cancelCustomerBooking(db, {
    customerUid: cust,
    rideId: r1.id,
    cancelReasonKey: "other",
  });
  record(
    "C01-customer-cancel-searching",
    c1.ok && c1.cancelledCount === 1 ? "PASS" : "FAIL",
    JSON.stringify(c1)
  );
  record(
    "PERF-cancel-click-to-confirmed",
    c1.ok && c1.cancelledCount === 1 ? "PASS" : "FAIL",
    `${Math.round(performance.now() - cancelStartMs)}ms`,
    { milliseconds: Math.round(performance.now() - cancelStartMs) }
  );

  // Other customer denied
  const r2 = await createCustomerBooking(db, { customerUid: cust, ridePayload: payload });
  let otherDenied = false;
  try {
    await cancelCustomerBooking(db, { customerUid: other, rideId: r2.id });
  } catch (e) {
    otherDenied = e.message === "NOT_YOUR_BOOKING";
  }
  record("C02-other-customer-denied", otherDenied ? "PASS" : "FAIL");

  // Repeat cancel safe
  const again = await cancelCustomerBooking(db, { customerUid: cust, rideId: r2.id });
  const again2 = await cancelCustomerBooking(db, { customerUid: cust, rideId: r2.id });
  record(
    "C03-repeat-cancel-safe",
    again.ok && again2.already === true ? "PASS" : "FAIL"
  );

  // Cancel in-progress applies partial fare (base + traveled km)
  const r3 = await createCustomerBooking(db, { customerUid: cust, ridePayload: payload });
  await db.doc(`rides/${r3.id}`).set(
    {
      status: "in_progress",
      driverId: drv,
      userId: cust,
      vehicleTypeKey: "go",
      pickupLocation: { lat: pickup.lat, lng: pickup.lng },
      driverLocation: { lat: pickup.lat + 0.004, lng: pickup.lng },
      traveledDistanceKm: 0.4,
    },
    { merge: true }
  );
  const c4 = await cancelCustomerBooking(db, {
    customerUid: cust,
    rideId: r3.id,
    cancelReasonKey: "other",
  });
  const r3After = (await db.doc(`rides/${r3.id}`).get()).data() || {};
  record(
    "C04-cancel-in-progress-partial-fare",
    c4.ok &&
      c4.partialFareApplies === true &&
      Number(c4.cancellationFare) > 0 &&
      r3After.status === "cancelled_by_customer" &&
      Number(r3After.cancellationFare) === Number(c4.cancellationFare)
      ? "PASS"
      : "FAIL",
    JSON.stringify({
      cancellationFare: c4.cancellationFare,
      traveledDistanceKm: c4.traveledDistanceKm,
      status: r3After.status,
    })
  );

  // Customer cancel accepted
  const r4 = await createCustomerBooking(db, { customerUid: cust, ridePayload: payload });
  await matchRideCandidates(db, {
    rideId: r4.id,
    pickup,
    onlineDrivers: [
      {
        driverId: drv,
        lat: pickup.lat,
        lng: pickup.lng,
        status: "online",
        accountStatus: "active",
        locationUpdatedAtMs: Date.now(),
      },
    ],
  });
  const off = await submitRideOffer(db, {
    rideId: r4.id,
    driverUid: drv,
    fare: 200,
    vehicleId: "cc-v",
    ownerId: "o",
    driverName: "D",
    vehiclePlate: "CC-1",
  });
  const acceptStartMs = performance.now();
  await finalizeAssignmentFromOffer(db, {
    offerId: off.offerId,
    actorUid: cust,
    actorRole: "customer",
  });
  const assignedAfterAccept = (await db.doc(`rides/${r4.id}`).get()).data() || {};
  record(
    "PERF-driver-accept-to-assignment-confirmed",
    assignedAfterAccept.status === "accepted" && assignedAfterAccept.driverId === drv ? "PASS" : "FAIL",
    `${Math.round(performance.now() - acceptStartMs)}ms`,
    { milliseconds: Math.round(performance.now() - acceptStartMs) }
  );
  const cAcc = await cancelCustomerBooking(db, {
    customerUid: cust,
    rideId: r4.id,
    cancelReasonKey: "other",
  });
  const rideAcc = (await db.doc(`rides/${r4.id}`).get()).data();
  const partner = (await db.doc(`partners/${drv}`).get()).data();
  record(
    "C05-customer-cancel-accepted",
    cAcc.ok &&
      rideAcc.status === "cancelled_by_customer" &&
      !partner?.activeRideId
      ? "PASS"
      : "FAIL",
    `status=${rideAcc.status} activeRide=${partner?.activeRideId}`
  );

  // Decline candidate only
  const r5 = await createCustomerBooking(db, { customerUid: cust, ridePayload: payload });
  await matchRideCandidates(db, {
    rideId: r5.id,
    pickup,
    onlineDrivers: [
      {
        driverId: drv,
        lat: pickup.lat,
        lng: pickup.lng,
        status: "online",
        accountStatus: "active",
        locationUpdatedAtMs: Date.now(),
      },
    ],
  });
  const dec = await declineRideCandidate(db, { rideId: r5.id, driverUid: drv });
  const rideStill = (await db.doc(`rides/${r5.id}`).get()).data();
  const cand = (await db.doc(`ride_candidates/${r5.id}_${drv}`).get()).data();
  record(
    "D01-decline-candidate-keeps-booking",
    dec.bookingTerminal === false &&
      rideStill.status === "searching_driver" &&
      cand.status === "declined"
      ? "PASS"
      : "FAIL"
  );

  // Withdraw offer
  await cancelCustomerBooking(db, { customerUid: cust, rideId: r5.id, cancelReasonKey: "other" }).catch(() => {});
  const r6 = await createCustomerBooking(db, {
    customerUid: cust,
    confirmedExtraBooking: true,
    ridePayload: payload,
  });
  await matchRideCandidates(db, {
    rideId: r6.id,
    pickup,
    onlineDrivers: [
      {
        driverId: drv,
        lat: pickup.lat,
        lng: pickup.lng,
        status: "online",
        accountStatus: "active",
        locationUpdatedAtMs: Date.now(),
      },
    ],
  });
  await submitRideOffer(db, {
    rideId: r6.id,
    driverUid: drv,
    fare: 210,
    vehicleId: "cc-v",
    ownerId: "o",
    driverName: "D",
    vehiclePlate: "CC-1",
  });
  const wd = await withdrawRideOffer(db, { offerId: `${r6.id}_${drv}`, driverUid: drv });
  const offerWd = (await db.doc(`ride_offers/${r6.id}_${drv}`).get()).data();
  record(
    "D02-withdraw-own-offer",
    wd.status === "withdrawn" && offerWd.status === "withdrawn" && wd.bookingTerminal === false
      ? "PASS"
      : "FAIL"
  );

  // Unassigned driver cannot cancel ride
  await cancelCustomerBooking(db, { customerUid: cust, rideId: r6.id, cancelReasonKey: "other" }).catch(() => {});
  const r7 = await createCustomerBooking(db, {
    customerUid: cust,
    confirmedExtraBooking: true,
    ridePayload: payload,
  });
  let unassignedDenied = false;
  try {
    await cancelAssignedRideByDriver(db, {
      rideId: r7.id,
      driverUid: drv,
      cancelReasonKey: "other",
    });
  } catch (e) {
    unassignedDenied =
      e.message === "NOT_ASSIGNED" || String(e.message).includes("NOT_CANCELLABLE");
  }
  record("D03-unassigned-cannot-cancel-ride", unassignedDenied ? "PASS" : "FAIL");

  // Assigned driver cancel → rematch, exclude self
  await cancelCustomerBooking(db, { customerUid: cust, rideId: r7.id, cancelReasonKey: "other" }).catch(() => {});
  const r8 = await createCustomerBooking(db, {
    customerUid: cust,
    confirmedExtraBooking: true,
    ridePayload: payload,
  });
  await db.doc(`partners/cc-drv2`).set({ role: "driver", accountStatus: "active" });
  await matchRideCandidates(db, {
    rideId: r8.id,
    pickup,
    onlineDrivers: [
      {
        driverId: drv,
        lat: pickup.lat,
        lng: pickup.lng,
        status: "online",
        accountStatus: "active",
        locationUpdatedAtMs: Date.now(),
      },
      {
        driverId: "cc-drv2",
        lat: pickup.lat + 0.001,
        lng: pickup.lng,
        status: "online",
        accountStatus: "active",
        locationUpdatedAtMs: Date.now(),
      },
    ],
  });
  const off8 = await submitRideOffer(db, {
    rideId: r8.id,
    driverUid: drv,
    fare: 220,
    vehicleId: "cc-v",
    ownerId: "o",
    driverName: "D",
    vehiclePlate: "CC-1",
  });
  await finalizeAssignmentFromOffer(db, {
    offerId: off8.offerId,
    actorUid: cust,
    actorRole: "customer",
  });
  const rem = await cancelAssignedRideByDriver(db, {
    rideId: r8.id,
    driverUid: drv,
    cancelReasonKey: "other",
  });
  const ride8 = (await db.doc(`rides/${r8.id}`).get()).data();
  const candSelf = await db.doc(`ride_candidates/${r8.id}_${drv}`).get();
  const gateAfter = await evaluateCustomerBookingGate(db, cust, { confirmedExtraBooking: true });
  const selfNotInvited = !candSelf.exists || candSelf.data()?.status !== "invited";
  record(
    "D04-assigned-cancel-rematch",
    rem.rematch === true &&
      ride8.status === "searching_driver" &&
      rem.excludeDriverId === drv &&
      selfNotInvited
      ? "PASS"
      : "FAIL",
    JSON.stringify({
      status: ride8.status,
      candidates: rem.candidateCount,
      exclude: rem.excludeDriverId,
      selfCand: candSelf.data()?.status,
      gateCount: gateAfter.count,
    })
  );
  record(
    "D05-rematch-same-booking-no-extra-slot",
    gateAfter.activeBookings?.some((b) => b.id === r8.id) &&
      gateAfter.activeBookings.filter((b) => b.id === r8.id).length === 1
      ? "PASS"
      : "FAIL",
    `count=${gateAfter.count}`
  );

  // Driver cannot cancel after start
  await cancelCustomerBooking(db, { customerUid: cust, rideId: r8.id, cancelReasonKey: "other" }).catch(() => {});
  const r9 = await createCustomerBooking(db, {
    customerUid: cust,
    confirmedExtraBooking: true,
    ridePayload: payload,
  });
  await db.doc(`rides/${r9.id}`).set(
    { status: "in_progress", driverId: drv, userId: cust },
    { merge: true }
  );
  let afterStartDenied = false;
  try {
    await cancelAssignedRideByDriver(db, {
      rideId: r9.id,
      driverUid: drv,
      cancelReasonKey: "other",
    });
  } catch (e) {
    afterStartDenied = String(e.message).includes("NOT_CANCELLABLE:in_progress");
  }
  record("D06-driver-cancel-after-start-rejected", afterStartDenied ? "PASS" : "FAIL");

  // Admin cancel
  await cancelCustomerBooking(db, { customerUid: cust, rideId: r9.id, cancelReasonKey: "other" }).catch(
    () => {}
  );
  await db.doc(`rides/${r9.id}`).set({ status: "cancelled_by_system" }, { merge: true });
  const r10 = await createCustomerBooking(db, {
    customerUid: cust,
    confirmedExtraBooking: true,
    ridePayload: payload,
  });
  const adm = await cancelRideByAdmin(db, {
    rideId: r10.id,
    adminUid: "admin-1",
    reason: "ops_safety",
  });
  const audit = await db.collection("admin_audit").where("rideId", "==", r10.id).limit(1).get();
  record(
    "A01-admin-cancel",
    adm.ok && adm.status === "cancelled_by_admin" && !audit.empty ? "PASS" : "FAIL"
  );
  const adm2 = await cancelRideByAdmin(db, {
    rideId: r10.id,
    adminUid: "admin-1",
    reason: "ops_safety",
  });
  record("A02-admin-repeat-safe", adm2.already === true ? "PASS" : "FAIL");

  let reasonReq = false;
  try {
    await cancelRideByAdmin(db, { rideId: r10.id, adminUid: "admin-1", reason: "" });
  } catch (e) {
    reasonReq = e.message === "REASON_REQUIRED";
  }
  // already cancelled returns already before reason check on empty - use fresh ride
  const r11 = await createCustomerBooking(db, {
    customerUid: cust,
    confirmedExtraBooking: true,
    ridePayload: payload,
  });
  try {
    await cancelRideByAdmin(db, { rideId: r11.id, adminUid: "admin-1", reason: "  " });
  } catch (e) {
    reasonReq = e.message === "REASON_REQUIRED";
  }
  record("A03-admin-reason-required", reasonReq ? "PASS" : "FAIL");

  // Admin started ride blocked
  const r12 = await createCustomerBooking(db, {
    customerUid: cust,
    confirmedExtraBooking: true,
    ridePayload: payload,
  });
  await db.doc(`rides/${r12.id}`).set({ status: "in_progress", driverId: drv }, { merge: true });
  let startedAdmin = false;
  try {
    await cancelRideByAdmin(db, {
      rideId: r12.id,
      adminUid: "admin-1",
      reason: "emergency",
    });
  } catch (e) {
    startedAdmin = e.message === "STARTED_RIDE_ADMIN_CANCEL_UNDEFINED";
  }
  record("A04-admin-started-not-silent", startedAdmin ? "PASS" : "FAIL");

  // Expiry still works
  await cancelRideByAdmin(db, { rideId: r11.id, adminUid: "admin-1", reason: "cleanup" }).catch(() => {});
  await db.doc(`rides/${r12.id}`).set({ status: "cancelled_by_system" }, { merge: true });
  const r13 = await createCustomerBooking(db, {
    customerUid: cust,
    confirmedExtraBooking: true,
    ridePayload: payload,
  });
  let early = "";
  try {
    await expireSearchingBooking(db, {
      customerUid: cust,
      rideId: r13.id,
      nowMs: Date.now(),
    });
  } catch (e) {
    early = e.message;
  }
  record("E01-before-3min", early === "NOT_YET_EXPIRED" ? "PASS" : "FAIL", early);
  const exp = await expireSearchingBooking(db, {
    customerUid: cust,
    rideId: r13.id,
    nowMs: Date.now() + SEARCH_EXPIRE_MS + 1,
  });
  record("E02-after-3min", exp.changed && exp.status === "expired" ? "PASS" : "FAIL");

  const summary = {
    pass: results.filter((r) => r.status === "PASS").length,
    fail: results.filter((r) => r.status === "FAIL").length,
    total: results.length,
  };
  writeFileSync(
    join(root, "tests/booking-cancellation-contract-results.json"),
    JSON.stringify({ suite: "booking-cancellation-contract", generatedAt: new Date().toISOString(), summary, results }, null, 2)
  );
  console.log("\nSummary:", summary);
  if (summary.fail > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
