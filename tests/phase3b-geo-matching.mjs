/**
 * Phase 3B — geo-scoped matching + scale cost verification (emulator only).
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
const OUT = path.join(ROOT, "tests", "phase3b-matching-results.json");

process.env.FIRESTORE_EMULATOR_HOST ||= "127.0.0.1:8080";
process.env.FIREBASE_AUTH_EMULATOR_HOST ||= "127.0.0.1:9099";
process.env.GCLOUD_PROJECT ||= PROJECT;
process.env.GOOGLE_CLOUD_PROJECT ||= PROJECT;

const admin = require(require.resolve("firebase-admin", { paths: [path.join(ROOT, "functions"), ROOT] }));
const {
  selectCandidatesProgressive,
  haversineKm,
  validateCandidateDriverLimit,
} = require(path.join(ROOT, "functions", "matching.js"));
const {
  gridCellId,
  locationGeoFields,
  cellsCoveringDisk,
  GOLDEN_HOTSPOTS,
  GOLDEN_HOTSPOT_RADIUS_KM,
  MATCH_GRID_DEG,
} = require(path.join(ROOT, "functions", "geo-cells.js"));
const { loadAndSelectGeoCandidates } = require(path.join(ROOT, "functions", "geo-match.js"));
const { matchRideCandidates } = require(path.join(ROOT, "functions", "bargaining.js"));

let adminApp;
try {
  adminApp = admin.app();
} catch {
  adminApp = admin.initializeApp({ projectId: PROJECT });
}
const db = admin.firestore(adminApp);
const FieldValue = admin.firestore.FieldValue;
const Timestamp = admin.firestore.Timestamp;

const pickup = { lat: 24.86, lng: 67.0011 };
const results = [];
const scaleRows = [];

function record(name, expected, actual, status, extra = {}) {
  results.push({ name, expected, actual, status, suite: "phase3b", ...extra });
  console.log(`${status === "PASS" ? "✓" : "✗"} [${status}] ${name}`);
}

function kmOffset(lat, lng, km, bearingRad = 0) {
  const dLat = (km / 111) * Math.cos(bearingRad);
  const dLng = (km / (111 * Math.cos((lat * Math.PI) / 180))) * Math.sin(bearingRad);
  return { lat: lat + dLat, lng: lng + dLng };
}

function clientApp(name) {
  const app = initializeApp({ apiKey: "demo", projectId: PROJECT, appId: "demo" }, name);
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
  return (await httpsCallable(functions, name)(data))?.data;
}

async function seedVehicle(id, driverId, lat, lng, extra = {}) {
  const now = Timestamp.now();
  await db.doc(`partners/${driverId}`).set(
    {
      role: "driver",
      accountStatus: extra.accountStatus || "active",
      activeRideId: extra.activeRideId || null,
      walletBalance: 0,
    },
    { merge: true }
  );
  await db.doc(`vehicles/${id}`).set({
    ownerId: "p3b-own",
    plate: id,
    status: extra.status || "online",
    driverId,
    location: { lat, lng },
    locationUpdatedAt: extra.locationUpdatedAt === undefined ? now : extra.locationUpdatedAt,
    activeRideId: extra.activeRideId || null,
    ...locationGeoFields(lat, lng),
    ...extra.vehiclePatch,
  });
}

async function batchSeedOnline(prefix, count, placeFn) {
  let batch = db.batch();
  let n = 0;
  const now = Timestamp.now();
  for (let i = 0; i < count; i++) {
    const uid = `${prefix}-d${i}`;
    const vid = `${prefix}-v${i}`;
    const pos = placeFn(i);
    const geo = locationGeoFields(pos.lat, pos.lng);
    batch.set(db.doc(`partners/${uid}`), {
      role: "driver",
      accountStatus: "active",
      walletBalance: 0,
    });
    batch.set(db.doc(`vehicles/${vid}`), {
      ownerId: "p3b-own",
      plate: vid,
      status: "online",
      driverId: uid,
      location: pos,
      locationUpdatedAt: now,
      ...geo,
    });
    n += 2;
    if (n >= 400) {
      await batch.commit();
      batch = db.batch();
      n = 0;
    }
  }
  if (n) await batch.commit();
}

function oldFullFleetReads(onlineCount) {
  return { vehicleDocsRead: onlineCount, partnerDocsRead: onlineCount, total: onlineCount * 2 };
}

async function main() {
  // --- Static / pure ---
  try {
    validateCandidateDriverLimit(15);
    record("invalid-limit-15", "throws", "accepted", "FAIL");
  } catch (e) {
    record("invalid-limit-15", "INVALID_CANDIDATE_LIMIT", e.message, e.message === "INVALID_CANDIDATE_LIMIT" ? "PASS" : "FAIL");
  }

  const indexSrc = fs.readFileSync(path.join(ROOT, "functions/index.js"), "utf8");
  const noFullScan =
    !/vehicles"\)\.where\("status",\s*"in",\s*\["online",\s*"in_ride"\]\)/.test(indexSrc) &&
    indexSrc.includes("CLIENT_CANDIDATE_INJECTION_DENIED") &&
    indexSrc.includes("matchRideCandidates(db");
  record(
    "no-full-fleet-scan-in-cf",
    "index.js uses geo path only",
    { noFullScan },
    noFullScan ? "PASS" : "FAIL"
  );

  const cellA = gridCellId(pickup.lat, pickup.lng);
  const nearby = kmOffset(pickup.lat, pickup.lng, 0.2, 0);
  const cellB = gridCellId(nearby.lat, nearby.lng);
  record("grid-cell-stability", "nearby point cell defined", { cellA, cellB, MATCH_GRID_DEG }, cellA && cellB ? "PASS" : "FAIL");

  const hs = GOLDEN_HOTSPOTS.find((h) => h.id === "hs_saddar");
  const inHs = locationGeoFields(hs.lat, hs.lng);
  const outHs = locationGeoFields(hs.lat + 0.02, hs.lng);
  record(
    "golden-hotspot-boundary",
    "inside 0.5km gets hotspotId; outside not",
    { inHs: inHs.hotspotId, outHs: outHs.hotspotId, radiusKm: GOLDEN_HOTSPOT_RADIUS_KM },
    inHs.hotspotId === "hs_saddar" && outHs.hotspotId == null ? "PASS" : "FAIL"
  );

  const cells1 = cellsCoveringDisk(pickup.lat, pickup.lng, 1);
  const cells3 = cellsCoveringDisk(pickup.lat, pickup.lng, 3);
  record(
    "cells-grow-with-radius",
    "3km cells >= 1km cells",
    { n1: cells1.length, n3: cells3.length },
    cells3.length >= cells1.length && cells1.length > 0 ? "PASS" : "FAIL"
  );

  // Overlap dedupe in progressive select
  const dupDrivers = [
    { driverId: "dup", lat: pickup.lat + 0.001, lng: pickup.lng, status: "online" },
    { driverId: "dup", lat: pickup.lat + 0.001, lng: pickup.lng, status: "online" },
    { driverId: "other", lat: pickup.lat + 0.002, lng: pickup.lng, status: "online" },
  ];
  const deduped = selectCandidatesProgressive(pickup, dupDrivers, 10);
  record(
    "overlapping-cells-dedupe",
    "unique driverIds",
    deduped.map((c) => c.driverId),
    deduped.filter((c) => c.driverId === "dup").length === 1 ? "PASS" : "FAIL"
  );

  // Exclusions
  const nowMs = Date.now();
  const excl = selectCandidatesProgressive(
    pickup,
    [
      { driverId: "ok", lat: pickup.lat + 0.001, lng: pickup.lng, status: "online", locationUpdatedAtMs: nowMs },
      { driverId: "off", lat: pickup.lat + 0.001, lng: pickup.lng, status: "offline", locationUpdatedAtMs: nowMs },
      { driverId: "busy", lat: pickup.lat + 0.001, lng: pickup.lng, status: "online", activeRideId: "r1", locationUpdatedAtMs: nowMs },
      { driverId: "block", lat: pickup.lat + 0.001, lng: pickup.lng, status: "online", accountStatus: "blocked", locationUpdatedAtMs: nowMs },
      { driverId: "susp", lat: pickup.lat + 0.001, lng: pickup.lng, status: "online", accountStatus: "suspended", locationUpdatedAtMs: nowMs },
      { driverId: "stale", lat: pickup.lat + 0.001, lng: pickup.lng, status: "online", locationUpdatedAtMs: nowMs - 10 * 60 * 1000 },
      { driverId: "bad", lat: NaN, lng: pickup.lng, status: "online", locationUpdatedAtMs: nowMs },
    ],
    10,
    { nowMs, requireFreshLocation: true }
  );
  record(
    "exclude-stale-blocked-busy-offline",
    "only ok",
    excl.map((c) => c.driverId),
    excl.length === 1 && excl[0].driverId === "ok" ? "PASS" : "FAIL"
  );

  // Nearest ordering
  const ordered = selectCandidatesProgressive(
    pickup,
    [
      { driverId: "far", lat: pickup.lat + 0.02, lng: pickup.lng, status: "online" },
      { driverId: "near", lat: pickup.lat + 0.001, lng: pickup.lng, status: "online" },
      { driverId: "mid", lat: pickup.lat + 0.008, lng: pickup.lng, status: "online" },
    ],
    10
  );
  record(
    "nearest-driver-ordering",
    "near, mid, far",
    ordered.map((c) => c.driverId),
    ordered[0]?.driverId === "near" && ordered[1]?.driverId === "mid" ? "PASS" : "FAIL"
  );

  // Ring expansion pure
  const ringDrivers = [];
  for (let i = 0; i < 3; i++) {
    const p = kmOffset(pickup.lat, pickup.lng, 0.5, i);
    ringDrivers.push({ driverId: `r1-${i}`, lat: p.lat, lng: p.lng, status: "online" });
  }
  for (let i = 0; i < 3; i++) {
    const p = kmOffset(pickup.lat, pickup.lng, 1.5, i);
    ringDrivers.push({ driverId: `r2-${i}`, lat: p.lat, lng: p.lng, status: "online" });
  }
  for (let i = 0; i < 3; i++) {
    const p = kmOffset(pickup.lat, pickup.lng, 2.5, i);
    ringDrivers.push({ driverId: `r3-${i}`, lat: p.lat, lng: p.lng, status: "online" });
  }
  const only1 = selectCandidatesProgressive(pickup, ringDrivers.slice(0, 3), 10);
  record("search-1km", "only ring1", only1.map((c) => c.ringKm), only1.every((c) => c.ringKm === 1) && only1.length === 3 ? "PASS" : "FAIL");
  const to2 = selectCandidatesProgressive(pickup, ringDrivers.slice(0, 6), 10);
  record(
    "expand-1-to-2km",
    "includes ring 2",
    to2.map((c) => c.ringKm),
    to2.some((c) => c.ringKm === 2) ? "PASS" : "FAIL"
  );
  const to3 = selectCandidatesProgressive(pickup, ringDrivers, 10);
  record(
    "expand-2-to-3km",
    "includes ring 3",
    to3.map((c) => c.ringKm),
    to3.some((c) => c.ringKm === 3) ? "PASS" : "FAIL"
  );
  const none = selectCandidatesProgressive(pickup, [{ driverId: "x", lat: pickup.lat + 0.1, lng: pickup.lng, status: "online" }], 10);
  record("no-driver-within-3km", "empty", none.length, none.length === 0 ? "PASS" : "FAIL");

  // --- Emulator geo path ---
  const prefix = `p3b${Date.now().toString(36)}`;
  await db.doc("settings/dispatch").set({ candidateDriverLimit: 10, searchRingsKm: [1, 2, 3] });

  // Local near drivers for limit 10 / 20
  for (let i = 0; i < 25; i++) {
    const p = kmOffset(pickup.lat, pickup.lng, 0.3 + i * 0.05, i * 0.4);
    await seedVehicle(`${prefix}-near-v${i}`, `${prefix}-near-d${i}`, p.lat, p.lng);
  }
  // Far fleet (should not inflate geo reads much when outside cells)
  await batchSeedOnline(`${prefix}-far`, 200, (i) => kmOffset(pickup.lat, pickup.lng, 15 + (i % 50) * 0.1, i));

  const rideRef = db.collection("rides").doc();
  await rideRef.set({
    userId: `${prefix}-cust`,
    status: "searching_driver",
    pickupLocation: { ...pickup, address: "P" },
    dropoffLocation: { lat: 24.9, lng: 67.05, address: "D" },
    createdAt: FieldValue.serverTimestamp(),
  });

  const t0 = Date.now();
  const matched10 = await matchRideCandidates(db, {
    rideId: rideRef.id,
    pickup,
    candidateDriverLimit: 10,
  });
  const ms10 = Date.now() - t0;
  record(
    "limit-10-geo",
    "10 candidates, geo metrics",
    {
      n: matched10.candidates.length,
      metrics: matched10.metrics,
      ms: ms10,
    },
    matched10.candidates.length === 10 && matched10.metrics?.usedFullFleetScan === false ? "PASS" : "FAIL"
  );

  await db.doc("settings/dispatch").set({ candidateDriverLimit: 20, searchRingsKm: [1, 2, 3] });
  const ride20 = db.collection("rides").doc();
  await ride20.set({
    userId: `${prefix}-cust`,
    status: "searching_driver",
    pickupLocation: { ...pickup, address: "P" },
    dropoffLocation: { lat: 24.9, lng: 67.05, address: "D" },
    createdAt: FieldValue.serverTimestamp(),
  });
  const matched20 = await matchRideCandidates(db, {
    rideId: ride20.id,
    pickup,
    candidateDriverLimit: 20,
  });
  record(
    "limit-20-geo",
    "20 candidates",
    { n: matched20.candidates.length, metrics: matched20.metrics },
    matched20.candidates.length === 20 && matched20.metrics?.source === "geo_scoped" ? "PASS" : "FAIL"
  );

  // Ring expansion geo: isolated pickup so near fleet does not satisfy limit at 1 km
  const isoPickup = { lat: 25.2, lng: 67.5 };
  const ringPref = `${prefix}-ring`;
  for (let i = 0; i < 5; i++) {
    const p = kmOffset(isoPickup.lat, isoPickup.lng, 2.2, i);
    await seedVehicle(`${ringPref}-v${i}`, `${ringPref}-d${i}`, p.lat, p.lng);
  }
  const geoRing = await loadAndSelectGeoCandidates(db, isoPickup, 10);
  record(
    "geo-expand-to-3km-for-distant",
    "ringExpandedToKm >= 2 with only 2.2km drivers",
    geoRing.metrics,
    geoRing.metrics.ringExpandedToKm >= 2 && geoRing.selected.length >= 1 ? "PASS" : "FAIL"
  );

  // Double-assign prevention is finalize path — assert activeRideId excluded
  await seedVehicle(`${prefix}-busy-v`, `${prefix}-busy-d`, pickup.lat + 0.001, pickup.lng, {
    activeRideId: "busy-ride",
  });
  const busySel = await loadAndSelectGeoCandidates(db, pickup, 10);
  record(
    "busy-driver-excluded",
    "busy-d not selected",
    busySel.selected.map((c) => c.driverId),
    !busySel.selected.some((c) => c.driverId === `${prefix}-busy-d`) ? "PASS" : "FAIL"
  );

  // --- Callable security ---
  const custUid = `${prefix}-cf-c`;
  await ensureUser(`${custUid}@example.com`, "Phase3B-test!", custUid);
  const cust = clientApp(`${prefix}-cf`);
  await signInWithEmailAndPassword(cust.auth, `${custUid}@example.com`, "Phase3B-test!");
  const cfRide = await callAs(cust.functions, "createCustomerBooking", {
    confirmedExtraBooking: true,
    pickupLocation: { ...pickup, address: "P" },
    dropoffLocation: { lat: 24.9, lng: 67.05, address: "D" },
    vehicleType: "Go",
    vehicleTypeKey: "go",
    distanceKm: 4,
    timeMins: 12,
    farePkr: 250,
    estimatedFare: 250,
    paymentMethod: "cash",
  });
  let injectDenied = false;
  try {
    await callAs(cust.functions, "matchRideCandidates", {
      rideId: cfRide.id,
      onlineDrivers: [{ driverId: "evil", lat: pickup.lat, lng: pickup.lng }],
    });
  } catch (e) {
    injectDenied = String(e.message || e.code || e).includes("CLIENT_CANDIDATE_INJECTION_DENIED") ||
      String(e.message || "").includes("invalid-argument");
  }
  record("client-cannot-inject-candidates", "denied", injectDenied, injectDenied ? "PASS" : "FAIL");

  await db.doc("settings/dispatch").set({ candidateDriverLimit: 10 });
  const cfMatch = await callAs(cust.functions, "matchRideCandidates", {
    rideId: cfRide.id,
    candidateDriverLimit: 20, // ignored for non-admin
  });
  record(
    "customer-cannot-bump-limit",
    "stays 10 from settings",
    cfMatch?.candidateDriverLimit,
    cfMatch?.candidateDriverLimit === 10 ? "PASS" : "FAIL"
  );

  // --- Scale fixtures (isolated pickups to avoid cross-run cell pollution) ---
  for (const total of [100, 1000, 10000]) {
    const sp = `${prefix}-s${total}`;
    const scalePickup = {
      lat: 24.5 + total * 0.00001,
      lng: 66.8 + total * 0.00001,
    };
    const tSeed = Date.now();
    await batchSeedOnline(`${sp}-local`, 30, (i) =>
      kmOffset(scalePickup.lat, scalePickup.lng, 0.2 + (i % 10) * 0.08, i)
    );
    await batchSeedOnline(`${sp}-far`, total - 30, (i) =>
      kmOffset(scalePickup.lat, scalePickup.lng, 12 + (i % 80) * 0.05, i * 0.17)
    );
    const seedMs = Date.now() - tSeed;
    const tMatch = Date.now();
    const geo = await loadAndSelectGeoCandidates(db, scalePickup, 10);
    const matchMs = Date.now() - tMatch;
    const old = oldFullFleetReads(total);
    const newReads = geo.metrics.vehicleDocsRead + geo.metrics.partnerDocsRead;
    const reductionPct = Math.round((1 - newReads / old.total) * 1000) / 10;
    const row = {
      totalOnline: total,
      queriedCells: geo.metrics.queriedCells.length,
      queriedHotspots: geo.metrics.queriedHotspots.length,
      vehicleDocsRead: geo.metrics.vehicleDocsRead,
      partnerDocsRead: geo.metrics.partnerDocsRead,
      candidatesInspected: geo.metrics.candidatesInspected,
      candidatesReturned: geo.selected.length,
      ringExpandedToKm: geo.metrics.ringExpandedToKm,
      matchMs,
      seedMs,
      oldFullFleetReads: old.total,
      newReads,
      measuredReadReductionPct: reductionPct,
      usedFullFleetScan: geo.metrics.usedFullFleetScan,
    };
    scaleRows.push(row);
    const okScale =
      !geo.metrics.usedFullFleetScan &&
      geo.selected.length > 0 &&
      newReads < old.total &&
      (total < 500 || newReads < old.total * 0.5);
    record(
      `scale-${total}-online`,
      "geo reads below full-fleet baseline; no full scan",
      row,
      okScale ? "PASS" : "FAIL"
    );
  }

  // Distant-only additivity: match twice with same local set — adding far already done; compare 100 vs 10000 vehicle reads should be similar order
  const r100 = scaleRows.find((r) => r.totalOnline === 100);
  const r10k = scaleRows.find((r) => r.totalOnline === 10000);
  const similar =
    r100 &&
    r10k &&
    r10k.vehicleDocsRead <= r100.vehicleDocsRead * 3 + 50; // allow some cell density variance
  record(
    "distant-drivers-do-not-inflate-reads",
    "10k vehicle reads not >> 100",
    { r100: r100?.vehicleDocsRead, r10k: r10k?.vehicleDocsRead },
    similar ? "PASS" : "FAIL"
  );

  await deleteApp(cust.app).catch(() => {});

  const passed = results.filter((r) => r.status === "PASS").length;
  const failed = results.filter((r) => r.status === "FAIL").length;
  const summary = {
    phase: "3B",
    project: PROJECT,
    productionTouched: false,
    billingEnabled: false,
    deployed: false,
    matchGridDeg: MATCH_GRID_DEG,
    scaleRows,
    totals: { passed, failed, blocked: 0, skipped: 0, total: results.length },
    results,
  };
  fs.writeFileSync(OUT, JSON.stringify(summary, null, 2));
  console.log(`\n[phase3b] ${passed} passed / ${failed} failed → ${OUT}`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
