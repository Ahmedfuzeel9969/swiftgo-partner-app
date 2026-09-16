/**
 * Trusted setDriverOnlineLocation handler — Admin SDK go-online after PIN.
 * Run: npm run test:driver-online-callable
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROJECT = "demo-swiftgo-phase1";
const OUT = path.join(ROOT, "tests", "driver-online-callable-results.json");

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
const db = admin.firestore(adminApp);
const { setDriverOnlineLocation } = require(path.join(ROOT, "functions", "driver-online.js"));
const { locationGeoFields } = require(path.join(ROOT, "functions", "geo-cells.js"));

const LAT = 24.8612;
const LNG = 67.0022;
const SESSION = "s_online_test_sess01";

const results = [];
function record(name, status, detail = "") {
  results.push({ name, status, detail, suite: "driver-online-callable" });
  const mark = status === "PASS" ? "✓" : status === "FAIL" ? "✗" : "·";
  console.log(`${mark} ${name} — ${status}${detail ? `: ${detail}` : ""}`);
}

async function expectThrow(fn, code, name) {
  try {
    await fn();
    record(name, "FAIL", "expected throw");
  } catch (e) {
    record(name, e.message === code || e.code === code ? "PASS" : "FAIL", e.message || String(e));
  }
}

async function main() {
  if (!process.env.FIRESTORE_EMULATOR_HOST) {
    record("emulator-host", "BLOCKED", "FIRESTORE_EMULATOR_HOST unset");
    writeOut(2);
    return;
  }

  const indexSrc = fs.readFileSync(path.join(ROOT, "functions", "index.js"), "utf8");
  const driverApp = fs.readFileSync(path.join(ROOT, "driver-app", "js", "driver-app.js"), "utf8");
  const clientSrc = fs.readFileSync(path.join(ROOT, "driver-app", "js", "driver-online-client.js"), "utf8");

  record(
    "export-wired",
    indexSrc.includes("setDriverOnlineLocation") &&
      indexSrc.includes('require("./driver-online")') &&
      indexSrc.includes('exports.setDriverOnlineLocation')
      ? "PASS"
      : "FAIL"
  );
  record(
    "client-wired",
    clientSrc.includes('"setDriverOnlineLocation"') &&
      driverApp.includes("setDriverOnlineLocationClient")
      ? "PASS"
      : "FAIL"
  );

  const writeStart = driverApp.indexOf("async function writeOnlineReadyVehicle");
  const writeEnd = driverApp.indexOf("async function activateDriverOnlineMode", writeStart);
  const writeBlock = driverApp.slice(writeStart, writeEnd);
  record(
    "online-write-uses-callable-not-client-updateDoc",
    writeBlock.includes("setDriverOnlineLocationClient") && !writeBlock.includes("updateDoc(")
      ? "PASS"
      : "FAIL"
  );

  const ownerUid = "owner-on1";
  const driverA = "driver-on-a";
  const driverB = "driver-on-b";
  const blocked = "driver-on-blocked";
  const geo = locationGeoFields(LAT, LNG);

  await db.doc(`partners/${driverA}`).set({
    uid: driverA,
    role: "driver",
    accountStatus: "active",
    currentVehicleId: "veh-on-a",
  });
  await db.doc(`partners/${blocked}`).set({
    uid: blocked,
    role: "driver",
    accountStatus: "blocked",
    currentVehicleId: "veh-on-blocked",
  });

  await db.doc("vehicles/veh-on-a").set({
    ownerId: ownerUid,
    plate: "ON-A",
    driverId: driverA,
    status: "offline",
    pinHash: "deadbeef",
  });
  await db.doc("vehicles/veh-on-pin").set({
    ownerId: ownerUid,
    plate: "ON-PIN",
    driverId: driverA,
    driverName: "Test Driver",
    status: "online",
    pinHash: "cafebabe",
    location: { lat: LAT, lng: LNG },
    locationUpdatedAt: admin.firestore.Timestamp.now(),
    ...geo,
  });
  await db.doc("vehicles/veh-on-other").set({
    ownerId: ownerUid,
    plate: "ON-OTH",
    driverId: driverA,
    status: "offline",
  });
  await db.doc("vehicles/veh-on-blocked").set({
    ownerId: ownerUid,
    plate: "ON-BLK",
    driverId: blocked,
    status: "offline",
  });
  await db.doc("rides/ride-live-1").set({
    driverId: driverA,
    vehicleId: "veh-on-ride",
    status: "in_progress",
    userId: "cust-on-1",
  });
  await db.doc("vehicles/veh-on-ride").set({
    ownerId: ownerUid,
    plate: "ON-RIDE",
    driverId: driverA,
    status: "in_ride",
    activeRideId: "ride-live-1",
  });

  try {
    const out = await setDriverOnlineLocation(db, {
      driverUid: driverA,
      vehicleId: "veh-on-a",
      lat: LAT,
      lng: LNG,
      trackingSessionId: SESSION,
      driverName: "Online A",
      observedAt: Date.now(),
      sequence: 1,
      source: "gps",
    });
    const snap = await db.doc("vehicles/veh-on-a").get();
    const data = snap.data() || {};
    const ok =
      out?.ok === true &&
      data.status === "online" &&
      data.driverId === driverA &&
      data.trackingSessionId === SESSION &&
      data.location?.sessionId === SESSION &&
      data.geoCell === geo.geoCell &&
      data.locationUpdatedAt != null &&
      data.trackingSessionStartedAt != null;
    record("happy-path-offline-to-online", ok ? "PASS" : "FAIL", ok ? "" : "missing session/geo/status");
  } catch (e) {
    record("happy-path-offline-to-online", "FAIL", e.message || String(e));
  }

  try {
    await setDriverOnlineLocation(db, {
      driverUid: driverA,
      vehicleId: "veh-on-pin",
      lat: LAT,
      lng: LNG,
      trackingSessionId: SESSION,
      driverName: "Online A",
      observedAt: Date.now(),
      sequence: 2,
      source: "gps",
    });
    const snap = await db.doc("vehicles/veh-on-pin").get();
    const data = snap.data() || {};
    const ok =
      data.status === "online" &&
      data.location?.sessionId === SESSION &&
      data.trackingSessionId === SESSION &&
      !("activeRideId" in data && data.activeRideId);
    record("post-pin-doc-stamps-sessionId", ok ? "PASS" : "FAIL");
  } catch (e) {
    record("post-pin-doc-stamps-sessionId", "FAIL", e.message || String(e));
  }

  await expectThrow(
    () =>
      setDriverOnlineLocation(db, {
        driverUid: driverB,
        vehicleId: "veh-on-other",
        lat: LAT,
        lng: LNG,
        trackingSessionId: SESSION,
      }),
    "VEHICLE_IN_USE",
    "deny-other-driver"
  );

  await expectThrow(
    () =>
      setDriverOnlineLocation(db, {
        driverUid: blocked,
        vehicleId: "veh-on-blocked",
        lat: LAT,
        lng: LNG,
        trackingSessionId: SESSION,
      }),
    "DRIVER_BLOCKED",
    "deny-blocked-partner"
  );

  await expectThrow(
    () =>
      setDriverOnlineLocation(db, {
        driverUid: driverA,
        vehicleId: "veh-on-ride",
        lat: LAT,
        lng: LNG,
        trackingSessionId: SESSION,
      }),
    "DRIVER_HAS_ACTIVE_RIDE",
    "deny-in-ride"
  );

  await db.doc("rides/ride-stale-done").set({
    driverId: driverA,
    vehicleId: "veh-on-stale",
    status: "completed",
  });
  await db.doc(`partners/${driverA}`).set({ activeRideId: "ride-stale-done" }, { merge: true });
  await db.doc("vehicles/veh-on-stale").set({
    ownerId: ownerUid,
    plate: "ON-STALE",
    driverId: driverA,
    status: "offline",
    pinHash: "stalebeef",
    activeRideId: "ride-stale-done",
  });
  try {
    await setDriverOnlineLocation(db, {
      driverUid: driverA,
      vehicleId: "veh-on-stale",
      lat: LAT,
      lng: LNG,
      trackingSessionId: SESSION,
      driverName: "Online A",
    });
    const partner = (await db.doc(`partners/${driverA}`).get()).data() || {};
    const veh = (await db.doc("vehicles/veh-on-stale").get()).data() || {};
    const ok =
      veh.status === "online" && !partner.activeRideId && !veh.activeRideId;
    record("heal-stale-partner-pointer-on-online", ok ? "PASS" : "FAIL");
  } catch (e) {
    record("heal-stale-partner-pointer-on-online", "FAIL", e.message || String(e));
  }

  await expectThrow(
    () =>
      setDriverOnlineLocation(db, {
        driverUid: driverA,
        vehicleId: "veh-on-a",
        lat: 999,
        lng: LNG,
        trackingSessionId: SESSION,
      }),
    "INVALID_LOCATION",
    "deny-invalid-lat"
  );

  writeOut(results.some((r) => r.status === "FAIL") ? 1 : 0);
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

main().catch((err) => {
  console.error(err);
  writeOut(1);
});
