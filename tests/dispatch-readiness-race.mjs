/**
 * Dispatch readiness race — documents broken vs corrected driver online order.
 * Run: npm run test:dispatch-readiness
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
import {
  getFirestore,
  connectFirestoreEmulator,
  collection,
  query,
  where,
  limit,
  getDocs,
  doc,
  getDoc,
} from "firebase/firestore";
import { getFunctions, connectFunctionsEmulator, httpsCallable } from "firebase/functions";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROJECT = "demo-swiftgo-phase1";
const OUT = path.join(ROOT, "tests", "dispatch-readiness-results.json");

process.env.FIRESTORE_EMULATOR_HOST ||= "127.0.0.1:8080";
process.env.FIREBASE_AUTH_EMULATOR_HOST ||= "127.0.0.1:9099";
process.env.FIREBASE_FUNCTIONS_EMULATOR_HOST ||= "127.0.0.1:5001";
process.env.GCLOUD_PROJECT ||= PROJECT;
process.env.GOOGLE_CLOUD_PROJECT ||= PROJECT;

const admin = require(require.resolve("firebase-admin", { paths: [path.join(ROOT, "functions"), ROOT] }));
const { matchRideCandidates } = require(path.join(ROOT, "functions", "bargaining.js"));
const { locationGeoFields, MATCH_GRID_DEG } = require(path.join(ROOT, "functions", "geo-cells.js"));

let adminApp;
try {
  adminApp = admin.app();
} catch {
  adminApp = admin.initializeApp({ projectId: PROJECT });
}
const db = admin.firestore(adminApp);
const FieldValue = admin.firestore.FieldValue;
const Timestamp = admin.firestore.Timestamp;

const pickup = { lat: 24.8612, lng: 67.0022, address: "Race Pickup" };
const dropoff = { lat: 24.871, lng: 67.012, address: "Race Dropoff" };

const results = [];

function record(name, status, detail = "") {
  results.push({ name, status, detail, suite: "dispatch-readiness" });
  const mark = status === "PASS" ? "✓" : status === "FAIL" ? "✗" : "·";
  console.log(`${mark} ${name} — ${status}${detail ? `: ${detail}` : ""}`);
}

function kmOffset(lat, lng, km, bearingRad = 0) {
  const dLat = (km / 111) * Math.cos(bearingRad);
  const dLng = (km / (111 * Math.cos((lat * Math.PI) / 180))) * Math.sin(bearingRad);
  return { lat: lat + dLat, lng: lng + dLng };
}

async function ensureUser(email, password, uid) {
  try {
    return await admin.auth().createUser({ uid, email, password, emailVerified: true });
  } catch (e) {
    if (e.code === "auth/uid-already-exists" || e.code === "auth/email-already-exists") {
      return admin.auth().getUser(uid).catch(() => admin.auth().getUserByEmail(email));
    }
    throw e;
  }
}

function clientApp(name) {
  const app = initializeApp({ apiKey: "demo", projectId: PROJECT, appId: "demo" }, name);
  const auth = getAuth(app);
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  const fsDb = getFirestore(app);
  connectFirestoreEmulator(fsDb, "127.0.0.1", 8080);
  const functions = getFunctions(app, "us-central1");
  connectFunctionsEmulator(functions, "127.0.0.1", 5001);
  return { app, auth, fsDb, functions };
}

async function seedPartner(driverUid, vehicleId, lat, lng, vehicleExtra = {}) {
  const now = Timestamp.now();
  await db.doc(`partners/${driverUid}`).set(
    {
      uid: driverUid,
      role: "driver",
      accountStatus: vehicleExtra.accountStatus || "active",
      activeRideId: vehicleExtra.activeRideId || null,
      currentVehicleId: vehicleId,
      walletBalance: 0,
    },
    { merge: true }
  );
  const geo = vehicleExtra.skipGeo ? {} : locationGeoFields(lat, lng);
  const vehicleDoc = {
    ownerId: vehicleExtra.ownerId || "owner-test",
    plate: vehicleId,
    driverId: driverUid,
    driverName: "Test Driver",
    status: vehicleExtra.status || "online",
    locationUpdatedAt: vehicleExtra.locationUpdatedAt === undefined ? now : vehicleExtra.locationUpdatedAt,
    activeRideId: vehicleExtra.activeRideId || null,
    ...geo,
    ...(vehicleExtra.vehiclePatch || {}),
  };
  if (!vehicleExtra.skipLocation) {
    vehicleDoc.location = { lat, lng };
  }
  await db.doc(`vehicles/${vehicleId}`).set(vehicleDoc);
}

function writeResults() {
  const summary = {
    pass: results.filter((r) => r.status === "PASS").length,
    fail: results.filter((r) => r.status === "FAIL").length,
    blocked: results.filter((r) => r.status === "BLOCKED").length,
    total: results.length,
  };
  fs.writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), summary, results }, null, 2));
  console.log("\nSummary:", summary);
  return summary.fail === 0 ? 0 : 1;
}

async function main() {
  record("geo-grid-deg", MATCH_GRID_DEG === 0.0036 ? "PASS" : "FAIL", `grid=${MATCH_GRID_DEG}`);

  await db.doc("settings/dispatch").set({
    candidateDriverLimit: 10,
    maxSearchRadiusKm: 3,
    searchRingsKm: [1, 2, 3],
  });

  const prefix = `rdy${Date.now().toString(36)}`;
  const customerUid = `${prefix}-cust`;
  const driverUid = `${prefix}-drv`;
  const vehicleId = `${prefix}-veh`;
  const near = kmOffset(pickup.lat, pickup.lng, 0.35, 0);

  await ensureUser(`${customerUid}@test.local`, "TestPass123!", customerUid);
  await ensureUser(`${driverUid}@test.local`, "TestPass123!", driverUid);

  // ── CASE A: broken order (online before geo) ──
  await seedPartner(driverUid, vehicleId, near.lat, near.lng, {
    skipGeo: true,
    skipLocation: true,
    status: "online",
    vehiclePatch: { geoCell: null, locationGridCell: null },
  });

  const brokenRide = db.collection("rides").doc();
  await brokenRide.set({
    userId: customerUid,
    status: "searching_driver",
    pickupLocation: pickup,
    dropoffLocation: dropoff,
    createdAt: FieldValue.serverTimestamp(),
    expiresAt: Timestamp.fromMillis(Date.now() + 180000),
  });

  const firstMatch = await matchRideCandidates(db, { rideId: brokenRide.id, pickup });
  const firstSource = String(firstMatch.metrics?.source || "");
  record(
    "CASE-A-first-match-zero",
    (firstMatch.candidateCount ?? 0) === 0 ? "PASS" : "FAIL",
    `count=${firstMatch.candidateCount} source=${firstSource}`
  );
  record(
    "CASE-A-first-source-probe-or-empty",
    (firstMatch.candidateCount ?? 0) === 0 &&
      (firstSource === "geo_scoped_plus_capped_probe" || firstSource === "geo_scoped")
      ? "PASS"
      : "FAIL",
    firstSource
  );

  const geo = locationGeoFields(near.lat, near.lng);
  await db.doc(`vehicles/${vehicleId}`).set(
    {
      location: { lat: near.lat, lng: near.lng },
      locationUpdatedAt: Timestamp.now(),
      ...geo,
    },
    { merge: true }
  );

  const recoveryMatch = await matchRideCandidates(db, { rideId: brokenRide.id, pickup });
  const recoverySource = String(recoveryMatch.metrics?.source || "");
  record(
    "CASE-A-recovery-rematch-one",
    (recoveryMatch.candidateCount ?? 0) >= 1 ? "PASS" : "FAIL",
    `count=${recoveryMatch.candidateCount} source=${recoverySource}`
  );
  record(
    "CASE-A-recovery-source-geo-scoped",
    recoverySource === "geo_scoped" ? "PASS" : "FAIL",
    recoverySource
  );

  // Retire CASE-A vehicle so it cannot pollute CASE-B first-match counts.
  await db.doc(`vehicles/${vehicleId}`).set({ status: "offline" }, { merge: true });

  // ── CASE B: corrected ONLINE_READY order ──
  const prefixB = `${prefix}-b`;
  const driverB = `${prefixB}-drv`;
  const vehicleB = `${prefixB}-veh`;
  const pickupB = { lat: 24.92, lng: 67.08, address: "Race Pickup B" };
  const dropoffB = { lat: 24.93, lng: 67.09, address: "Race Dropoff B" };
  const posB = kmOffset(pickupB.lat, pickupB.lng, 0.4, 0.2);
  await ensureUser(`${driverB}@test.local`, "TestPass123!", driverB);
  await seedPartner(driverB, vehicleB, posB.lat, posB.lng);

  const cust = clientApp(`${prefixB}-client`);
  await signInWithEmailAndPassword(cust.auth, `${customerUid}@test.local`, "TestPass123!");
  let created;
  try {
    created = (
      await httpsCallable(cust.functions, "createCustomerBooking")({
        confirmedExtraBooking: true,
        pickupLocation: pickupB,
        dropoffLocation: dropoffB,
        vehicleType: "Go",
        vehicleTypeKey: "go",
        distanceKm: 4,
        timeMins: 12,
        farePkr: 250,
        estimatedFare: 250,
        paymentMethod: "cash",
      })
    )?.data;
  } catch (e) {
    record("CASE-B-createCustomerBooking", "FAIL", String(e.message || e));
    created = null;
  }

  if (created?.id) {
    record("CASE-B-first-match-ready", created.matchingStatus === "candidates_ready" ? "PASS" : "FAIL", created.matchingStatus);
    record(
      "CASE-B-first-count-one",
      Number(created.candidateCount ?? 0) === 1 ? "PASS" : "FAIL",
      `count=${created.candidateCount}`
    );
    const rideSnap = await db.doc(`rides/${created.id}`).get();
    const ride = rideSnap.data() || {};
    record(
      "CASE-B-source-geo-scoped",
      String(ride.matchingSource || "") === "geo_scoped" ? "PASS" : "FAIL",
      String(ride.matchingSource || "")
    );

    const candId = `${created.id}_${driverB}`;
    const candSnap = await db.doc(`ride_candidates/${candId}`).get();
    record(
      "CASE-B-candidate-invited",
      candSnap.exists && candSnap.data()?.status === "invited" ? "PASS" : "FAIL",
      candId
    );

    const drv = clientApp(`${prefixB}-drv-client`);
    await signInWithEmailAndPassword(drv.auth, `${driverB}@test.local`, "TestPass123!");
    const cq = query(
      collection(drv.fsDb, "ride_candidates"),
      where("driverId", "==", driverB),
      where("status", "==", "invited"),
      limit(40)
    );
    const cdocs = await getDocs(cq);
    record("CASE-B-driver-candidate-query", cdocs.size === 1 ? "PASS" : "FAIL", `docs=${cdocs.size}`);

    const rideRead = await getDoc(doc(drv.fsDb, "rides", created.id));
    record("CASE-B-driver-ride-read", rideRead.exists() ? "PASS" : "FAIL");

    const strangerUid = `${prefixB}-stranger`;
    await ensureUser(`${strangerUid}@test.local`, "TestPass123!", strangerUid);
    const stranger = clientApp(`${prefixB}-str-client`);
    await signInWithEmailAndPassword(stranger.auth, `${strangerUid}@test.local`, "TestPass123!");
    let denied = false;
    try {
      await getDoc(doc(stranger.fsDb, "rides", created.id));
    } catch {
      denied = true;
    }
    record("CASE-B-non-invited-denied", denied ? "PASS" : "FAIL");
    await deleteApp(stranger.app).catch(() => {});
    await deleteApp(drv.app).catch(() => {});
  }

  await deleteApp(cust.app).catch(() => {});

  // ── Failure / eligibility variants (isolated pickup) ──
  const iso = { lat: 25.22, lng: 67.72, address: "Iso" };
  async function assertNotInvited(label, extra) {
    const uid = `${prefix}-fail-${label}-d`;
    const vid = `${prefix}-fail-${label}-v`;
    const p = kmOffset(iso.lat, iso.lng, 0.3, 0.4);
    await seedPartner(uid, vid, p.lat, p.lng, extra);
    const r = db.collection("rides").doc();
    await r.set({
      userId: customerUid,
      status: "searching_driver",
      pickupLocation: iso,
      dropoffLocation: { lat: iso.lat + 0.01, lng: iso.lng + 0.01, address: "D" },
      createdAt: FieldValue.serverTimestamp(),
    });
    const m = await matchRideCandidates(db, { rideId: r.id, pickup: iso });
    const cand = await db.doc(`ride_candidates/${r.id}_${uid}`).get();
    record(`fail-${label}`, !cand.exists ? "PASS" : "FAIL", `invited=${cand.exists} total=${m.candidateCount ?? 0}`);
  }

  await assertNotInvited("missing-geo", { skipGeo: true });
  await assertNotInvited("offline", { status: "offline" });
  await assertNotInvited("stale-location", {
    locationUpdatedAt: Timestamp.fromMillis(Date.now() - 20 * 60 * 1000),
  });
  await assertNotInvited("blocked-partner", { accountStatus: "blocked" });
  await assertNotInvited("suspended-partner", { accountStatus: "suspended" });
  await assertNotInvited("busy-driver", { activeRideId: "busy-ride" });
  await assertNotInvited("wrong-driverId", { vehiclePatch: { driverId: "other-uid" } });

  {
    const uid = `${prefix}-fail-outside-d`;
    const vid = `${prefix}-fail-outside-v`;
    const far = kmOffset(iso.lat, iso.lng, 12, 0);
    await seedPartner(uid, vid, far.lat, far.lng);
    const r = db.collection("rides").doc();
    await r.set({
      userId: customerUid,
      status: "searching_driver",
      pickupLocation: iso,
      dropoffLocation: { lat: iso.lat + 0.01, lng: iso.lng + 0.01, address: "D" },
      createdAt: FieldValue.serverTimestamp(),
    });
    const m = await matchRideCandidates(db, { rideId: r.id, pickup: iso });
    const cand = await db.doc(`ride_candidates/${r.id}_${uid}`).get();
    record("fail-outside-radius", !cand.exists ? "PASS" : "FAIL", `total=${m.candidateCount ?? 0}`);
  }

  // Rematch preserves non-zero total when toInvite empty
  const rematchRide = db.collection("rides").doc();
  const rematchPickup = { lat: 25.28, lng: 67.78, address: "Rematch" };
  await rematchRide.set({
    userId: customerUid,
    status: "searching_driver",
    pickupLocation: rematchPickup,
    dropoffLocation: { lat: rematchPickup.lat + 0.01, lng: rematchPickup.lng + 0.01, address: "D" },
    createdAt: FieldValue.serverTimestamp(),
  });
  const remPos = kmOffset(rematchPickup.lat, rematchPickup.lng, 0.35, 0.1);
  const remDriver = `${prefix}-rem-d`;
  const remVeh = `${prefix}-rem-v`;
  await ensureUser(`${remDriver}@test.local`, "TestPass123!", remDriver);
  await seedPartner(remDriver, remVeh, remPos.lat, remPos.lng);
  const m1 = await matchRideCandidates(db, { rideId: rematchRide.id, pickup: rematchPickup });
  const m2 = await matchRideCandidates(db, { rideId: rematchRide.id, pickup: rematchPickup });
  record(
    "rematch-count-nonzero",
    Number(m1.candidateCount ?? 0) >= 1 && Number(m2.candidateCount ?? 0) >= 1 ? "PASS" : "FAIL",
    `first=${m1.candidateCount} second=${m2.candidateCount}`
  );

  process.exit(writeResults());
}

main().catch((err) => {
  console.error(err);
  record("fatal", "FAIL", String(err.message || err));
  process.exit(writeResults() || 1);
});
