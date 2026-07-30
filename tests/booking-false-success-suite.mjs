/**
 * Focused regression: false "4 active bookings" + false booking success.
 * Emulator-backed when Admin SDK + Firestore emulator available; otherwise
 * static contract checks still run and record BLOCKED/FAIL appropriately.
 *
 * Run: node tests/booking-false-success-suite.mjs
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const require = createRequire(import.meta.url);

const results = [];
function record(name, status, detail = "", expected = "", actual = "") {
  results.push({ name, status, detail, expected, actual });
  const mark = status === "PASS" ? "✓" : status === "FAIL" ? "✗" : "·";
  console.log(`${mark} ${name} — ${status}${detail ? `: ${detail}` : ""}`);
}

function read(rel) {
  return readFileSync(join(root, rel), "utf8");
}

function staticContractChecks() {
  const appJs = read("customer-app/js/app.js");
  const rideFlow = read("customer-app/js/ride-flow.js");
  const bookingGate = read("customer-app/js/booking-gate.js");
  const bookingClient = read("customer-app/js/booking-client.js");
  const rideStatus = read("customer-app/js/ride-status.js");
  const history = read("customer-app/js/history.js");
  const bargaining = read("functions/bargaining.js");
  const matching = read("functions/matching.js");
  const firebaseJs = read("customer-app/js/firebase.js");
  const firebaseConfig = read("customer-app/js/firebase-config.js");

  // Success toast only after ride.id
  const successGuarded =
    /const ride = await startRideRequest\(state\)/.test(appJs) &&
    /if \(ride\?\.id\)/.test(appJs) &&
    /bookingCreated/.test(appJs);
  record(
    "S01-success-toast-requires-ride-id",
    successGuarded ? "PASS" : "FAIL",
    "app.js must not toast success unless startRideRequest returns ride.id",
    "guarded success toast",
    successGuarded ? "guarded" : "unguarded"
  );

  const noBlindSuccess =
    !/await startRideRequest\(state\);\s*showToast\(`\$\{t\("bookingCreated"\)\}/.test(appJs);
  record(
    "S02-no-blind-success-after-await",
    noBlindSuccess ? "PASS" : "FAIL",
    "must not show bookingCreated immediately after await without checking return"
  );

  const validatesRideId =
    /MISSING_RIDE_ID/.test(rideFlow) &&
    /created\?\.id/.test(rideFlow);
  record(
    "S03-create-requires-canonical-ride-id",
    validatesRideId ? "PASS" : "FAIL",
    "ride-flow must reject createCustomerBooking responses without id"
  );

  const usesTrustedCreate =
    bookingClient.includes("createCustomerBooking") &&
    !/addDoc\(collection\(db,\s*"rides"\)/.test(rideFlow);
  record(
    "S04-trusted-createCustomerBooking-only",
    usesTrustedCreate ? "PASS" : "FAIL",
    "booking path must call trusted callable; no direct rides write in ride-flow"
  );

  const sharedStatuses =
    rideStatus.includes("searching_driver") &&
    rideStatus.includes("accepted") &&
    rideStatus.includes("arrived") &&
    rideStatus.includes("in_progress") &&
    bookingGate.includes("NON_TERMINAL_RIDE_STATUSES") &&
    history.includes("NON_TERMINAL_RIDE_STATUSES");
  record(
    "S05-shared-non-terminal-status-helper",
    sharedStatuses ? "PASS" : "FAIL",
    "Customer gate + history must share ride-status.js non-terminal list"
  );

  const matchingStatuses =
    matching.includes('"searching_driver"') &&
    matching.includes('"accepted"') &&
    matching.includes('"arrived"') &&
    matching.includes('"in_progress"');
  record(
    "S06-backend-non-terminal-matches-contract",
    matchingStatuses ? "PASS" : "FAIL"
  );

  const gateUsesLiveRides =
    /const count = active\.length/.test(bargaining) &&
    bargaining.includes("countCustomerActiveBookings");
  record(
    "S07-gate-counts-live-rides-not-inflated-slots",
    gateUsesLiveRides ? "PASS" : "FAIL",
    "evaluateCustomerBookingGate must use active.length after reconcile"
  );

  const createReconciles =
    bargaining.includes("reconcileCustomerBookingState") &&
    /createCustomerBooking[\s\S]*reconcileCustomerBookingState/.test(bargaining);
  record(
    "S08-create-reconciles-slots-before-limit",
    createReconciles ? "PASS" : "FAIL"
  );

  const maxIsFour =
    /MAX_CUSTOMER_ACTIVE_BOOKINGS\s*=\s*4/.test(matching) &&
    /MAX_CUSTOMER_ACTIVE_BOOKINGS\s*=\s*4/.test(rideStatus);
  record("S09-four-booking-limit-preserved", maxIsFour ? "PASS" : "FAIL");

  const projectOk =
    firebaseConfig.includes("swiftgo-ride-app") &&
    firebaseJs.includes('getFunctions(app, "us-central1")');
  record(
    "S10-production-project-and-region",
    projectOk ? "PASS" : "FAIL",
    "customer firebase-config projectId + functions region us-central1"
  );

  const emulatorNotForcedProd =
    firebaseJs.includes("shouldUseEmulators") &&
    /host !== "localhost"/.test(firebaseJs);
  record(
    "S11-emulator-not-forced-on-hosting",
    emulatorNotForcedProd ? "PASS" : "FAIL"
  );

  const noRideRequestsWrite =
    !/collection\(db,\s*"ride_requests"\)/.test(rideFlow) &&
    !/addDoc\([\s\S]*ride_requests/.test(bookingClient);
  record(
    "S12-no-legacy-ride_requests-writes",
    noRideRequestsWrite ? "PASS" : "FAIL"
  );

  const maxReturnNull =
    /reason === "MAX_ACTIVE_BOOKINGS"[\s\S]*return null/.test(rideFlow);
  record(
    "S13-max-active-returns-null-not-success",
    maxReturnNull ? "PASS" : "FAIL"
  );
}

async function emulatorBehaviourChecks() {
  // Resolve firebase-admin from functions/ so FieldValue matches bargaining.js
  // (mixed package copies break ServerTimestampTransform serialization).
  let admin;
  try {
    admin = require(
      require.resolve("firebase-admin", { paths: [join(root, "functions"), root] })
    );
  } catch {
    record("E00-admin-sdk", "BLOCKED", "firebase-admin not installed");
    return;
  }

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
    matchRideCandidates,
  } = require(join(root, "functions/bargaining.js"));
  const { hashVehiclePin } = require(join(root, "functions/pin-security.js"));

  const uid = "bfs-customer";
  const other = "bfs-other-customer";

  // Clean slate
  await db.doc(`booking_slots/${uid}`).set({ count: 99 }); // intentionally inflated
  await db.doc(`partners/${uid}`).set({ role: "customer", accountStatus: "active" });

  // Terminal + foreign + legacy-shaped docs must not block
  await db.doc("rides/bfs-completed").set({
    userId: uid,
    status: "completed",
    pickupLocation: { lat: 24.86, lng: 67.0 },
    dropoffLocation: { lat: 24.87, lng: 67.01 },
  });
  await db.doc("rides/bfs-cancelled").set({
    userId: uid,
    status: "cancelled_by_customer",
    pickupLocation: { lat: 24.86, lng: 67.0 },
    dropoffLocation: { lat: 24.87, lng: 67.01 },
  });
  await db.doc("rides/bfs-expired").set({
    userId: uid,
    status: "expired",
    pickupLocation: { lat: 24.86, lng: 67.0 },
    dropoffLocation: { lat: 24.87, lng: 67.01 },
  });
  await db.doc("rides/bfs-no-driver").set({
    userId: uid,
    status: "no_driver_found",
    pickupLocation: { lat: 24.86, lng: 67.0 },
    dropoffLocation: { lat: 24.87, lng: 67.01 },
  });
  await db.doc("rides/bfs-rejected").set({
    userId: uid,
    status: "declined",
    pickupLocation: { lat: 24.86, lng: 67.0 },
    dropoffLocation: { lat: 24.87, lng: 67.01 },
  });
  await db.doc("rides/bfs-other").set({
    userId: other,
    status: "searching_driver",
    pickupLocation: { lat: 24.86, lng: 67.0 },
    dropoffLocation: { lat: 24.87, lng: 67.01 },
  });
  await db.doc("ride_requests/bfs-legacy").set({
    userId: uid,
    status: "pending",
  });

  try {
    const gate0 = await evaluateCustomerBookingGate(db, uid, {});
    record(
      "E01-zero-active-no-warning",
      gate0.allowed === true && gate0.count === 0 ? "PASS" : "FAIL",
      JSON.stringify({ allowed: gate0.allowed, count: gate0.count, reason: gate0.reason }),
      "allowed=true count=0",
      `allowed=${gate0.allowed} count=${gate0.count}`
    );

    const slotAfter = (await db.doc(`booking_slots/${uid}`).get()).data();
    record(
      "E02-inflated-slots-reconciled-to-live",
      Number(slotAfter?.count ?? -1) === 0 ? "PASS" : "FAIL",
      `slot count=${slotAfter?.count}`,
      "0",
      String(slotAfter?.count)
    );

    const created = await createCustomerBooking(db, {
      customerUid: uid,
      confirmedExtraBooking: false,
      ridePayload: {
        pickupLocation: { lat: 24.8607, lng: 67.0011, address: "A" },
        dropoffLocation: { lat: 24.87, lng: 67.01, address: "B" },
        vehicleType: "Go",
        vehicleTypeKey: "go",
        distanceKm: 2,
        timeMins: 8,
        farePkr: 200,
        estimatedFare: 200,
        paymentMethod: "cash",
      },
    });
    record(
      "E03-first-booking-returns-ride-id",
      Boolean(created?.id) ? "PASS" : "FAIL",
      created?.id || "missing"
    );

    const rideSnap = await db.doc(`rides/${created.id}`).get();
    record(
      "E04-canonical-rides-doc-created",
      rideSnap.exists && rideSnap.data()?.status === "searching_driver" && rideSnap.data()?.userId === uid
        ? "PASS"
        : "FAIL"
    );

    const searching = await db
      .collection("rides")
      .where("userId", "==", uid)
      .where("status", "==", "searching_driver")
      .get();
    record(
      "E05-exactly-one-searching-ride",
      searching.size === 1 ? "PASS" : "FAIL",
      `size=${searching.size}`
    );

    // Matching with one eligible online driver nearby
    const driverUid = "bfs-driver";
    await db.doc(`partners/${driverUid}`).set({
      role: "driver",
      accountStatus: "active",
    });
    await db.doc("vehicles/bfs-veh").set({
      ownerId: "bfs-owner",
      driverId: driverUid,
      status: "online",
      plate: "BFS-1",
      pinHash: hashVehiclePin("4242"),
      location: { lat: 24.861, lng: 67.002 },
      locationUpdatedAt: admin.firestore.Timestamp.now(),
      geoCell: "g_6905_18611",
    });
    await db.doc("settings/dispatch").set({ candidateDriverLimit: 10 }, { merge: true });

    const matched = await matchRideCandidates(db, {
      rideId: created.id,
      pickup: { lat: 24.8607, lng: 67.0011 },
    });
    const candId = `${created.id}_${driverUid}`;
    const cand = await db.doc(`ride_candidates/${candId}`).get();
    record(
      "E06-matching-creates-candidate-for-eligible-driver",
      cand.exists && matched?.candidates?.length >= 1 ? "PASS" : "FAIL",
      JSON.stringify({
        candidates: matched?.candidates?.length,
        candExists: cand.exists,
        matchingStatus: (await db.doc(`rides/${created.id}`).get()).data()?.matchingStatus,
      })
    );

    // Build to 4 active, reject 5th
    for (let i = 0; i < 3; i += 1) {
      await createCustomerBooking(db, {
        customerUid: uid,
        confirmedExtraBooking: true,
        ridePayload: {
          pickupLocation: { lat: 24.8607, lng: 67.0011, address: "A" },
          dropoffLocation: { lat: 24.87, lng: 67.01, address: "B" },
          vehicleType: "Go",
          farePkr: 200,
          estimatedFare: 200,
          paymentMethod: "cash",
        },
      });
    }
    const gate4 = await evaluateCustomerBookingGate(db, uid, { confirmedExtraBooking: true });
    record(
      "E07-four-active-blocks-fifth-at-gate",
      gate4.allowed === false && gate4.reason === "MAX_ACTIVE_BOOKINGS" ? "PASS" : "FAIL",
      JSON.stringify(gate4)
    );

    let fifthDenied = false;
    try {
      await createCustomerBooking(db, {
        customerUid: uid,
        confirmedExtraBooking: true,
        ridePayload: {
          pickupLocation: { lat: 24.8607, lng: 67.0011, address: "A" },
          dropoffLocation: { lat: 24.87, lng: 67.01, address: "B" },
          vehicleType: "Go",
          farePkr: 200,
          estimatedFare: 200,
          paymentMethod: "cash",
        },
      });
    } catch (e) {
      fifthDenied = e.message === "MAX_ACTIVE_BOOKINGS";
    }
    record(
      "E08-fifth-create-rejected-no-partial",
      fifthDenied ? "PASS" : "FAIL",
      "MAX_ACTIVE_BOOKINGS"
    );

    const activeAfter = await db
      .collection("rides")
      .where("userId", "==", uid)
      .where("status", "in", ["searching_driver", "accepted", "arrived", "in_progress"])
      .get();
    record(
      "E09-still-exactly-four-non-terminal",
      activeAfter.size === 4 ? "PASS" : "FAIL",
      `size=${activeAfter.size}`
    );

    // Cancel one searching — slot frees
    const oneId = activeAfter.docs[0].id;
    await cancelCustomerBooking(db, {
      customerUid: uid,
      rideId: oneId,
      cancelReasonKey: "booked_by_mistake",
      cancelReason: "test",
    });
    const afterCancel = await evaluateCustomerBookingGate(db, uid, {
      confirmedExtraBooking: true,
    });
    record(
      "E10-cancel-frees-slot",
      afterCancel.allowed === true && afterCancel.count === 3 ? "PASS" : "FAIL",
      JSON.stringify({ allowed: afterCancel.allowed, count: afterCancel.count })
    );
  } catch (e) {
    record("E99-emulator-run", "FAIL", String(e?.message || e));
  }
}

async function main() {
  console.log("\n=== Booking false-success focused suite ===\n");
  staticContractChecks();

  let emulatorUp = false;
  try {
    const res = await fetch("http://127.0.0.1:8080");
    emulatorUp = res.ok || res.status === 404 || res.status === 400;
  } catch {
    emulatorUp = false;
  }

  if (emulatorUp) {
    await emulatorBehaviourChecks();
  } else {
    record(
      "E00-firestore-emulator",
      "BLOCKED",
      "Firestore emulator not reachable at 127.0.0.1:8080 — behavioural E-tests skipped"
    );
  }

  const summary = {
    pass: results.filter((r) => r.status === "PASS").length,
    fail: results.filter((r) => r.status === "FAIL").length,
    blocked: results.filter((r) => r.status === "BLOCKED").length,
    total: results.length,
  };
  const out = {
    suite: "booking-false-success",
    generatedAt: new Date().toISOString(),
    summary,
    results,
  };
  writeFileSync(
    join(root, "tests/booking-false-success-results.json"),
    JSON.stringify(out, null, 2)
  );
  console.log("\nSummary:", summary);
  if (summary.fail > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
