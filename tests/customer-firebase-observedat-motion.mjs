/**
 * Regression: Firebase location observedAt must not be coerced with Number().
 * Number(FirestoreTimestamp) / Number(0) → Date.now() poisons the arbiter so later
 * real GPS samples look stale and the customer marker freezes.
 *
 * Also guards active-ride move gate (must be ~10m, not idle 200m).
 *
 * Run: node tests/customer-firebase-observedat-motion.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCustomerP2pController } from "../customer-app/js/p2p-ride-controller.mjs";
import { createLiveLocationSourceArbiter } from "../customer-app/js/live-location-source-arbiter.mjs";
import { timestampToMs } from "../customer-app/js/live-location-render.mjs";
import {
  ACTIVE_LOCATION_MOVE_M,
  MIN_LOCATION_MOVE_M,
} from "../driver-app/js/location-checkpoint-policy.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "tests/customer-firebase-observedat-motion-results.json");

const results = [];
function record(name, ok, detail = "") {
  const status = ok ? "PASS" : "FAIL";
  results.push({ name, status, detail });
  console.log(`${ok ? "✓" : "✗"} ${name} — ${status}${detail ? `: ${detail}` : ""}`);
}

const src = fs.readFileSync(
  path.join(ROOT, "customer-app/js/p2p-ride-controller.mjs"),
  "utf8"
);
record(
  "static-uses-timestampToMs-not-Number-observedAt",
  src.includes("timestampToMs(loc?.observedAt)") &&
    !src.includes("Number(loc.observedAt)") &&
    !src.includes("Number(rideMeta.driverLocationUpdatedAt)"),
  "ingestFirebaseLocation"
);

record(
  "active-move-gate-not-idle-200m",
  ACTIVE_LOCATION_MOVE_M === 10 && MIN_LOCATION_MOVE_M === 200,
  `active=${ACTIVE_LOCATION_MOVE_M} idle=${MIN_LOCATION_MOVE_M}`
);

const pipeSrc = fs.readFileSync(
  path.join(ROOT, "shared/js/display-location-pipeline.mjs"),
  "utf8"
);
record(
  "generation-0-not-treated-as-missing",
  pipeSrc.includes("Number.isFinite(parsedGen)") &&
    !pipeSrc.includes("Number(input.generation) || routeGeneration"),
  "setActiveRoute"
);

const t0 = 1_700_000_000_000;
const fakeTs = { seconds: Math.floor(t0 / 1000), nanoseconds: 0 };
record(
  "timestampToMs-parses-firestore-shape",
  timestampToMs(fakeTs) === t0,
  String(timestampToMs(fakeTs))
);

// Poison recreation via arbiter with controllable clock (bypass Firebase 4s throttle).
let now = t0 + 60_000;
const paints = [];
const arb = createLiveLocationSourceArbiter({
  nowMs: () => now,
  firebaseBackupReadIntervalMs: 4_000,
  onRender: (fix) => paints.push({ lat: fix.lat, lng: fix.lng, observedAt: fix.observedAt }),
});
const gen = arb.getGeneration();

// Old bug: Number(fakeTs) === NaN → Date.now() locks arbiter to wall clock.
// New path: timestampToMs(fakeTs) === t0 so later GPS at t0+5s is accepted.
arb.ingestFirebase(
  {
    lat: 24.87,
    lng: 67.01,
    sequence: 1,
    trackingSessionId: "s2",
    observedAt: timestampToMs(fakeTs),
  },
  gen
);
now += 5_000;
arb.ingestFirebase(
  {
    lat: 24.871,
    lng: 67.011,
    sequence: 2,
    trackingSessionId: "s2",
    observedAt: t0 + 5_000,
  },
  gen
);
record(
  "firestore-timestamp-observedAt-allows-next-fix",
  paints.length >= 2 && paints[paints.length - 1].lat === 24.871,
  `paints=${paints.length} last=${JSON.stringify(paints[paints.length - 1] || null)}`
);

// Controller path with throttle bypassed via spaced wall clock is hard in unit tests;
// prove ingestFirebaseLocation uses timestampToMs by feeding Timestamp then advancing
// enough for throttle + newer observedAt.
const paints2 = [];
let wall = Date.now();
const ctrl = createCustomerP2pController({
  onRenderFix: (fix) => paints2.push({ lat: fix.lat, lng: fix.lng, observedAt: fix.observedAt }),
  watchRidePeerSession: () => () => {},
});
// Monkey-patch arbiter clock via ingest spacing: first paint, wait >4s, second paint.
ctrl.bindRide("ride_obs_motion");
ctrl.ingestFirebaseLocation(
  { lat: 24.86, lng: 67.0, sequence: 1, sessionId: "s1", observedAt: fakeTs },
  {}
);
await new Promise((r) => setTimeout(r, 4100));
ctrl.ingestFirebaseLocation(
  { lat: 24.861, lng: 67.001, sequence: 2, sessionId: "s1", observedAt: t0 + 8_000 },
  {}
);
record(
  "controller-ingest-timestamp-then-newer-gps",
  paints2.length >= 2 && paints2[paints2.length - 1].lat === 24.861,
  `paints=${paints2.length} last=${JSON.stringify(paints2[paints2.length - 1] || null)} wallDelta=${Date.now() - wall}`
);

// Contrast: if observedAt were poisoned to ~Date.now(), a later historical GPS would be stale-rejected.
const paints3 = [];
const arbPoison = createLiveLocationSourceArbiter({
  nowMs: () => now,
  firebaseBackupReadIntervalMs: 0,
  onRender: (fix) => paints3.push(fix),
});
const g2 = arbPoison.getGeneration();
const poisonedNow = Date.now();
arbPoison.ingestFirebase(
  { lat: 24.9, lng: 67.1, sequence: 1, trackingSessionId: "p", observedAt: poisonedNow },
  g2
);
now += 1;
arbPoison.ingestFirebase(
  { lat: 24.901, lng: 67.101, sequence: 2, trackingSessionId: "p", observedAt: t0 + 9_000 },
  g2
);
record(
  "poisoned-Date.now-observedAt-rejects-real-gps",
  paints3.length === 1 && arbPoison.getCounters().staleRejected >= 1,
  `paints=${paints3.length} stale=${arbPoison.getCounters().staleRejected}`
);

ctrl.destroy();
arb.reset();
arbPoison.reset();

const fail = results.filter((r) => r.status === "FAIL").length;
const pass = results.filter((r) => r.status === "PASS").length;
fs.writeFileSync(
  OUT,
  JSON.stringify({ generatedAt: new Date().toISOString(), pass, fail, results }, null, 2)
);
console.log(`\n${pass} PASS / ${fail} FAIL → ${OUT}`);
if (fail) process.exit(1);
