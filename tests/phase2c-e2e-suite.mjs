/**
 * Phase 2C — end-to-end journey + functions module verification (Admin SDK / emulator).
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
if (!process.env.FIREBASE_AUTH_EMULATOR_HOST) {
  process.env.FIREBASE_AUTH_EMULATOR_HOST = "127.0.0.1:9099";
}

const results = [];
function record(name, expected, actual, status) {
  results.push({ name, expected, actual, status, suite: "phase2c-e2e" });
}

const admin = require(require.resolve("firebase-admin", { paths: [path.join(ROOT, "functions"), ROOT] }));
let app;
try {
  app = admin.app();
} catch {
  app = admin.initializeApp({ projectId: PROJECT });
}
const db = admin.firestore(app);

const { validateCandidateDriverLimit, selectCandidatesProgressive } = require(
  path.join(ROOT, "functions", "matching.js")
);
const {
  createCustomerBooking,
  matchRideCandidates,
  submitRideOffer,
  counterRideOffer,
  finalizeAssignmentFromOffer,
  evaluateCustomerBookingGate,
} = require(path.join(ROOT, "functions", "bargaining.js"));
const { settleRide } = require(path.join(ROOT, "functions", "settlement.js"));
const { linkVehicleByPin } = require(path.join(ROOT, "functions", "pin-link.js"));
const { hashVehiclePin } = require(path.join(ROOT, "functions", "pin-security.js"));
const {
  BOOTSTRAP_ADMIN_EMAIL,
  isAdminAuth,
  bootstrapAdminClaim,
  grantAdminClaim,
  revokeAdminClaim,
  setAdminEmailBootstrap,
  isEmailBootstrapEnabled,
} = require(path.join(ROOT, "functions", "admin-claims.js"));
const { migrateVehiclePins } = require(path.join(ROOT, "tools", "migrate-vehicle-pins.cjs"));

const pickup = { lat: 24.86, lng: 67.01, address: "Pickup" };
const dropoff = { lat: 24.9, lng: 67.05, address: "Drop" };

function ridePayload(fare = 200) {
  return {
    pickupLocation: pickup,
    dropoffLocation: dropoff,
    vehicleType: "go",
    vehicleTypeKey: "go",
    distanceKm: 4,
    timeMins: 12,
    farePkr: fare,
    estimatedFare: fare,
  };
}

async function main() {
  // Export surface check
  const index = require(path.join(ROOT, "functions", "index.js"));
  const required = [
    "completeRideSettlement",
    "bootstrapAdminClaim",
    "grantAdminClaim",
    "revokeAdminClaim",
    "setAdminEmailBootstrap",
    "linkVehicleByPin",
    "checkCustomerBookingGate",
    "createCustomerBooking",
    "matchRideCandidates",
    "submitRideOffer",
    "counterRideOffer",
    "finalizeAssignmentFromOffer",
    "setCandidateDriverLimit",
  ];
  const missing = required.filter((k) => typeof index[k] !== "function");
  record(
    "C01-functions-exports-complete",
    "all Phase 2 callables exported",
    missing.length ? missing.join(",") : "all present",
    missing.length ? "FAIL" : "PASS"
  );

  await db.doc("settings/pricing").set({
    commissionPercent: 10,
    vehicles: { go: { commissionPercent: 10 } },
  });
  await db.doc("settings/dispatch").set({ candidateDriverLimit: 10 });
  await db.doc("settings/security").set({ adminBootstrapEnabled: true });

  // Candidate limits
  try {
    validateCandidateDriverLimit(10);
    validateCandidateDriverLimit(20);
    let bad = false;
    try {
      validateCandidateDriverLimit(15);
    } catch {
      bad = true;
    }
    const drivers = Array.from({ length: 25 }, (_, i) => ({
      driverId: `cd${i}`,
      lat: pickup.lat + 0.001 * ((i % 5) + 1),
      lng: pickup.lng,
      status: "online",
    }));
    const n10 = selectCandidatesProgressive(pickup, drivers, 10).length;
    const n20 = selectCandidatesProgressive(pickup, drivers, 20).length;
    record(
      "C02-candidate-limits-10-20",
      "10 and 20 work; invalid rejected",
      `n10=${n10} n20=${n20} invalidRejected=${bad}`,
      n10 === 10 && n20 === 20 && bad ? "PASS" : "FAIL"
    );
  } catch (e) {
    record("C02-candidate-limits-10-20", "ok", e.message, "FAIL");
  }

  // Admin claim transition (Auth emulator; no emails in evidence)
  let adminClaimStatus = "FAIL";
  let adminClaimDetail = {};
  try {
    const auth = admin.auth();
    const bootUser = await auth.createUser({
      uid: "e2e-boot-admin",
      email: BOOTSTRAP_ADMIN_EMAIL,
      emailVerified: true,
      password: "Phase2C-test-only!",
    });
    const ordinary = await auth.createUser({
      uid: "e2e-ordinary",
      email: "ordinary-phase2c@example.com",
      emailVerified: true,
      password: "Phase2C-test-only!",
    });
    const target = await auth.createUser({
      uid: "e2e-grant-target",
      email: "grant-target-phase2c@example.com",
      emailVerified: true,
      password: "Phase2C-test-only!",
    });

    const claimOk = await isAdminAuth(db, { uid: "a1", token: { admin: true } });
    const ordinaryDenied = !(await isAdminAuth(db, {
      uid: ordinary.uid,
      token: { email: ordinary.email, email_verified: true },
    }));

    let ordinaryCannotGrant = false;
    try {
      await grantAdminClaim(
        db,
        { uid: ordinary.uid, token: { email: ordinary.email, email_verified: true } },
        target.uid
      );
    } catch (e) {
      ordinaryCannotGrant = e.message === "ADMIN_ONLY" || e.code === "permission-denied";
    }

    const boot = await bootstrapAdminClaim(db, {
      uid: bootUser.uid,
      token: { email: BOOTSTRAP_ADMIN_EMAIL, email_verified: true },
    });
    const bootClaims = (await auth.getUser(bootUser.uid)).customClaims || {};
    const adminClaimSet = boot.admin === true && bootClaims.admin === true;

    await grantAdminClaim(
      db,
      { uid: bootUser.uid, token: { admin: true } },
      target.uid
    );
    const grantedClaims = (await auth.getUser(target.uid)).customClaims || {};
    await revokeAdminClaim(
      db,
      { uid: bootUser.uid, token: { admin: true } },
      target.uid
    );
    const revokedClaims = (await auth.getUser(target.uid)).customClaims || {};
    const revokeOk = grantedClaims.admin === true && revokedClaims.admin === false;

    await setAdminEmailBootstrap(db, { uid: bootUser.uid, token: { admin: true } }, false);
    const bootstrapOff = (await isEmailBootstrapEnabled(db)) === false;
    const emailDeniedWhenOff = !(await isAdminAuth(db, {
      uid: "boot-check",
      token: { email: BOOTSTRAP_ADMIN_EMAIL, email_verified: true },
    }));
    let bootstrapCallDenied = false;
    try {
      await bootstrapAdminClaim(db, {
        uid: "another-boot",
        token: { email: BOOTSTRAP_ADMIN_EMAIL, email_verified: true },
      });
    } catch (e) {
      bootstrapCallDenied = e.message === "BOOTSTRAP_DISABLED" || e.code === "failed-precondition";
    }
    await setAdminEmailBootstrap(db, { uid: bootUser.uid, token: { admin: true } }, true);

    adminClaimDetail = {
      claimOk,
      ordinaryDenied,
      ordinaryCannotGrant,
      adminClaimSet,
      revokeOk,
      bootstrapOff,
      emailDeniedWhenOff,
      bootstrapCallDenied,
    };
    adminClaimStatus =
      claimOk &&
      ordinaryDenied &&
      ordinaryCannotGrant &&
      adminClaimSet &&
      revokeOk &&
      bootstrapOff &&
      emailDeniedWhenOff &&
      bootstrapCallDenied
        ? "PASS"
        : "FAIL";
  } catch (e) {
    adminClaimDetail = { error: e.message, authEmulator: Boolean(process.env.FIREBASE_AUTH_EMULATOR_HOST) };
    adminClaimStatus = process.env.FIREBASE_AUTH_EMULATOR_HOST ? "FAIL" : "BLOCKED";
  }
  record(
    "C03-admin-claim-transition",
    "bootstrap sets admin:true; ordinary cannot grant; revoke clears claim; bootstrap disable safe",
    JSON.stringify(adminClaimDetail),
    adminClaimStatus
  );

  // PIN migration fixtures
  await db.doc("vehicles/mig-plain").set({
    ownerId: "own",
    plate: "MIG-1",
    pin: "5555",
    status: "offline",
  });
  await db.doc("vehicles/mig-hash").set({
    ownerId: "own",
    plate: "MIG-2",
    pinHash: hashVehiclePin("6666"),
    status: "offline",
  });
  const dry = await migrateVehiclePins(db, { apply: false });
  const applied = await migrateVehiclePins(db, { apply: true });
  const afterPlain = (await db.doc("vehicles/mig-plain").get()).data();
  const afterHash = (await db.doc("vehicles/mig-hash").get()).data();
  record(
    "C04-pin-migration-emulator",
    "plaintext removed; hash present; idempotent",
    JSON.stringify({
      dryMigrated: dry.migrated,
      appliedMigrated: applied.migrated,
      plainHasPin: afterPlain?.pin != null,
      plainHasHash: Boolean(afterPlain?.pinHash),
      hashUntouched: Boolean(afterHash?.pinHash) && afterHash?.pin == null,
    }),
    dry.withPlaintextPin >= 1 &&
      !afterPlain?.pin &&
      Boolean(afterPlain?.pinHash) &&
      afterHash?.pin == null
      ? "PASS"
      : "FAIL"
  );

  // E2E journey
  await db.doc("partners/e2e-d1").set({
    role: "driver",
    accountStatus: "active",
    walletBalance: 0,
    totalEarnings: 0,
    totalRidesCompleted: 0,
  });
  await db.doc("partners/e2e-d2").set({
    role: "driver",
    accountStatus: "active",
    walletBalance: 0,
  });
  await db.doc("partners/e2e-blocked").set({
    role: "driver",
    accountStatus: "blocked",
  });
  await db.doc("vehicles/e2e-v1").set({
    ownerId: "e2e-own",
    plate: "E2E1",
    pinHash: hashVehiclePin("7777"),
    status: "offline",
  });

  const pinLink = await linkVehicleByPin(db, {
    driverUid: "e2e-d1",
    pin: "7777",
    driverName: "E2E Driver",
  });
  record(
    "C05-pin-link-callable",
    "link succeeds without returning pin",
    JSON.stringify({ ok: pinLink.ok, vehicleId: pinLink.vehicleId, hasPin: "pin" in pinLink }),
    pinLink.ok && !("pin" in pinLink) ? "PASS" : "FAIL"
  );

  const b1 = await createCustomerBooking(db, {
    customerUid: "e2e-cust",
    ridePayload: ridePayload(300),
  });
  await matchRideCandidates(db, {
    rideId: b1.id,
    pickup,
    onlineDrivers: [
      { driverId: "e2e-d1", lat: pickup.lat + 0.001, lng: pickup.lng, status: "online" },
      { driverId: "e2e-d2", lat: pickup.lat + 0.002, lng: pickup.lng, status: "online" },
      {
        driverId: "e2e-blocked",
        lat: pickup.lat + 0.0015,
        lng: pickup.lng,
        status: "online",
        accountStatus: "blocked",
      },
    ],
    candidateDriverLimit: 10,
  });
  const cands = await db.collection("ride_candidates").where("rideId", "==", b1.id).get();
  const blockedCand = cands.docs.some((d) => d.data()?.driverId === "e2e-blocked");
  record(
    "C06-booking-and-match",
    "booking created; blocked not candidate",
    `ride=${b1.id} cands=${cands.size} blockedCand=${blockedCand}`,
    b1.id && !blockedCand && cands.size >= 1 ? "PASS" : "FAIL"
  );

  const o1 = await submitRideOffer(db, {
    rideId: b1.id,
    driverUid: "e2e-d1",
    fare: 320,
    vehicleId: "e2e-v1",
    ownerId: "e2e-own",
    driverName: "E2E Driver",
    vehiclePlate: "E2E1",
  });
  await counterRideOffer(db, { offerId: o1.offerId, customerUid: "e2e-cust", fare: 310 });
  const fin = await finalizeAssignmentFromOffer(db, {
    offerId: o1.offerId,
    actorUid: "e2e-d1",
    actorRole: "driver",
  });
  const rideAssigned = (await db.doc(`rides/${b1.id}`).get()).data();
  record(
    "C07-bargain-counter-assign",
    "counter then assign one driver",
    `status=${rideAssigned?.status} driver=${rideAssigned?.driverId} fare=${fin.fare}`,
    rideAssigned?.status === "accepted" &&
      rideAssigned?.driverId === "e2e-d1" &&
      fin.fare === 310
      ? "PASS"
      : "FAIL"
  );

  // Second active ride blocked for same driver
  const b2 = await createCustomerBooking(db, {
    customerUid: "e2e-cust",
    confirmedExtraBooking: true,
    ridePayload: ridePayload(250),
  });
  await matchRideCandidates(db, {
    rideId: b2.id,
    pickup,
    onlineDrivers: [
      { driverId: "e2e-d1", lat: pickup.lat + 0.001, lng: pickup.lng, status: "online" },
      { driverId: "e2e-d2", lat: pickup.lat + 0.002, lng: pickup.lng, status: "online" },
    ],
  });
  let secondBlocked = false;
  try {
    await submitRideOffer(db, {
      rideId: b2.id,
      driverUid: "e2e-d1",
      fare: 260,
      vehicleId: "e2e-v1",
      ownerId: "e2e-own",
      driverName: "E2E Driver",
      vehiclePlate: "E2E1",
    });
  } catch (e) {
    secondBlocked = e.message === "DRIVER_HAS_ACTIVE_RIDE";
  }
  record(
    "C08-one-active-ride-enforced",
    "assigned driver cannot bargain another",
    `blocked=${secondBlocked}`,
    secondBlocked ? "PASS" : "FAIL"
  );

  // Four booking limit
  await createCustomerBooking(db, {
    customerUid: "e2e-cust",
    confirmedExtraBooking: true,
    ridePayload: ridePayload(210),
  });
  await createCustomerBooking(db, {
    customerUid: "e2e-cust",
    confirmedExtraBooking: true,
    ridePayload: ridePayload(220),
  });
  // now 4 non-terminal (b1 accepted + 3 searching) — wait b1 accepted counts, b2 searching, +2 = 4
  let fifthDenied = false;
  try {
    await createCustomerBooking(db, {
      customerUid: "e2e-cust",
      confirmedExtraBooking: true,
      ridePayload: ridePayload(230),
    });
  } catch (e) {
    fifthDenied = e.message === "MAX_ACTIVE_BOOKINGS";
  }
  const gate = await evaluateCustomerBookingGate(db, "e2e-cust", { confirmedExtraBooking: true });
  record(
    "C09-four-booking-limit",
    "fifth rejected while four non-terminal exist",
    `fifthDenied=${fifthDenied} allowed=${gate.allowed} reason=${gate.reason}`,
    fifthDenied && !gate.allowed ? "PASS" : "FAIL"
  );

  // Progress + settle once
  await db.doc(`rides/${b1.id}`).update({ status: "arrived" });
  await db.doc(`rides/${b1.id}`).update({ status: "in_progress" });
  const settle1 = await settleRide(db, {
    rideId: b1.id,
    collectionName: "rides",
    callerUid: "e2e-d1",
  });
  const [settleA, settleB] = await Promise.all([
    settleRide(db, { rideId: b1.id, collectionName: "rides", callerUid: "e2e-d1" }),
    settleRide(db, { rideId: b1.id, collectionName: "rides", callerUid: "e2e-d1" }),
  ]);
  const ledgers = await db.collection("ledger_transactions").where("rideId", "==", b1.id).get();
  const partner = (await db.doc("partners/e2e-d1").get()).data();
  const audits = await db.collection("audit_logs").where("rideId", "==", b1.id).get();
  const expectedCommission = Math.round((310 * 10) / 100);
  const expectedEarn = 310 - expectedCommission;
  record(
    "C10-settlement-once",
    "one ledger; wallet/earnings correct; repeat idempotent",
    JSON.stringify({
      commission: settle1.commissionAmount,
      earn: settle1.driverEarnings,
      ledgerCount: ledgers.size,
      wallet: partner?.walletBalance,
      totalEarnings: partner?.totalEarnings,
      alreadyA: settleA.alreadySettled,
      alreadyB: settleB.alreadySettled,
      audits: audits.size,
    }),
    settle1.commissionAmount === expectedCommission &&
      settle1.driverEarnings === expectedEarn &&
      ledgers.size === 1 &&
      partner?.walletBalance === -expectedCommission &&
      partner?.totalEarnings === expectedEarn &&
      settleA.alreadySettled &&
      settleB.alreadySettled
      ? "PASS"
      : "FAIL"
  );

  // Unauthorized settle
  let wrongDenied = false;
  await db.doc("rides/e2e-wrong").set({
    userId: "e2e-cust",
    status: "in_progress",
    driverId: "e2e-d2",
    farePkr: 100,
    estimatedFare: 100,
    vehicleTypeKey: "go",
    pickupLocation: pickup,
    dropoffLocation: dropoff,
    vehicleType: "go",
    distanceKm: 1,
    timeMins: 5,
    createdAt: admin.firestore.Timestamp.now(),
  });
  try {
    await settleRide(db, { rideId: "e2e-wrong", callerUid: "e2e-d1" });
  } catch (e) {
    wrongDenied = e.message === "NOT_ASSIGNED_DRIVER";
  }
  record(
    "C11-unauthorized-settlement-denied",
    "wrong driver denied",
    `denied=${wrongDenied}`,
    wrongDenied ? "PASS" : "FAIL"
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
    path.join(ROOT, "tests", "phase2c-e2e-results.json"),
    JSON.stringify(out, null, 2)
  );
  console.log(`[phase2c-e2e] passed=${passed} failed=${failed} blocked=${blocked}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
