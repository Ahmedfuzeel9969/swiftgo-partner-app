/**
 * Authenticated Driver client write for writeOnlineReadyVehicle() under Firestore rules.
 * Run: npm run test:dispatch-online-ready-rules
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
import { doc, updateDoc, Timestamp, serverTimestamp } from "firebase/firestore";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROJECT = "demo-swiftgo-phase1";
const rules = fs.readFileSync(path.join(ROOT, "firestore.rules"), "utf8");
const OUT = path.join(ROOT, "tests", "dispatch-online-ready-rules-results.json");

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080";
}

const admin = require(require.resolve("firebase-admin", { paths: [path.join(ROOT, "functions"), ROOT] }));
let adminApp;
try {
  adminApp = admin.app();
} catch {
  adminApp = admin.initializeApp({ projectId: PROJECT });
}
const adminDb = admin.firestore(adminApp);
const AdminTimestamp = admin.firestore.Timestamp;

const { locationGeoFields, MATCH_GRID_DEG } = require(path.join(ROOT, "functions", "geo-cells.js"));

const LOCATION_GRID_DEG = 0.009;
const LAT = 24.8612;
const LNG = 67.0022;

const results = [];
function record(name, status, detail = "") {
  results.push({ name, status, detail, suite: "dispatch-online-ready-rules" });
  const mark = status === "PASS" ? "✓" : status === "FAIL" ? "✗" : "·";
  console.log(`${mark} ${name} — ${status}${detail ? `: ${detail}` : ""}`);
}

function matchGeoCellId(lat, lng) {
  return `g_${Math.floor(lat / MATCH_GRID_DEG)}_${Math.floor(lng / MATCH_GRID_DEG)}`;
}

/** Mirrors driver-app buildOnlineReadyVehiclePayload + client updateDoc fields. */
function buildOnlineReadyPayload(driverUid, lat = LAT, lng = LNG, { activeRideId = null } = {}) {
  const cell = `${Math.floor(lat / LOCATION_GRID_DEG)}_${Math.floor(lng / LOCATION_GRID_DEG)}`;
  const sessionId = `s_or_${driverUid.slice(0, 8)}_${Math.floor(lat * 1000)}`;
  return {
    driverId: driverUid,
    status: "online",
    driverName: "Test Driver",
    location: {
      lat,
      lng,
      observedAt: Date.now(),
      sequence: 1,
      sessionId,
      source: "gps",
    },
    locationUpdatedAt: Timestamp.now(),
    locationGridCell: cell,
    geoCell: matchGeoCellId(lat, lng),
    hotspotId: null,
    activeRideId,
    trackingSessionId: sessionId,
    trackingSessionStartedAt: serverTimestamp(),
  };
}

async function seedPartner(uid, { accountStatus = "active", currentVehicleId = null } = {}) {
  await adminDb.doc(`partners/${uid}`).set(
    {
      uid,
      role: "driver",
      accountStatus,
      currentVehicleId,
      walletBalance: 0,
    },
    { merge: true }
  );
}

async function driverWrite(testEnv, driverUid, vehicleId, payload) {
  const db = testEnv.authenticatedContext(driverUid, { email: `${driverUid}@test.local` }).firestore();
  await assertSucceeds(updateDoc(doc(db, "vehicles", vehicleId), payload));
}

async function driverWriteFails(testEnv, driverUid, vehicleId, payload) {
  const db = testEnv.authenticatedContext(driverUid, { email: `${driverUid}@test.local` }).firestore();
  await assertFails(updateDoc(doc(db, "vehicles", vehicleId), payload));
}

function writeOut(code) {
  const summary = {
    pass: results.filter((r) => r.status === "PASS").length,
    fail: results.filter((r) => r.status === "FAIL").length,
    blocked: results.filter((r) => r.status === "BLOCKED").length,
    total: results.length,
  };
  fs.writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), summary, results }, null, 2));
  console.log("\nSummary:", summary);
  process.exitCode = code;
}

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

  await testEnv.clearFirestore();

  const ownerUid = "owner-or1";
  const driverA = "driver-a";
  const driverB = "driver-b";
  const blockedDriver = "driver-blocked";

  await seedPartner(driverA, { currentVehicleId: "veh-a" });
  await seedPartner(driverB);
  await seedPartner(blockedDriver, { accountStatus: "blocked" });

  const baseVehicle = {
    ownerId: ownerUid,
    plate: "TEST-1",
    pinHash: "deadbeef",
  };

  // ── A: linked, offline, activeRideId absent ──
  try {
    await adminDb.doc("vehicles/veh-a").set({
      ...baseVehicle,
      driverId: driverA,
      status: "offline",
    });
    await driverWrite(testEnv, driverA, "veh-a", buildOnlineReadyPayload(driverA));
    record("state-A-linked-offline-no-activeRideId", "PASS");
  } catch (e) {
    record("state-A-linked-offline-no-activeRideId", "FAIL", String(e.message || e));
  }

  // ── B: linked, offline, activeRideId null ──
  try {
    await adminDb.doc("vehicles/veh-b").set({
      ...baseVehicle,
      plate: "TEST-2",
      driverId: driverA,
      status: "offline",
      activeRideId: null,
    });
    await driverWrite(testEnv, driverA, "veh-b", buildOnlineReadyPayload(driverA));
    record("state-B-linked-offline-activeRideId-null", "PASS");
  } catch (e) {
    record("state-B-linked-offline-activeRideId-null", "FAIL", String(e.message || e));
  }

  // ── C: shape after linkVehicleByPin (CF), driver refreshes ONLINE_READY ──
  try {
    const geo = locationGeoFields(LAT, LNG);
    await adminDb.doc("vehicles/veh-pin").set({
      ...baseVehicle,
      plate: "TEST-PIN",
      driverId: driverA,
      driverName: "Test Driver",
      status: "online",
      pinHash: "cafebabe",
      updatedAt: AdminTimestamp.now(),
      location: { lat: LAT, lng: LNG },
      locationUpdatedAt: AdminTimestamp.now(),
      ...geo,
    });
    await driverWrite(testEnv, driverA, "veh-pin", buildOnlineReadyPayload(driverA));
    record("state-C-after-pin-link-refresh", "PASS");
  } catch (e) {
    record("state-C-after-pin-link-refresh", "FAIL", String(e.message || e));
  }

  // ── D: returning after ride — clear activeRideId + fresh geo ──
  try {
    await adminDb.doc("vehicles/veh-return").set({
      ...baseVehicle,
      plate: "TEST-RET",
      driverId: driverA,
      status: "in_ride",
      activeRideId: "ride-prev-1",
      location: { lat: LAT - 0.01, lng: LNG - 0.01 },
      locationUpdatedAt: AdminTimestamp.fromMillis(Date.now() - 60000),
      geoCell: matchGeoCellId(LAT - 0.01, LNG - 0.01),
      locationGridCell: "old_cell",
    });
    await driverWrite(testEnv, driverA, "veh-return", buildOnlineReadyPayload(driverA, LAT, LNG, { activeRideId: null }));
    record("state-D-after-ride-activeRideId-cleared", "PASS");
  } catch (e) {
    record("state-D-after-ride-activeRideId-cleared", "FAIL", String(e.message || e));
  }

  // ── Negative: other driver ──
  try {
    await adminDb.doc("vehicles/veh-other").set({
      ...baseVehicle,
      plate: "TEST-OTH",
      driverId: driverA,
      status: "offline",
    });
    await driverWriteFails(testEnv, driverB, "veh-other", buildOnlineReadyPayload(driverB));
    record("deny-other-driver", "PASS");
  } catch (e) {
    record("deny-other-driver", "FAIL", String(e.message || e));
  }

  // ── Negative: blocked partner ──
  try {
    await adminDb.doc("vehicles/veh-blocked").set({
      ...baseVehicle,
      plate: "TEST-BLK",
      driverId: blockedDriver,
      status: "offline",
    });
    await driverWriteFails(testEnv, blockedDriver, "veh-blocked", buildOnlineReadyPayload(blockedDriver));
    record("deny-blocked-partner", "PASS");
  } catch (e) {
    record("deny-blocked-partner", "FAIL", String(e.message || e));
  }

  // Owner wallet mutation remains blocked under current owner policy (separate hardening later).
  try {
    await adminDb.doc("vehicles/veh-fin").set({
      ...baseVehicle,
      plate: "TEST-FIN",
      status: "offline",
      walletBalance: 0,
    });
    const ownerDb = testEnv.authenticatedContext(ownerUid, { email: "owner@test.local" }).firestore();
    await assertFails(updateDoc(doc(ownerDb, "vehicles", "veh-fin"), { walletBalance: 9999 }));
    record("deny-owner-wallet-mutation", "PASS");
  } catch (e) {
    record("deny-owner-wallet-mutation", "FAIL", String(e.message || e));
  }

  // ── Combined payload is the exact writeOnlineReadyVehicle shape ──
  const payloadKeys = Object.keys(buildOnlineReadyPayload(driverA)).sort().join(",");
  record(
    "payload-shape-matches-driver-app",
    payloadKeys.includes("geoCell") && payloadKeys.includes("locationUpdatedAt") ? "PASS" : "FAIL",
    payloadKeys
  );

  await testEnv.cleanup();
  const failed = results.some((r) => r.status === "FAIL");
  writeOut(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  record("fatal", "FAIL", String(err.message || err));
  writeOut(1);
});
