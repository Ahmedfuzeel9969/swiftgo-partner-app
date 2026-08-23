/**
 * Customer location report counter mapping — arbiter render vs receive.
 * Run: node tests/customer-location-report-counters.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLiveLocationSourceArbiter } from "../customer-app/js/live-location-source-arbiter.mjs";
import {
  mapCustomerRuntimeCounters,
  createRideLocationReportClient,
} from "../shared/js/ride-location-report-client.mjs";
import { classifyReportHealth } from "../shared/js/ride-location-report-schema.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "tests", "customer-location-report-counters-results.json");

const results = [];
function record(name, status, detail = "") {
  results.push({ name, status, detail });
  const mark = status === "PASS" ? "✓" : "✗";
  console.log(`${mark} ${name}${detail ? ` — ${detail}` : ""}`);
}

function fix(at, lat = 24.86, lng = 67.0) {
  return { lat, lng, observedAt: at, sequence: at, trackingSessionId: "trk_1" };
}

{
  let now = 1_000_000;
  const arb = createLiveLocationSourceArbiter({
    nowMs: () => now,
    firebaseBackupReadIntervalMs: 5_000,
    onRender: () => {},
  });
  const gen = arb.getGeneration();

  arb.ingestFirebase(fix(now), gen);
  now += 12_000;
  arb.ingestFirebase(fix(now), gen);
  now += 12_000;
  arb.ingestFirebase(fix(now), gen);

  const counters = arb.getCounters();
  record(
    "arbiter-firebase-received-and-rendered-match",
    counters.firebaseAccepted === 3 && counters.firebaseRendered === 3 ? "PASS" : "FAIL",
    `accepted=${counters.firebaseAccepted} rendered=${counters.firebaseRendered}`
  );

  const mapped = mapCustomerRuntimeCounters(counters, {});
  record(
    "map-customer-firebase-rendered",
    mapped.firebaseSnapshotsReceived === 3 && mapped.firebaseValidRendered === 3 ? "PASS" : "FAIL",
    `received=${mapped.firebaseSnapshotsReceived} rendered=${mapped.firebaseValidRendered}`
  );
}

{
  let now = 2_000_000;
  const arb = createLiveLocationSourceArbiter({
    nowMs: () => now,
    firebaseBackupReadIntervalMs: 10_000,
    onRender: () => {},
  });
  const gen = arb.getGeneration();

  arb.ingestFirebase(fix(now), gen);
  arb.ingestFirebase(fix(now + 1_000), gen);
  arb.ingestFirebase(fix(now + 2_000), gen);

  const counters = arb.getCounters();
  record(
    "arbiter-firebase-throttled-not-rendered",
    counters.firebaseAccepted === 1 && counters.firebaseThrottled === 2 ? "PASS" : "FAIL",
    `accepted=${counters.firebaseAccepted} throttled=${counters.firebaseThrottled} rendered=${counters.firebaseRendered}`
  );
}

{
  let now = 3_000_000;
  const arb = createLiveLocationSourceArbiter({
    nowMs: () => now,
    firebaseBackupReadIntervalMs: 1_000,
    onRender: () => {},
  });
  const gen = arb.getGeneration();

  arb.ingestFirebase(fix(now), gen);
  now += 2_000;
  arb.ingestFirebase(fix(now - 5_000), gen);

  const counters = arb.getCounters();
  record(
    "arbiter-stale-rejected-not-rendered",
    counters.firebaseAccepted === 1 && counters.staleRejected === 1 && counters.firebaseRendered === 1
      ? "PASS"
      : "FAIL",
    `accepted=${counters.firebaseAccepted} stale=${counters.staleRejected} rendered=${counters.firebaseRendered}`
  );
}

{
  let now = 4_000_000;
  const arb = createLiveLocationSourceArbiter({
    nowMs: () => now,
    onRender: () => {},
  });
  const gen = arb.getGeneration();

  arb.ingestP2p(fix(now), gen);
  const counters = arb.getCounters();
  record(
    "arbiter-p2p-rendered",
    counters.p2pAccepted === 1 && counters.p2pRendered === 1 ? "PASS" : "FAIL",
    `accepted=${counters.p2pAccepted} rendered=${counters.p2pRendered}`
  );
}

{
  const storage = {
    data: {},
    getItem(k) {
      return this.data[k] ?? null;
    },
    setItem(k, v) {
      this.data[k] = v;
    },
    removeItem(k) {
      delete this.data[k];
    },
  };

  const client = createRideLocationReportClient({
    role: "customer",
    storage,
    getFirebase: () => ({ ready: true, functions: {} }),
    getRuntimeCounters: () => ({
      p2p: {
        firebaseAccepted: 4,
        firebaseRendered: 4,
        p2pAccepted: 0,
        p2pRendered: 0,
      },
      display: {},
    }),
    callSubmit: async () => ({ ok: true }),
  });

  await client.bindForRide({
    rideId: "ride_report_01",
    assignmentSessionToken: "a".repeat(32),
  });
  client.syncCountersFromRuntime();
  const snap = client.snapshotSection();
  record(
    "report-client-sync-firebase-rendered",
    snap?.counters?.firebaseSnapshotsReceived === 4 && snap?.counters?.firebaseValidRendered === 4
      ? "PASS"
      : "FAIL",
    `received=${snap?.counters?.firebaseSnapshotsReceived} rendered=${snap?.counters?.firebaseValidRendered}`
  );

  const health = classifyReportHealth({
    driver: { counters: { gpsFixesReceived: 4 } },
    server: { counters: { mirrorAccepted: 4 } },
    customer: { counters: snap?.counters || {} },
  });
  record(
    "health-not-critical-when-rendered-matches-received",
    health.status !== "critical" || !health.reasons.includes("rendered_to_received_ratio_low")
      ? "PASS"
      : "FAIL",
    health.status
  );
}

const pass = results.filter((r) => r.status === "PASS").length;
const fail = results.filter((r) => r.status === "FAIL").length;
fs.writeFileSync(
  OUT,
  JSON.stringify({ generatedAt: new Date().toISOString(), pass, fail, results }, null, 2)
);
console.log(`\ncustomer-location-report-counters: ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
