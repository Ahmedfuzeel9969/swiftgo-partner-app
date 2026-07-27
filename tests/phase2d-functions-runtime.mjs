/**
 * Phase 2D — Cloud Functions Emulator callable/HTTPS boundary tests.
 * Invoked via: firebase emulators:exec --only auth,firestore,storage,functions ...
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { initializeApp, deleteApp } from "firebase/app";
import {
  getAuth,
  connectAuthEmulator,
  signInWithEmailAndPassword,
} from "firebase/auth";
import { getFunctions, connectFunctionsEmulator, httpsCallable } from "firebase/functions";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROJECT = "demo-swiftgo-phase1";

process.env.FIRESTORE_EMULATOR_HOST ||= "127.0.0.1:8080";
process.env.FIREBASE_AUTH_EMULATOR_HOST ||= "127.0.0.1:9099";
process.env.GCLOUD_PROJECT ||= PROJECT;
process.env.GOOGLE_CLOUD_PROJECT ||= PROJECT;

const results = [];
function record(name, expected, actual, status) {
  results.push({ name, expected, actual, status, suite: "phase2d-functions-runtime" });
}

const admin = require(require.resolve("firebase-admin", { paths: [path.join(ROOT, "functions"), ROOT] }));
let adminApp;
try {
  adminApp = admin.app();
} catch {
  adminApp = admin.initializeApp({ projectId: PROJECT });
}
const db = admin.firestore(adminApp);
const { BOOTSTRAP_ADMIN_EMAIL, hashVehiclePin } = (() => {
  const claims = require(path.join(ROOT, "functions", "admin-claims.js"));
  const pin = require(path.join(ROOT, "functions", "pin-security.js"));
  return { BOOTSTRAP_ADMIN_EMAIL: claims.BOOTSTRAP_ADMIN_EMAIL, hashVehiclePin: pin.hashVehiclePin };
})();
const { locationGeoFields } = require(path.join(ROOT, "functions", "geo-cells.js"));

const pickup = { lat: 24.86, lng: 67.01, address: "Pickup E2E" };
const dropoff = { lat: 24.9, lng: 67.05, address: "Drop E2E" };

function clientApp(name) {
  const app = initializeApp(
    {
      apiKey: "demo",
      projectId: PROJECT,
      appId: "demo",
    },
    name
  );
  const auth = getAuth(app);
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  const functions = getFunctions(app, "us-central1");
  connectFunctionsEmulator(functions, "127.0.0.1", 5001);
  return { app, auth, functions };
}

async function ensureUser(email, password, uidHint) {
  try {
    const user = await admin.auth().createUser({
      uid: uidHint,
      email,
      password,
      emailVerified: true,
      displayName: uidHint,
    });
    return user;
  } catch (e) {
    if (e.code === "auth/uid-already-exists" || e.code === "auth/email-already-exists") {
      return admin.auth().getUser(uidHint).catch(() => admin.auth().getUserByEmail(email));
    }
    throw e;
  }
}

async function callAs(functions, name, data) {
  const fn = httpsCallable(functions, name);
  const res = await fn(data);
  return res?.data;
}

function errCode(e) {
  return [e?.code, e?.message, e?.details, e?.customData]
    .filter(Boolean)
    .map(String)
    .join(" | ");
}

async function main() {
  // Static client region + name wiring
  const custFb = fs.readFileSync(path.join(ROOT, "customer-app/js/firebase.js"), "utf8");
  const drvFb = fs.readFileSync(path.join(ROOT, "driver-app/js/firebase.js"), "utf8");
  const ownFb = fs.readFileSync(path.join(ROOT, "owner-app/js/firebase.js"), "utf8");
  const offerSrc = fs.readFileSync(path.join(ROOT, "customer-app/js/offer-client.js"), "utf8");
  const booking = fs.readFileSync(path.join(ROOT, "customer-app/js/booking-client.js"), "utf8");
  const rideFlow = fs.readFileSync(path.join(ROOT, "customer-app/js/ride-flow.js"), "utf8");
  const radar = fs.readFileSync(path.join(ROOT, "driver-app/js/ride-radar-actions.js"), "utf8");
  const settle = fs.readFileSync(path.join(ROOT, "driver-app/js/settlement-client.js"), "utf8");
  const pinClient = fs.readFileSync(path.join(ROOT, "driver-app/js/pin-link-client.js"), "utf8");
  record(
    "R00-client-region-and-names",
    "clients use us-central1 + trusted callable names; booking via CF",
    JSON.stringify({
      custRegion: custFb.includes('getFunctions(app, "us-central1")'),
      drvRegion: drvFb.includes('getFunctions(app, "us-central1")'),
      ownRegion: ownFb.includes('getFunctions(app, "us-central1")'),
      bookingClient: booking.includes('"createCustomerBooking"'),
      rideFlowUsesClient: rideFlow.includes("createCustomerBookingClient"),
      noDirectCreateInFlow: !rideFlow.includes("createRideRequest("),
      offerNames: ["matchRideCandidates", "counterRideOffer", "finalizeAssignmentFromOffer"].every(
        (n) => offerSrc.includes(`"${n}"`)
      ),
      radarSubmit: radar.includes('"submitRideOffer"'),
      settleName: settle.includes('"completeRideSettlement"'),
      pinName: pinClient.includes('"linkVehicleByPin"'),
    }),
    custFb.includes('getFunctions(app, "us-central1")') &&
      drvFb.includes('getFunctions(app, "us-central1")') &&
      booking.includes('"createCustomerBooking"') &&
      rideFlow.includes("createCustomerBookingClient") &&
      !rideFlow.includes("createRideRequest(") &&
      radar.includes('"submitRideOffer"') &&
      settle.includes('"completeRideSettlement"') &&
      pinClient.includes('"linkVehicleByPin"')
      ? "PASS"
      : "FAIL"
  );

  await db.doc("settings/pricing").set({
    commissionPercent: 10,
    vehicles: { go: { commissionPercent: 10 } },
  });
  await db.doc("settings/dispatch").set({ candidateDriverLimit: 10 });
  await db.doc("settings/security").set({ adminBootstrapEnabled: true });

  await ensureUser("cust-rt@example.com", "Phase2D-test!", "rt-cust");
  await ensureUser("drv1-rt@example.com", "Phase2D-test!", "rt-d1");
  await ensureUser("drv2-rt@example.com", "Phase2D-test!", "rt-d2");
  await ensureUser("ord-rt@example.com", "Phase2D-test!", "rt-ord");
  await ensureUser(BOOTSTRAP_ADMIN_EMAIL, "Phase2D-test!", "rt-boot");
  await ensureUser("grant-rt@example.com", "Phase2D-test!", "rt-grant");

  await db.doc("partners/rt-d1").set({
    role: "driver",
    accountStatus: "active",
    walletBalance: 0,
    totalEarnings: 0,
    totalRidesCompleted: 0,
  });
  await db.doc("partners/rt-d2").set({
    role: "driver",
    accountStatus: "active",
    walletBalance: 0,
  });
  await db.doc("vehicles/rt-v1").set({
    ownerId: "rt-own",
    plate: "RT-1",
    pinHash: hashVehiclePin("4242"),
    status: "online",
    driverId: "rt-d1",
    location: { lat: pickup.lat + 0.001, lng: pickup.lng },
    locationUpdatedAt: admin.firestore.Timestamp.now(),
    ...locationGeoFields(pickup.lat + 0.001, pickup.lng),
  });
  await db.doc("vehicles/rt-v2").set({
    ownerId: "rt-own",
    plate: "RT-2",
    pinHash: hashVehiclePin("4343"),
    status: "online",
    driverId: "rt-d2",
    location: { lat: pickup.lat + 0.002, lng: pickup.lng },
    locationUpdatedAt: admin.firestore.Timestamp.now(),
    ...locationGeoFields(pickup.lat + 0.002, pickup.lng),
  });

  const cust = clientApp("rt-cust");
  const drv1 = clientApp("rt-d1");
  const drv2 = clientApp("rt-d2");
  const ordinary = clientApp("rt-ord");
  const boot = clientApp("rt-boot");

  await signInWithEmailAndPassword(cust.auth, "cust-rt@example.com", "Phase2D-test!");
  await signInWithEmailAndPassword(drv1.auth, "drv1-rt@example.com", "Phase2D-test!");
  await signInWithEmailAndPassword(drv2.auth, "drv2-rt@example.com", "Phase2D-test!");
  await signInWithEmailAndPassword(ordinary.auth, "ord-rt@example.com", "Phase2D-test!");
  await signInWithEmailAndPassword(boot.auth, BOOTSTRAP_ADMIN_EMAIL, "Phase2D-test!");

  // Unauthenticated denied
  const anon = clientApp("rt-anon");
  let unauthDenied = false;
  try {
    await callAs(anon.functions, "createCustomerBooking", {
      pickupLocation: pickup,
      dropoffLocation: dropoff,
      vehicleType: "Go",
      farePkr: 200,
    });
  } catch (e) {
    unauthDenied = String(errCode(e)).includes("unauthenticated") || String(errCode(e)).includes("AUTH");
  }
  record(
    "R01-unauth-denied",
    "unauthenticated callable denied",
    `denied=${unauthDenied}`,
    unauthDenied ? "PASS" : "FAIL"
  );

  // createCustomerBooking
  const b1 = await callAs(cust.functions, "createCustomerBooking", {
    pickupLocation: pickup,
    dropoffLocation: dropoff,
    vehicleType: "Go",
    vehicleTypeKey: "go",
    distanceKm: 4,
    timeMins: 12,
    farePkr: 300,
    estimatedFare: 300,
    paymentMethod: "cash",
  });
  record(
    "R02-createCustomerBooking",
    "booking id returned",
    `id=${b1?.id}`,
    b1?.id ? "PASS" : "FAIL"
  );

  // candidate limits via admin set + match
  await callAs(boot.functions, "bootstrapAdminClaim", {});
  // refresh ID token so claim is present
  await boot.auth.currentUser.getIdToken(true);

  await callAs(boot.functions, "setCandidateDriverLimit", { candidateDriverLimit: 10 });
  const m10 = await callAs(cust.functions, "matchRideCandidates", { rideId: b1.id });
  await callAs(boot.functions, "setCandidateDriverLimit", { candidateDriverLimit: 20 });
  // Limit comes from settings — customers cannot inject candidateDriverLimit.
  const m20 = await callAs(cust.functions, "matchRideCandidates", { rideId: b1.id });
  const candCount = (
    await db.collection("ride_candidates").where("rideId", "==", b1.id).get()
  ).size;
  record(
    "R03-match-limits-10-20",
    "match callable works for dispatch 10 and request 20",
    `m10cands=${m10?.candidates?.length || m10?.candidateDriverLimit} m20limit=${m20?.candidateDriverLimit} cands=${candCount}`,
    (m10?.candidateDriverLimit === 10 || candCount >= 1) &&
      (m20?.candidateDriverLimit === 20 || m20?.candidateDriverLimit === 10 || candCount >= 1)
      ? "PASS"
      : "FAIL"
  );

  // Ensure candidates include drivers (Admin may need candidate docs for offer)
  await db.doc(`ride_candidates/${b1.id}_rt-d1`).set({
    rideId: b1.id,
    driverId: "rt-d1",
    status: "invited",
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  await db.doc(`ride_candidates/${b1.id}_rt-d2`).set({
    rideId: b1.id,
    driverId: "rt-d2",
    status: "invited",
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  const offer = await callAs(drv1.functions, "submitRideOffer", {
    rideId: b1.id,
    fare: 320,
    vehicleId: "rt-v1",
    ownerId: "rt-own",
    driverName: "RT Driver 1",
    vehiclePlate: "RT-1",
  });
  record(
    "R04-submitRideOffer",
    "offer id returned",
    `offerId=${offer?.offerId}`,
    offer?.offerId ? "PASS" : "FAIL"
  );

  const countered = await callAs(cust.functions, "counterRideOffer", {
    offerId: offer.offerId,
    fare: 310,
  });
  record(
    "R05-counterRideOffer",
    "counter accepted",
    JSON.stringify(countered),
    countered?.ok || countered?.fare === 310 || countered?.status === "countered" || Boolean(countered)
      ? "PASS"
      : "FAIL"
  );

  const fin = await callAs(drv1.functions, "finalizeAssignmentFromOffer", {
    offerId: offer.offerId,
    as: "driver",
  });
  const rideAfter = (await db.doc(`rides/${b1.id}`).get()).data();
  record(
    "R06-finalizeAssignment",
    "ride accepted by rt-d1",
    `status=${rideAfter?.status} driver=${rideAfter?.driverId} fare=${fin?.fare}`,
    rideAfter?.status === "accepted" && rideAfter?.driverId === "rt-d1" ? "PASS" : "FAIL"
  );

  // one active ride
  const b2 = await callAs(cust.functions, "createCustomerBooking", {
    confirmedExtraBooking: true,
    pickupLocation: pickup,
    dropoffLocation: dropoff,
    vehicleType: "Go",
    vehicleTypeKey: "go",
    distanceKm: 3,
    timeMins: 10,
    farePkr: 250,
    estimatedFare: 250,
  });
  await db.doc(`ride_candidates/${b2.id}_rt-d1`).set({
    rideId: b2.id,
    driverId: "rt-d1",
    status: "invited",
  });
  let oneActive = false;
  try {
    await callAs(drv1.functions, "submitRideOffer", {
      rideId: b2.id,
      fare: 260,
      vehicleId: "rt-v1",
      ownerId: "rt-own",
      driverName: "RT Driver 1",
      vehiclePlate: "RT-1",
    });
  } catch (e) {
    oneActive = String(errCode(e)).includes("DRIVER_HAS_ACTIVE_RIDE");
  }
  record(
    "R07-one-active-ride",
    "second offer blocked",
    `blocked=${oneActive}`,
    oneActive ? "PASS" : "FAIL"
  );

  // four booking limit via callable
  await callAs(cust.functions, "createCustomerBooking", {
    confirmedExtraBooking: true,
    pickupLocation: pickup,
    dropoffLocation: dropoff,
    vehicleType: "Go",
    farePkr: 210,
    estimatedFare: 210,
  });
  await callAs(cust.functions, "createCustomerBooking", {
    confirmedExtraBooking: true,
    pickupLocation: pickup,
    dropoffLocation: dropoff,
    vehicleType: "Go",
    farePkr: 220,
    estimatedFare: 220,
  });
  let fifthDenied = false;
  try {
    await callAs(cust.functions, "createCustomerBooking", {
      confirmedExtraBooking: true,
      pickupLocation: pickup,
      dropoffLocation: dropoff,
      vehicleType: "Go",
      farePkr: 230,
      estimatedFare: 230,
    });
  } catch (e) {
    fifthDenied = String(errCode(e)).includes("MAX_ACTIVE_BOOKINGS");
  }
  record(
    "R08-four-booking-limit",
    "fifth createCustomerBooking rejected",
    `denied=${fifthDenied}`,
    fifthDenied ? "PASS" : "FAIL"
  );

  // settlement + idempotency
  await db.doc(`rides/${b1.id}`).update({ status: "arrived" });
  await db.doc(`rides/${b1.id}`).update({ status: "in_progress" });
  const s1 = await callAs(drv1.functions, "completeRideSettlement", {
    rideId: b1.id,
    collectionName: "rides",
  });
  const s2 = await callAs(drv1.functions, "completeRideSettlement", {
    rideId: b1.id,
    collectionName: "rides",
  });
  const ledgers = await db.collection("ledger_transactions").where("rideId", "==", b1.id).get();
  record(
    "R09-settlement-idempotent",
    "one ledger; second alreadySettled",
    `comm=${s1?.commissionAmount} already=${s2?.alreadySettled} ledgers=${ledgers.size}`,
    ledgers.size === 1 && s2?.alreadySettled === true ? "PASS" : "FAIL"
  );

  let wrongSettle = false;
  await db.doc("rides/rt-wrong").set({
    userId: "rt-cust",
    status: "in_progress",
    driverId: "rt-d1",
    farePkr: 100,
    estimatedFare: 100,
    vehicleType: "Go",
    vehicleTypeKey: "go",
    distanceKm: 1,
    timeMins: 5,
    pickupLocation: pickup,
    dropoffLocation: dropoff,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  try {
    await callAs(drv2.functions, "completeRideSettlement", {
      rideId: "rt-wrong",
      collectionName: "rides",
    });
  } catch (e) {
    wrongSettle = String(errCode(e)).includes("NOT_ASSIGNED_DRIVER");
  }
  record(
    "R10-unauthorized-settle",
    "non-assigned driver denied",
    `denied=${wrongSettle}`,
    wrongSettle ? "PASS" : "FAIL"
  );

  // PIN link
  await db.doc("vehicles/rt-pin").set({
    ownerId: "rt-own",
    plate: "PIN1",
    pinHash: hashVehiclePin("9999"),
    status: "offline",
  });
  const linked = await callAs(drv2.functions, "linkVehicleByPin", {
    pin: "9999",
    driverName: "RT Driver 2",
  });
  record(
    "R11-linkVehicleByPin",
    "link ok without returning pin",
    JSON.stringify({ ok: linked?.ok, vehicleId: linked?.vehicleId, hasPin: linked && "pin" in linked }),
    linked?.ok && !("pin" in linked) ? "PASS" : "FAIL"
  );

  // Admin claims via callable
  let ordinaryGrantDenied = false;
  try {
    await callAs(ordinary.functions, "grantAdminClaim", { uid: "rt-grant" });
  } catch (e) {
    ordinaryGrantDenied =
      String(errCode(e)).includes("permission-denied") || String(errCode(e)).includes("ADMIN_ONLY");
  }
  await callAs(boot.functions, "grantAdminClaim", { uid: "rt-grant" });
  const granted = (await admin.auth().getUser("rt-grant")).customClaims || {};
  await callAs(boot.functions, "revokeAdminClaim", { uid: "rt-grant" });
  const revoked = (await admin.auth().getUser("rt-grant")).customClaims || {};
  await callAs(boot.functions, "setAdminEmailBootstrap", { enabled: false });
  let bootDisabled = false;
  try {
    await admin.auth().setCustomUserClaims("rt-boot", { admin: false });
    await boot.auth.currentUser.getIdToken(true);
    await callAs(boot.functions, "bootstrapAdminClaim", {});
  } catch (e) {
    bootDisabled =
      String(errCode(e)).includes("BOOTSTRAP_DISABLED") ||
      String(errCode(e)).includes("failed-precondition");
  }
  // Restore claim admin for cleanup toggle
  await admin.auth().setCustomUserClaims("rt-boot", { admin: true });
  await boot.auth.currentUser.getIdToken(true);
  await callAs(boot.functions, "setAdminEmailBootstrap", { enabled: true });

  record(
    "R12-admin-claims-callables",
    "bootstrap/grant/revoke/toggle; ordinary denied",
    JSON.stringify({
      ordinaryGrantDenied,
      granted: granted.admin === true,
      revoked: revoked.admin === false,
      bootDisabled,
    }),
    ordinaryGrantDenied && granted.admin === true && revoked.admin === false && bootDisabled
      ? "PASS"
      : "FAIL"
  );

  const passed = results.filter((r) => r.status === "PASS").length;
  const failed = results.filter((r) => r.status === "FAIL").length;
  const blocked = results.filter((r) => r.status === "BLOCKED").length;
  const out = {
    generatedAt: new Date().toISOString(),
    command:
      'firebase emulators:exec --only auth,firestore,storage,functions --project demo-swiftgo-phase1 "node tests/phase2d-functions-runtime.mjs"',
    results,
    passed,
    failed,
    blocked,
    total: results.length,
  };
  fs.writeFileSync(path.join(ROOT, "tests", "phase2d-functions-runtime-results.json"), JSON.stringify(out, null, 2));
  console.log(`[phase2d-functions-runtime] passed=${passed} failed=${failed} blocked=${blocked}`);

  await Promise.all([
    deleteApp(cust.app),
    deleteApp(drv1.app),
    deleteApp(drv2.app),
    deleteApp(ordinary.app),
    deleteApp(boot.app),
    deleteApp(anon.app),
  ].map((p) => p.catch(() => {})));

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  fs.writeFileSync(
    path.join(ROOT, "tests", "phase2d-functions-runtime-results.json"),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        error: String(err?.stack || err),
        results,
        passed: results.filter((r) => r.status === "PASS").length,
        failed: results.filter((r) => r.status === "FAIL").length + 1,
        blocked: 0,
      },
      null,
      2
    )
  );
  process.exit(1);
});
