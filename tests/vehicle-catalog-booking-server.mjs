/**
 * Phase 1 — server-side booking vehicle validation (unit + emulator).
 * Run: node tests/vehicle-catalog-booking-server.mjs
 * Emulator: firebase emulators:exec --only firestore --project demo-swiftgo-phase1 "node tests/vehicle-catalog-booking-server.mjs"
 */
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const require = createRequire(import.meta.url);

const results = [];
function record(name, status, detail = "") {
  results.push({ name, status, detail, generatedAt: new Date().toISOString() });
  const mark = status === "PASS" ? "✓" : status === "FAIL" ? "✗" : "·";
  console.log(`${mark} ${name} — ${status}${detail ? `: ${detail}` : ""}`);
}

const esm = await import(pathToFileURL(join(root, "shared/js/vehicle-catalog.mjs")).href);
const cjs = require(join(root, "functions/vehicle-catalog.js"));

const basePayload = {
  pickupLocation: { lat: 24.8607, lng: 67.0011, address: "A" },
  dropoffLocation: { lat: 24.87, lng: 67.01, address: "B" },
  distanceKm: 3,
  timeMins: 10,
  farePkr: 200,
  estimatedFare: 200,
  paymentMethod: "cash",
};

function expectNormalize(fn, input, expected) {
  const out = fn(input);
  const ok =
    out.vehicleTypeKey === expected.vehicleTypeKey &&
    (expected.vehicleType == null || out.vehicleType === expected.vehicleType);
  record(
    expected.name,
    ok ? "PASS" : "FAIL",
    JSON.stringify(out)
  );
}

function expectNormalizeThrow(fn, input, code, name) {
  let thrown = null;
  try {
    fn(input);
  } catch (err) {
    thrown = err;
  }
  record(
    name,
    thrown?.code === code ? "PASS" : "FAIL",
    thrown ? `${thrown.code}:${thrown.message}` : "no throw"
  );
}

for (const id of esm.CANONICAL_VEHICLE_IDS) {
  for (const [label, fn] of [
    ["esm", esm.normalizeBookingVehicleFields.bind(esm)],
    ["cjs", cjs.normalizeBookingVehicleFields.bind(cjs)],
  ]) {
    expectNormalize(fn, { vehicleTypeKey: id, vehicleType: "Display" }, {
      name: `B01-${label}-canonical-${id}`,
      vehicleTypeKey: id,
      vehicleType: "Display",
    });
  }
}

const legacyCases = [
  ["mini", "go"],
  ["ac", "go-plus"],
  ["premium", "business"],
  ["rickshaw", "bike-cargo"],
  ["van", "suzuki"],
  ["cargo", "truck"],
];

for (const [legacy, canonical] of legacyCases) {
  expectNormalize(cjs.normalizeBookingVehicleFields, { vehicleTypeKey: legacy }, {
    name: `B02-legacy-${legacy}-to-${canonical}`,
    vehicleTypeKey: canonical,
  });
}

expectNormalizeThrow(
  cjs.normalizeBookingVehicleFields,
  { vehicleTypeKey: "not-a-real-vehicle" },
  "UNKNOWN_VEHICLE_TYPE",
  "B03-unknown-rejected"
);

expectNormalizeThrow(
  cjs.normalizeBookingVehicleFields,
  {},
  "EMPTY_VEHICLE_TYPE",
  "B04-missing-both-rejected"
);

expectNormalize(
  cjs.normalizeBookingVehicleFields,
  { vehicleType: "go" },
  { name: "B05-missing-key-type-only-resolves", vehicleTypeKey: "go" }
);

expectNormalizeThrow(
  cjs.normalizeBookingVehicleFields,
  { vehicleTypeKey: "go", vehicleType: "premium" },
  "VEHICLE_TYPE_CONFLICT",
  "B06-conflict-rejected"
);

async function emulatorReachable(host) {
  const [hostname, portStr] = host.split(":");
  const port = Number(portStr);
  if (!hostname || !Number.isFinite(port)) return false;
  const net = await import("node:net");
  return new Promise((resolve) => {
    const socket = net.connect({ host: hostname, port, timeout: 1500 }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
    socket.on("timeout", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function runEmulatorBookingTests() {
  const host = process.env.FIRESTORE_EMULATOR_HOST;
  if (!host || !(await emulatorReachable(host))) {
    record("B07-emulator-booking-suite", "BLOCKED", host ? `Firestore emulator unreachable at ${host}` : "FIRESTORE_EMULATOR_HOST not set");
    return;
  }

  const { createCustomerBooking } = require(join(root, "functions/bargaining.js"));
  const admin = require("firebase-admin");
  if (!admin.apps.length) {
    admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || "demo-swiftgo-phase1" });
  }
  const db = admin.firestore();

  const uid = `vc-booking-${Date.now()}`;
  await db.doc(`booking_slots/${uid}`).set({ count: 0 });

  async function book(vehicleFields) {
    return createCustomerBooking(db, {
      customerUid: uid,
      confirmedExtraBooking: false,
      ridePayload: { ...basePayload, ...vehicleFields },
    });
  }

  try {
    const created = await book({ vehicleTypeKey: "bike", vehicleType: "Bike" });
    const snap = await db.doc(`rides/${created.id}`).get();
    const data = snap.data() || {};
    record(
      "B07-emulator-canonical-stored",
      data.vehicleTypeKey === "bike" ? "PASS" : "FAIL",
      JSON.stringify({ vehicleTypeKey: data.vehicleTypeKey, vehicleType: data.vehicleType })
    );

    const legacy = await book({ vehicleTypeKey: "mini", vehicleType: "Go" });
    const legacySnap = await db.doc(`rides/${legacy.id}`).get();
    const legacyData = legacySnap.data() || {};
    record(
      "B08-emulator-legacy-normalized",
      legacyData.vehicleTypeKey === "go" ? "PASS" : "FAIL",
      JSON.stringify({ vehicleTypeKey: legacyData.vehicleTypeKey })
    );

    let unknownRejected = false;
    try {
      await book({ vehicleTypeKey: "unknown-vehicle-x" });
    } catch (err) {
      unknownRejected = err?.message === "UNKNOWN_VEHICLE_TYPE" || err?.code === "invalid-argument";
    }
    record("B09-emulator-unknown-rejected", unknownRejected ? "PASS" : "FAIL");

    let emptyRejected = false;
    try {
      await book({});
    } catch (err) {
      emptyRejected = err?.message === "EMPTY_VEHICLE_TYPE" || err?.code === "invalid-argument";
    }
    record("B10-emulator-empty-rejected", emptyRejected ? "PASS" : "FAIL");

    let conflictRejected = false;
    try {
      await book({ vehicleTypeKey: "go", vehicleType: "premium" });
    } catch (err) {
      conflictRejected = err?.message === "VEHICLE_TYPE_CONFLICT" || err?.code === "invalid-argument";
    }
    record("B11-emulator-conflict-rejected", conflictRejected ? "PASS" : "FAIL");
  } finally {
    const rides = await db.collection("rides").where("userId", "==", uid).get();
    for (const docSnap of rides.docs) {
      await docSnap.ref.delete();
    }
    await db.doc(`booking_slots/${uid}`).delete().catch(() => {});
  }
}

await runEmulatorBookingTests();

const failCount = results.filter((r) => r.status === "FAIL").length;
const blockedCount = results.filter((r) => r.status === "BLOCKED").length;
const passCount = results.filter((r) => r.status === "PASS").length;

writeFileSync(
  join(root, "tests/vehicle-catalog-booking-server-results.json"),
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      pass: passCount,
      fail: failCount,
      blocked: blockedCount,
      results,
    },
    null,
    2
  )
);

console.log(`\nSummary: pass=${passCount} fail=${failCount} blocked=${blockedCount}`);
process.exit(failCount ? 1 : 0);
