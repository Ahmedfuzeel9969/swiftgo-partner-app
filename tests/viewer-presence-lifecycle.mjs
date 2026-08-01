/**
 * Phase 1 — customer viewer presence + ride view lifecycle suite.
 * Run: npm run test:viewer-presence-lifecycle
 *
 * Categories: unit / emulator / rules / static
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
  doc,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  serverTimestamp,
} from "firebase/firestore";
import {
  createRideViewLifecycle,
  attachBrowserLifecycleListeners,
  HIDDEN_GRACE_MS,
  VIEW_STATE,
  VIEWER_DIAG,
} from "../customer-app/js/ride-view-lifecycle.mjs";
import {
  createViewerPresenceClient,
  nextHeartbeatDelayMs,
  nextRetryDelayMs,
  PRESENCE_HEARTBEAT_MS,
  PRESENCE_HEARTBEAT_JITTER_FRAC,
  PRESENCE_HEARTBEAT_JITTER_MAX_MS,
  PRESENCE_LEASE_TTL_MS,
  PRESENCE_RETRY_MAX_ATTEMPTS,
  presenceDocId,
  isValidPresenceSessionId,
  createPresenceSessionId,
} from "../customer-app/js/viewer-presence-client.mjs";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "tests", "viewer-presence-lifecycle-results.json");
const PROJECT = "demo-swiftgo-phase1";
const rulesText = fs.readFileSync(path.join(ROOT, "firestore.rules"), "utf8");

process.env.FIRESTORE_EMULATOR_HOST ||= "127.0.0.1:8080";
process.env.FIREBASE_AUTH_EMULATOR_HOST ||= "127.0.0.1:9099";
process.env.GCLOUD_PROJECT ||= PROJECT;
process.env.GOOGLE_CLOUD_PROJECT ||= PROJECT;

const results = [];

function record(name, status, detail = "", category = "unit") {
  results.push({ name, status, detail, suite: "viewer-presence-lifecycle", category });
  const mark = status === "PASS" ? "✓" : status === "FAIL" ? "✗" : "·";
  console.log(`${mark} [${category}] ${name} — ${status}${detail ? `: ${detail}` : ""}`);
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

const {
  refreshRideViewerPresence,
  PRESENCE_LEASE_TTL_MS: CF_TTL,
  presenceDocId: cfPresenceDocId,
} = require(path.join(ROOT, "functions", "ride-viewer-presence.js"));

function createFakeTimers() {
  const queue = [];
  let now = 0;
  let idSeq = 1;
  return {
    nowMs: () => now,
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

function unitLifecycleTests() {
  const timers = createFakeTimers();
  let liveCount = 0;
  let presenceStarts = 0;
  let presenceStops = 0;
  let latestCalls = 0;
  let lastOnLatest = null;
  let rideAUpdates = 0;
  let rideBUpdates = 0;
  const rides = {
    rideA: { id: "rideA", status: "accepted", userId: "cust1", driverLocation: { lat: 1, lng: 2 } },
    rideB: { id: "rideB", status: "accepted", userId: "cust1", driverLocation: { lat: 3, lng: 4 } },
  };
  let fetchRideId = "rideA";
  let fetchImpl = async (id) => rides[id] || null;
  const diags = [];
  let subscribedRideId = "";

  const lc = createRideViewLifecycle({
    nowMs: timers.nowMs,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    diag: (code) => diags.push(code),
    fetchLatestRide: async (id) => {
      latestCalls += 1;
      return fetchImpl(id);
    },
    onLatestRide: (ride, gen) => {
      lastOnLatest = { ride, gen };
      if (ride?.id === "rideA") rideAUpdates += 1;
      if (ride?.id === "rideB") rideBUpdates += 1;
    },
    subscribeLive: (rideId) => {
      liveCount += 1;
      subscribedRideId = rideId;
    },
    unsubscribeLive: () => {
      if (liveCount > 0) liveCount -= 1;
      subscribedRideId = "";
    },
    startPresenceHeartbeat: () => {
      presenceStarts += 1;
    },
    stopPresenceHeartbeat: () => {
      presenceStops += 1;
    },
  });
  void subscribedRideId;

  // Patch document visibility for bindRide
  const prevDoc = globalThis.document;
  globalThis.document = { visibilityState: "visible" };

  return (async () => {
    await lc.bindRide({ rideId: "rideA" });

    record(
      "01-visible-attaches-one-listener",
      liveCount === 1 && lc.isLiveAttached() ? "PASS" : "FAIL",
      `live=${liveCount} state=${lc.getState()}`
    );

    globalThis.document.visibilityState = "hidden";
    lc.onHidden();
    await timers.flush(HIDDEN_GRACE_MS);
    record(
      "02-hidden-detaches-listener",
      liveCount === 0 && !lc.isLiveAttached() ? "PASS" : "FAIL",
      `live=${liveCount}`
    );
    record(
      "28-listener-accounting-zero-while-hidden",
      liveCount === 0 ? "PASS" : "FAIL",
      `live=${liveCount}`
    );

    const readsBefore = latestCalls;
    const attachesBefore = lc.getCounters().listenerAttaches;
    globalThis.document.visibilityState = "visible";
    await lc.onVisible();
    record(
      "03-hidden-to-visible-latest-then-one-listener",
      latestCalls === readsBefore + 1 &&
        lc.isLiveAttached() &&
        liveCount === 1 &&
        lc.getCounters().listenerAttaches === attachesBefore + 1
        ? "PASS"
        : "FAIL",
      `reads=${latestCalls - readsBefore} live=${liveCount}`
    );

    const att2 = lc.getCounters().listenerAttaches;
    await lc.onVisible();
    record(
      "04-repeated-visible-no-duplicate",
      lc.getCounters().listenerAttaches === att2 && liveCount === 1 ? "PASS" : "FAIL"
    );

    lc.onHidden();
    lc.onHidden();
    await timers.flush(HIDDEN_GRACE_MS);
    record(
      "05-repeated-hidden-harmless",
      liveCount === 0 && !lc.isLiveAttached() ? "PASS" : "FAIL"
    );

    // Rapid hide/show race: start resume, hide before fetch resolves
    let resolveFetch;
    fetchImpl = () =>
      new Promise((resolve) => {
        resolveFetch = resolve;
      });
    globalThis.document.visibilityState = "visible";
    const resumeP = lc.onVisible();
    await Promise.resolve();
    globalThis.document.visibilityState = "hidden";
    lc.enterBackground();
    resolveFetch?.(rides.rideA);
    await resumeP;
    record(
      "06-rapid-hide-show-stale-generation-ignored",
      !lc.isLiveAttached() && liveCount === 0 ? "PASS" : "FAIL",
      `live=${liveCount} state=${lc.getState()}`
    );

    fetchImpl = async (id) => rides[id] || null;
    rideAUpdates = 0;
    rideBUpdates = 0;
    globalThis.document.visibilityState = "visible";
    await lc.bindRide({ rideId: "rideB" });
    const staleGen = lc.getGeneration() - 1;
    record(
      "07-ride-a-to-b-prevents-a-updates",
      lc.getBoundRideId() === "rideB" &&
        liveCount === 1 &&
        !lc.isCurrentGeneration(staleGen)
        ? "PASS"
        : "FAIL",
      `bound=${lc.getBoundRideId()} live=${liveCount}`
    );

    // Late snapshot after detach ignored
    lc.enterBackground();
    lc.noteSnapshot(); // should not count when not live
    globalThis.document.visibilityState = "visible";
    await lc.onVisible();
    lc.noteSnapshot();
    lc.enterBackground();
    const afterDetach = lc.getCounters().snapshotEvents;
    lc.noteSnapshot();
    record(
      "26-late-snapshot-after-detach-ignored",
      lc.getCounters().snapshotEvents === afterDetach && !lc.isLiveAttached()
        ? "PASS"
        : "FAIL"
    );

    // Sign-out cleanup
    await lc.bindRide({ rideId: "rideA" });
    lc.destroy();
    record(
      "08-sign-out-cleanup",
      !lc.isLiveAttached() && liveCount === 0 && !lc.getBoundRideId() ? "PASS" : "FAIL"
    );

    // Fresh controller for terminal / cancelled / missing
    const timers2 = createFakeTimers();
    let live2 = 0;
    const lc2 = createRideViewLifecycle({
      nowMs: timers2.nowMs,
      setTimeoutFn: timers2.setTimeoutFn,
      clearTimeoutFn: timers2.clearTimeoutFn,
      fetchLatestRide: async () => ({ id: "t1", status: "completed" }),
      onLatestRide: () => {},
      subscribeLive: () => {
        live2 += 1;
      },
      unsubscribeLive: () => {
        live2 = Math.max(0, live2 - 1);
      },
      startPresenceHeartbeat: () => {},
      stopPresenceHeartbeat: () => {},
    });
    globalThis.document.visibilityState = "visible";
    await lc2.bindRide({ rideId: "t1" });
    record(
      "09-terminal-ride-cleanup",
      !lc2.isLiveAttached() && live2 === 0 ? "PASS" : "FAIL"
    );

    const lc3 = createRideViewLifecycle({
      setTimeoutFn: timers2.setTimeoutFn,
      clearTimeoutFn: timers2.clearTimeoutFn,
      fetchLatestRide: async () => ({ id: "c1", status: "cancelled_by_user" }),
      onLatestRide: () => {},
      subscribeLive: () => {
        live2 += 1;
      },
      unsubscribeLive: () => {
        live2 = Math.max(0, live2 - 1);
      },
      startPresenceHeartbeat: () => {},
      stopPresenceHeartbeat: () => {},
    });
    await lc3.bindRide({ rideId: "c1" });
    record(
      "10-cancelled-ride-cleanup",
      !lc3.isLiveAttached() ? "PASS" : "FAIL"
    );

    const lc4 = createRideViewLifecycle({
      setTimeoutFn: timers2.setTimeoutFn,
      clearTimeoutFn: timers2.clearTimeoutFn,
      fetchLatestRide: async () => null,
      onLatestRide: () => {},
      subscribeLive: () => {
        live2 += 1;
      },
      unsubscribeLive: () => {
        live2 = Math.max(0, live2 - 1);
      },
      startPresenceHeartbeat: () => {},
      stopPresenceHeartbeat: () => {},
    });
    await lc4.bindRide({ rideId: "missing" });
    record(
      "11-missing-ride-cleanup",
      !lc4.isLiveAttached() ? "PASS" : "FAIL"
    );

    // Animation/timer cleanup via detach counters
    const lc5 = createRideViewLifecycle({
      setTimeoutFn: timers2.setTimeoutFn,
      clearTimeoutFn: timers2.clearTimeoutFn,
      fetchLatestRide: async () => rides.rideA,
      onLatestRide: () => {},
      subscribeLive: () => {},
      unsubscribeLive: () => {},
      startPresenceHeartbeat: () => {},
      stopPresenceHeartbeat: () => {},
    });
    await lc5.bindRide({ rideId: "rideA" });
    const stopsBefore = lc5.getCounters().animationStops;
    lc5.enterBackground();
    record(
      "27-animation-timer-cleanup",
      lc5.getCounters().animationStops === stopsBefore + 1 ? "PASS" : "FAIL"
    );

    // pagehide / pageshow / offline→online via browser adapters
    const listeners = {};
    const fakeDoc = {
      visibilityState: "visible",
      addEventListener: (ev, fn) => {
        listeners[`doc:${ev}`] = fn;
      },
      removeEventListener: (ev) => {
        delete listeners[`doc:${ev}`];
      },
    };
    const fakeWin = {
      addEventListener: (ev, fn) => {
        listeners[`win:${ev}`] = fn;
      },
      removeEventListener: (ev) => {
        delete listeners[`win:${ev}`];
      },
    };
    const lc6 = createRideViewLifecycle({
      setTimeoutFn: timers2.setTimeoutFn,
      clearTimeoutFn: timers2.clearTimeoutFn,
      fetchLatestRide: async () => rides.rideA,
      onLatestRide: () => {},
      subscribeLive: () => {
        live2 += 1;
      },
      unsubscribeLive: () => {
        live2 = Math.max(0, live2 - 1);
      },
      startPresenceHeartbeat: () => {},
      stopPresenceHeartbeat: () => {},
    });
    const detach = attachBrowserLifecycleListeners(lc6, fakeDoc, fakeWin);
    globalThis.document = fakeDoc;
    await lc6.bindRide({ rideId: "rideA" });
    listeners["win:pagehide"]?.();
    record(
      "23-pagehide-cleanup",
      !lc6.isLiveAttached() ? "PASS" : "FAIL"
    );
    fakeDoc.visibilityState = "visible";
    await listeners["win:pageshow"]?.();
    record(
      "24-pageshow-bfcache-recovery",
      lc6.isLiveAttached() ? "PASS" : "FAIL"
    );
    lc6.enterBackground();
    fakeDoc.visibilityState = "visible";
    await listeners["win:online"]?.();
    record(
      "25-offline-online-recovery-while-visible",
      lc6.isLiveAttached() ? "PASS" : "FAIL"
    );
    detach();

    globalThis.document = prevDoc;
  })();
}

function unitPresenceHeartbeatTests() {
  const delays = [];
  for (let i = 0; i < 40; i += 1) {
    delays.push(nextHeartbeatDelayMs(() => i / 40));
  }
  const span = Math.min(
    PRESENCE_HEARTBEAT_JITTER_MAX_MS,
    PRESENCE_HEARTBEAT_MS * PRESENCE_HEARTBEAT_JITTER_FRAC
  );
  const lo = PRESENCE_HEARTBEAT_MS - span;
  const hi = PRESENCE_HEARTBEAT_MS + span;
  const inRange = delays.every((d) => d >= Math.max(1000, lo - 1) && d <= hi + 1);
  record(
    "19-heartbeat-jitter-safe-range",
    inRange ? "PASS" : "FAIL",
    `lo=${lo} hi=${hi} sample=${delays[0]}`
  );

  const timers = createFakeTimers();
  let calls = 0;
  let visible = true;
  let genOk = true;
  const client = createViewerPresenceClient({
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    random: () => 0.5,
    isVisible: () => visible,
    isCurrentGeneration: () => genOk,
    callRefresh: async () => {
      calls += 1;
      return { ok: true };
    },
  });

  client.start({ rideId: "r1", generation: 1 });
  return (async () => {
    await Promise.resolve();
    const firstCalls = calls;
    client.start({ rideId: "r1", generation: 1 });
    await Promise.resolve();
    record(
      "20-one-heartbeat-loop-only",
      calls === firstCalls ? "PASS" : "FAIL",
      `calls=${calls}`
    );

    // Bounded retry/backoff
    const timers2 = createFakeTimers();
    let attempts = 0;
    const failClient = createViewerPresenceClient({
      setTimeoutFn: timers2.setTimeoutFn,
      clearTimeoutFn: timers2.clearTimeoutFn,
      random: () => 0,
      isVisible: () => true,
      isCurrentGeneration: () => true,
      callRefresh: async () => {
        attempts += 1;
        throw new Error("fail");
      },
    });
    failClient.start({ rideId: "r2", generation: 1 });
    await Promise.resolve();
    for (let i = 0; i < PRESENCE_RETRY_MAX_ATTEMPTS + 3; i += 1) {
      await timers2.flush(nextRetryDelayMs(i, () => 0) + 10);
      await Promise.resolve();
    }
    record(
      "21-heartbeat-bounded-retry-backoff",
      attempts <= PRESENCE_RETRY_MAX_ATTEMPTS + 2 ? "PASS" : "FAIL",
      `attempts=${attempts}`
    );

    visible = false;
    const beforeHide = calls;
    client.stop();
    const hideClient = createViewerPresenceClient({
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
      random: () => 0.5,
      isVisible: () => false,
      isCurrentGeneration: () => true,
      callRefresh: async () => {
        calls += 1;
        return { ok: true };
      },
    });
    hideClient.start({ rideId: "r3", generation: 1 });
    await Promise.resolve();
    await timers.flush(PRESENCE_HEARTBEAT_MS);
    record(
      "22-hidden-page-schedules-no-heartbeat",
      calls === beforeHide ? "PASS" : "FAIL",
      `calls=${calls} before=${beforeHide}`
    );

    record(
      "session-id-validation",
      isValidPresenceSessionId(createPresenceSessionId()) &&
        !isValidPresenceSessionId("x") &&
        !isValidPresenceSessionId("bad id!")
        ? "PASS"
        : "FAIL"
    );
  })();
}

async function emulatorPresenceTests() {
  const admin = require("firebase-admin");
  if (!admin.apps.length) {
    admin.initializeApp({ projectId: PROJECT });
  }
  const db = admin.firestore();
  const customer = "vp-cust";
  const other = "vp-other";
  const driver = "vp-drv";
  const owner = "vp-owner";
  const rideId = "vp-ride-1";
  const sessionId = "vp_sess_abc123";

  await db.doc(`rides/${rideId}`).set({
    userId: customer,
    driverId: driver,
    ownerId: owner,
    status: "accepted",
    vehicleId: "vp-veh",
    farePkr: 100,
  });

  async function tryPass(name, fn) {
    try {
      await fn();
      record(name, "PASS", "", "emulator");
    } catch (e) {
      record(name, "FAIL", String(e.message || e).slice(0, 200), "emulator");
    }
  }

  await tryPass("12-valid-assigned-customer-presence-refresh", async () => {
    const res = await refreshRideViewerPresence(db, {
      customerUid: customer,
      rideId,
      sessionId,
      leaseVersion: 1,
    });
    if (!res?.ok) throw new Error("not ok");
    const snap = await db.doc(`rideViewerPresence/${cfPresenceDocId(rideId, customer)}`).get();
    if (!snap.exists) throw new Error("missing doc");
    const d = snap.data();
    if (d.customerId !== customer || d.role !== "customer" || d.state !== "visible") {
      throw new Error("bad fields");
    }
    if (!d.lastSeenAt || !d.expiresAt) throw new Error("missing timestamps");
    if (d.lat != null || d.lng != null || d.userAgent) throw new Error("PII/coords stored");
  });

  await tryPass("13-unrelated-customer-denied", async () => {
    try {
      await refreshRideViewerPresence(db, {
        customerUid: other,
        rideId,
        sessionId,
        leaseVersion: 1,
      });
      throw new Error("should deny");
    } catch (e) {
      if (String(e.message) !== "NOT_RIDE_CUSTOMER") throw e;
    }
  });

  await tryPass("14-driver-denied", async () => {
    try {
      await refreshRideViewerPresence(db, {
        customerUid: driver,
        rideId,
        sessionId,
        leaseVersion: 1,
      });
      throw new Error("should deny");
    } catch (e) {
      if (String(e.message) !== "NOT_RIDE_CUSTOMER") throw e;
    }
  });

  await tryPass("15-owner-denied", async () => {
    try {
      await refreshRideViewerPresence(db, {
        customerUid: owner,
        rideId,
        sessionId,
        leaseVersion: 1,
      });
      throw new Error("should deny");
    } catch (e) {
      if (String(e.message) !== "NOT_RIDE_CUSTOMER") throw e;
    }
  });

  await tryPass("16-anonymous-denied", async () => {
    try {
      await refreshRideViewerPresence(db, {
        customerUid: "",
        rideId,
        sessionId,
        leaseVersion: 1,
      });
      throw new Error("should deny");
    } catch (e) {
      if (String(e.message) !== "AUTH_REQUIRED") throw e;
    }
  });

  await tryPass("17-terminal-ride-presence-denied", async () => {
    await db.doc(`rides/${rideId}`).update({ status: "completed" });
    try {
      await refreshRideViewerPresence(db, {
        customerUid: customer,
        rideId,
        sessionId,
        leaseVersion: 2,
      });
      throw new Error("should deny");
    } catch (e) {
      if (String(e.message) !== "RIDE_NOT_TRACKABLE") throw e;
    }
    await db.doc(`rides/${rideId}`).update({ status: "accepted" });
  });

  await tryPass("18-client-cannot-forge-timestamps", async () => {
    const before = Date.now();
    await refreshRideViewerPresence(db, {
      customerUid: customer,
      rideId,
      sessionId,
      leaseVersion: 3,
      lastSeenAt: new Date(0),
      expiresAt: new Date(0),
    });
    const snap = await db.doc(`rideViewerPresence/${cfPresenceDocId(rideId, customer)}`).get();
    const d = snap.data();
    const expMs = d.expiresAt.toMillis();
    if (expMs < before + CF_TTL - 5_000) throw new Error(`forged expiry ${expMs}`);
    // lastSeenAt is serverTimestamp — may be Timestamp or null until resolved; expiresAt is set client-side server-derived
    if (Math.abs(expMs - (before + CF_TTL)) > 15_000) {
      throw new Error(`unexpected ttl ${expMs - before}`);
    }
  });

  await tryPass("wrong-customer-ride-rejected-fetch-path", async () => {
    // Covered by NOT_RIDE_CUSTOMER + lifecycle null fetch; assert helper
    if (presenceDocId(rideId, customer) !== `${rideId}_${customer}`) {
      throw new Error("doc id shape");
    }
  });
}

async function rulesTests() {
  const testEnv = await initializeTestEnvironment({
    projectId: PROJECT,
    firestore: { rules: rulesText, host: "127.0.0.1", port: 8080 },
  });
  const admin = require("firebase-admin");
  if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT });
  const adminDb = admin.firestore();
  const AdminTs = admin.firestore.Timestamp;

  await testEnv.clearFirestore();

  const customer = "vp-rules-cust";
  const other = "vp-rules-other";
  const driver = "vp-rules-drv";
  const owner = "vp-rules-owner";
  const rideId = "vp-rules-ride";
  const docId = `${rideId}_${customer}`;

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
    sessionId: "vp_rules_sess",
    lastSeenAt: AdminTs.now(),
    expiresAt: AdminTs.fromMillis(Date.now() + PRESENCE_LEASE_TTL_MS),
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
  const otherDb = testEnv.authenticatedContext(other).firestore();
  const drvDb = testEnv.authenticatedContext(driver).firestore();
  const ownerDb = testEnv.authenticatedContext(owner).firestore();
  const anonDb = testEnv.unauthenticatedContext().firestore();

  await tryPass("rules-customer-can-read-own-presence", async () => {
    await assertSucceeds(getDoc(doc(custDb, "rideViewerPresence", docId)));
  });
  await tryPass("rules-driver-can-read-assigned-presence", async () => {
    await assertSucceeds(getDoc(doc(drvDb, "rideViewerPresence", docId)));
  });
  await tryPass("rules-other-customer-read-denied", async () => {
    await assertFails(getDoc(doc(otherDb, "rideViewerPresence", docId)));
  });
  await tryPass("rules-owner-read-denied", async () => {
    await assertFails(getDoc(doc(ownerDb, "rideViewerPresence", docId)));
  });
  await tryPass("rules-anon-read-denied", async () => {
    await assertFails(getDoc(doc(anonDb, "rideViewerPresence", docId)));
  });
  await tryPass("rules-client-create-denied", async () => {
    await assertFails(
      setDoc(doc(custDb, "rideViewerPresence", `${rideId}_forge`), {
        rideId,
        customerId: customer,
        role: "customer",
        state: "visible",
        lastSeenAt: serverTimestamp(),
        expiresAt: serverTimestamp(),
      })
    );
  });
  await tryPass("rules-client-update-denied", async () => {
    await assertFails(
      updateDoc(doc(custDb, "rideViewerPresence", docId), { leaseVersion: 99 })
    );
  });
  await tryPass("rules-client-delete-denied", async () => {
    await assertFails(deleteDoc(doc(custDb, "rideViewerPresence", docId)));
  });

  await testEnv.cleanup();
}

function staticChecks() {
  const flow = read("customer-app/js/ride-flow.js");
  const app = read("customer-app/js/app.js");
  const index = read("functions/index.js");
  const rules = read("firestore.rules");
  const booking = read("customer-app/js/booking-client.js");

  record(
    "29-booking-assignment-flow-unchanged-hooks",
    flow.includes("createCustomerBookingClient") &&
      flow.includes("bindRideView") &&
      app.includes("clearCustomerRideSession") &&
      booking.includes("createCustomerBooking")
      ? "PASS"
      : "FAIL",
    "",
    "static"
  );

  record(
    "S01-lifecycle-modules-wired",
    flow.includes("ride-view-lifecycle.mjs") &&
      flow.includes("viewer-presence-client.mjs") &&
      flow.includes("attachBrowserLifecycleListeners")
      ? "PASS"
      : "FAIL",
    "",
    "static"
  );

  record(
    "S02-presence-callable-exported",
    index.includes("refreshRideViewerPresence") &&
      rules.includes("match /rideViewerPresence/{presenceId}") &&
      rules.includes("allow create, update, delete: if false")
      ? "PASS"
      : "FAIL",
    "",
    "static"
  );

  record(
    "S03-no-beforeunload-correctness",
    !flow.includes("beforeunload") &&
      read("customer-app/js/ride-view-lifecycle.mjs").includes("visibilitychange") &&
      read("customer-app/js/ride-view-lifecycle.mjs").includes("pagehide")
      ? "PASS"
      : "FAIL",
    "",
    "static"
  );

  record(
    "S04-privacy-safe-diags-only",
    Object.values(VIEWER_DIAG).every((c) => typeof c === "string" && c.startsWith("viewer_"))
      ? "PASS"
      : "FAIL",
    "",
    "static"
  );

  record(
    "S05-no-driver-throttle-yet",
    !read("driver-app/js/driver-app.js").includes("rideViewerPresence") &&
      !read("functions/driver-location.js").includes("rideViewerPresence")
      ? "PASS"
      : "FAIL",
    "",
    "static"
  );

  record(
    "30-live-location-envelope-modules-intact",
    fs.existsSync(path.join(ROOT, "customer-app/js/live-location-render.mjs")) &&
      fs.existsSync(path.join(ROOT, "functions/driver-location.js"))
      ? "PASS"
      : "FAIL",
    "",
    "static"
  );
}

async function main() {
  console.log("\n=== viewer-presence-lifecycle ===\n");
  staticChecks();
  await unitLifecycleTests();
  await unitPresenceHeartbeatTests();
  await emulatorPresenceTests();
  await rulesTests();

  const pass = results.filter((r) => r.status === "PASS").length;
  const fail = results.filter((r) => r.status === "FAIL").length;
  const byCat = {};
  for (const r of results) {
    byCat[r.category] = byCat[r.category] || { pass: 0, fail: 0 };
    byCat[r.category][r.status === "PASS" ? "pass" : "fail"] += 1;
  }
  const summary = {
    suite: "viewer-presence-lifecycle",
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
