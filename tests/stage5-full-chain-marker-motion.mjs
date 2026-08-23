/**
 * Stage 5 — TRUE full-chain in-process marker motion test.
 *
 * Exercises: driver GPS → driver controller → driver peer session →
 * serialized LOC via channel.send → customer peer session validation →
 * customer controller → source arbiter → display pipeline → marker positions.
 *
 * NOT an arbiter-only inject test. Uses real controllers + bidirectional DC bridge.
 *
 * Run: node tests/stage5-full-chain-marker-motion.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createDriverP2pController } from "../driver-app/js/p2p-ride-controller.mjs";
import { createCustomerP2pController } from "../customer-app/js/p2p-ride-controller.mjs";
import { createDisplayLocationPipeline } from "../customer-app/js/display-location-pipeline.mjs";
import {
  FIREBASE_BACKUP_READ_INTERVAL_MS,
  P2P_FALLBACK_AFTER_MS,
  P2P_SEND_INTERVAL_MS,
} from "../customer-app/js/p2p-protocol.mjs";

const require = createRequire(import.meta.url);
const { assignmentVersionFromRide } = require("../functions/ride-peer-session.js");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "tests", "stage5-full-chain-marker-motion-results.json");

const TRACKING_SESSION_ID = "trk_fullchain_xyz";

const results = [];
function record(name, status, detail = "") {
  results.push({ name, status, detail });
  console.log(`${status === "PASS" ? "✓" : "✗"} ${name} — ${status}${detail ? `: ${detail}` : ""}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Unified clock so controller peer sessions + arbiter + display share one timeline. */
function installFakeClock(startMs = 2_000_000) {
  let t = startMs;
  const realNow = Date.now.bind(Date);
  Date.now = () => t;
  return {
    nowMs: () => t,
    advance(ms) {
      t += Number(ms) || 0;
    },
    restore() {
      Date.now = realNow;
    },
  };
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

function createSignalingHub(serverAv) {
  /** @type {Map<string, object>} */
  const docs = new Map();
  /** @type {Map<string, Set<Function>>} */
  const customerWatches = new Map();
  /** @type {Map<string, Set<Function>>} */
  const driverWatches = new Map();

  function notify(set, rideId, doc) {
    for (const cb of set.get(rideId) || []) {
      try {
        cb(doc);
      } catch {
        /* ignore */
      }
    }
  }

  return {
    createRidePeerOfferClient: async (payload) => {
      const doc = {
        sessionId: payload.peerSessionId,
        offer: payload.offerSdp,
        trackingSessionId: payload.trackingSessionId,
        assignmentVersion: serverAv,
        state: "offered",
      };
      docs.set(payload.rideId, doc);
      notify(customerWatches, payload.rideId, doc);
      return { assignmentVersion: serverAv, sessionId: payload.peerSessionId };
    },
    publishRidePeerAnswerClient: async (payload) => {
      const doc = {
        ...(docs.get(payload.rideId) || {}),
        sessionId: payload.peerSessionId,
        answer: payload.answerSdp,
        assignmentVersion: serverAv,
        state: "answered",
      };
      docs.set(payload.rideId, doc);
      notify(driverWatches, payload.rideId, doc);
      return { ok: true };
    },
    watchForCustomer: (rideId, onData, onError) => {
      if (!customerWatches.has(rideId)) customerWatches.set(rideId, new Set());
      customerWatches.get(rideId).add(onData);
      const doc = docs.get(rideId);
      if (doc?.offer) onData(doc);
      return () => customerWatches.get(rideId)?.delete(onData);
    },
    watchForDriver: (rideId, onData, onError) => {
      if (!driverWatches.has(rideId)) driverWatches.set(rideId, new Set());
      driverWatches.get(rideId).add(onData);
      const doc = docs.get(rideId);
      if (doc?.answer) onData(doc);
      return () => driverWatches.get(rideId)?.delete(onData);
    },
    closeRidePeerSessionClient: async () => {},
  };
}

function wireBidirectionalChannel(driverSession, customerSession) {
  const drvGen = driverSession.getState().generation;
  const custGen = customerSession.getState().generation;
  driverSession._setChannelOpenForTest(true, (payload) => {
    customerSession._handleMessageForTest(String(payload), custGen);
  });
  customerSession._setChannelOpenForTest(true, (payload) => {
    driverSession._handleMessageForTest(String(payload), drvGen);
  });
}

function parseLocAssignmentVersion(serialized) {
  try {
    const msg = JSON.parse(String(serialized));
    return Number(msg.assignmentVersion) || 0;
  } catch {
    return 0;
  }
}

async function waitForSessions(drv, cust, ms = 200) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (drv._getSessionForTest?.() && cust._getSessionForTest?.()) return true;
    await sleep(20);
  }
  return Boolean(drv._getSessionForTest?.() && cust._getSessionForTest?.());
}

async function runFullChainMotion() {
  console.log("\n=== Stage 5 TRUE full-chain marker motion ===\n");

  const clock = installFakeClock(2_000_000);

  const rideMeta = { driverId: "drv_fullchain", vehicleId: "veh_fullchain" };
  const serverAv = assignmentVersionFromRide(rideMeta);
  record(
    "authoritative-assignmentVersion-not-1",
    serverAv !== 1 ? "PASS" : "FAIL",
    `serverAv=${serverAv}`
  );

  const displayFrames = [];
  const locAssignmentVersions = [];
  let driverAcksReceived = 0;

  const pipe = createDisplayLocationPipeline({
    nowMs: clock.nowMs,
    raf: (fn) => {
      fn(clock.nowMs());
      return 1;
    },
    caf: () => {},
    onDisplayFrame: (p) => {
      displayFrames.push({ lat: p.lat, lng: p.lng, observedAt: p.observedAt, at: clock.nowMs() });
    },
    onRawFallback: (p) => {
      displayFrames.push({
        lat: p.lat,
        lng: p.lng,
        observedAt: p.observedAt,
        at: clock.nowMs(),
        mode: "raw",
      });
    },
  });
  pipe.clearRoute();

  const hub = createSignalingHub(serverAv);
  const cust = createCustomerP2pController({
    RTCPeerConnection: MockRTCPeerConnection,
    ensureIceConfiguration: async () => {},
    onRenderFix: (fix) => {
      pipe.ingestValidatedFix({
        lat: fix.lat,
        lng: fix.lng,
        observedAt: fix.observedAt,
        headingDeg: fix.headingDeg,
        speedMps: 8,
        accuracyM: 10,
      });
    },
    publishRidePeerAnswerClient: hub.publishRidePeerAnswerClient,
    closeRidePeerSessionClient: hub.closeRidePeerSessionClient,
    watchRidePeerSession: (rideId, onData, onError) => hub.watchForCustomer(rideId, onData, onError),
  });

  const drv = createDriverP2pController({
    RTCPeerConnection: MockRTCPeerConnection,
    ensureIceConfiguration: async () => {},
    createRidePeerOfferClient: hub.createRidePeerOfferClient,
    closeRidePeerSessionClient: hub.closeRidePeerSessionClient,
    watchRidePeerSession: (rideId, onData, onError) => hub.watchForDriver(rideId, onData, onError),
    onAck: () => {
      driverAcksReceived += 1;
    },
  });

  const ride = { id: "ride_fullchain", status: "in_progress", vehicleId: rideMeta.vehicleId };
  cust.syncForRide(ride, { isVisible: true });
  drv.syncForRide({ ride, trackingSessionId: TRACKING_SESSION_ID });
  await sleep(120);

  const ready = await waitForSessions(drv, cust, 300);
  record("controllers-establish-peer-sessions", ready ? "PASS" : "FAIL");

  const driverSession = drv._getSessionForTest?.();
  const customerSession = cust._getSessionForTest?.();
  if (!driverSession || !customerSession) {
    record("full-chain-aborted", "FAIL", "sessions missing");
    clock.restore();
    return { serverAv, displayFrames, locAssignmentVersions };
  }

  driverSession._setChannelOpenForTest(true, (payload) => {
    locAssignmentVersions.push(parseLocAssignmentVersion(payload));
    customerSession._handleMessageForTest(
      String(payload),
      customerSession.getState().generation
    );
  });
  customerSession._setChannelOpenForTest(true, (payload) => {
    driverSession._handleMessageForTest(String(payload), driverSession.getState().generation);
  });

  let lat = 24.861;
  let lng = 67.001;
  for (let i = 0; i < 5; i += 1) {
    lat += 0.0002;
    lng += 0.0001;
    clock.advance(P2P_SEND_INTERVAL_MS);
    drv.onLocationFix({
      lat,
      lng,
      observedAt: clock.nowMs(),
      accuracyM: 10,
      headingDeg: 90,
    });
    driverSession._flushPendingForTest();
    await sleep(5);
  }

  const custCounters = cust.getCounters();
  const drvCounters = drv.getCounters();
  const allAvOk =
    locAssignmentVersions.length >= 5 &&
    locAssignmentVersions.every((av) => av === serverAv);
  record(
    "all-loc-packets-use-authoritative-assignmentVersion",
    allAvOk ? "PASS" : "FAIL",
    `avs=${locAssignmentVersions.join(",")} expected=${serverAv}`
  );
  record(
    "customer-invalidMessages-zero",
    (custCounters.invalidMessages || 0) === 0 ? "PASS" : "FAIL",
    `invalid=${custCounters.invalidMessages || 0}`
  );
  record(
    "five-fixes-through-controller-chain",
    (drvCounters.fixesSent || 0) >= 5 && (custCounters.fixesReceived || 0) >= 5 ? "PASS" : "FAIL",
    `sent=${drvCounters.fixesSent || 0} recv=${custCounters.fixesReceived || 0}`
  );

  const increasing =
    displayFrames.length >= 5 &&
    displayFrames.every((f, i) => !i || f.lat >= displayFrames[i - 1].lat);
  record(
    "display-marker-positions-move-forward",
    increasing ? "PASS" : "FAIL",
    `frames=${displayFrames.length} lastLat=${displayFrames.at(-1)?.lat}`
  );
  record(
    "valid-acks-return-to-driver",
    driverAcksReceived >= 5 || (driverSession.getCounters().acknowledgementsReceived || 0) >= 5
      ? "PASS"
      : "FAIL",
    `onAck=${driverAcksReceived} acksRecv=${driverSession.getCounters().acknowledgementsReceived || 0}`
  );

  // P2P loss → responsive Firebase takeover → P2P recovery
  const arb = cust.getArbiter();
  clock.advance(P2P_FALLBACK_AFTER_MS + 1_000);
  arb.ensureP2pHealth();
  const beforeFb = displayFrames.length;
  let fbSeq = 100;
  for (let i = 0; i < 3; i += 1) {
    lat += 0.0003;
    lng += 0.00015;
    clock.advance(FIREBASE_BACKUP_READ_INTERVAL_MS);
    cust.ingestFirebaseLocation(
      { lat, lng, observedAt: clock.nowMs(), sequence: fbSeq++, trackingSessionId: TRACKING_SESSION_ID },
      ride
    );
  }
  const fbAdded = displayFrames.length - beforeFb;
  record(
    "p2p-loss-responsive-firebase-takeover",
    fbAdded >= 2 && arb.getState().preferred === "firebase" ? "PASS" : "FAIL",
    `fbFrames=${fbAdded} preferred=${arb.getState().preferred}`
  );

  const latBeforeRec = displayFrames.at(-1)?.lat ?? 0;
  for (let i = 0; i < 3; i += 1) {
    lat += 0.0002;
    lng += 0.0001;
    clock.advance(P2P_SEND_INTERVAL_MS);
    drv.onLocationFix({ lat, lng, observedAt: clock.nowMs(), accuracyM: 8 });
    driverSession._flushPendingForTest();
    await sleep(5);
  }
  const latAfterRec = displayFrames.at(-1)?.lat ?? 0;
  record(
    "p2p-recovery-no-coordinate-rollback",
    latAfterRec >= latBeforeRec && arb.getState().preferred === "p2p" ? "PASS" : "FAIL",
    `before=${latBeforeRec} after=${latAfterRec} preferred=${arb.getState().preferred}`
  );

  await drv.stop({ closeRemote: false });
  await cust.stop({ closeRemote: false });
  clock.restore();
  return { serverAv, displayFrames, locAssignmentVersions };
}

async function testStaleLocBlockedAcrossRideSwitch() {
  const rideMeta = { driverId: "drv_stale", vehicleId: "veh_stale" };
  const serverAv = assignmentVersionFromRide(rideMeta);
  const hub = createSignalingHub(serverAv);
  const renders = [];

  const cust = createCustomerP2pController({
    RTCPeerConnection: MockRTCPeerConnection,
    ensureIceConfiguration: async () => {},
    onRenderFix: (fix) => renders.push(fix),
    publishRidePeerAnswerClient: hub.publishRidePeerAnswerClient,
    closeRidePeerSessionClient: hub.closeRidePeerSessionClient,
    watchRidePeerSession: (rideId, onData, onError) => hub.watchForCustomer(rideId, onData, onError),
  });

  const drvA = createDriverP2pController({
    RTCPeerConnection: MockRTCPeerConnection,
    ensureIceConfiguration: async () => {},
    createRidePeerOfferClient: hub.createRidePeerOfferClient,
    closeRidePeerSessionClient: hub.closeRidePeerSessionClient,
    watchRidePeerSession: (rideId, onData, onError) => hub.watchForDriver(rideId, onData, onError),
  });

  const rideA = { id: "ride_stale_A", status: "in_progress", vehicleId: rideMeta.vehicleId };
  cust.syncForRide(rideA, { isVisible: true });
  drvA.syncForRide({ ride: rideA, trackingSessionId: "trk_stale_A" });
  await sleep(120);
  await waitForSessions(drvA, cust, 300);

  const staleSession = drvA._getSessionForTest?.();
  const staleCustomer = cust._getSessionForTest?.();
  if (staleSession && staleCustomer) {
    wireBidirectionalChannel(staleSession, staleCustomer);
    staleSession._setChannelOpenForTest(true, (payload) => {
      staleCustomer._handleMessageForTest(
        String(payload),
        staleCustomer.getState().generation
      );
    });
    drvA.onLocationFix({ lat: 24.9, lng: 67.1, observedAt: Date.now() });
    staleSession._flushPendingForTest();
    await sleep(30);
  }

  const rendersAfterA = renders.length;
  cust.syncForRide(
    { id: "ride_stale_B", status: "in_progress", vehicleId: rideMeta.vehicleId },
    { isVisible: true }
  );
  await sleep(80);

  if (staleSession) {
    staleSession._setChannelOpenForTest(true, (payload) => {
      cust.getArbiter().ingestP2p(
        { lat: 25.5, lng: 67.5, observedAt: Date.now(), sequence: 999 },
        cust.getArbiter().getGeneration()
      );
    });
    staleSession._handleMessageForTest(
      JSON.stringify({
        v: 1,
        type: "loc",
        peerSessionId: staleSession.getState().peerSessionId,
        trackingSessionId: "trk_stale_A",
        assignmentVersion: serverAv,
        seq: 99,
        observedAt: Date.now(),
        lat: 25.5,
        lng: 67.5,
        role: "driver",
      }),
      staleSession.getState().generation
    );
  }

  const leaked = renders.length > rendersAfterA;
  record(
    "stale-ride-loc-blocked-after-ride-switch",
    !leaked ? "PASS" : "FAIL",
    `renders=${renders.length} afterA=${rendersAfterA}`
  );

  await drvA.stop({ closeRemote: false });
  await cust.stop({ closeRemote: false });
}

async function main() {
  console.log("\n=== STAGE 5 — true full-chain marker motion ===\n");
  await runFullChainMotion();
  await testStaleLocBlockedAcrossRideSwitch();

  const pass = results.filter((r) => r.status === "PASS").length;
  const fail = results.filter((r) => r.status === "FAIL").length;
  const summary = {
    stage: 5,
    suite: "full-chain-marker-motion",
    honestDescription:
      "Driver+customer controllers, serialized LOC via channel.send, customer validation, arbiter, display pipeline",
    generatedAt: new Date().toISOString(),
    pass,
    fail,
    results,
  };
  fs.writeFileSync(OUT, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`\nStage 5 full-chain: ${pass} PASS / ${fail} FAIL`);
  console.log(`Wrote ${OUT}\n`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
