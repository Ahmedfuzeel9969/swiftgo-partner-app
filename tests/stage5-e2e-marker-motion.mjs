/**
 * Stage 5 — end-to-end marker motion through full customer chain.
 *
 * Proves: driver GPS → driver P2P LOC → customer validation → arbiter →
 * display pipeline → increasing display coordinates; P2P fallback/recovery.
 *
 * Run: node tests/stage5-e2e-marker-motion.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createP2pPeerSession } from "../driver-app/js/p2p-peer-session.mjs";
import { createDriverP2pController } from "../driver-app/js/p2p-ride-controller.mjs";
import { createLiveLocationSourceArbiter } from "../customer-app/js/live-location-source-arbiter.mjs";
import { createDisplayLocationPipeline } from "../customer-app/js/display-location-pipeline.mjs";
import {
  FIREBASE_BACKUP_READ_INTERVAL_MS,
  P2P_FALLBACK_AFTER_MS,
} from "../customer-app/js/p2p-protocol.mjs";

const require = createRequire(import.meta.url);
const { assignmentVersionFromRide } = require("../functions/ride-peer-session.js");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "tests", "stage5-e2e-marker-motion-results.json");

const PEER_SESSION_ID = "ps_stage5abcdef01";
const TRACKING_SESSION_ID = "trk_stage5_xyz";

const results = [];
function record(name, status, detail = "") {
  results.push({ name, status, detail });
  const mark = status === "PASS" ? "✓" : "✗";
  console.log(`${mark} ${name} — ${status}${detail ? `: ${detail}` : ""}`);
}

function MockRTCPeerConnection() {
  const self = {
    iceGatheringState: "complete",
    localDescription: null,
    remoteDescription: null,
    createDataChannel() {
      return { readyState: "connecting", bufferedAmount: 0, send() {}, close() {} };
    },
    async createOffer() {
      return { type: "offer", sdp: "v=0\r\no=- offer\r\n" };
    },
    async createAnswer() {
      return { type: "answer", sdp: "v=0\r\no=- answer\r\n" };
    },
    async setLocalDescription(desc) {
      self.localDescription = desc;
    },
    async setRemoteDescription(desc) {
      self.remoteDescription = desc;
    },
    addEventListener() {},
    removeEventListener() {},
    close() {},
    set ondatachannel(_fn) {},
    get ondatachannel() {
      return null;
    },
  };
  return self;
}

function createFakeTimers() {
  let now = 2_000_000;
  const queue = [];
  let idSeq = 1;
  return {
    nowMs: () => now,
    advance(ms) {
      now += Number(ms) || 0;
      queue.sort((a, b) => a.at - b.at);
      const due = queue.filter((t) => t.at <= now);
      for (const t of due) {
        const i = queue.findIndex((x) => x.id === t.id);
        if (i >= 0) queue.splice(i, 1);
        t.fn();
      }
    },
    raf(fn) {
      const id = idSeq++;
      queue.push({ id, at: now + 16, fn: () => fn(now) });
      return id;
    },
    caf(id) {
      const i = queue.findIndex((t) => t.id === id);
      if (i >= 0) queue.splice(i, 1);
    },
  };
}

async function runE2eMarkerMotion() {
  console.log("\n=== Stage 5 E2E — full pipeline marker motion ===\n");

  const ride = { driverId: "drv_stage5", vehicleId: "veh_stage5" };
  const serverAv = assignmentVersionFromRide(ride);
  record(
    "server-assignmentVersion-not-1",
    serverAv !== 1 ? "PASS" : "FAIL",
    `serverAv=${serverAv}`
  );

  const timers = createFakeTimers();
  const displayFrames = [];
  const pipe = createDisplayLocationPipeline({
    nowMs: timers.nowMs,
    raf: (fn) => timers.raf(fn),
    caf: (id) => timers.caf(id),
    onDisplayFrame: (p) => {
      displayFrames.push({
        lat: p.lat,
        lng: p.lng,
        observedAt: p.observedAt,
        mode: p.displayMode || "snap",
        at: timers.nowMs(),
      });
    },
    onRawFallback: (p) => {
      displayFrames.push({
        lat: p.lat,
        lng: p.lng,
        observedAt: p.observedAt,
        mode: "raw",
        at: timers.nowMs(),
      });
    },
  });
  pipe.clearRoute();

  const counters = {
    fixesSent: 0,
    fixesReceived: 0,
    invalidMessages: 0,
    p2pRendered: 0,
    firebaseRendered: 0,
    staleRejected: 0,
    sourceSwitches: 0,
    displayRawFixes: 0,
    displaySnapFixes: 0,
    animationStarts: 0,
    animationCompletions: 0,
  };

  const arb = createLiveLocationSourceArbiter({
    nowMs: timers.nowMs,
    fallbackAfterMs: P2P_FALLBACK_AFTER_MS,
    firebaseBackupReadIntervalMs: FIREBASE_BACKUP_READ_INTERVAL_MS,
    onRender: (fix) => {
      if (fix.source === "p2p") counters.p2pRendered += 1;
      if (fix.source === "firebase") counters.firebaseRendered += 1;
      const before = displayFrames.length;
      const res = pipe.ingestValidatedFix({
        lat: fix.lat,
        lng: fix.lng,
        observedAt: fix.observedAt,
        headingDeg: fix.headingDeg,
        speedMps: 8,
        accuracyM: 10,
      });
      const added = displayFrames.length - before;
      if (added > 0) {
        const last = displayFrames[displayFrames.length - 1];
        if (last.mode === "raw") counters.displayRawFixes += 1;
        else counters.displaySnapFixes += 1;
      }
      void res;
    },
  });
  const gen = arb.getGeneration();

  const customerSession = createP2pPeerSession({
    role: "customer",
    RTCPeerConnection: MockRTCPeerConnection,
    ensureIceConfiguration: async () => {},
    nowMs: timers.nowMs,
    onLocationFix: (fix) => {
      counters.fixesReceived += 1;
      arb.ingestP2p(fix, gen);
    },
    onDiag: (code) => {
      if (code === "p2p_invalid_message") counters.invalidMessages += 1;
    },
  });

  await customerSession.startAsCustomer({
    peerSessionId: PEER_SESSION_ID,
    trackingSessionId: TRACKING_SESSION_ID,
    assignmentVersion: serverAv,
    offerSdp: "v=0\r\no=- offer\r\n",
  });
  const custGen = customerSession.getState().generation;

  const driverSession = createP2pPeerSession({
    role: "driver",
    RTCPeerConnection: MockRTCPeerConnection,
    ensureIceConfiguration: async () => {},
    nowMs: timers.nowMs,
    onLocalDescription: async () => {
      driverSession.syncAssignmentVersion(serverAv);
    },
    onDiag: () => {},
  });

  await driverSession.startAsDriver({
    peerSessionId: PEER_SESSION_ID,
    trackingSessionId: TRACKING_SESSION_ID,
    assignmentVersion: 1,
  });
  driverSession.syncAssignmentVersion(serverAv);

  driverSession._setChannelOpenForTest(true, (payload) => {
    counters.fixesSent += 1;
    customerSession._handleMessageForTest(String(payload), custGen);
  });

  // Phase 1 — five increasing driver GPS fixes via real driver enqueue → P2P packet path
  let lat = 24.861;
  let lng = 67.001;
  const p2pCoords = [];
  for (let i = 0; i < 5; i += 1) {
    lat += 0.0002;
    lng += 0.0001;
    const observedAt = timers.nowMs();
    driverSession.enqueueLocationFix({
      lat,
      lng,
      observedAt,
      accuracyM: 12,
      headingDeg: 90,
    });
    p2pCoords.push({ lat, lng, observedAt });
    timers.advance(500);
  }

  const drvSessionAv = driverSession.getState().assignmentVersion;
  record(
    "driver-loc-packets-use-authoritative-assignmentVersion",
    drvSessionAv === serverAv ? "PASS" : "FAIL",
    `sessionAv=${drvSessionAv}`
  );
  record(
    "five-p2p-fixes-sent-and-received",
    counters.fixesSent === 5 && counters.fixesReceived === 5 && counters.invalidMessages === 0
      ? "PASS"
      : "FAIL",
    `sent=${counters.fixesSent} recv=${counters.fixesReceived} invalid=${counters.invalidMessages}`
  );

  const increasingP2p =
    displayFrames.length >= 5 &&
    p2pCoords.every((c, i) => {
      const frame = displayFrames[i];
      return frame && Math.abs(frame.lat - c.lat) < 1e-6 && frame.lat >= (displayFrames[i - 1]?.lat ?? -Infinity);
    });
  record(
    "five-increasing-display-coordinates-from-p2p",
    increasingP2p ? "PASS" : "FAIL",
    `frames=${displayFrames.length} p2pRendered=${counters.p2pRendered}`
  );

  // Phase 2 — P2P silent → Firebase fallback with immediate first render
  timers.advance(P2P_FALLBACK_AFTER_MS + 1_000);
  const framesBeforeFb = displayFrames.length;
  let fbSeq = 10;
  for (let i = 0; i < 4; i += 1) {
    lat += 0.00025;
    lng += 0.00012;
    arb.ingestFirebase(
      {
        lat,
        lng,
        observedAt: timers.nowMs(),
        sequence: fbSeq++,
        trackingSessionId: TRACKING_SESSION_ID,
      },
      gen
    );
    timers.advance(FIREBASE_BACKUP_READ_INTERVAL_MS);
  }
  const fbFrames = displayFrames.length - framesBeforeFb;
  const arbStateFb = arb.getState();
  record(
    "p2p-silent-firebase-fallback-renders",
    fbFrames >= 3 &&
      arbStateFb.preferred === "firebase" &&
      arbStateFb.counters.firebaseRendered >= 3
      ? "PASS"
      : "FAIL",
    `fbFrames=${fbFrames} preferred=${arbStateFb.preferred} fbRendered=${arbStateFb.counters.firebaseRendered}`
  );

  // Phase 3 — P2P recovers without coordinate rollback
  const latBeforeRecovery = displayFrames[displayFrames.length - 1]?.lat ?? 0;
  for (let i = 0; i < 3; i += 1) {
    lat += 0.0002;
    lng += 0.0001;
    driverSession.enqueueLocationFix({
      lat,
      lng,
      observedAt: timers.nowMs(),
      accuracyM: 10,
    });
    timers.advance(500);
  }
  const latAfterRecovery = displayFrames[displayFrames.length - 1]?.lat ?? 0;
  const arbStateRec = arb.getState();
  record(
    "p2p-recovery-no-coordinate-rollback",
    latAfterRecovery > latBeforeRecovery && arbStateRec.preferred === "p2p"
      ? "PASS"
      : "FAIL",
    `before=${latBeforeRecovery} after=${latAfterRecovery} preferred=${arbStateRec.preferred}`
  );

  const arbCounters = arb.getCounters();
  counters.staleRejected = arbCounters.staleRejected;
  counters.sourceSwitches = arbCounters.sourceSwitches;
  counters.p2pRendered = arbCounters.p2pRendered;
  counters.firebaseRendered = arbCounters.firebaseRendered;

  record(
    "no-invalid-messages-end-to-end",
    counters.invalidMessages === 0 && customerSession.getCounters().invalidMessages === 0
      ? "PASS"
      : "FAIL",
    `invalid=${customerSession.getCounters().invalidMessages}`
  );

  record(
    "firebase-backup-interval-4s-not-15s",
    FIREBASE_BACKUP_READ_INTERVAL_MS === 4_000 ? "PASS" : "FAIL",
    `${FIREBASE_BACKUP_READ_INTERVAL_MS}ms`
  );

  await driverSession.close();
  await customerSession.close();

  return {
    serverAv,
    counters: {
      ...counters,
      driverFixesSent: driverSession.getCounters().fixesSent,
      customerFixesReceived: customerSession.getCounters().fixesReceived,
      customerInvalid: customerSession.getCounters().invalidMessages,
      sourceSwitchP2pToFirebase: arbCounters.sourceSwitchP2pToFirebase,
      sourceSwitchFirebaseToP2p: arbCounters.sourceSwitchFirebaseToP2p,
      firebaseThrottled: arbCounters.firebaseThrottled,
      firebaseIgnoredWhileP2p: arbCounters.firebaseIgnoredWhileP2p,
      displayFrameCount: displayFrames.length,
    },
    displayFrames,
  };
}

async function testControllerPathSyncsAv() {
  const ride = { driverId: "drv_s5_ctrl", vehicleId: "veh_s5_ctrl" };
  const serverAv = assignmentVersionFromRide(ride);
  const drv = createDriverP2pController({
    RTCPeerConnection: MockRTCPeerConnection,
    ensureIceConfiguration: async () => {},
    createRidePeerOfferClient: async () => ({
      assignmentVersion: serverAv,
      sessionId: PEER_SESSION_ID,
    }),
    closeRidePeerSessionClient: async () => {},
    watchRidePeerSession: () => () => {},
  });
  await drv.start({
    rideId: "ride_s5",
    trackingSessionId: TRACKING_SESSION_ID,
    vehicleId: ride.vehicleId,
  });
  await new Promise((r) => setTimeout(r, 30));
  record(
    "controller-path-assignmentVersion-synced",
    drv.getState().assignmentVersion === serverAv ? "PASS" : "FAIL",
    `av=${drv.getState().assignmentVersion}`
  );
  await drv.stop({ closeRemote: false });
}

async function testFallbackTakeoverImmediateRender() {
  let now = 100_000;
  const renders = [];
  const arb = createLiveLocationSourceArbiter({
    nowMs: () => now,
    fallbackAfterMs: 12_000,
    firebaseBackupReadIntervalMs: 4_000,
    onRender: (fix) => renders.push({ ...fix, at: now }),
  });
  const gen = arb.getGeneration();
  arb.ingestP2p({ lat: 1, lng: 1, observedAt: 100_000, sequence: 1 }, gen);
  arb.ingestFirebase({ lat: 2, lng: 2, observedAt: 100_500, sequence: 2 }, gen);
  now += 3_000;
  arb.ingestFirebase({ lat: 3, lng: 3, observedAt: 103_000, sequence: 3 }, gen);
  now += 15_000;
  arb.ensureP2pHealth();
  const renderedAfterFallback = arb.ingestFirebase(
    { lat: 4, lng: 4, observedAt: now, sequence: 4 },
    gen
  );
  record(
    "fallback-takeover-immediate-firebase-render",
    renderedAfterFallback && renders.at(-1)?.lat === 4 ? "PASS" : "FAIL",
    `renders=${renders.length} lastLat=${renders.at(-1)?.lat}`
  );
}

async function main() {
  console.log("\n=== STAGE 5 — end-to-end marker motion ===\n");
  const e2e = await runE2eMarkerMotion();
  await testControllerPathSyncsAv();
  await testFallbackTakeoverImmediateRender();

  const pass = results.filter((r) => r.status === "PASS").length;
  const fail = results.filter((r) => r.status === "FAIL").length;
  const summary = {
    stage: 5,
    generatedAt: new Date().toISOString(),
    pass,
    fail,
    serverAssignmentVersion: e2e.serverAv,
    counters: e2e.counters,
    results,
  };
  fs.writeFileSync(OUT, `${JSON.stringify(summary, null, 2)}\n`);
  console.log("\n--- Counter rollup ---");
  console.log(JSON.stringify(e2e.counters, null, 2));
  console.log(`\nStage 5 summary: ${pass} PASS / ${fail} FAIL`);
  console.log(`Wrote ${OUT}\n`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
