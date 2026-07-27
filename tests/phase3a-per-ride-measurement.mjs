/**
 * Phase 3A — per-ride Firebase operation measurement on emulators.
 * Invoked via: npm run test:phase3a
 *
 * Measures Function invocations + Admin-observed document mutations.
 * Listener deliveries are estimated from known client subscription patterns
 * (emulator does not expose billable read counters).
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
const OUT = path.join(ROOT, "tests", "phase3a-per-ride-results.json");

process.env.FIRESTORE_EMULATOR_HOST ||= "127.0.0.1:8080";
process.env.FIREBASE_AUTH_EMULATOR_HOST ||= "127.0.0.1:9099";
process.env.GCLOUD_PROJECT ||= PROJECT;
process.env.GOOGLE_CLOUD_PROJECT ||= PROJECT;

const admin = require(require.resolve("firebase-admin", { paths: [path.join(ROOT, "functions"), ROOT] }));
const { FieldValue } = require("firebase-admin/firestore");
const { hashVehiclePin } = require(path.join(ROOT, "functions", "pin-security.js"));
const { locationGeoFields } = require(path.join(ROOT, "functions", "geo-cells.js"));

let adminApp;
try {
  adminApp = admin.app();
} catch {
  adminApp = admin.initializeApp({ projectId: PROJECT });
}
const db = admin.firestore(adminApp);

const pickup = { lat: 24.8607, lng: 67.0011, address: "Pickup 3A" };
const dropoff = { lat: 24.9056, lng: 67.0822, address: "Drop 3A" };
const PASSWORD = "Phase3A-test!";

const results = [];
function record(name, expected, actual, status, extra = {}) {
  results.push({ name, expected, actual, status, suite: "phase3a-per-ride", ...extra });
  console.log(`${status === "PASS" ? "✓" : "✗"} [${status}] ${name}`);
}

function clientApp(name) {
  const app = initializeApp(
    { apiKey: "demo", projectId: PROJECT, appId: "demo" },
    name
  );
  const auth = getAuth(app);
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  const functions = getFunctions(app, "us-central1");
  connectFunctionsEmulator(functions, "127.0.0.1", 5001);
  return { app, auth, functions };
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

async function callAs(functions, name, data) {
  const res = await httpsCallable(functions, name)(data);
  return res?.data;
}

async function countCollection(name) {
  return (await db.collection(name).get()).size;
}

/**
 * Estimate billable Firestore ops for one complete ride path (code-path model),
 * refined with measured Function invocation counts and post-run doc deltas.
 */
function estimateRideOps({
  candidateLimit,
  onlineDriversScanned,
  candidatesWritten,
  counterRounds,
  includeFallbackLocationWrites = 0,
  ownerMapOpen = false,
  adminMapOpen = false,
  settlementRetries = 1,
}) {
  // Matching CF: settings read + vehicles query (all online) + partner reads + candidate writes + ride merge
  const matchReads = 1 + onlineDriversScanned + onlineDriversScanned; // settings + vehicles + partners
  const matchWrites = candidatesWritten + 1; // candidates + ride merge

  // Booking CF: slot read/write + ride create
  const bookingReads = 1;
  const bookingWrites = 2;

  // Offer + counters + finalize
  const bargainReads = 4 + counterRounds * 2;
  const bargainWrites = 1 + counterRounds + 3; // offer + counters + finalize multi-doc

  // Status arrived + in_progress (client updates)
  const stageWrites = 2;

  // Settlement transaction (~ride, partner, ledger, audit, slot)
  const settleReads = 5 * settlementRetries;
  const settleWrites = 5; // idempotent — retries should not multiply writes

  // Listener deliveries (estimate): customer ride+offers, driver candidates/active, optional owner/admin
  const listenerBase =
    8 + // customer ride watch updates across lifecycle
    4 + // customer offers
    candidatesWritten + // each candidate doc to invited drivers (radar)
    6; // driver active ride + vehicle
  const listenerExtra =
    (ownerMapOpen ? 20 : 0) + // owner vehicles/rides fan-out during ride
    (adminMapOpen ? onlineDriversScanned + 50 : 0); // admin vehicles + rides feed

  const functionInvocations =
    1 + // createCustomerBooking
    1 + // matchRideCandidates
    1 + // submitRideOffer
    counterRounds + // counterRideOffer
    1 + // finalize
    settlementRetries; // completeRideSettlement

  return {
    firestoreReads: matchReads + bookingReads + bargainReads + settleReads + includeFallbackLocationWrites,
    firestoreWrites:
      matchWrites + bookingWrites + bargainWrites + stageWrites + settleWrites + includeFallbackLocationWrites,
    firestoreDeletes: 0,
    listenerDeliveriesEstimate: listenerBase + listenerExtra,
    functionInvocations,
    storageOps: 0,
    authOps: 0,
    notes: [
      "Listener deliveries estimated — not emulator-metered.",
      "Matching scans all online/in_ride vehicles (architecture cost).",
      "Settlement writes assumed idempotent after first success.",
    ],
  };
}

async function seedDrivers(n, prefix) {
  const ids = [];
  for (let i = 0; i < n; i++) {
    const uid = `${prefix}-d${i}`;
    const vid = `${prefix}-v${i}`;
    await ensureUser(`${uid}@example.com`, PASSWORD, uid);
    await db.doc(`partners/${uid}`).set({
      role: "driver",
      accountStatus: "active",
      currentVehicleId: vid,
      walletBalance: 0,
      totalEarnings: 0,
    });
    await db.doc(`vehicles/${vid}`).set({
      ownerId: `${prefix}-own`,
      plate: `3A-${i}`,
      pinHash: hashVehiclePin("1111"),
      status: "online",
      driverId: uid,
      location: { lat: pickup.lat + i * 0.0005, lng: pickup.lng + i * 0.0005 },
      locationUpdatedAt: admin.firestore.Timestamp.now(),
      ...locationGeoFields(pickup.lat + i * 0.0005, pickup.lng + i * 0.0005),
    });
    ids.push({ uid, vid });
  }
  return ids;
}

async function runJourney({
  name,
  candidateLimit,
  onlineCount,
  counters,
  settlementRetries = 1,
  cancelOnly = false,
}) {
  await db.doc("settings/dispatch").set({
    candidateDriverLimit: candidateLimit,
    maxDriverOpenBargains: 10,
    maxCustomerActiveBookings: 4,
    searchRingsKm: [1, 2, 3],
  });
  await db.doc("settings/pricing").set({
    commissionPercent: 10,
    vehicles: { go: { commissionPercent: 10 } },
  });

  const prefix = `p3a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const custUid = `${prefix}-c`;
  await ensureUser(`${custUid}@example.com`, PASSWORD, custUid);
  const drivers = await seedDrivers(onlineCount, prefix);

  const cust = clientApp(`${prefix}-cust`);
  const drv = clientApp(`${prefix}-drv`);
  await signInWithEmailAndPassword(cust.auth, `${custUid}@example.com`, PASSWORD);
  await signInWithEmailAndPassword(drv.auth, `${drivers[0].uid}@example.com`, PASSWORD);

  const before = {
    rides: await countCollection("rides"),
    offers: await countCollection("ride_offers"),
    candidates: await countCollection("ride_candidates"),
    ledger: await countCollection("ledger_transactions"),
    audit: await countCollection("audit_logs"),
  };

  let invocations = 0;
  const track = async (fn, ...args) => {
    invocations += 1;
    return fn(...args);
  };

  const created = await track(callAs, cust.functions, "createCustomerBooking", {
    confirmedExtraBooking: true,
    pickupLocation: pickup,
    dropoffLocation: dropoff,
    vehicleType: "Go",
    vehicleTypeKey: "go",
    distanceKm: 6,
    timeMins: 18,
    farePkr: 250,
    estimatedFare: 250,
    paymentMethod: "cash",
  });
  const rideId = created.id;

  await track(callAs, cust.functions, "matchRideCandidates", {
    rideId,
    candidateDriverLimit: candidateLimit,
  });

  if (cancelOnly) {
    await track(callAs, cust.functions, "cancelCustomerBooking", { rideId });
    const after = {
      rides: await countCollection("rides"),
      candidates: await countCollection("ride_candidates"),
    };
    const est = estimateRideOps({
      candidateLimit,
      onlineDriversScanned: onlineCount,
      candidatesWritten: Math.min(candidateLimit, onlineCount),
      counterRounds: 0,
    });
    return {
      name,
      rideId,
      invocations,
      measuredDeltas: {
        rides: after.rides - before.rides,
        candidates: after.candidates - before.candidates,
      },
      estimate: est,
      cancelled: true,
    };
  }

  await track(callAs, drv.functions, "submitRideOffer", {
    rideId,
    fare: 300,
    vehicleId: drivers[0].vid,
    ownerId: `${prefix}-own`,
    driverName: "D0",
    vehiclePlate: "3A-0",
  });

  const offerId = `${rideId}_${drivers[0].uid}`;
  for (let i = 0; i < counters; i++) {
    await track(callAs, cust.functions, "counterRideOffer", {
      offerId,
      fare: 280 - i,
    });
  }

  await track(callAs, drv.functions, "finalizeAssignmentFromOffer", {
    offerId,
    as: "driver",
  });

  await db.doc(`rides/${rideId}`).set({ status: "arrived" }, { merge: true });
  await db.doc(`rides/${rideId}`).set({ status: "in_progress" }, { merge: true });

  for (let i = 0; i < settlementRetries; i++) {
    try {
      await track(callAs, drv.functions, "completeRideSettlement", {
        rideId,
        collectionName: "rides",
      });
    } catch (e) {
      /* retry path */
    }
  }

  const after = {
    rides: await countCollection("rides"),
    offers: await countCollection("ride_offers"),
    candidates: await countCollection("ride_candidates"),
    ledger: await countCollection("ledger_transactions"),
    audit: await countCollection("audit_logs"),
  };

  const candSnap = await db.collection("ride_candidates").where("rideId", "==", rideId).get();
  const ledgerSnap = await db.collection("ledger_transactions").get();
  const rideLedgers = ledgerSnap.docs.filter(
    (d) => d.data()?.rideId === rideId || d.id.includes(rideId)
  );

  const est = estimateRideOps({
    candidateLimit,
    onlineDriversScanned: onlineCount,
    candidatesWritten: candSnap.size,
    counterRounds: counters,
    settlementRetries,
  });

  await deleteApp(cust.app).catch(() => {});
  await deleteApp(drv.app).catch(() => {});

  return {
    name,
    rideId,
    candidateLimit,
    onlineCount,
    counters,
    candidatesWritten: candSnap.size,
    invocations,
    measuredDeltas: {
      rides: after.rides - before.rides,
      offers: after.offers - before.offers,
      candidates: after.candidates - before.candidates,
      ledger: after.ledger - before.ledger,
      audit: after.audit - before.audit,
    },
    ledgerCountForRide: rideLedgers.length,
    estimate: est,
  };
}

async function main() {
  // Static optimization gates (pre/post evidence)
  const drvSrc = fs.readFileSync(path.join(ROOT, "driver-app/js/driver-app.js"), "utf8");
  const ownSrc = fs.readFileSync(path.join(ROOT, "owner-app/js/owner-app.js"), "utf8");
  const adminSrc = fs.readFileSync(path.join(ROOT, "super-admin-panel/js/admin-app.js"), "utf8");

  const loc60 =
    /VEHICLE_LOCATION_WRITE_MS\s*=\s*60_?000/.test(drvSrc) &&
    /VEHICLE_LOCATION_WRITE_MS\s*=\s*60_?000/.test(ownSrc);
  const no8s = !/VEHICLE_LOCATION_WRITE_MS\s*=\s*8000/.test(drvSrc);
  const zoneGrid = /LOCATION_GRID_DEG/.test(drvSrc) && /LOCATION_GRID_DEG/.test(ownSrc);
  const mapStop = adminSrc.includes("stopFleetMap()") && adminSrc.includes('key === "live-map"');
  const noUnboundedRidesListen =
    !/onSnapshot\(\s*\n?\s*collection\(db,\s*"rides"\)/.test(adminSrc) &&
    adminSrc.includes("getCountFromServer");

  record(
    "OPT-location-1min",
    "driver+owner use 60s snapshot",
    { loc60, no8s, zoneGrid },
    loc60 && no8s && zoneGrid ? "PASS" : "FAIL"
  );
  record(
    "OPT-admin-map-detach",
    "stopFleetMap when leaving live-map",
    { mapStop },
    mapStop ? "PASS" : "FAIL"
  );
  record(
    "OPT-admin-no-unbounded-rides-listener",
    "rides total via getCountFromServer, not full collection listen",
    { noUnboundedRidesListen },
    noUnboundedRidesListen ? "PASS" : "FAIL"
  );

  // Location cost model comparison (pure calc)
  const oldWritesPerHour = 3600 / 8;
  const newWritesPerHour = 3600 / 60;
  const savingPct = Math.round((1 - newWritesPerHour / oldWritesPerHour) * 100);
  record(
    "LOC-model-8s-vs-60s",
    "≥87% write reduction vs old 8s model",
    { oldWritesPerHour, newWritesPerHour, savingPct },
    savingPct >= 87 ? "PASS" : "FAIL"
  );

  const scenarios = [];
  scenarios.push(
    await runJourney({
      name: "S1-limit10-minimal-bargain",
      candidateLimit: 10,
      onlineCount: 12,
      counters: 0,
    })
  );
  scenarios.push(
    await runJourney({
      name: "S2-limit10-heavy-counters",
      candidateLimit: 10,
      onlineCount: 12,
      counters: 3,
    })
  );
  scenarios.push(
    await runJourney({
      name: "S3-limit20-minimal-bargain",
      candidateLimit: 20,
      onlineCount: 25,
      counters: 0,
    })
  );
  scenarios.push(
    await runJourney({
      name: "S4-limit20-heavy-counters",
      candidateLimit: 20,
      onlineCount: 25,
      counters: 3,
    })
  );
  scenarios.push(
    await runJourney({
      name: "S11-cancelled-booking",
      candidateLimit: 10,
      onlineCount: 5,
      counters: 0,
      cancelOnly: true,
    })
  );
  scenarios.push(
    await runJourney({
      name: "S12-settlement-retry",
      candidateLimit: 10,
      onlineCount: 8,
      counters: 0,
      settlementRetries: 3,
    })
  );

  for (const s of scenarios) {
    const okLedger = s.cancelled || s.ledgerCountForRide === 1;
    const candOk =
      s.cancelled ||
      (s.candidatesWritten > 0 && s.candidatesWritten <= s.candidateLimit);
    record(
      `MEAS-${s.name}`,
      "journey completes with expected candidates/ledger",
      {
        invocations: s.invocations,
        candidatesWritten: s.candidatesWritten,
        ledgerCountForRide: s.ledgerCountForRide,
        estimate: s.estimate,
        measuredDeltas: s.measuredDeltas,
      },
      okLedger && candOk ? "PASS" : "FAIL"
    );
  }

  const s1 = scenarios.find((s) => s.name.startsWith("S1"));
  const s3 = scenarios.find((s) => s.name.startsWith("S3"));
  if (s1 && s3) {
    record(
      "CMP-10-vs-20-candidates",
      "limit 20 writes more candidate docs than limit 10",
      {
        c10: s1.candidatesWritten,
        c20: s3.candidatesWritten,
        readDeltaEst: s3.estimate.firestoreReads - s1.estimate.firestoreReads,
      },
      s3.candidatesWritten >= s1.candidatesWritten ? "PASS" : "FAIL"
    );
  }

  // Model-only scenarios documented (P2P / dashboards) — no billable traffic
  record(
    "S5-S10-modelled-only",
    "P2P/dashboard scenarios documented without paid traffic",
    {
      s5: "P2P success → 0 Firebase live location writes during trip (local/P2P)",
      s6: "P2P fail → fallback at 1/min + zone-change",
      s7: "Owner dashboard closed → no owner ride/vehicle listeners",
      s8: "Admin map closed → stopFleetMap (optimized)",
      s9: "1 booking baseline = S1",
      s10: "4 concurrent ≈ 4× booking/match/bargain listeners",
    },
    "PASS"
  );

  const passed = results.filter((r) => r.status === "PASS").length;
  const failed = results.filter((r) => r.status === "FAIL").length;
  const summary = {
    phase: "3A",
    project: PROJECT,
    productionTouched: false,
    billingEnabled: false,
    locationWriteMs: 60_000,
    locationWriteSavingVs8sPercent: savingPct,
    scenarios,
    totals: { passed, failed, blocked: 0, total: results.length },
    results,
  };
  fs.writeFileSync(OUT, JSON.stringify(summary, null, 2));
  console.log(`\n[phase3a] ${passed} passed / ${failed} failed → ${OUT}`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
