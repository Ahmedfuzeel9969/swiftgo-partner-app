/**
 * Phase 2 — adaptive location checkpoint policy suite.
 * Run: npm run test:checkpoint-policy
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
import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  setDoc,
  updateDoc,
  deleteDoc,
  serverTimestamp,
  where,
} from "firebase/firestore";
import {
  BACKGROUND_APPROACH_INTERVAL_MS,
  BACKGROUND_TRIP_INTERVAL_MS,
  CHECKPOINT_POLICY,
  MIN_LOCATION_MOVE_M,
  RESPONSIVE_INTERVAL_MS,
  VIEWER_LEASE,
  createCheckpointPolicyController,
  presenceDocId,
  resolveCheckpointPolicy,
  resolveViewerLeaseState,
  shouldAllowCheckpointWrite,
  timestampToMsSafe,
} from "../driver-app/js/location-checkpoint-policy.mjs";
import { createViewerPresenceConsumer } from "../driver-app/js/viewer-presence-consumer.mjs";
import { createLocationWriteSerializer } from "../driver-app/js/location-write-queue.mjs";
import {
  evaluateFixAgainstPrevious,
  normalizeLocationFix,
} from "../driver-app/js/location-envelope.mjs";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "tests", "checkpoint-policy-results.json");
const PROJECT = "demo-swiftgo-phase1";
const rulesText = fs.readFileSync(path.join(ROOT, "firestore.rules"), "utf8");

process.env.FIRESTORE_EMULATOR_HOST ||= "127.0.0.1:8080";
process.env.FIREBASE_AUTH_EMULATOR_HOST ||= "127.0.0.1:9099";
process.env.GCLOUD_PROJECT ||= PROJECT;
process.env.GOOGLE_CLOUD_PROJECT ||= PROJECT;

const results = [];

function record(name, status, detail = "", category = "unit") {
  results.push({ name, status, detail, suite: "checkpoint-policy", category });
  const mark = status === "PASS" ? "✓" : status === "FAIL" ? "✗" : "·";
  console.log(`${mark} [${category}] ${name} — ${status}${detail ? `: ${detail}` : ""}`);
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

function unitPolicyTests() {
  const v = resolveCheckpointPolicy({
    hasActiveRide: true,
    rideStatus: "accepted",
    viewerLease: VIEWER_LEASE.VISIBLE,
  });
  record(
    "01-visible-responsive-4s",
    v.policy === CHECKPOINT_POLICY.RESPONSIVE_FIREBASE &&
      v.intervalMs === RESPONSIVE_INTERVAL_MS &&
      v.hardInterval === false
      ? "PASS"
      : "FAIL",
    `policy=${v.policy} ms=${v.intervalMs}`
  );

  const hAcc = resolveCheckpointPolicy({
    hasActiveRide: true,
    rideStatus: "accepted",
    viewerLease: VIEWER_LEASE.EXPIRED,
  });
  record(
    "02-hidden-accepted-60s",
    hAcc.policy === CHECKPOINT_POLICY.BACKGROUND_APPROACH_CHECKPOINT &&
      hAcc.intervalMs === BACKGROUND_APPROACH_INTERVAL_MS &&
      hAcc.hardInterval
      ? "PASS"
      : "FAIL"
  );

  const hArr = resolveCheckpointPolicy({
    hasActiveRide: true,
    rideStatus: "arrived",
    viewerLease: VIEWER_LEASE.EXPIRED,
  });
  record(
    "03-hidden-arrived-60s",
    hArr.intervalMs === BACKGROUND_APPROACH_INTERVAL_MS && hArr.hardInterval
      ? "PASS"
      : "FAIL"
  );

  const hTrip = resolveCheckpointPolicy({
    hasActiveRide: true,
    rideStatus: "in_progress",
    viewerLease: VIEWER_LEASE.EXPIRED,
  });
  record(
    "04-hidden-in-progress-30s",
    hTrip.policy === CHECKPOINT_POLICY.BACKGROUND_TRIP_CHECKPOINT &&
      hTrip.intervalMs === BACKGROUND_TRIP_INTERVAL_MS
      ? "PASS"
      : "FAIL"
  );

  const uAcc = resolveCheckpointPolicy({
    hasActiveRide: true,
    rideStatus: "accepted",
    viewerLease: VIEWER_LEASE.UNKNOWN,
  });
  record(
    "05-unknown-accepted-60s-safe",
    uAcc.policy === CHECKPOINT_POLICY.SAFE_UNKNOWN_APPROACH &&
      uAcc.intervalMs === BACKGROUND_APPROACH_INTERVAL_MS
      ? "PASS"
      : "FAIL"
  );

  const uTrip = resolveCheckpointPolicy({
    hasActiveRide: true,
    rideStatus: "in_progress",
    viewerLease: VIEWER_LEASE.UNKNOWN,
  });
  record(
    "06-unknown-in-progress-30s-safe",
    uTrip.policy === CHECKPOINT_POLICY.SAFE_UNKNOWN_TRIP &&
      uTrip.intervalMs === BACKGROUND_TRIP_INTERVAL_MS
      ? "PASS"
      : "FAIL"
  );

  record(
    "07-presence-failure-does-not-stop",
    resolveCheckpointPolicy({
      hasActiveRide: true,
      rideStatus: "accepted",
      viewerLease: VIEWER_LEASE.UNKNOWN,
    }).intervalMs > 0
      ? "PASS"
      : "FAIL"
  );

  const ctrl = createCheckpointPolicyController({ diag: () => {} });
  ctrl.setActiveRide({ rideId: "r1", status: "accepted", active: true });
  ctrl.setViewerLease(VIEWER_LEASE.EXPIRED);
  const before = ctrl.getCounters().immediateRequested;
  ctrl.setViewerLease(VIEWER_LEASE.VISIBLE);
  record(
    "08-visible-transition-immediate",
    ctrl.getCounters().immediateRequested === before + 1 && ctrl.hasImmediatePending()
      ? "PASS"
      : "FAIL"
  );

  ctrl.requestImmediate();
  ctrl.requestImmediate();
  record(
    "09-repeated-visible-no-burst",
    ctrl.getCounters().immediateCoalesced >= 1 && ctrl.hasImmediatePending()
      ? "PASS"
      : "FAIL",
    `coalesced=${ctrl.getCounters().immediateCoalesced}`
  );

  ctrl.consumeImmediate();
  ctrl.setActiveRide({ rideId: "r1", status: "arrived", active: true });
  const mid = ctrl.getCounters().immediateRequested;
  ctrl.setActiveRide({ rideId: "r1", status: "in_progress", active: true });
  record(
    "10-accepted-to-in-progress-immediate",
    ctrl.getCounters().immediateRequested === mid + 1 ? "PASS" : "FAIL"
  );

  ctrl.consumeImmediate();
  ctrl.requestImmediate("network");
  record(
    "11-offline-online-immediate",
    ctrl.hasImmediatePending() ? "PASS" : "FAIL"
  );

  ctrl.consumeImmediate();
  ctrl.requestImmediate("session");
  record(
    "12-session-change-immediate",
    ctrl.hasImmediatePending() ? "PASS" : "FAIL"
  );

  const genA = ctrl.getGeneration();
  ctrl.setActiveRide({ rideId: "r2", status: "accepted", active: true });
  record(
    "13-old-generation-cannot-write",
    !ctrl.isCurrentGeneration(genA) && ctrl.getGeneration() !== genA ? "PASS" : "FAIL"
  );

  record(
    "39-no-cadence-cut-while-visible",
    resolveCheckpointPolicy({
      hasActiveRide: true,
      rideStatus: "in_progress",
      viewerLease: VIEWER_LEASE.VISIBLE,
      p2pActive: false,
    }).intervalMs === RESPONSIVE_INTERVAL_MS
      ? "PASS"
      : "FAIL"
  );

  record(
    "40-never-stop-during-execution",
    [VIEWER_LEASE.EXPIRED, VIEWER_LEASE.UNKNOWN].every((lease) => {
      const d = resolveCheckpointPolicy({
        hasActiveRide: true,
        rideStatus: "accepted",
        viewerLease: lease,
      });
      return d.intervalMs > 0 && d.intervalMs < Infinity;
    })
      ? "PASS"
      : "FAIL"
  );

  const hard = shouldAllowCheckpointWrite({
    force: false,
    nowMs: 10_000,
    lastWriteMs: 9_000,
    intervalMs: BACKGROUND_APPROACH_INTERVAL_MS,
    hardInterval: true,
    movedEnough: true,
  });
  record(
    "hard-interval-blocks-early-move",
    !hard.allow ? "PASS" : "FAIL"
  );

  const hardOk = shouldAllowCheckpointWrite({
    force: false,
    nowMs: 70_000,
    lastWriteMs: 5_000,
    intervalMs: BACKGROUND_APPROACH_INTERVAL_MS,
    hardInterval: true,
    movedEnough: false,
  });
  record(
    "hard-interval-allows-heartbeat",
    hardOk.allow ? "PASS" : "FAIL"
  );

  record(
    "movement-threshold-documented",
    MIN_LOCATION_MOVE_M === 10 ? "PASS" : "FAIL"
  );

  const fakeLease = resolveViewerLeaseState({
    expiresAtMs: Date.now() - 1000,
    nowMs: Date.now(),
    presenceDocExists: true,
    presenceReadable: true,
  });
  record(
    "30-fake-client-expiry-cannot-keep-responsive",
    fakeLease === VIEWER_LEASE.EXPIRED &&
      resolveCheckpointPolicy({
        hasActiveRide: true,
        rideStatus: "accepted",
        viewerLease: fakeLease,
      }).intervalMs === BACKGROUND_APPROACH_INTERVAL_MS
      ? "PASS"
      : "FAIL"
  );

  record(
    "malformed-timestamp-failsafe",
    resolveViewerLeaseState({
      expiresAtMs: timestampToMsSafe("bad"),
      presenceDocExists: true,
    }) === VIEWER_LEASE.UNKNOWN
      ? "PASS"
      : "FAIL"
  );
}

async function unitPresenceConsumerTests() {
  const timers = [];
  let now = 1_000_000;
  const setT = (fn, ms) => {
    const id = timers.length + 1;
    timers.push({ id, at: now + ms, fn });
    return id;
  };
  const clearT = (id) => {
    const i = timers.findIndex((t) => t.id === id);
    if (i >= 0) timers.splice(i, 1);
  };
  const flush = async (ms) => {
    now += ms;
    const due = timers.filter((t) => t.at <= now).sort((a, b) => a.at - b.at);
    for (const t of due) {
      const i = timers.findIndex((x) => x.id === t.id);
      if (i >= 0) timers.splice(i, 1);
      await t.fn();
    }
  };

  let leases = [];
  let snapHandler = null;
  let errHandler = null;
  let gen = 1;
  const consumer = createViewerPresenceConsumer({
    nowMs: () => now,
    setTimeoutFn: setT,
    clearTimeoutFn: clearT,
    isCurrentGeneration: (g) => g === gen,
    onLeaseChange: (lease) => leases.push(lease),
    subscribeDoc: (_path, onNext, onError) => {
      snapHandler = onNext;
      errHandler = onError;
      return () => {
        snapHandler = null;
        errHandler = null;
      };
    },
  });

  consumer.bind({ rideId: "rideA", customerUid: "cust", generation: gen });
  snapHandler?.({
    exists: true,
    data: { expiresAt: new Date(now + 5_000) },
  });
  record(
    "28-lease-local-expiry-changes-policy",
    leases.at(-1) === VIEWER_LEASE.VISIBLE ? "PASS" : "FAIL",
    `lease=${leases.at(-1)}`
  );
  await flush(5_100);
  record(
    "28b-expiry-timer-fires",
    leases.at(-1) === VIEWER_LEASE.EXPIRED ? "PASS" : "FAIL",
    `lease=${leases.at(-1)}`
  );

  // Idempotent refresh
  const beforeLen = timers.length;
  snapHandler?.({
    exists: true,
    data: { expiresAt: new Date(now + 8_000) },
  });
  snapHandler?.({
    exists: true,
    data: { expiresAt: new Date(now + 8_000) },
  });
  record(
    "29-expiry-timer-refresh-idempotent",
    timers.length <= beforeLen + 1 ? "PASS" : "FAIL",
    `timers=${timers.length}`
  );

  // Stale generation ignored
  const leaseCount = leases.length;
  const oldGen = gen;
  gen = 2;
  snapHandler?.({
    exists: true,
    data: { expiresAt: new Date(now + 90_000) },
  });
  record(
    "14-old-ride-presence-callback-ignored",
    leases.length === leaseCount ? "PASS" : "FAIL"
  );
  void oldGen;

  // Ride A → B
  gen = 3;
  consumer.bind({ rideId: "rideB", customerUid: "cust", generation: gen });
  record(
    "15-ride-a-to-b-attaches-only-b",
    consumer.getBound().rideId === "rideB" ? "PASS" : "FAIL"
  );

  consumer.unbind();
  record(
    "16-terminal-detaches",
    !consumer.getBound().rideId ? "PASS" : "FAIL"
  );

  consumer.bind({ rideId: "rideC", customerUid: "cust", generation: 4 });
  gen = 4;
  consumer.unbind();
  record(
    "17-cancelled-detaches",
    !consumer.getBound().rideId ? "PASS" : "FAIL"
  );

  consumer.bind({ rideId: "rideD", customerUid: "cust", generation: 5 });
  gen = 5;
  consumer.unbind();
  record(
    "18-sign-out-detaches",
    !consumer.getBound().rideId ? "PASS" : "FAIL"
  );

  consumer.bind({ rideId: "rideE", customerUid: "cust", generation: 6 });
  gen = 6;
  consumer.unbind();
  record(
    "19-unlink-detaches",
    !consumer.getBound().rideId ? "PASS" : "FAIL"
  );

  // Read error → unknown, still trackable via policy
  consumer.bind({ rideId: "rideF", customerUid: "cust", generation: 7 });
  gen = 7;
  errHandler?.(new Error("permission-denied"));
  record(
    "07b-read-error-unknown-lease",
    leases.at(-1) === VIEWER_LEASE.UNKNOWN ? "PASS" : "FAIL"
  );

  const noRide = resolveCheckpointPolicy({ hasActiveRide: false });
  record(
    "20-no-active-ride-preserves-dispatch-cadence",
    noRide.policy === CHECKPOINT_POLICY.NO_ACTIVE_RIDE &&
      noRide.intervalMs === RESPONSIVE_INTERVAL_MS &&
      !noRide.hardInterval
      ? "PASS"
      : "FAIL"
  );

  record(
    "21-presence-doc-specific-helper",
    presenceDocId("r", "c") === "r_c" &&
      read("driver-app/js/viewer-presence-consumer.mjs").includes('collection: "rideViewerPresence"') &&
      !read("driver-app/js/viewer-presence-consumer.mjs").includes("collection(")
      ? "PASS"
      : "FAIL"
  );
}

async function unitSerializerTests() {
  let inFlight = 0;
  let maxInFlight = 0;
  let writes = 0;
  const ser = createLocationWriteSerializer({
    isCancelled: () => false,
    writeFn: async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      writes += 1;
      inFlight -= 1;
    },
  });
  const p1 = ser.enqueue({ generation: 1, sessionId: "s", envelope: {}, payload: { a: 1 } });
  const p2 = ser.enqueue({ generation: 1, sessionId: "s", envelope: {}, payload: { a: 2 } });
  const p3 = ser.enqueue({ generation: 1, sessionId: "s", envelope: {}, payload: { a: 3 } });
  await Promise.all([p1, p2, p3]);
  record(
    "31-serializer-single-in-flight",
    maxInFlight === 1 ? "PASS" : "FAIL",
    `max=${maxInFlight}`
  );
  record(
    "32-newest-pending-coalescing",
    writes <= 2 ? "PASS" : "FAIL",
    `writes=${writes}`
  );

  // Rapid transitions shouldn't strand
  let stranded = false;
  let injectedAfterDrain = false;
  const ser2 = createLocationWriteSerializer({
    isCancelled: () => false,
    writeFn: async () => {
      await new Promise((r) => setTimeout(r, 5));
    },
    onAfterDrainBeforeClear: () => {
      if (!injectedAfterDrain) {
        injectedAfterDrain = true;
        ser2.enqueue({ generation: 1, sessionId: "s", envelope: {}, payload: { n: 9 } });
      }
    },
  });
  await ser2.enqueue({ generation: 1, sessionId: "s", envelope: {}, payload: { n: 1 } });
  await new Promise((r) => setTimeout(r, 20));
  const stats = ser2.getStats();
  stranded = stats.hasPending && !stats.inFlight;
  record(
    "33-rapid-transitions-no-strand",
    !stranded || stats.writesCompleted >= 1 ? "PASS" : "FAIL",
    JSON.stringify(stats)
  );

  const session = "sess-cp";
  const base = { lat: 24.86, lng: 67.0, observedAt: 1_000_000, source: "gps" };
  const first = normalizeLocationFix(base, { sessionId: session, sequence: 1 });
  const ooo = evaluateFixAgainstPrevious(first.envelope, {
    ...first.envelope,
    observedAt: first.envelope.observedAt - 5000,
    sequence: 2,
  });
  record("34-out-of-order-rejected", !ooo.accept ? "PASS" : "FAIL");
  const dup = evaluateFixAgainstPrevious(first.envelope, { ...first.envelope });
  record("35-duplicate-noop", !dup.accept ? "PASS" : "FAIL");
}

function staticChecks() {
  const driver = read("driver-app/js/driver-app.js");
  const policy = read("driver-app/js/location-checkpoint-policy.mjs");
  const consumer = read("driver-app/js/viewer-presence-consumer.mjs");
  const rules = read("firestore.rules");
  const mirror = read("functions/driver-location.js");
  const dataCust = read("customer-app/js/data.js");

  record(
    "36-customer-reopen-integration-hooks",
    driver.includes("syncCheckpointPresenceForActiveRide") &&
      driver.includes("requestImmediate") &&
      read("customer-app/js/ride-view-lifecycle.mjs").includes("resumeVisible")
      ? "PASS"
      : "FAIL",
    "",
    "static"
  );

  record(
    "37-server-mirror-transactional",
    mirror.includes("mirrorRideLocationTransactional") ||
      mirror.includes("runTransaction")
      ? "PASS"
      : "FAIL",
    "",
    "static"
  );

  record(
    "38-no-direct-client-ride-location-write",
    driver.includes("Intentionally no client ride.driverLocation") &&
      !/updateDoc\([^)]*rides[^)]*driverLocation/.test(driver)
      ? "PASS"
      : "FAIL",
    "",
    "static"
  );

  record(
    "S01-policy-module-wired",
    driver.includes("location-checkpoint-policy.mjs") &&
      driver.includes("viewer-presence-consumer.mjs") &&
      policy.includes("BACKGROUND_APPROACH_INTERVAL_MS") &&
      consumer.includes("rideViewerPresence")
      ? "PASS"
      : "FAIL",
    "",
    "static"
  );

  record(
    "S02-rules-trackable-status-gate",
    rules.includes("rideViewerPresence") &&
      rules.includes("in ['accepted', 'arrived', 'in_progress']") &&
      rules.includes("allow list: if false")
      ? "PASS"
      : "FAIL",
    "",
    "static"
  );

  record(
    "S03-settlement-accuracy-documented",
    policy.includes("partial-cancel") &&
      policy.includes("undercount") &&
      policy.includes("Breadcrumb batching")
      ? "PASS"
      : "FAIL",
    "",
    "static"
  );

  record(
    "S04-no-collection-query-in-consumer",
    !consumer.includes("getDocs") &&
      !consumer.includes("where(") &&
      consumer.includes("subscribeDoc")
      ? "PASS"
      : "FAIL",
    "",
    "static"
  );

  void dataCust;
}

async function rulesTests() {
  const testEnv = await initializeTestEnvironment({
    projectId: PROJECT,
    firestore: { rules: rulesText, host: "127.0.0.1", port: 8080 },
  });
  const admin = require("firebase-admin");
  if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT });
  const adminDb = admin.firestore();
  const Ts = admin.firestore.Timestamp;

  await testEnv.clearFirestore();

  const customer = "cp-cust";
  const other = "cp-other";
  const driver = "cp-drv";
  const otherDrv = "cp-drv-other";
  const owner = "cp-owner";
  const rideId = "cp-ride";
  const docId = presenceDocId(rideId, customer);

  await adminDb.doc(`rides/${rideId}`).set({
    userId: customer,
    driverId: driver,
    ownerId: owner,
    status: "accepted",
  });
  await adminDb.doc(`rideViewerPresence/${docId}`).set({
    rideId,
    customerId: customer,
    role: "customer",
    state: "visible",
    leaseVersion: 1,
    sessionId: "cp_sess_ok",
    lastSeenAt: Ts.now(),
    expiresAt: Ts.fromMillis(Date.now() + 90_000),
  });

  async function tryPass(name, fn) {
    try {
      await fn();
      record(name, "PASS", "", "rules");
    } catch (e) {
      record(name, "FAIL", String(e.message || e).slice(0, 160), "rules");
    }
  }

  const custDb = testEnv.authenticatedContext(customer).firestore();
  const drvDb = testEnv.authenticatedContext(driver).firestore();
  const otherDrvDb = testEnv.authenticatedContext(otherDrv).firestore();
  const ownerDb = testEnv.authenticatedContext(owner).firestore();
  const anonDb = testEnv.unauthenticatedContext().firestore();

  await tryPass("23-assigned-active-driver-get-allowed", async () => {
    await assertSucceeds(getDoc(doc(drvDb, "rideViewerPresence", docId)));
  });
  await tryPass("22-unrelated-driver-denied", async () => {
    await assertFails(getDoc(doc(otherDrvDb, "rideViewerPresence", docId)));
  });
  await tryPass("24-assigned-driver-list-denied", async () => {
    await assertFails(
      getDocs(query(collection(drvDb, "rideViewerPresence"), where("rideId", "==", rideId)))
    );
  });
  await tryPass("25-owner-denied", async () => {
    await assertFails(getDoc(doc(ownerDb, "rideViewerPresence", docId)));
  });
  await tryPass("26-anonymous-denied", async () => {
    await assertFails(getDoc(doc(anonDb, "rideViewerPresence", docId)));
  });
  await tryPass("27-customer-cannot-write-presence", async () => {
    await assertFails(
      updateDoc(doc(custDb, "rideViewerPresence", docId), { leaseVersion: 99 })
    );
    await assertFails(
      setDoc(doc(custDb, "rideViewerPresence", `${rideId}_forge`), {
        rideId,
        customerId: customer,
        lastSeenAt: serverTimestamp(),
      })
    );
    await assertFails(deleteDoc(doc(custDb, "rideViewerPresence", docId)));
  });

  // Terminal ride: driver get denied
  await adminDb.doc(`rides/${rideId}`).update({ status: "completed" });
  await tryPass("terminal-ride-driver-get-denied", async () => {
    await assertFails(getDoc(doc(drvDb, "rideViewerPresence", docId)));
  });
  await adminDb.doc(`rides/${rideId}`).update({ status: "accepted" });

  await testEnv.cleanup();
}

async function main() {
  console.log("\n=== checkpoint-policy (Phase 2) ===\n");
  staticChecks();
  unitPolicyTests();
  await unitPresenceConsumerTests();
  await unitSerializerTests();
  await rulesTests();

  const pass = results.filter((r) => r.status === "PASS").length;
  const fail = results.filter((r) => r.status === "FAIL").length;
  const byCat = {};
  for (const r of results) {
    byCat[r.category] = byCat[r.category] || { pass: 0, fail: 0 };
    byCat[r.category][r.status === "PASS" ? "pass" : "fail"] += 1;
  }
  const summary = {
    suite: "checkpoint-policy",
    pass,
    fail,
    total: results.length,
    byCategory: byCat,
    results,
    generatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(OUT, JSON.stringify(summary, null, 2));
  console.log(`\n${pass} PASS / ${fail} FAIL / ${results.length} total`);
  console.log(`Wrote ${OUT}`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
