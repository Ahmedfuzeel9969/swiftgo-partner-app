/**
 * Phase 6 hardening suite — idempotent start, queue serialization, sampling,
 * pre-settlement flush, assignment token + activeRideId, honest rules, billing sims.
 * Run: npm run test:breadcrumb-hardening
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  BREADCRUMB_MAX_UPLOADS_PER_WAKE,
  BREADCRUMB_MAX_UPLOADS_PER_SCHEDULED_TICK,
  BREADCRUMB_SAMPLE_INTERVAL_MS,
  BREADCRUMB_TARGET_BATCH_POINTS,
  assignmentVersionFromToken,
  buildBreadcrumbBatch,
} from "../shared/js/breadcrumb-schema.mjs";
import { createBreadcrumbQueue } from "../driver-app/js/breadcrumb-queue.mjs";
import { createBreadcrumbCollector } from "../driver-app/js/breadcrumb-collector.mjs";
import { createBreadcrumbUploader } from "../driver-app/js/breadcrumb-uploader.mjs";
import {
  runIsolatedBreadcrumbTelemetryRules,
  validateIsolatedRulesResults,
  BREADCRUMB_TELEMETRY_RULES_RESULTS,
} from "./breadcrumb-isolated-rules-runner.mjs";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "tests", "breadcrumb-hardening-results.json");
const PROJECT = "demo-swiftgo-phase1";

process.env.FIRESTORE_EMULATOR_HOST ||= "127.0.0.1:8080";
process.env.FIREBASE_AUTH_EMULATOR_HOST ||= "127.0.0.1:9099";
process.env.GCLOUD_PROJECT ||= PROJECT;
process.env.GOOGLE_CLOUD_PROJECT ||= PROJECT;

const results = [];
function record(name, status, detail = "", category = "unit") {
  results.push({ name, status, detail, suite: "breadcrumb-hardening", category });
  const mark = status === "PASS" ? "✓" : status === "FAIL" ? "✗" : "·";
  console.log(`${mark} [${category}] ${name} — ${status}${detail ? `: ${detail}` : ""}`);
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

const { submitRideBreadcrumbBatch, TELEMETRY_COLLECTION } = require(
  path.join(ROOT, "functions", "breadcrumb-batch.js")
);
const { settleRide } = require(path.join(ROOT, "functions", "settlement.js"));
const { mintAssignmentSessionToken } = require(path.join(ROOT, "functions", "bargaining.js"));
const admin = require(
  require.resolve("firebase-admin", { paths: [path.join(ROOT, "functions"), ROOT] })
);

function createFakeTimers() {
  const queue = [];
  let now = Date.now();
  let idSeq = 1;
  return {
    nowMs: () => now,
    setNow: (n) => {
      now = n;
    },
    advance: (ms) => {
      now += Number(ms) || 0;
    },
    setTimeoutFn: (fn, ms) => {
      const id = idSeq++;
      queue.push({ id, at: now + Number(ms) || 0, fn });
      return id;
    },
    clearTimeoutFn: (id) => {
      const i = queue.findIndex((t) => t.id === id);
      if (i >= 0) queue.splice(i, 1);
    },
    async flush(ms) {
      now += Number(ms) || 0;
      queue.sort((a, b) => a.at - b.at);
      const due = queue.filter((t) => t.at <= now);
      for (const t of due) {
        const i = queue.findIndex((x) => x.id === t.id);
        if (i >= 0) queue.splice(i, 1);
        await t.fn();
      }
    },
    pending: () => queue.length,
  };
}

function binding(overrides = {}) {
  const assignmentSessionToken = overrides.assignmentSessionToken || "as_harden_token_01";
  return {
    rideId: "ride_h1",
    driverId: "driver_h1",
    vehicleId: "veh_h1",
    assignmentSessionToken,
    assignmentVersion: assignmentVersionFromToken(assignmentSessionToken),
    trackingSessionId: "s_harden_1",
    ...overrides,
  };
}

function rawFix(seq, timers, overrides = {}) {
  return {
    sequence: seq,
    observedAt: timers.nowMs(),
    lat: 24.86 + (seq % 2000) * 0.00008,
    lng: 67.0 + (seq % 2000) * 0.00005,
    accuracyM: 8,
    speedMps: 8,
    headingDeg: 90,
    source: "gps",
    ...overrides,
  };
}

async function idempotentStartTests() {
  const timers = createFakeTimers();
  let uploads = 0;
  const diags = [];
  const b = binding();
  const collector = createBreadcrumbCollector({
    nowMs: timers.nowMs,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    onDiag: (c) => diags.push(c),
    callSubmit: async () => {
      uploads += 1;
      return { ok: true, acknowledged: true };
    },
  });
  const first = await collector.start({ ...b, status: "in_progress", assignedDriverId: b.driverId });
  const gen1 = collector.getGeneration();
  const last1 = collector._uploader._getLastUploadAt();
  // Snapshot every 4s for >2 minutes
  for (let i = 0; i < 35; i += 1) {
    timers.advance(4000);
    const r = await collector.start({ ...b, status: "in_progress", assignedDriverId: b.driverId });
    if (r.reason !== "already_active") {
      record("h-idempotent-4s-snapshots", "FAIL", `i=${i} reason=${r.reason}`, "unit");
      return;
    }
  }
  // Snapshot every 30s for >2 minutes
  for (let i = 0; i < 6; i += 1) {
    timers.advance(30000);
    const r = await collector.start({ ...b, status: "in_progress", assignedDriverId: b.driverId });
    if (r.reason !== "already_active") {
      record("h-idempotent-30s-snapshots", "FAIL", `i=${i}`, "unit");
      return;
    }
  }
  record(
    "h-idempotent-start-no-gen-bump",
    collector.getGeneration() === gen1 &&
      collector._uploader._getLastUploadAt() === last1 &&
      first.ok
      ? "PASS"
      : "FAIL",
    `gen=${collector.getGeneration()} vs ${gen1}`,
    "unit"
  );

  // Cadence: sample every 4s, upload ~every 60s
  let seq = 1;
  for (let t = 0; t < 130_000; t += 1000) {
    timers.advance(1000);
    await collector.ingestRawFix(rawFix(seq, timers), {
      status: "in_progress",
      rideId: b.rideId,
      trackingSessionId: b.trackingSessionId,
    });
    seq += 1;
    await timers.flush(0);
  }
  await collector._uploader.tick({ force: true });
  const c = collector.getCounters();
  record(
    "h-idempotent-cadence-no-stale-gen",
    c.collected >= 30 && c.collected <= 40 && uploads >= 2 && !diags.includes("stale")
      ? "PASS"
      : "FAIL",
    `collected=${c.collected} uploads=${uploads} sampledOut=${c.sampledOut}`,
    "unit"
  );
  await collector.stop({ purge: true });
}

async function queueConcurrencyTests() {
  const timers = createFakeTimers();
  const q = createBreadcrumbQueue({ nowMs: timers.nowMs, allowMemoryFallback: true });
  const b = binding({ rideId: "ride_conc" });

  const appends = [];
  for (let i = 1; i <= 20; i += 1) {
    timers.advance(1000);
    appends.push(q.appendPoint(b, rawFix(i, timers)));
  }
  const resultsAppend = await Promise.all(appends);
  const okAppend = resultsAppend.filter((r) => r.ok).length;
  const cnt = await q.pointCount(b);
  record(
    "h-concurrent-append-no-loss",
    okAppend === 20 && cnt === 20 ? "PASS" : "FAIL",
    `ok=${okAppend} cnt=${cnt}`,
    "unit"
  );

  const b2 = binding({ rideId: "ride_conc2" });
  for (let i = 1; i <= 10; i += 1) {
    timers.advance(1000);
    await q.appendPoint(b2, rawFix(i, timers));
  }
  const [a, take] = await Promise.all([
    q.appendPoint(b2, rawFix(11, { nowMs: () => timers.nowMs() + 1000 })),
    q.takeBatch(b2, { force: true, maxPoints: 5 }),
  ]);
  timers.advance(1000);
  const left = await q.pointCount(b2);
  const pending = await q.peekOldestBatch(b2);
  const takePts = take.batch?.points?.length || 0;
  const snap2 = await q._load(b2);
  const seqs = [
    ...(snap2?.points || []).map((p) => p.sequence),
    ...(pending?.points || []).map((p) => p.sequence),
  ].sort((x, y) => x - y);
  const exactTotal = left + takePts === 11;
  const exactTake = take.ok && takePts === 5;
  const exactSeqs =
    a.ok &&
    seqs.length === 11 &&
    seqs.every((s, i) => s === i + 1) &&
    pending &&
    pending.batchSequence === take.batch.batchSequence;
  record(
    "h-append-take-no-loss",
    exactTotal && exactTake && exactSeqs ? "PASS" : "FAIL",
    `left=${left} takePts=${takePts} total=${left + takePts} seqs=[${seqs.join(",")}] a=${a.ok}`,
    "unit"
  );

  const b3 = binding({ rideId: "ride_conc3" });
  for (let i = 1; i <= 5; i += 1) {
    timers.advance(1000);
    await q.appendPoint(b3, rawFix(i, timers));
  }
  const tb = await q.takeBatch(b3, { force: true });
  timers.advance(1000);
  await Promise.all([
    q.appendPoint(b3, rawFix(6, timers)),
    q.acknowledgeBatch(b3, tb.batch.batchSequence),
  ]);
  const still = await q.peekOldestBatch(b3);
  const snap3 = await q._load(b3);
  const cnt3 = await q.pointCount(b3);
  const ackGone = !still || still.batchSequence !== tb.batch.batchSequence;
  const point6Once =
    cnt3 === 1 &&
    (snap3?.points || []).length === 1 &&
    snap3.points[0].sequence === 6 &&
    !(snap3?.pendingBatches || []).some((b) =>
      (b.points || []).some((p) => p.sequence === 6)
    );
  record(
    "h-append-ack-no-resurrect",
    ackGone && point6Once ? "PASS" : "FAIL",
    `ackGone=${ackGone} cnt=${cnt3} seq6once=${point6Once}`,
    "unit"
  );

  const bA = binding({ rideId: "ride_part_a" });
  const bB = binding({ rideId: "ride_part_b" });
  await Promise.all([
    q.appendPoint(bA, rawFix(1, timers)),
    q.appendPoint(bB, rawFix(1, timers)),
  ]);
  record(
    "h-partition-independence",
    (await q.pointCount(bA)) === 1 && (await q.pointCount(bB)) === 1 ? "PASS" : "FAIL",
    "",
    "unit"
  );

  // Simulated IDB failure after durable mode: do not wipe to empty memory.
  const failQ = createBreadcrumbQueue({
    nowMs: timers.nowMs,
    allowMemoryFallback: false,
    indexedDB: {
      open: () => {
        throw new Error("boom");
      },
    },
  });
  const failRes = await failQ.appendPoint(binding({ rideId: "ride_fail_idb" }), rawFix(1, timers));
  record(
    "h-idb-fail-safe",
    !failRes.ok &&
      (failRes.reason === "idb_failed" || failQ.getCounters().persistenceMode === "failed")
      ? "PASS"
      : "FAIL",
    `reason=${failRes.reason} mode=${failQ.getCounters().persistenceMode}`,
    "unit"
  );
}

async function samplingBillingSims() {
  const timers = createFakeTimers();
  let uploads = 0;
  const b = binding({ rideId: "ride_sim20" });
  const collector = createBreadcrumbCollector({
    nowMs: timers.nowMs,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    callSubmit: async () => {
      uploads += 1;
      return { ok: true, acknowledged: true };
    },
  });
  await collector.start({ ...b, status: "in_progress", assignedDriverId: b.driverId });
  let maxQ = 0;
  let seq = 1;
  // 20 minutes @ 1Hz GPS, 4s sample
  for (let s = 0; s < 20 * 60; s += 1) {
    timers.advance(1000);
    await collector.ingestRawFix(rawFix(seq++, timers), {
      status: "in_progress",
      rideId: b.rideId,
      trackingSessionId: b.trackingSessionId,
    });
    if (s % 60 === 59) await collector._uploader.tick({ force: false });
    maxQ = Math.max(maxQ, await collector._queue.pointCount(b));
  }
  await collector._uploader.tick({ force: true });
  const c20 = collector.getCounters();
  record(
    "h-sim-20min-queue-bounded",
    maxQ <= 20 && c20.collected >= 280 && c20.collected <= 320 && uploads >= 18 && uploads <= 25
      ? "PASS"
      : "FAIL",
    `maxQ=${maxQ} collected=${c20.collected} uploads=${uploads}`,
    "performance"
  );

  // 8h abbreviated: 8*60 minutes but advance in 4s steps for sample alignment
  uploads = 0;
  const b8 = binding({ rideId: "ride_sim8h" });
  const c8 = createBreadcrumbCollector({
    nowMs: timers.nowMs,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    callSubmit: async () => {
      uploads += 1;
      return { ok: true, acknowledged: true };
    },
  });
  await c8.start({ ...b8, status: "in_progress", assignedDriverId: b8.driverId });
  maxQ = 0;
  seq = 1;
  for (let min = 0; min < 8 * 60; min += 1) {
    for (let i = 0; i < 15; i += 1) {
      timers.advance(BREADCRUMB_SAMPLE_INTERVAL_MS);
      await c8.ingestRawFix(rawFix(seq++, timers), {
        status: "in_progress",
        rideId: b8.rideId,
        trackingSessionId: b8.trackingSessionId,
      });
    }
    await c8._uploader.tick({ force: true });
    maxQ = Math.max(maxQ, await c8._queue.pointCount(b8));
  }
  record(
    "h-sim-8h-no-continuous-overflow",
    maxQ <= 20 && uploads >= 450 && uploads <= 520 ? "PASS" : "FAIL",
    `maxQ=${maxQ} uploads=${uploads} overflows=${c8.getCounters().queue.overflows}`,
    "performance"
  );

  // Offline backlog → wake drain: shared queue, DI submitter, strict ≤3 attempts/wake.
  const bOff = binding({ rideId: "ride_offline" });
  let online = false;
  let wake1Attempts = 0;
  let wake2Attempts = 0;
  let wakePhase = 0;
  const ackedSeqs = [];
  const qOff = createBreadcrumbQueue({ nowMs: timers.nowMs, allowMemoryFallback: true });
  const upOff = createBreadcrumbUploader({
    queue: qOff,
    getBinding: () => bOff,
    nowMs: timers.nowMs,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    callSubmit: async (batch) => {
      if (!online) throw new Error("offline");
      if (wakePhase === 1) wake1Attempts += 1;
      if (wakePhase === 2) wake2Attempts += 1;
      ackedSeqs.push(batch.batchSequence);
      return { ok: true, acknowledged: true };
    },
  });
  upOff.start();
  seq = 1;
  for (let i = 0; i < 75; i += 1) {
    timers.advance(4000);
    await qOff.appendPoint(bOff, rawFix(seq++, timers));
  }
  const batchSeqs = [];
  for (let i = 0; i < 5; i += 1) {
    const tb = await qOff.takeBatch(bOff, { force: true, maxPoints: 15 });
    if (tb.ok) batchSeqs.push(tb.batch.batchSequence);
  }
  const beforeWake = await qOff._load(bOff);
  const pendingBefore = beforeWake?.pendingBatches?.length || 0;
  online = true;
  wakePhase = 1;
  await upOff.tick({ force: true, wake: true });
  const afterWake1 = await qOff._load(bOff);
  const pendingAfter1 = afterWake1?.pendingBatches?.length || 0;
  const oldestAfter1 = afterWake1?.pendingBatches?.[0]?.batchSequence;
  wakePhase = 2;
  await upOff.tick({ force: true, wake: true });
  const afterWake2 = await qOff._load(bOff);
  const pendingAfter2 = afterWake2?.pendingBatches?.length || 0;
  const allAckedUnique = new Set(ackedSeqs).size === ackedSeqs.length;
  const wakeOk =
    BREADCRUMB_MAX_UPLOADS_PER_WAKE === 3 &&
    BREADCRUMB_MAX_UPLOADS_PER_SCHEDULED_TICK === 1 &&
    pendingBefore === 5 &&
    wake1Attempts === 3 &&
    wake1Attempts <= BREADCRUMB_MAX_UPLOADS_PER_WAKE &&
    pendingAfter1 === 2 &&
    oldestAfter1 === batchSeqs[3] &&
    wake2Attempts === 2 &&
    pendingAfter2 === 0 &&
    allAckedUnique &&
    ackedSeqs.length === 5 &&
    ackedSeqs[0] === batchSeqs[0] &&
    (await qOff.pointCount(bOff)) === 0;
  record(
    "h-offline-bound-then-wake-limit",
    wakeOk ? "PASS" : "FAIL",
    `w1=${wake1Attempts} w2=${wake2Attempts} pend=${pendingBefore}->${pendingAfter1}->${pendingAfter2} acked=[${ackedSeqs.join(",")}]`,
    "performance"
  );
  upOff.stop();
  await qOff.purgePartition(bOff);

  // Production-shaped wake: one failed pending batch + raw queued points not yet batched.
  // Policy: wake drains existing pending only (≤3); does NOT form new batches from raw points.
  const bProd = binding({ rideId: "ride_wake_prod" });
  let prodOnline = false;
  let prodAttempts = 0;
  const prodAcked = [];
  const qProd = createBreadcrumbQueue({ nowMs: timers.nowMs, allowMemoryFallback: true });
  const upProd = createBreadcrumbUploader({
    queue: qProd,
    getBinding: () => bProd,
    nowMs: timers.nowMs,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    callSubmit: async (batch) => {
      if (!prodOnline) throw new Error("offline");
      prodAttempts += 1;
      prodAcked.push(batch.batchSequence);
      return { ok: true, acknowledged: true };
    },
  });
  upProd.start();
  seq = 1;
  for (let i = 0; i < 40; i += 1) {
    timers.advance(4000);
    await qProd.appendPoint(bProd, rawFix(seq++, timers));
  }
  const pendingProd = await qProd.takeBatch(bProd, { force: true, maxPoints: 15 });
  const rawBefore = await qProd.pointCount(bProd);
  // Failed upload leaves the pending batch in place (uploadOldest peeks pending first).
  prodOnline = false;
  await upProd.tick({ force: true, wake: true });
  const mid = await qProd._load(bProd);
  const pendingMid = mid?.pendingBatches?.length || 0;
  prodOnline = true;
  prodAttempts = 0;
  prodAcked.length = 0;
  await upProd.tick({ force: true, wake: true, reason: "network_resume" });
  const after = await qProd._load(bProd);
  const rawAfter = after?.points?.length || 0;
  const pendingAfter = after?.pendingBatches?.length || 0;
  const allSeqs = [
    ...(after?.points || []).map((p) => p.sequence),
    ...((after?.pendingBatches || []).flatMap((b) => (b.points || []).map((p) => p.sequence))),
  ];
  // Pending batch (seqs 1-15) acked once; raw 16-40 remain exactly once; no new pending formed.
  const prodOk =
    pendingProd.ok &&
    rawBefore === 25 &&
    pendingMid === 1 &&
    prodAttempts === 1 &&
    prodAttempts <= BREADCRUMB_MAX_UPLOADS_PER_WAKE &&
    pendingAfter === 0 &&
    rawAfter === 25 &&
    prodAcked.length === 1 &&
    allSeqs.length === 25 &&
    allSeqs.every((s, i) => s === i + 16) &&
    new Set(allSeqs).size === 25;
  record(
    "h-wake-pending-plus-raw-points",
    prodOk ? "PASS" : "FAIL",
    `policy=wake_drains_pending_only attempts=${prodAttempts} raw=${rawBefore}->${rawAfter} pendMid=${pendingMid} pendAfter=${pendingAfter}`,
    "performance"
  );
  upProd.stop();
  await qProd.purgePartition(bProd);

  await collector.stop({ purge: true });
  await c8.stop({ purge: true });
}

async function wakePendingOnlyPolicyTests() {
  const timers = createFakeTimers();
  timers.setNow(1_700_000_000_000);

  async function makeScenario(id, rawCount, pendingSizes = [], submitFn = async () => ({ ok: true })) {
    const b = binding({ rideId: `ride_wake_${id}` });
    const q = createBreadcrumbQueue({ nowMs: timers.nowMs, allowMemoryFallback: true });
    for (let i = 1; i <= rawCount; i += 1) {
      timers.advance(4000);
      await q.appendPoint(b, rawFix(i, timers));
    }
    for (const maxPoints of pendingSizes) {
      await q.takeBatch(b, { force: true, maxPoints });
    }
    let takeCalls = 0;
    let submits = 0;
    const originalTakeBatch = q.takeBatch.bind(q);
    q.takeBatch = async (...args) => {
      takeCalls += 1;
      return originalTakeBatch(...args);
    };
    const uploader = createBreadcrumbUploader({
      queue: q,
      getBinding: () => b,
      nowMs: timers.nowMs,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
      callSubmit: async (batch) => {
        submits += 1;
        return submitFn(batch, submits);
      },
    });
    return {
      b,
      q,
      uploader,
      counts: () => ({ takeCalls, submits }),
      state: () => q._load(b),
    };
  }

  const rawOnly = await makeScenario("raw_only", 4);
  const rawBefore = await rawOnly.state();
  const seqsBefore = rawBefore.points.map((p) => p.sequence);
  await rawOnly.uploader.tick({ force: true, wake: true, reason: "network_resume" });
  const rawAfter = await rawOnly.state();
  const rawCounts = rawOnly.counts();
  record(
    "wake-raw-only-does-not-form-batch",
    rawCounts.takeCalls === 0 && rawAfter.pendingBatches.length === 0 ? "PASS" : "FAIL",
    `takeBatch=${rawCounts.takeCalls} pending=${rawAfter.pendingBatches.length}`,
    "unit"
  );
  record(
    "wake-raw-only-does-not-submit",
    rawCounts.submits === 0 ? "PASS" : "FAIL",
    `submits=${rawCounts.submits}`,
    "unit"
  );
  record(
    "wake-raw-only-preserves-all-sequences",
    JSON.stringify(rawAfter.points.map((p) => p.sequence)) === JSON.stringify(seqsBefore)
      ? "PASS"
      : "FAIL",
    `before=[${seqsBefore}] after=[${rawAfter.points.map((p) => p.sequence)}]`,
    "unit"
  );

  const mixed = await makeScenario("mixed", 8, [3]);
  await mixed.uploader.tick({ force: true, wake: true });
  const mixedAfter = await mixed.state();
  const mixedCounts = mixed.counts();
  record(
    "wake-pending-plus-raw-uploads-pending-only",
    mixedCounts.submits === 1 &&
      mixedCounts.takeCalls === 0 &&
      mixedAfter.pendingBatches.length === 0 &&
      mixedAfter.points.map((p) => p.sequence).join(",") === "4,5,6,7,8"
      ? "PASS"
      : "FAIL",
    `submits=${mixedCounts.submits} takeBatch=${mixedCounts.takeCalls} raw=[${mixedAfter.points.map(
      (p) => p.sequence
    )}]`,
    "unit"
  );

  const three = await makeScenario("three_pending", 6, [2, 2, 2]);
  await three.uploader.tick({ force: true, wake: true });
  const threeAfter = await three.state();
  record(
    "wake-three-pending-respects-total-limit",
    three.counts().submits === BREADCRUMB_MAX_UPLOADS_PER_WAKE &&
      three.counts().takeCalls === 0 &&
      threeAfter.pendingBatches.length === 0
      ? "PASS"
      : "FAIL",
    `submits=${three.counts().submits} takeBatch=${three.counts().takeCalls}`,
    "unit"
  );

  const failure = await makeScenario("failure", 4, [2, 2], async () => {
    throw new Error("expected_wake_failure");
  });
  await failure.uploader.tick({ force: true, wake: true });
  const failureAfter = await failure.state();
  record(
    "wake-pending-failure-stops-drain",
    failure.counts().submits === 1 &&
      failure.counts().takeCalls === 0 &&
      failureAfter.pendingBatches.length === 2
      ? "PASS"
      : "FAIL",
    `submits=${failure.counts().submits} pending=${failureAfter.pendingBatches.length}`,
    "unit"
  );

  const later = await makeScenario("later_scheduled", 3);
  await later.uploader.tick({ force: true, wake: true });
  await later.uploader.tick({ force: true, reason: "scheduled_test" });
  const laterAfter = await later.state();
  record(
    "scheduled-tick-after-wake-forms-raw-batch",
    later.counts().takeCalls === 1 &&
      later.counts().submits === 1 &&
      laterAfter.points.length === 0 &&
      laterAfter.pendingBatches.length === 0
      ? "PASS"
      : "FAIL",
    `takeBatch=${later.counts().takeCalls} submits=${later.counts().submits}`,
    "unit"
  );

  const repeated = await makeScenario("repeated", 5);
  const repeatedBefore = (await repeated.state()).points.map((p) => p.sequence);
  await repeated.uploader.tick({ force: true, wake: true });
  await repeated.uploader.tick({ force: true, wake: true });
  const repeatedAfter = await repeated.state();
  const repeatedSeqs = repeatedAfter.points.map((p) => p.sequence);
  record(
    "repeated-wake-does-not-duplicate-or-lose-points",
    repeated.counts().takeCalls === 0 &&
      repeated.counts().submits === 0 &&
      repeatedSeqs.join(",") === repeatedBefore.join(",") &&
      new Set(repeatedSeqs).size === repeatedSeqs.length
      ? "PASS"
      : "FAIL",
    `before=[${repeatedBefore}] after=[${repeatedSeqs}]`,
    "unit"
  );
}

async function flushOrderAndSettlement(db) {
  const timers = createFakeTimers();
  timers.setNow(Date.now());
  const token = mintAssignmentSessionToken();
  const rideId = "ride_flush_settle";
  const driverId = "driver_flush";
  const vehicleId = "veh_flush";
  await db.collection("rides").doc(rideId).set({
    driverId,
    vehicleId,
    userId: "cust_flush",
    status: "in_progress",
    estimatedFare: 400,
    farePkr: 400,
    traveledDistanceKm: 2,
    assignmentSessionToken: token,
    paymentMethod: "cash",
  });
  await db.collection("vehicles").doc(vehicleId).set({
    driverId,
    trackingSessionId: "s_flush_1",
    activeRideId: rideId,
    status: "in_ride",
  });
  await db.collection("partners").doc(driverId).set({
    accountStatus: "active",
    walletBalance: 1000,
  });

  let callWhileInProgress = 0;
  let callWhileCompleted = 0;
  const collector = createBreadcrumbCollector({
    nowMs: timers.nowMs,
    sampleIntervalMs: 1,
    callSubmit: async (batch) => {
      const snap = await db.collection("rides").doc(rideId).get();
      const st = snap.data()?.status;
      if (st === "in_progress") callWhileInProgress += 1;
      if (st === "completed") callWhileCompleted += 1;
      return submitRideBreadcrumbBatch(db, { driverUid: driverId, batch });
    },
  });
  const b = binding({
    rideId,
    driverId,
    vehicleId,
    assignmentSessionToken: token,
    trackingSessionId: "s_flush_1",
  });
  await collector.start({ ...b, status: "in_progress", assignedDriverId: driverId });
  for (let i = 1; i <= 5; i += 1) {
    timers.advance(1000);
    await collector.ingestRawFix(rawFix(i, timers), {
      status: "in_progress",
      rideId,
      trackingSessionId: "s_flush_1",
    });
  }
  const flush = await collector.flushBeforeSettlement();
  record(
    "h-flush-while-in_progress",
    flush.ok && callWhileInProgress >= 1 && callWhileCompleted === 0 ? "PASS" : "FAIL",
    `flush=${flush.ok} inProg=${callWhileInProgress} completed=${callWhileCompleted}`,
    "emulator"
  );

  const beforeSettle = await db.collection("rides").doc(rideId).get();
  const fareBefore = beforeSettle.data().estimatedFare;
  const travelBefore = beforeSettle.data().traveledDistanceKm;

  const settle1 = await settleRide(db, {
    rideId,
    callerUid: driverId,
    collectionName: "rides",
  });
  const settle2 = await settleRide(db, {
    rideId,
    callerUid: driverId,
    collectionName: "rides",
  });
  record(
    "h-settlement-once-after-flush",
    settle1.alreadySettled === false && settle2.alreadySettled === true ? "PASS" : "FAIL",
    `s1=${settle1.alreadySettled} s2=${settle2.alreadySettled}`,
    "emulator"
  );

  await collector.stop({ purge: true, flush: false });
  const after = (await db.collection("rides").doc(rideId).get()).data();
  const tel = (await db.collection(TELEMETRY_COLLECTION).doc(rideId).get()).data();
  record(
    "h-financial-isolation-module",
    after.estimatedFare === fareBefore &&
      after.traveledDistanceKm === travelBefore &&
      Number(tel?.denseChordDistanceMeters || 0) >= 0 &&
      !("denseChordDistanceMeters" in after)
      ? "PASS"
      : "FAIL",
    `fare=${after.estimatedFare} travel=${after.traveledDistanceKm} dense=${tel?.denseChordDistanceMeters}`,
    "emulator"
  );

  // Timeout path: flush fails, settlement still succeeds
  const rideId2 = "ride_flush_timeout";
  const token2 = mintAssignmentSessionToken();
  await db.collection("rides").doc(rideId2).set({
    driverId,
    vehicleId: "veh_flush2",
    userId: "cust_flush",
    status: "in_progress",
    estimatedFare: 300,
    farePkr: 300,
    traveledDistanceKm: 1,
    assignmentSessionToken: token2,
    paymentMethod: "cash",
  });
  await db.collection("vehicles").doc("veh_flush2").set({
    driverId,
    trackingSessionId: "s_flush_2",
    activeRideId: rideId2,
    status: "in_ride",
  });
  const cFail = createBreadcrumbCollector({
    nowMs: timers.nowMs,
    sampleIntervalMs: 1,
    callSubmit: async () => {
      throw new Error("network");
    },
  });
  const bFail = binding({
    rideId: rideId2,
    driverId,
    vehicleId: "veh_flush2",
    assignmentSessionToken: token2,
    trackingSessionId: "s_flush_2",
  });
  await cFail.start({ ...bFail, status: "in_progress", assignedDriverId: driverId });
  timers.advance(1000);
  await cFail.ingestRawFix(rawFix(1, timers), {
    status: "in_progress",
    rideId: rideId2,
    trackingSessionId: "s_flush_2",
  });
  const flushFail = await cFail.flushBeforeSettlement();
  const settleFail = await settleRide(db, {
    rideId: rideId2,
    callerUid: driverId,
    collectionName: "rides",
  });
  record(
    "h-flush-timeout-settlement-ok",
    !flushFail.ok && settleFail.alreadySettled === false ? "PASS" : "FAIL",
    `flush=${flushFail.reason} settled=${settleFail.alreadySettled}`,
    "emulator"
  );
  await cFail.stop({ purge: true, flush: false });

  // ActiveRideId + token checks
  const seed = {
    rideId: "ride_bind",
    driverId,
    vehicleId: "veh_bind",
    av: assignmentVersionFromToken(token),
    session: "s_bind_1",
    assignmentSessionToken: token,
  };
  await db.collection("rides").doc(seed.rideId).set({
    driverId,
    vehicleId: seed.vehicleId,
    status: "in_progress",
    assignmentSessionToken: token,
    traveledDistanceKm: 0,
    estimatedFare: 100,
  });
  await db.collection("vehicles").doc(seed.vehicleId).set({
    driverId,
    trackingSessionId: seed.session,
    activeRideId: "other_ride",
    status: "in_ride",
  });
  let deniedActive = false;
  try {
    await submitRideBreadcrumbBatch(db, {
      driverUid: driverId,
      batch: buildBreadcrumbBatch({
        rideBinding: {
          rideId: seed.rideId,
          vehicleId: seed.vehicleId,
          driverId,
        },
        assignmentVersion: seed.av,
        assignmentSessionToken: token,
        trackingSessionId: seed.session,
        batchSequence: 1,
        points: [
          {
            sequence: 1,
            observedAt: timers.nowMs() - 2000,
            lat: 24.86,
            lng: 67.01,
            accuracyM: 5,
          },
          {
            sequence: 2,
            observedAt: timers.nowMs(),
            lat: 24.8602,
            lng: 67.0102,
            accuracyM: 5,
          },
        ],
      }),
    });
  } catch (e) {
    deniedActive = String(e.message).includes("VEHICLE_ACTIVE_RIDE_MISMATCH");
  }
  record("h-activeRideId-enforced", deniedActive ? "PASS" : "FAIL", "", "emulator");

  // Restore vehicle pointer for assignmentVersion binding tests
  await db.collection("vehicles").doc(seed.vehicleId).set(
    {
      driverId,
      trackingSessionId: seed.session,
      activeRideId: seed.rideId,
      status: "in_ride",
    },
    { merge: true }
  );

  function makeBindBatch({ assignmentSessionToken, assignmentVersion, batchSequence = 1 }) {
    return buildBreadcrumbBatch({
      rideBinding: {
        rideId: seed.rideId,
        vehicleId: seed.vehicleId,
        driverId,
      },
      assignmentVersion,
      assignmentSessionToken,
      trackingSessionId: seed.session,
      batchSequence,
      points: [
        {
          sequence: batchSequence * 2 - 1,
          observedAt: timers.nowMs() - 2000,
          lat: 24.86,
          lng: 67.01,
          accuracyM: 5,
        },
        {
          sequence: batchSequence * 2,
          observedAt: timers.nowMs(),
          lat: 24.8602,
          lng: 67.0102,
          accuracyM: 5,
        },
      ],
    });
  }

  let wrongAv = false;
  try {
    await submitRideBreadcrumbBatch(db, {
      driverUid: driverId,
      batch: makeBindBatch({
        assignmentSessionToken: token,
        assignmentVersion: seed.av + 99,
        batchSequence: 1,
      }),
    });
  } catch (e) {
    wrongAv =
      String(e.message).includes("ASSIGNMENT_VERSION_MISMATCH") ||
      String(e.message).includes("STALE_ASSIGNMENT");
  }
  record(
    "h-valid-token-wrong-assignmentVersion",
    wrongAv ? "PASS" : "FAIL",
    "",
    "emulator"
  );

  let wrongTok = false;
  try {
    await submitRideBreadcrumbBatch(db, {
      driverUid: driverId,
      batch: makeBindBatch({
        assignmentSessionToken: "as_wrong_token_xxxxxxxx",
        assignmentVersion: seed.av,
        batchSequence: 2,
      }),
    });
  } catch (e) {
    wrongTok = String(e.message).includes("STALE_ASSIGNMENT");
  }
  record(
    "h-wrong-token-correct-looking-version",
    wrongTok ? "PASS" : "FAIL",
    "",
    "emulator"
  );

  await db.collection("rides").doc("ride_legacy_no_token").set({
    driverId,
    vehicleId: seed.vehicleId,
    status: "in_progress",
    traveledDistanceKm: 0,
    estimatedFare: 100,
  });
  await db.collection("vehicles").doc(seed.vehicleId).set(
    { activeRideId: "ride_legacy_no_token", trackingSessionId: seed.session, driverId },
    { merge: true }
  );
  let missingTok = false;
  try {
    await submitRideBreadcrumbBatch(db, {
      driverUid: driverId,
      batch: buildBreadcrumbBatch({
        rideBinding: {
          rideId: "ride_legacy_no_token",
          vehicleId: seed.vehicleId,
          driverId,
        },
        assignmentVersion: seed.av,
        assignmentSessionToken: token,
        trackingSessionId: seed.session,
        batchSequence: 1,
        points: [
          {
            sequence: 1,
            observedAt: timers.nowMs() - 2000,
            lat: 24.86,
            lng: 67.01,
            accuracyM: 5,
          },
          {
            sequence: 2,
            observedAt: timers.nowMs(),
            lat: 24.8602,
            lng: 67.0102,
            accuracyM: 5,
          },
        ],
      }),
    });
  } catch (e) {
    missingTok = String(e.message).includes("ASSIGNMENT_TOKEN_MISSING");
  }
  record("h-missing-legacy-token-denied", missingTok ? "PASS" : "FAIL", "", "emulator");

  await db.collection("vehicles").doc(seed.vehicleId).set(
    { activeRideId: seed.rideId, trackingSessionId: seed.session, driverId },
    { merge: true }
  );
  let okBind = false;
  try {
    const res = await submitRideBreadcrumbBatch(db, {
      driverUid: driverId,
      batch: makeBindBatch({
        assignmentSessionToken: token,
        assignmentVersion: assignmentVersionFromToken(token),
        batchSequence: 1,
      }),
    });
    okBind = Boolean(res?.ok || res?.acknowledged);
  } catch (e) {
    okBind = false;
  }
  record(
    "h-correct-token-derived-version-accepted",
    okBind ? "PASS" : "FAIL",
    "",
    "emulator"
  );

  // Terminal snapshot must not flush
  record(
    "h-terminal-no-flush",
    read("driver-app/js/driver-app.js").includes('flush: false, reason: "terminal_status"') &&
      read("driver-app/js/driver-app.js").includes("flushBeforeSettlement")
      ? "PASS"
      : "FAIL",
    "",
    "static"
  );
}

async function rulesHonest() {
  const outcome = runIsolatedBreadcrumbTelemetryRules({ root: ROOT });
  if (!outcome.ok) {
    const status = outcome.status === "BLOCKED" ? "BLOCKED" : "FAIL";
    record("h-rules-read-denied", status, outcome.reason || "isolated_rules_failed", "rules");
    record("h-rules-write-denied", status, outcome.reason || "isolated_rules_failed", "rules");
    record(
      "h-static-deny-all-architecture",
      /rideBreadcrumbTelemetry/.test(read("firestore.rules")) ? "PASS" : "FAIL",
      `static only; isolated=${outcome.reason}`,
      "static"
    );
    return;
  }
  const byName = outcome.byName || {};
  record(
    "h-rules-read-denied",
    byName["rules-client-read-denied"]?.status || "FAIL",
    byName["rules-client-read-denied"]?.detail || "",
    "rules"
  );
  record(
    "h-rules-write-denied",
    byName["rules-client-write-denied"]?.status || "FAIL",
    byName["rules-client-write-denied"]?.detail || "",
    "rules"
  );
  record(
    "h-static-deny-all-architecture",
    byName["static-telemetry-deny-all-architecture"]?.status || "FAIL",
    byName["static-telemetry-deny-all-architecture"]?.detail || "",
    "static"
  );
  record(
    "h-isolated-rules-child-status-ok",
    outcome.child?.status === 0 && !outcome.child?.error ? "PASS" : "FAIL",
    `status=${outcome.child?.status}`,
    "rules"
  );
}

function staleIsolatedRulesRejectionTest() {
  const resultsPath = path.join(ROOT, "tests", BREADCRUMB_TELEMETRY_RULES_RESULTS);
  const staleGeneratedAt = new Date(Date.now() - 60 * 60_000).toISOString();
  const stalePass = {
    suite: "breadcrumb-telemetry-rules",
    generatedAt: staleGeneratedAt,
    total: 3,
    pass: 3,
    fail: 0,
    blocked: 0,
    results: [
      {
        name: "static-telemetry-deny-all-architecture",
        status: "PASS",
        detail: "stale",
        category: "static",
      },
      {
        name: "rules-client-read-denied",
        status: "PASS",
        detail: "stale",
        category: "rules",
      },
      {
        name: "rules-client-write-denied",
        status: "PASS",
        detail: "stale",
        category: "rules",
      },
    ],
  };
  fs.writeFileSync(resultsPath, JSON.stringify(stalePass, null, 2));

  // Child exits non-zero and writes nothing — old PASS file must not be accepted.
  const outcome = runIsolatedBreadcrumbTelemetryRules({
    root: ROOT,
    childArgs: ["-e", "process.exit(2)"],
    echoOutput: false,
  });
  const rejected =
    !outcome.ok &&
    (outcome.status === "FAIL" || outcome.status === "BLOCKED") &&
    String(outcome.reason || "").includes("child_status_2");
  // After delete+failed child, either no file or not a fresh PASS acceptance.
  let staleStillAccepted = false;
  if (fs.existsSync(resultsPath)) {
    try {
      const leftover = JSON.parse(fs.readFileSync(resultsPath, "utf8"));
      staleStillAccepted =
        leftover.generatedAt === staleGeneratedAt && leftover.pass === 3 && outcome.ok;
    } catch {
      staleStillAccepted = false;
    }
  }
  record(
    "isolated-rules-nonzero-child-cannot-use-stale-pass",
    rejected && !staleStillAccepted && !outcome.ok ? "PASS" : "FAIL",
    `reason=${outcome.reason} acceptedStale=${staleStillAccepted}`,
    "unit"
  );

  const startedAtMs = Date.now();
  const validateStale = validateIsolatedRulesResults(stalePass, { startedAtMs });
  record(
    "h-stale-generatedAt-rejected",
    !validateStale.ok && String(validateStale.reason || "").startsWith("stale_generatedAt")
      ? "PASS"
      : "FAIL",
    validateStale.reason || "",
    "unit"
  );

  try {
    if (fs.existsSync(resultsPath)) fs.unlinkSync(resultsPath);
  } catch {
    /* ignore */
  }
}

function isolatedRulesValidationIntegrityTests() {
  const startedAtMs = Date.now();
  const childFinishedAtMs = startedAtMs + 100;
  const valid = {
    suite: "breadcrumb-telemetry-rules",
    generatedAt: new Date(startedAtMs + 50).toISOString(),
    total: 3,
    pass: 3,
    fail: 0,
    blocked: 0,
    results: [
      { name: "static-telemetry-deny-all-architecture", status: "PASS" },
      { name: "rules-client-read-denied", status: "PASS" },
      { name: "rules-client-write-denied", status: "PASS" },
    ],
  };
  const validate = (value) =>
    validateIsolatedRulesResults(value, { startedAtMs, childFinishedAtMs, maxSkewMs: 100 });
  const mutate = (fn) => {
    const value = JSON.parse(JSON.stringify(valid));
    fn(value);
    return value;
  };

  const wrongTotal = validate(mutate((v) => (v.total = 999)));
  record(
    "isolated-rules-wrong-total-rejected",
    !wrongTotal.ok && String(wrongTotal.reason).startsWith("count_mismatch") ? "PASS" : "FAIL",
    wrongTotal.reason || "",
    "unit"
  );
  const badSum = validate(mutate((v) => (v.pass = 2)));
  record(
    "isolated-rules-count-sum-mismatch-rejected",
    !badSum.ok && String(badSum.reason).startsWith("count_mismatch") ? "PASS" : "FAIL",
    badSum.reason || "",
    "unit"
  );
  const negative = validate(mutate((v) => (v.fail = -1)));
  record(
    "isolated-rules-negative-count-rejected",
    !negative.ok && String(negative.reason).includes("invalid_non_negative_integer")
      ? "PASS"
      : "FAIL",
    negative.reason || "",
    "unit"
  );
  const future = validate(
    mutate((v) => (v.generatedAt = new Date(childFinishedAtMs + 101).toISOString()))
  );
  record(
    "isolated-rules-future-generatedAt-rejected",
    !future.ok && String(future.reason).startsWith("future_generatedAt") ? "PASS" : "FAIL",
    future.reason || "",
    "unit"
  );
  const duplicate = validate(
    mutate((v) => {
      v.results[2].name = "rules-client-read-denied";
    })
  );
  record(
    "isolated-rules-duplicate-name-rejected",
    !duplicate.ok && String(duplicate.reason).startsWith("result_name_count") ? "PASS" : "FAIL",
    duplicate.reason || "",
    "unit"
  );
  const accepted = validate(valid);
  record(
    "isolated-rules-fresh-valid-result-accepted",
    accepted.ok ? "PASS" : "FAIL",
    accepted.reason || "",
    "unit"
  );
}

async function privacyDocs() {
  const docText = read("docs/PHASE-6-BREADCRUMB-BATCHING.md");
  record(
    "h-privacy-wording",
    docText.includes("sensitive location") &&
      docText.includes("no application-level encryption") &&
      docText.includes("must not become financial truth") &&
      docText.includes("one accepted point every 4 seconds") &&
      docText.includes("Wake drain policy")
      ? "PASS"
      : "FAIL",
    "",
    "static"
  );
}

async function main() {
  console.log("\n=== Phase 6 breadcrumb hardening ===\n");
  try {
    staleIsolatedRulesRejectionTest();
  } catch (e) {
    record("h-stale-rules-uncaught", "FAIL", String(e.message || e).slice(0, 160), "unit");
  }
  // Rules first in an isolated child, before Admin SDK initializes Firestore.
  try {
    await rulesHonest();
  } catch (e) {
    record("h-rules-uncaught", "FAIL", String(e.message || e).slice(0, 160), "rules");
  }
  try {
    await idempotentStartTests();
  } catch (e) {
    record("h-idempotent-uncaught", "FAIL", String(e.message || e).slice(0, 160), "unit");
  }
  try {
    await queueConcurrencyTests();
  } catch (e) {
    record("h-queue-uncaught", "FAIL", String(e.message || e).slice(0, 160), "unit");
  }
  try {
    await samplingBillingSims();
  } catch (e) {
    record("h-sim-uncaught", "FAIL", String(e.message || e).slice(0, 160), "performance");
  }
  try {
    isolatedRulesValidationIntegrityTests();
  } catch (e) {
    record(
      "isolated-rules-validation-tests-uncaught",
      "FAIL",
      String(e.message || e).slice(0, 160),
      "unit"
    );
  }
  try {
    await wakePendingOnlyPolicyTests();
  } catch (e) {
    record("wake-policy-tests-uncaught", "FAIL", String(e.message || e).slice(0, 160), "unit");
  }
  try {
    await privacyDocs();
  } catch (e) {
    record("h-privacy-uncaught", "FAIL", String(e.message || e).slice(0, 160), "static");
  }

  if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT });
  const db = admin.firestore();
  try {
    await flushOrderAndSettlement(db);
  } catch (e) {
    record("h-flush-settle-uncaught", "FAIL", String(e.message || e).slice(0, 200), "emulator");
  }

  const summary = {
    suite: "breadcrumb-hardening",
    generatedAt: new Date().toISOString(),
    total: results.length,
    pass: results.filter((r) => r.status === "PASS").length,
    fail: results.filter((r) => r.status === "FAIL").length,
    blocked: results.filter((r) => r.status === "BLOCKED").length,
    results,
  };
  fs.writeFileSync(OUT, JSON.stringify(summary, null, 2));
  console.log(
    `\nSummary: ${summary.pass} PASS / ${summary.fail} FAIL / ${summary.blocked} BLOCKED (${summary.total}) → ${OUT}`
  );
  if (summary.fail > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
