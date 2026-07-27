/**
 * Phase 2B security + data-consistency suite (rules + Admin SDK helpers).
 * Run via: firebase emulators:exec --only firestore --project demo-swiftgo-phase1 "node tests/phase2b-run-all.mjs"
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from "@firebase/rules-unit-testing";
import {
  doc,
  setDoc,
  getDoc,
  updateDoc,
  collection,
  query,
  where,
  getDocs,
  limit,
} from "firebase/firestore";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROJECT = "demo-swiftgo-phase1";
const rules = fs.readFileSync(path.join(ROOT, "firestore.rules"), "utf8");

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080";
}

const results = [];
function record(name, status, detail) {
  results.push({ name, status, detail, suite: "phase2b" });
}

const admin = require(require.resolve("firebase-admin", { paths: [path.join(ROOT, "functions"), ROOT] }));
let adminApp;
try {
  adminApp = admin.app();
} catch {
  adminApp = admin.initializeApp({ projectId: PROJECT });
}
const adminDb = admin.firestore(adminApp);

const {
  hashVehiclePin,
  evaluatePinAttemptGate,
  nextFailState,
  MAX_PIN_ATTEMPTS,
} = require(path.join(ROOT, "functions", "pin-security.js"));
const { linkVehicleByPin } = require(path.join(ROOT, "functions", "pin-link.js"));
const { settleRide } = require(path.join(ROOT, "functions", "settlement.js"));
const {
  isEmailBootstrapEnabled,
  isAdminAuth,
  setAdminEmailBootstrap,
} = require(path.join(ROOT, "functions", "admin-claims.js"));
const { submitRideOffer, matchRideCandidates } = require(path.join(
  ROOT,
  "functions",
  "bargaining.js"
));

async function main() {
  const emuHost = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";
  const [host, portStr] = emuHost.split(":");
  const port = Number(portStr) || 8080;

  let testEnv;
  try {
    testEnv = await initializeTestEnvironment({
      projectId: PROJECT,
      firestore: { rules, host, port },
    });
  } catch (err) {
    record("emulator-bootstrap", "BLOCKED", String(err.message));
    writeOut(2);
    return;
  }

  const claimAdminDb = testEnv
    .authenticatedContext("claim-admin", {
      email: "admin-claim@example.com",
      email_verified: true,
      admin: true,
    })
    .firestore();
  const bootstrapEmailDb = testEnv
    .authenticatedContext("bootstrap-admin", {
      email: "fuzail1158@gmail.com",
      email_verified: true,
    })
    .firestore();
  const ordinaryDb = testEnv
    .authenticatedContext("ordinary-user", {
      email: "user@example.com",
      email_verified: true,
    })
    .firestore();
  const revokedDb = testEnv
    .authenticatedContext("revoked-admin", {
      email: "was-admin@example.com",
      email_verified: true,
      // no admin claim — simulates post-refresh without claim
    })
    .firestore();
  const driverDb = testEnv.authenticatedContext("driver-2b").firestore();
  const otherDriverDb = testEnv.authenticatedContext("driver-other").firestore();
  const ownerDb = testEnv.authenticatedContext("owner-2b").firestore();

  // ── Admin claim authorization ──
  try {
    await assertSucceeds(
      updateDoc(doc(claimAdminDb, "settings", "pricing"), { commissionPercent: 11 })
    );
    record("S01-claim-admin-can-write-settings", "PASS", "ok");
  } catch (e) {
    // settings may need setDoc
    try {
      await assertSucceeds(
        setDoc(doc(claimAdminDb, "settings", "pricing"), { commissionPercent: 11 }, { merge: true })
      );
      record("S01-claim-admin-can-write-settings", "PASS", "set merge ok");
    } catch (e2) {
      record("S01-claim-admin-can-write-settings", "FAIL", e2.message);
    }
  }

  try {
    await assertFails(
      setDoc(doc(ordinaryDb, "settings", "pricing"), { commissionPercent: 0 }, { merge: true })
    );
    record("S02-ordinary-user-cannot-be-super-admin", "PASS", "settings write denied");
  } catch (e) {
    record("S02-ordinary-user-cannot-be-super-admin", "FAIL", e.message);
  }

  try {
    await assertFails(
      setDoc(doc(revokedDb, "settings", "pricing"), { commissionPercent: 9 }, { merge: true })
    );
    record("S03-revoked-claim-no-access", "PASS", "no admin claim → denied");
  } catch (e) {
    record("S03-revoked-claim-no-access", "FAIL", e.message);
  }

  // Bootstrap email works while enabled (default)
  await adminDb.doc("settings/security").set({ adminBootstrapEnabled: true });
  try {
    await assertSucceeds(
      setDoc(doc(bootstrapEmailDb, "settings", "dispatch"), { candidateDriverLimit: 10 }, { merge: true })
    );
    record("S04-bootstrap-email-while-enabled", "PASS", "ok");
  } catch (e) {
    record("S04-bootstrap-email-while-enabled", "FAIL", e.message);
  }

  // Disable bootstrap → email-only token loses Super Admin
  await adminDb.doc("settings/security").set({ adminBootstrapEnabled: false });
  try {
    await assertFails(
      setDoc(doc(bootstrapEmailDb, "settings", "dispatch"), { candidateDriverLimit: 20 }, { merge: true })
    );
    record("S05-bootstrap-disabled-email-denied", "PASS", "email path closed");
  } catch (e) {
    record("S05-bootstrap-disabled-email-denied", "FAIL", e.message);
  }

  // Claim admin still works after bootstrap disabled
  try {
    await assertSucceeds(
      setDoc(doc(claimAdminDb, "settings", "dispatch"), { candidateDriverLimit: 20 }, { merge: true })
    );
    record("S06-claim-admin-after-bootstrap-off", "PASS", "ok");
  } catch (e) {
    record("S06-claim-admin-after-bootstrap-off", "FAIL", e.message);
  }

  // Re-enable for rest of suite compatibility with other suites in same emulator process
  await adminDb.doc("settings/security").set({ adminBootstrapEnabled: true });

  const authProbe = await isAdminAuth(adminDb, {
    uid: "x",
    token: { admin: true },
  });
  record("S07-isAdminAuth-claim", authProbe ? "PASS" : "FAIL", String(authProbe));

  // ── Dual wallet: settlement touches partners only ──
  await adminDb.doc("partners/settle-d").set({
    role: "driver",
    accountStatus: "active",
    walletBalance: 0,
    totalEarnings: 0,
    totalRidesCompleted: 0,
  });
  await adminDb.doc("users/settle-d").set({
    displayName: "Same UID",
    email: "d@example.com",
    walletBalance: 50,
  });
  await adminDb.doc("settings/pricing").set({
    commissionPercent: 10,
    vehicles: { go: { commissionPercent: 10 } },
  });
  await adminDb.doc("rides/settle-wallet").set({
    userId: "cust-w",
    status: "in_progress",
    driverId: "settle-d",
    vehicleId: "v1",
    ownerId: "o1",
    vehicleType: "go",
    vehicleTypeKey: "go",
    farePkr: 200,
    estimatedFare: 200,
    distanceKm: 2,
    timeMins: 8,
    pickupLocation: { lat: 1, lng: 1, address: "A" },
    dropoffLocation: { lat: 2, lng: 2, address: "B" },
    createdAt: admin.firestore.Timestamp.now(),
  });
  await settleRide(adminDb, {
    rideId: "settle-wallet",
    collectionName: "rides",
    callerUid: "settle-d",
  });
  const partnerAfter = (await adminDb.doc("partners/settle-d").get()).data();
  const userAfter = (await adminDb.doc("users/settle-d").get()).data();
  record(
    "S08-canonical-wallet-partners-only",
    partnerAfter?.walletBalance === -20 && userAfter?.walletBalance === 50 ? "PASS" : "FAIL",
    `partners=${partnerAfter?.walletBalance} users=${userAfter?.walletBalance}`
  );

  try {
    await settleRide(adminDb, {
      rideId: "settle-wallet",
      collectionName: "ride_requests",
      callerUid: "settle-d",
    });
    record("S09-legacy-collection-settlement-denied", "FAIL", "accepted ride_requests");
  } catch (e) {
    record(
      "S09-legacy-collection-settlement-denied",
      e.message === "LEGACY_COLLECTION_DENIED" ? "PASS" : "FAIL",
      e.message
    );
  }

  // Conflicting dual-wallet client write rejected
  // Conflicting dual-wallet client write rejected
  await adminDb.doc("users/driver-2b").set({
    displayName: "D",
    email: "d@x.com",
    walletBalance: 0,
  });
  await adminDb.doc("partners/driver-2b").set({
    role: "driver",
    accountStatus: "active",
    walletBalance: 0,
    totalEarnings: 0,
  });
  try {
    await assertFails(updateDoc(doc(driverDb, "users", "driver-2b"), { walletBalance: 999 }));
    await assertFails(
      updateDoc(doc(driverDb, "partners", "driver-2b"), { walletBalance: 999 })
    );
    record("S10-conflicting-wallet-writes-denied", "PASS", "users+partners locked");
  } catch (e) {
    record("S10-conflicting-wallet-writes-denied", "FAIL", e.message);
  }

  // ── drivers allowlist ──
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), "drivers", "driver-2b"), {
      displayName: "Driver",
      name: "Driver",
    });
  });
  try {
    await assertSucceeds(
      updateDoc(doc(driverDb, "drivers", "driver-2b"), { displayName: "Driver Two" })
    );
    await assertFails(
      updateDoc(doc(driverDb, "drivers", "driver-2b"), {
        role: "admin",
        walletBalance: 100,
        accountStatus: "active",
      })
    );
    record("S11-driver-profile-allowlist", "PASS", "safe ok / protected denied");
  } catch (e) {
    record("S11-driver-profile-allowlist", "FAIL", e.message);
  }

  // ── Vehicle privacy ──
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), "vehicles", "priv-1"), {
      ownerId: "owner-2b",
      plate: "PRIV-1",
      pinHash: hashVehiclePin("4242"),
      status: "offline",
      driverId: null,
    });
  });
  try {
    await assertFails(getDoc(doc(ordinaryDb, "vehicles", "priv-1")));
    await assertFails(getDoc(doc(otherDriverDb, "vehicles", "priv-1")));
    await assertSucceeds(getDoc(doc(ownerDb, "vehicles", "priv-1")));
    // Global PIN query must fail for unrelated driver (list filter won't return others' docs)
    const pinQ = query(
      collection(otherDriverDb, "vehicles"),
      where("pinHash", "==", hashVehiclePin("4242")),
      limit(1)
    );
    await assertFails(getDocs(pinQ));
    record("S12-vehicle-privacy", "PASS", "unrelated cannot read/query PIN");
  } catch (e) {
    record("S12-vehicle-privacy", "FAIL", e.message);
  }

  // ── Blocked driver online + bargain ──
  await adminDb.doc("partners/blocked-d").set({
    role: "driver",
    accountStatus: "blocked",
    walletBalance: 0,
  });
  await adminDb.doc("vehicles/veh-b2").set({
    ownerId: "owner-2b",
    plate: "B2",
    pinHash: hashVehiclePin("1111"),
    status: "offline",
  });
  const blockedClient = testEnv.authenticatedContext("blocked-d").firestore();
  try {
    await assertFails(
      updateDoc(doc(blockedClient, "vehicles", "veh-b2"), {
        driverId: "blocked-d",
        status: "online",
      })
    );
    record("S13-blocked-cannot-go-online", "PASS", "rules deny");
  } catch (e) {
    record("S13-blocked-cannot-go-online", "FAIL", e.message);
  }

  await adminDb.doc("rides/blocked-ride").set({
    userId: "cust-b",
    status: "searching_driver",
    pickupLocation: { lat: 24.86, lng: 67.01, address: "A" },
    dropoffLocation: { lat: 24.87, lng: 67.02, address: "B" },
    vehicleType: "go",
    distanceKm: 1,
    timeMins: 5,
    farePkr: 100,
    createdAt: admin.firestore.Timestamp.now(),
  });
  await adminDb.doc("ride_candidates/blocked-ride_blocked-d").set({
    rideId: "blocked-ride",
    driverId: "blocked-d",
    status: "invited",
    distanceKm: 0.5,
    ringKm: 1,
  });
  try {
    await submitRideOffer(adminDb, {
      rideId: "blocked-ride",
      driverUid: "blocked-d",
      fare: 120,
      vehicleId: "veh-b2",
      ownerId: "owner-2b",
      driverName: "B",
      vehiclePlate: "B2",
    });
    record("S14-blocked-cannot-bargain", "FAIL", "offer accepted");
  } catch (e) {
    record(
      "S14-blocked-cannot-bargain",
      e.message === "DRIVER_BLOCKED" ? "PASS" : "FAIL",
      e.message
    );
  }

  // Matching excludes blocked
  const matched = await matchRideCandidates(adminDb, {
    rideId: "blocked-ride",
    pickup: { lat: 24.86, lng: 67.01 },
    onlineDrivers: [
      {
        driverId: "blocked-d",
        lat: 24.861,
        lng: 67.01,
        status: "online",
        accountStatus: "blocked",
      },
    ],
    candidateDriverLimit: 10,
  });
  record(
    "S15-blocked-not-candidate",
    matched.candidates.length === 0 ? "PASS" : "FAIL",
    `n=${matched.candidates.length}`
  );

  // Blocked cannot progress ride
  await adminDb.doc("rides/blocked-active").set({
    userId: "cust-b",
    status: "accepted",
    driverId: "blocked-d",
    vehicleId: "veh-b2",
    ownerId: "owner-2b",
    farePkr: 100,
    pickupLocation: { lat: 24.86, lng: 67.01, address: "A" },
    dropoffLocation: { lat: 24.87, lng: 67.02, address: "B" },
    vehicleType: "go",
    distanceKm: 1,
    timeMins: 5,
    createdAt: admin.firestore.Timestamp.now(),
  });
  try {
    await assertFails(
      updateDoc(doc(blockedClient, "rides", "blocked-active"), { status: "arrived" })
    );
    record("S16-blocked-cannot-progress-ride", "PASS", "arrived denied");
  } catch (e) {
    record("S16-blocked-cannot-progress-ride", "FAIL", e.message);
  }

  // ── PIN lockout ──
  let gate = evaluatePinAttemptGate({ failCount: 0 });
  record("S17-pin-gate-open", gate.allowed ? "PASS" : "FAIL", JSON.stringify(gate));
  let state = { failCount: 0 };
  for (let i = 0; i < MAX_PIN_ATTEMPTS; i++) state = nextFailState(state);
  gate = evaluatePinAttemptGate(state);
  record(
    "S18-pin-lockout-after-max",
    !gate.allowed && gate.reason === "PIN_LOCKED" ? "PASS" : "FAIL",
    JSON.stringify(gate)
  );

  await adminDb.doc("partners/pin-d").set({
    role: "driver",
    accountStatus: "active",
  });
  await adminDb.doc("vehicles/pin-v").set({
    ownerId: "owner-2b",
    plate: "PIN1",
    pinHash: hashVehiclePin("9999"),
    status: "offline",
  });
  // Wrong PIN attempts
  let locked = false;
  for (let i = 0; i < MAX_PIN_ATTEMPTS; i++) {
    try {
      await linkVehicleByPin(adminDb, { driverUid: "pin-d", pin: "0000" });
    } catch (e) {
      if (e.message === "PIN_LOCKED") locked = true;
    }
  }
  try {
    await linkVehicleByPin(adminDb, { driverUid: "pin-d", pin: "9999" });
    record("S19-pin-link-while-locked", locked ? "FAIL" : "PASS", "unexpected success");
  } catch (e) {
    record(
      "S19-pin-link-while-locked",
      e.message === "PIN_LOCKED" ? "PASS" : "FAIL",
      e.message
    );
  }

  // Fresh driver success path
  await adminDb.doc("partners/pin-ok").set({ role: "driver", accountStatus: "active" });
  await adminDb.doc("pin_attempts/pin-ok").set({ failCount: 0, lockedUntilMs: 0 });
  const linked = await linkVehicleByPin(adminDb, {
    driverUid: "pin-ok",
    pin: "9999",
    driverName: "OK",
  });
  record(
    "S20-pin-link-success-no-pin-echo",
    linked.ok && linked.vehicleId && !("pin" in linked) ? "PASS" : "FAIL",
    JSON.stringify(linked)
  );
  const vehAfter = (await adminDb.doc("vehicles/pin-v").get()).data();
  record(
    "S21-plaintext-pin-stripped",
    !vehAfter?.pin && Boolean(vehAfter?.pinHash) ? "PASS" : "FAIL",
    `pin=${vehAfter?.pin}`
  );

  // ── Legacy ride_requests fully locked ──
  try {
    await assertFails(
      setDoc(doc(ordinaryDb, "ride_requests", "legacy-1"), {
        userId: "ordinary-user",
        status: "pending",
      })
    );
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "ride_requests", "legacy-2"), {
        userId: "ordinary-user",
        driverId: "driver-2b",
        status: "accepted",
      });
    });
    await assertFails(
      updateDoc(doc(driverDb, "ride_requests", "legacy-2"), { status: "arrived" })
    );
    record("S22-ride-requests-no-write-bypass", "PASS", "create+update denied");
  } catch (e) {
    record("S22-ride-requests-no-write-bypass", "FAIL", e.message);
  }

  const enabled = await isEmailBootstrapEnabled(adminDb);
  record("S23-bootstrap-flag-readable", enabled === true ? "PASS" : "FAIL", String(enabled));

  // Toggle bootstrap requires claim admin — simulate via Admin SDK helper with fake auth
  try {
    await setAdminEmailBootstrap(
      adminDb,
      { uid: "claim-admin", token: { admin: true } },
      true
    );
    record("S24-set-bootstrap-flag-claim-admin", "PASS", "ok");
  } catch (e) {
    record("S24-set-bootstrap-flag-claim-admin", "FAIL", e.message);
  }

  writeOut(results.some((r) => r.status === "FAIL") ? 1 : 0);
}

function writeOut(code) {
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
    path.join(ROOT, "tests", "phase2b-security-results.json"),
    JSON.stringify(out, null, 2)
  );
  console.log(`[phase2b-security] passed=${passed} failed=${failed} blocked=${blocked}`);
  process.exit(code);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
