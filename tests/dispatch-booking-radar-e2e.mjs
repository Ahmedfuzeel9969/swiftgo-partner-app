/**
 * End-to-end dispatch: createCustomerBooking → rides → match → ride_candidates → driver radar query.
 * Run: firebase emulators:exec --only auth,firestore,functions --project demo-swiftgo-phase1 "node tests/dispatch-booking-radar-e2e.mjs"
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
  onSnapshot,
} from "firebase/firestore";
import { getFunctions, connectFunctionsEmulator, httpsCallable } from "firebase/functions";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROJECT = "demo-swiftgo-phase1";
const OUT = path.join(ROOT, "tests", "dispatch-booking-radar-results.json");

process.env.FIRESTORE_EMULATOR_HOST ||= "127.0.0.1:8080";
process.env.FIREBASE_AUTH_EMULATOR_HOST ||= "127.0.0.1:9099";
process.env.FIREBASE_FUNCTIONS_EMULATOR_HOST ||= "127.0.0.1:5001";
process.env.GCLOUD_PROJECT ||= PROJECT;
process.env.GOOGLE_CLOUD_PROJECT ||= PROJECT;

const admin = require(require.resolve("firebase-admin", { paths: [path.join(ROOT, "functions"), ROOT] }));
const { matchRideCandidates, createCustomerBooking } = require(path.join(ROOT, "functions", "bargaining.js"));
const { locationGeoFields, gridCellId, MATCH_GRID_DEG } = require(path.join(ROOT, "functions", "geo-cells.js"));
const { submitRideOffer, acceptCustomerInitialFareAsDriver } = require(path.join(ROOT, "functions", "bargaining.js"));

let adminApp;
try {
  adminApp = admin.app();
} catch {
  adminApp = admin.initializeApp({ projectId: PROJECT });
}
const db = admin.firestore(adminApp);
const FieldValue = admin.firestore.FieldValue;
const Timestamp = admin.firestore.Timestamp;

const pickup = { lat: 24.8607, lng: 67.0011, address: "Test Pickup" };
const dropoff = { lat: 24.87, lng: 67.01, address: "Test Dropoff" };

const results = [];

function record(name, status, detail = "", extra = {}) {
  results.push({ name, status, detail, suite: "dispatch-e2e", ...extra });
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

async function seedDriver(prefix, driverUid, vehicleId, lat, lng, extra = {}) {
  const now = Timestamp.now();
  await db.doc(`partners/${driverUid}`).set(
    {
      uid: driverUid,
      role: "driver",
      accountStatus: extra.accountStatus || "active",
      activeRideId: extra.activeRideId || null,
      currentVehicleId: vehicleId,
      walletBalance: 0,
    },
    { merge: true }
  );
  const geo = extra.skipGeo ? {} : locationGeoFields(lat, lng);
  await db.doc(`vehicles/${vehicleId}`).set({
    ownerId: `${prefix}-owner`,
    plate: vehicleId,
    status: extra.status || "online",
    driverId: driverUid,
    driverName: "Test Driver",
    location: { lat, lng },
    locationUpdatedAt: extra.locationUpdatedAt === undefined ? now : extra.locationUpdatedAt,
    activeRideId: extra.activeRideId || null,
    ...geo,
    ...(extra.vehiclePatch || {}),
  });
}

async function driverCandidateQuery(clientDb, driverUid) {
  const q = query(
    collection(clientDb, "ride_candidates"),
    where("driverId", "==", driverUid),
    where("status", "==", "invited"),
    limit(40)
  );
  return getDocs(q);
}

function staticChecks() {
  const indexes = JSON.parse(fs.readFileSync(path.join(ROOT, "firestore.indexes.json"), "utf8"));
  const idx = indexes.indexes || [];
  const hasCandIdx = idx.some(
    (i) =>
      i.collectionGroup === "ride_candidates" &&
      i.fields?.some((f) => f.fieldPath === "driverId") &&
      i.fields?.some((f) => f.fieldPath === "status")
  );
  record("index-ride_candidates-driver-status", hasCandIdx ? "PASS" : "FAIL");

  const rules = fs.readFileSync(path.join(ROOT, "firestore.rules"), "utf8");
  record(
    "rules-candidates-driver-list-only",
    /ride_candidates[\s\S]*allow list:[\s\S]*driverId == request\.auth\.uid/.test(rules) ? "PASS" : "FAIL"
  );
  record(
    "rules-candidates-no-client-write",
    /ride_candidates[\s\S]*allow create, update, delete: if false/.test(rules) ? "PASS" : "FAIL"
  );
  record("geo-grid-deg", MATCH_GRID_DEG === 0.0036 ? "PASS" : "FAIL", `grid=${MATCH_GRID_DEG}`);
}

async function main() {
  staticChecks();

  const prefix = `de2e${Date.now().toString(36)}`;
  const customerUid = `${prefix}-cust`;
  const driverUid = `${prefix}-drv`;
  const otherUid = `${prefix}-other`;
  const vehicleId = `${prefix}-veh`;
  const otherVehicleId = `${prefix}-veh2`;

  await db.doc("settings/dispatch").set({
    candidateDriverLimit: 10,
    maxSearchRadiusKm: 3,
    searchRingsKm: [1, 2, 3],
  });

  await ensureUser(`${customerUid}@test.local`, "TestPass123!", customerUid);
  await ensureUser(`${driverUid}@test.local`, "TestPass123!", driverUid);
  await ensureUser(`${otherUid}@test.local`, "TestPass123!", otherUid);

  const near = kmOffset(pickup.lat, pickup.lng, 0.4, 0);
  await seedDriver(prefix, driverUid, vehicleId, near.lat, near.lng);
  await seedDriver(prefix, otherUid, otherVehicleId, near.lat + 0.01, near.lng + 0.01);

  // --- Callable createCustomerBooking (T0–T2) ---
  // Keep the driver signed in and listening before booking so listener latency
  // is not polluted by authentication or subscription startup.
  const drv = clientApp(`${prefix}-driver`);
  await signInWithEmailAndPassword(drv.auth, `${driverUid}@test.local`, "TestPass123!");
  const listenerMarks = new Map();
  let listenerReadyResolve;
  const listenerReady = new Promise((resolve) => {
    listenerReadyResolve = resolve;
  });
  const unsubCandidateListener = onSnapshot(
    query(
      collection(drv.fsDb, "ride_candidates"),
      where("driverId", "==", driverUid),
      where("status", "==", "invited")
    ),
    (snap) => {
      if (listenerReadyResolve) {
        listenerReadyResolve();
        listenerReadyResolve = null;
      }
      snap.docChanges().forEach((change) => {
        const rideId = change.doc.data()?.rideId;
        if (change.type === "added" && rideId) {
          listenerMarks.set(rideId, performance.now());
        }
      });
    }
  );
  await listenerReady;
  const cust = clientApp(`${prefix}-client`);
  await signInWithEmailAndPassword(cust.auth, `${customerUid}@test.local`, "TestPass123!");
  let created;
  let bookingStartMs = 0;
  let bookingResponseMs = 0;
  const dispatchTraceId = `dt_test_${Date.now().toString(36)}`;
  try {
    bookingStartMs = performance.now();
    created = (
      await httpsCallable(cust.functions, "createCustomerBooking")({
        confirmedExtraBooking: true,
        dispatchTraceId,
        pickupLocation: pickup,
        dropoffLocation: dropoff,
        vehicleType: "Go",
        vehicleTypeKey: "go",
        distanceKm: 4,
        timeMins: 12,
        farePkr: 250,
        estimatedFare: 250,
        paymentMethod: "cash",
      })
    )?.data;
    bookingResponseMs = performance.now();
  } catch (e) {
    record("T0-createCustomerBooking-callable", "FAIL", String(e.message || e));
    created = null;
  }

  if (created?.id) {
    record("T0-createCustomerBooking-callable", "PASS", `rideId=${created.id}`);
    record(
      "T0-ride-id-nonempty",
      created.id ? "PASS" : "FAIL",
      String(created.id || "")
    );
  }

  let rideId = created?.id;
  if (!rideId) {
    record("T1-T7-chain", "BLOCKED", "no ride id from callable");
  } else {
    const rideSnap = await db.doc(`rides/${rideId}`).get();
    const ride = rideSnap.data() || {};
    const t1 =
      ride.userId === customerUid &&
      ride.status === "searching_driver" &&
      ride.dispatchTraceId === dispatchTraceId &&
      Number.isFinite(Number(ride.pickupLocation?.lat)) &&
      Number.isFinite(Number(ride.dropoffLocation?.lat)) &&
      ride.createdAt &&
      ride.expiresAt &&
      (ride.estimatedFare != null || ride.farePkr != null) &&
      ride.vehicleTypeKey;
    record("T1-ride-document-shape", t1 ? "PASS" : "FAIL");
    record(
      "T1-dispatch-trace-correlated",
      created.dispatchTraceId === dispatchTraceId && ride.dispatchTraceId === dispatchTraceId ? "PASS" : "FAIL",
      `trace=${ride.dispatchTraceId || "missing"}`
    );

    record(
      "T2-matching-status",
      ["candidates_ready", "no_candidates", "match_failed", "invalid_pickup", "pending"].includes(
        String(created.matchingStatus || ride.matchingStatus || "")
      )
        ? "PASS"
        : "FAIL",
      `status=${created.matchingStatus || ride.matchingStatus} count=${created.candidateCount ?? ride.candidateCount}`
    );
    record(
      "T2-candidates-ready",
      Number(created.candidateCount ?? ride.candidateCount ?? 0) >= 1 ? "PASS" : "FAIL",
      `candidateCount=${created.candidateCount ?? ride.candidateCount}`
    );

    const candId = `${rideId}_${driverUid}`;
    const candSnap = await db.doc(`ride_candidates/${candId}`).get();
    const cand = candSnap.data() || {};
    const t4 =
      candSnap.exists &&
      cand.rideId === rideId &&
      cand.driverId === driverUid &&
      cand.status === "invited" &&
      cand.dispatchTraceId === dispatchTraceId &&
      cand.ridePreview?.status === "searching_driver" &&
      Number.isFinite(Number(cand.ridePreview?.pickupLocation?.lat)) &&
      Number.isFinite(Number(cand.ridePreview?.dropoffLocation?.lat)) &&
      cand.createdAt;
    record("T4-candidate-doc", t4 ? "PASS" : "FAIL", candId);
    record(
      "T4-candidate-card-preview",
      cand.ridePreview?.vehicleTypeKey === "go" && Number(cand.ridePreview?.estimatedFare) === 250
        ? "PASS"
        : "FAIL",
      `vehicle=${cand.ridePreview?.vehicleTypeKey || "missing"} fare=${cand.ridePreview?.estimatedFare ?? "missing"}`
    );

    let deliveryReceipt;
    try {
      deliveryReceipt = (
        await httpsCallable(drv.functions, "recordDispatchDeliveryReceipt")({
          rideId,
          dispatchTraceId,
          clientReceivedAtMs: Date.now(),
          clientRenderedAtMs: Date.now(),
        })
      )?.data;
    } catch (err) {
      deliveryReceipt = { ok: false, error: String(err?.message || err) };
    }
    const receiptSnap = await db.doc(`rides/${rideId}/dispatch_receipts/${driverUid}`).get();
    record(
      "T5-driver-delivery-receipt",
      deliveryReceipt?.ok === true &&
        receiptSnap.exists &&
        receiptSnap.data()?.dispatchTraceId === dispatchTraceId,
      `ok=${deliveryReceipt?.ok === true}`
    );

    // T5 driver client query (same as ride-radar-service)
    const candQ = await driverCandidateQuery(drv.fsDb, driverUid);
    const driverCandidateVisibleMs = performance.now();
    await new Promise((resolve) => setTimeout(resolve, 200));
    const driverListenerReceivedMs = listenerMarks.get(rideId) || 0;
    record(
      "T5-driver-candidate-query",
      candQ.docs.some((d) => d.id === candId) ? "PASS" : "FAIL",
      `docs=${candQ.size}`
    );
    record(
      "PERF-book-click-to-ride-created-and-match-complete",
      "PASS",
      `${Math.round(bookingResponseMs - bookingStartMs)}ms`,
      {
        milliseconds: Math.round(bookingResponseMs - bookingStartMs),
        serverLatencyMs: Number(created?.latencyMs) || null,
      }
    );
    record(
      "PERF-book-click-to-driver-candidate-visible",
      candQ.docs.some((d) => d.id === candId) ? "PASS" : "FAIL",
      `${Math.round(driverCandidateVisibleMs - bookingStartMs)}ms`,
      { milliseconds: Math.round(driverCandidateVisibleMs - bookingStartMs) }
    );
    record(
      "PERF-cold-book-click-to-driver-listener",
      driverListenerReceivedMs > 0 ? "PASS" : "FAIL",
      driverListenerReceivedMs > 0 ? `${Math.round(driverListenerReceivedMs - bookingStartMs)}ms` : "not received",
      { milliseconds: driverListenerReceivedMs > 0 ? Math.round(driverListenerReceivedMs - bookingStartMs) : null }
    );

    const warmStartMs = performance.now();
    const warmCreated = (
      await httpsCallable(cust.functions, "createCustomerBooking")({
        confirmedExtraBooking: true,
        pickupLocation: pickup,
        dropoffLocation: dropoff,
        vehicleType: "Go",
        vehicleTypeKey: "go",
        distanceKm: 4,
        timeMins: 12,
        farePkr: 250,
        estimatedFare: 250,
        paymentMethod: "cash",
      })
    )?.data;
    const warmResponseMs = performance.now();
    await new Promise((resolve) => setTimeout(resolve, 250));
    const warmListenerMs = listenerMarks.get(warmCreated?.id) || 0;
    record(
      "PERF-warm-book-click-to-callable-response",
      warmCreated?.id ? "PASS" : "FAIL",
      `${Math.round(warmResponseMs - warmStartMs)}ms`,
      { milliseconds: Math.round(warmResponseMs - warmStartMs), serverLatencyMs: warmCreated?.latencyMs ?? null }
    );
    record(
      "PERF-warm-book-click-to-driver-listener",
      warmListenerMs > 0 ? "PASS" : "FAIL",
      warmListenerMs > 0 ? `${Math.round(warmListenerMs - warmStartMs)}ms` : "not received",
      { milliseconds: warmListenerMs > 0 ? Math.round(warmListenerMs - warmStartMs) : null }
    );

    // T6 ride read as invited driver
    const rideClientSnap = await getDoc(doc(drv.fsDb, "rides", rideId));
    record(
      "T6-driver-ride-get",
      rideClientSnap.exists() && rideClientSnap.data()?.status === "searching_driver" ? "PASS" : "FAIL"
    );

    // T6 non-invited driver cannot read ride (rules) — use driver never matched
    const strangerUid = `${prefix}-stranger`;
    await ensureUser(`${strangerUid}@test.local`, "TestPass123!", strangerUid);
    await seedDriver(prefix, strangerUid, `${prefix}-str-v`, kmOffset(pickup.lat, pickup.lng, 8, 1).lat, kmOffset(pickup.lat, pickup.lng, 8, 1).lng);
    const stranger = clientApp(`${prefix}-stranger-client`);
    await signInWithEmailAndPassword(stranger.auth, `${strangerUid}@test.local`, "TestPass123!");
    let otherDenied = false;
    try {
      await getDoc(doc(stranger.fsDb, "rides", rideId));
      otherDenied = false;
    } catch {
      otherDenied = true;
    }
    record("T6-non-invited-ride-denied", otherDenied ? "PASS" : "FAIL");

    // Bargaining: offer + accept initial fare (no auto-assign on offer alone)
    await submitRideOffer(db, {
      rideId,
      driverUid,
      fare: 240,
      vehicleId,
      ownerId: `${prefix}-owner`,
      driverName: "Test Driver",
      vehiclePlate: vehicleId,
    });
    const offers = await db.collection("ride_offers").where("rideId", "==", rideId).get();
    record("T7-offer-created", offers.size >= 1 ? "PASS" : "FAIL");
    const rideBeforeAccept = (await db.doc(`rides/${rideId}`).get()).data() || {};
    record(
      "T7-not-assigned-on-offer-only",
      rideBeforeAccept.status === "searching_driver" ? "PASS" : "FAIL"
    );
    const acceptStartMs = performance.now();
    await acceptCustomerInitialFareAsDriver(db, {
      rideId,
      driverUid,
      vehicleId,
      ownerId: `${prefix}-owner`,
      driverName: "Test Driver",
      vehiclePlate: vehicleId,
    });
    const rideAfter = (await db.doc(`rides/${rideId}`).get()).data() || {};
    record(
      "T7-single-assignment",
      rideAfter.status === "accepted" && rideAfter.driverId === driverUid ? "PASS" : "FAIL"
    );
    record(
      "PERF-driver-accept-to-assignment-confirmed",
      rideAfter.status === "accepted" && rideAfter.driverId === driverUid ? "PASS" : "FAIL",
      `${Math.round(performance.now() - acceptStartMs)}ms`,
      { milliseconds: Math.round(performance.now() - acceptStartMs) }
    );
    await deleteApp(cust.app).catch(() => {});
    unsubCandidateListener();
    await deleteApp(drv.app).catch(() => {});
    await deleteApp(stranger.app).catch(() => {});
  }

  // --- Failure variants (admin match path) ---
  const failPrefix = `${prefix}-fail`;
  const isoPickup = { lat: 25.12, lng: 67.55, address: "Iso" };
  async function matchWithVehicle(label, vehicleExtra, expectZero = true) {
    const uid = `${failPrefix}-${label}-d`;
    const vid = `${failPrefix}-${label}-v`;
    const p = kmOffset(isoPickup.lat, isoPickup.lng, 0.3, 0.5);
    await seedDriver(failPrefix, uid, vid, p.lat, p.lng, vehicleExtra);
    const r = db.collection("rides").doc();
    await r.set({
      userId: customerUid,
      status: "searching_driver",
      pickupLocation: isoPickup,
      dropoffLocation: { lat: isoPickup.lat + 0.01, lng: isoPickup.lng + 0.01, address: "D" },
      createdAt: FieldValue.serverTimestamp(),
    });
    const m = await matchRideCandidates(db, { rideId: r.id, pickup: isoPickup });
    const candSnap = await db.doc(`ride_candidates/${r.id}_${uid}`).get();
    const invitedTarget = candSnap.exists;
    record(
      `fail-${label}`,
      expectZero ? (!invitedTarget ? "PASS" : "FAIL") : invitedTarget ? "PASS" : "FAIL",
      `targetInvited=${invitedTarget} totalCount=${m.candidateCount ?? 0}`
    );
  }

  await matchWithVehicle("offline", { status: "offline" }, true);
  await matchWithVehicle("missing-geo", { skipGeo: true }, true);
  await matchWithVehicle("stale-location", {
    locationUpdatedAt: Timestamp.fromMillis(Date.now() - 20 * 60 * 1000),
  }, true);
  await matchWithVehicle("blocked-partner", { accountStatus: "blocked" }, true);
  await matchWithVehicle("busy-driver", { activeRideId: "busy-1" }, true);
  {
    const uid = `${failPrefix}-outside-d`;
    const vid = `${failPrefix}-outside-v`;
    const farPos = kmOffset(isoPickup.lat, isoPickup.lng, 10, 0);
    await seedDriver(failPrefix, uid, vid, farPos.lat, farPos.lng);
    const r = db.collection("rides").doc();
    await r.set({
      userId: customerUid,
      status: "searching_driver",
      pickupLocation: isoPickup,
      dropoffLocation: { lat: isoPickup.lat + 0.01, lng: isoPickup.lng + 0.01, address: "D" },
      createdAt: FieldValue.serverTimestamp(),
    });
    const m = await matchRideCandidates(db, { rideId: r.id, pickup: isoPickup });
    const candSnap = await db.doc(`ride_candidates/${r.id}_${uid}`).get();
    record(
      "fail-outside-radius",
      !candSnap.exists ? "PASS" : "FAIL",
      `targetInvited=${candSnap.exists} totalCount=${m.candidateCount ?? 0}`
    );
  }

  const rematchPickup = { lat: 25.18, lng: 67.62, address: "Rematch" };
  const rematchRide = db.collection("rides").doc();
  await rematchRide.set({
    userId: customerUid,
    status: "searching_driver",
    pickupLocation: rematchPickup,
    dropoffLocation: { lat: rematchPickup.lat + 0.01, lng: rematchPickup.lng + 0.01, address: "D" },
    createdAt: FieldValue.serverTimestamp(),
  });
  const pNear = kmOffset(rematchPickup.lat, rematchPickup.lng, 0.35, 0.2);
  await seedDriver(failPrefix, `${failPrefix}-rem-d`, `${failPrefix}-rem-v`, pNear.lat, pNear.lng);
  const first = await matchRideCandidates(db, { rideId: rematchRide.id, pickup: rematchPickup });
  const second = await matchRideCandidates(db, { rideId: rematchRide.id, pickup: rematchPickup });
  record(
    "rematch-candidate-count-preserved",
    (first.candidateCount ?? 0) >= 1 && (second.candidateCount ?? 0) >= 1 ? "PASS" : "FAIL",
    `first=${first.candidateCount} second=${second.candidateCount} toInvite2=${second.candidates?.length ?? 0}`
  );

  const summary = {
    pass: results.filter((r) => r.status === "PASS").length,
    fail: results.filter((r) => r.status === "FAIL").length,
    blocked: results.filter((r) => r.status === "BLOCKED").length,
    total: results.length,
  };
  fs.writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), summary, results }, null, 2));
  console.log("\nSummary:", summary);
  if (summary.fail > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
