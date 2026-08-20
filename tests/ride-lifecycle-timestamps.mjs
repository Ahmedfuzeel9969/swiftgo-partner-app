/**
 * Ride lifecycle timestamps + assignment token rotation tests.
 * Run: npm run test:ride-lifecycle-timestamps
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "tests", "ride-lifecycle-timestamps-results.json");

const results = [];

function record(name, status, detail = "") {
  results.push({ name, status, detail });
  console.log(`${status === "PASS" ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

const {
  planLifecycleTimestampStamp,
  buildLifecycleTimestampPatch,
  applyRideLifecycleTimestampStamp,
  hasTimestamp,
} = require("../functions/ride-lifecycle-timestamps.js");

// ─── Unit: pure planning ───

record(
  "unit-arrived-stamps-driver-arrived-only",
  (() => {
    const plan = planLifecycleTimestampStamp(
      { status: "accepted" },
      { status: "arrived" }
    );
    return plan.driverArrivedAt === true && plan.tripStartedAt === false ? "PASS" : "FAIL";
  })()
);

record(
  "unit-in-progress-stamps-trip-started-only",
  (() => {
    const plan = planLifecycleTimestampStamp(
      { status: "arrived", driverArrivedAt: { seconds: 1 } },
      { status: "in_progress" }
    );
    return plan.driverArrivedAt === false && plan.tripStartedAt === true ? "PASS" : "FAIL";
  })()
);

record(
  "unit-no-stamp-when-status-unchanged",
  planLifecycleTimestampStamp({ status: "arrived" }, { status: "arrived" }).driverArrivedAt ===
    false &&
    planLifecycleTimestampStamp({ status: "arrived" }, { status: "arrived" }).tripStartedAt === false
    ? "PASS"
    : "FAIL"
);

record(
  "unit-idempotent-when-timestamp-present",
  (() => {
    const plan = planLifecycleTimestampStamp(
      { status: "accepted" },
      { status: "arrived", driverArrivedAt: { seconds: 100, nanoseconds: 0 } }
    );
    return plan.driverArrivedAt === false ? "PASS" : "FAIL";
  })()
);

record(
  "unit-has-timestamp-detects-firestore-shape",
  hasTimestamp({ seconds: 1, nanoseconds: 0 }) && !hasTimestamp(null) ? "PASS" : "FAIL"
);

record(
  "unit-build-patch-null-when-nothing-to-stamp",
  buildLifecycleTimestampPatch({ status: "accepted" }, { status: "accepted" }) === null
    ? "PASS"
    : "FAIL"
);

record(
  "static-assignment-always-mints-fresh-token",
  (() => {
    const src = read("functions/bargaining.js");
    const matches = [...src.matchAll(/assignmentSessionToken:\s*mintAssignmentSessionToken\(\)/g)];
    return matches.length >= 2 &&
      !src.includes('String(ride.assignmentSessionToken || "").trim() || mintAssignmentSessionToken()')
      ? "PASS"
      : "FAIL";
  })()
);

record(
  "static-cancel-clears-token-and-lifecycle-fields",
  (() => {
    const src = read("functions/ride-cancellation.js");
    return (
      src.includes("assignmentSessionToken: FieldValue.delete()") &&
      src.includes("driverArrivedAt: FieldValue.delete()") &&
      src.includes("tripStartedAt: FieldValue.delete()")
    )
      ? "PASS"
      : "FAIL";
  })()
);

record(
  "static-trigger-exported",
  read("functions/index.js").includes("exports.stampRideLifecycleTimestamps") &&
    read("functions/index.js").includes("onDocumentUpdated")
    ? "PASS"
    : "FAIL"
);

record(
  "static-rules-still-status-only-for-driver-advance",
  (() => {
    const rules = read("firestore.rules");
    return (
      /resource\.data\.status == 'accepted'[\s\S]*request\.resource\.data\.status == 'arrived'/.test(
        rules
      ) &&
      /affectedKeys\(\)\.hasOnly\(\['status'\]\)/.test(rules)
    )
      ? "PASS"
      : "FAIL";
  })()
);

// ─── Emulator: token rotation + lifecycle stamp ───

const admin = require(require.resolve("firebase-admin", { paths: [path.join(ROOT, "functions"), ROOT] }));
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";

let app;
try {
  app = admin.app();
} catch {
  app = admin.initializeApp({ projectId: "demo-swiftgo-phase1" });
}
const db = admin.firestore(app);

const {
  createCustomerBooking,
  matchRideCandidates,
  submitRideOffer,
  finalizeAssignmentFromOffer,
} = require("../functions/bargaining.js");
const { cancelAssignedRideByDriver } = require("../functions/ride-cancellation.js");

const pickup = { lat: 24.8607, lng: 67.0011 };
const payload = {
  pickupLocation: { ...pickup, address: "A" },
  dropoffLocation: { lat: 24.87, lng: 67.01, address: "B" },
  vehicleType: "Go",
  farePkr: 200,
  estimatedFare: 200,
  paymentMethod: "cash",
};

const cust = "rlt-cust";
const drv1 = "rlt-drv1";
const drv2 = "rlt-drv2";

await db.doc(`partners/${cust}`).set({ role: "customer", accountStatus: "active" });
await db.doc(`partners/${drv1}`).set({ role: "driver", accountStatus: "active" });
await db.doc(`partners/${drv2}`).set({ role: "driver", accountStatus: "active" });
await db.doc("vehicles/rlt-v-drv1").set({
  ownerId: "rlt-owner",
  driverId: drv1,
  status: "online",
  plate: "RLT-1",
  location: { lat: pickup.lat, lng: pickup.lng },
  locationUpdatedAt: admin.firestore.Timestamp.now(),
});
await db.doc("vehicles/rlt-v-drv2").set({
  ownerId: "rlt-owner",
  driverId: drv2,
  status: "online",
  plate: "RLT-2",
  location: { lat: pickup.lat + 0.001, lng: pickup.lng },
  locationUpdatedAt: admin.firestore.Timestamp.now(),
});

async function assignRideToDriver(rideId, driverUid, vehicleId, driverLabel) {
  await matchRideCandidates(db, {
    rideId,
    pickup,
    onlineDrivers: [
      {
        driverId: driverUid,
        lat: pickup.lat,
        lng: pickup.lng,
        status: "online",
        accountStatus: "active",
        locationUpdatedAtMs: Date.now(),
      },
    ],
  });
  const off = await submitRideOffer(db, {
    rideId,
    driverUid,
    fare: 220,
    vehicleId,
    ownerId: "rlt-owner",
    driverName: driverLabel,
    vehiclePlate: "RLT-1",
  });
  await finalizeAssignmentFromOffer(db, {
    offerId: off.offerId,
    actorUid: cust,
    actorRole: "customer",
  });
}

const booking = await createCustomerBooking(db, {
  customerUid: cust,
  confirmedExtraBooking: true,
  ridePayload: payload,
});
const rideId = booking.id;

await assignRideToDriver(rideId, drv1, "rlt-v-drv1", "Driver1");
const rideAfterAssign1 = (await db.doc(`rides/${rideId}`).get()).data();
const token1 = String(rideAfterAssign1.assignmentSessionToken || "");

record(
  "emulator-assignment-mints-token",
  token1.length >= 8 ? "PASS" : "FAIL",
  token1.slice(0, 12)
);

await cancelAssignedRideByDriver(db, {
  rideId,
  driverUid: drv1,
  cancelReasonKey: "other",
});
const rideAfterCancel = (await db.doc(`rides/${rideId}`).get()).data();
record(
  "emulator-cancel-clears-assignment-token",
  !rideAfterCancel.assignmentSessionToken &&
    !rideAfterCancel.driverArrivedAt &&
    !rideAfterCancel.tripStartedAt &&
    rideAfterCancel.status === "searching_driver"
    ? "PASS"
    : "FAIL"
);

await assignRideToDriver(rideId, drv2, "rlt-v-drv2", "Driver2");
const rideAfterAssign2 = (await db.doc(`rides/${rideId}`).get()).data();
const token2 = String(rideAfterAssign2.assignmentSessionToken || "");
record(
  "emulator-rematch-rotates-token",
  token1 && token2 && token1 !== token2 ? "PASS" : "FAIL",
  `${token1.slice(0, 8)}→${token2.slice(0, 8)}`
);

await db.doc(`rides/${rideId}`).update({ status: "arrived" });
const beforeArrived = (await db.doc(`rides/${rideId}`).get()).data();
const arrivedApply = await applyRideLifecycleTimestampStamp(
  db,
  rideId,
  { status: "accepted" },
  beforeArrived
);
const rideArrived = (await db.doc(`rides/${rideId}`).get()).data();
record(
  "emulator-stamp-driver-arrived-at",
  arrivedApply.stamped === true &&
    arrivedApply.fields.includes("driverArrivedAt") &&
    hasTimestamp(rideArrived.driverArrivedAt)
    ? "PASS"
    : "FAIL"
);

const arrivedMs1 = rideArrived.driverArrivedAt.toMillis();
const idemArrived = await applyRideLifecycleTimestampStamp(db, rideId, { status: "accepted" }, rideArrived);
record(
  "emulator-driver-arrived-idempotent",
  idemArrived.stamped === false ? "PASS" : "FAIL"
);

await db.doc(`rides/${rideId}`).update({ status: "in_progress" });
const beforeTrip = (await db.doc(`rides/${rideId}`).get()).data();
const tripApply = await applyRideLifecycleTimestampStamp(
  db,
  rideId,
  { status: "arrived", driverArrivedAt: beforeTrip.driverArrivedAt },
  beforeTrip
);
const rideInProgress = (await db.doc(`rides/${rideId}`).get()).data();
record(
  "emulator-stamp-trip-started-at",
  tripApply.stamped === true &&
    tripApply.fields.includes("tripStartedAt") &&
    hasTimestamp(rideInProgress.tripStartedAt) &&
    rideInProgress.tripStartedAt.toMillis() >= arrivedMs1
    ? "PASS"
    : "FAIL"
);

const failCount = results.filter((r) => r.status === "FAIL").length;
const passCount = results.filter((r) => r.status === "PASS").length;

fs.writeFileSync(
  OUT,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      pass: passCount,
      fail: failCount,
      results,
    },
    null,
    2
  )
);

console.log(`\nSummary: ${passCount} PASS, ${failCount} FAIL`);
if (failCount > 0) process.exit(1);
