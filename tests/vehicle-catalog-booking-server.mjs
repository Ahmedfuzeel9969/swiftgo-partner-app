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
  let admin;
  try {
    admin = require(
      require.resolve("firebase-admin", { paths: [join(root, "functions"), root] })
    );
  } catch {
    record("B07-emulator-booking-suite", "BLOCKED", "firebase-admin not installed");
    return;
  }

  process.env.FIRESTORE_EMULATOR_HOST =
    process.env.FIRESTORE_EMULATOR_HOST || host;
  let app;
  try {
    app = admin.app();
  } catch {
    app = admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || "demo-swiftgo-phase1" });
  }
  const db = admin.firestore(app);

  async function bookFor(customerUid, vehicleFields, { confirmedExtraBooking = false } = {}) {
    return createCustomerBooking(db, {
      customerUid,
      confirmedExtraBooking,
      ridePayload: { ...basePayload, ...vehicleFields },
    });
  }

  async function expectBookingReject(customerUid, vehicleFields, code, name) {
    let rejected = false;
    let detail = "";
    try {
      await bookFor(customerUid, vehicleFields);
    } catch (err) {
      detail = `${err?.code || ""}:${err?.message || err}`;
      rejected = err?.message === code || String(err?.message || "").includes(code);
    }
    record(name, rejected ? "PASS" : "FAIL", detail || "no throw");
  }

  const cleanupUids = [];
  try {
    const canonicalUid = `vc-booking-canonical-${Date.now()}`;
    cleanupUids.push(canonicalUid);
    const created = await bookFor(canonicalUid, { vehicleTypeKey: "bike", vehicleType: "Bike" });
    const snap = await db.doc(`rides/${created.id}`).get();
    const data = snap.data() || {};
    record(
      "B07-emulator-canonical-stored",
      data.vehicleTypeKey === "bike" ? "PASS" : "FAIL",
      JSON.stringify({ vehicleTypeKey: data.vehicleTypeKey, vehicleType: data.vehicleType })
    );

    const legacyUid = `vc-booking-legacy-${Date.now()}`;
    cleanupUids.push(legacyUid);
    const legacy = await bookFor(legacyUid, { vehicleTypeKey: "mini", vehicleType: "Go" });
    const legacySnap = await db.doc(`rides/${legacy.id}`).get();
    const legacyData = legacySnap.data() || {};
    record(
      "B08-emulator-legacy-normalized",
      legacyData.vehicleTypeKey === "go" ? "PASS" : "FAIL",
      JSON.stringify({ vehicleTypeKey: legacyData.vehicleTypeKey })
    );

    await expectBookingReject(
      `vc-booking-unknown-${Date.now()}`,
      { vehicleTypeKey: "unknown-vehicle-x" },
      "UNKNOWN_VEHICLE_TYPE",
      "B09-emulator-unknown-rejected"
    );

    await expectBookingReject(
      `vc-booking-empty-${Date.now()}`,
      {},
      "EMPTY_VEHICLE_TYPE",
      "B10-emulator-empty-rejected"
    );

    await expectBookingReject(
      `vc-booking-conflict-${Date.now()}`,
      { vehicleTypeKey: "go", vehicleType: "premium" },
      "VEHICLE_TYPE_CONFLICT",
      "B11-emulator-conflict-rejected"
    );
  } catch (err) {
    record("B12-emulator-booking-suite", "FAIL", String(err?.message || err));
  } finally {
    for (const customerUid of cleanupUids) {
      const rides = await db.collection("rides").where("userId", "==", customerUid).get();
      for (const docSnap of rides.docs) {
        await docSnap.ref.delete();
      }
      await db.doc(`booking_slots/${customerUid}`).delete().catch(() => {});
    }
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
