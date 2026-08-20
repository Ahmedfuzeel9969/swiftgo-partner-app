/**
 * Stage 3 — stabilize authoritative assignment state after bootstrap.
 *
 * Run: node tests/stage3-assignment-identity-stability.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createDriverP2pController } from "../driver-app/js/p2p-ride-controller.mjs";
import { P2P_STATE } from "../driver-app/js/p2p-protocol.mjs";

const require = createRequire(import.meta.url);
const { assignmentVersionFromRide } = require("../functions/ride-peer-session.js");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "tests", "stage3-assignment-identity-stability-results.json");

const DRIVER_UID = "drv_stage3_id";
const CUSTOMER_UID = "cust_stage3_id";
const RIDE_A = "ride_stage3_A";
const RIDE_B = "ride_stage3_B";
const VEHICLE_A = "veh_stage3_A";
const VEHICLE_B = "veh_stage3_B";
const TRK_A = "trk_stage3_A";
const TRK_B = "trk_stage3_B";
const OFFER_SDP = "v=0\r\no=- stage3 offer\r\n";

const results = [];
function record(name, status, detail = "") {
  results.push({ name, status, detail });
  console.log(`${status === "PASS" ? "✓" : "✗"} ${name} — ${status}${detail ? `: ${detail}` : ""}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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
      return { type: "offer", sdp: OFFER_SDP };
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

function rideAv(vehicleId, token) {
  return assignmentVersionFromRide({
    driverId: DRIVER_UID,
    vehicleId,
    assignmentSessionToken: token,
  });
}

function createDriver(opts = {}) {
  let offerCount = 0;
  const offers = [];
  const answerWatchers = new Map();
  const serverAvByRide = opts.serverAvByRide || {};

  const drv = createDriverP2pController({
    RTCPeerConnection: MockRTCPeerConnection,
    ensureIceConfiguration: async () => {},
    createRidePeerOfferClient: async (payload) => {
      offerCount += 1;
      offers.push({ ...payload });
      const av =
        Math.floor(Number(serverAvByRide[payload.rideId]) || 0) ||
        Math.floor(Number(opts.defaultServerAv) || 0) ||
        42;
      return { assignmentVersion: av, sessionId: payload.peerSessionId };
    },
    closeRidePeerSessionClient: async () => {},
    watchRidePeerSession: (rideId, onData) => {
      if (!answerWatchers.has(rideId)) answerWatchers.set(rideId, new Set());
      answerWatchers.get(rideId).add(onData);
      return () => answerWatchers.get(rideId)?.delete(onData);
    },
    ...opts.extra,
  });

  return {
    drv,
    getOfferCount: () => offerCount,
    getOffers: () => offers.slice(),
    pushAnswer(rideId, doc) {
      for (const cb of answerWatchers.get(rideId) || []) {
        try {
          cb(doc);
        } catch {
          /* ignore */
        }
      }
    },
  };
}

async function testBootstrapThenResyncStable() {
  console.log("\n=== Bootstrap 0 → server AV; same-ride resync 10x ===\n");
  const serverAv = rideAv(VEHICLE_A, "ast_stage3_boot");
  const { drv, getOfferCount } = createDriver({
    defaultServerAv: serverAv,
  });

  drv.syncForRide({
    ride: { id: RIDE_A, status: "in_progress", vehicleId: VEHICLE_A },
    trackingSessionId: TRK_A,
    assignmentVersion: 0,
  });
  await sleep(250);

  const sessionRef = drv._getSessionForTest?.();
  const peerSessionId = sessionRef?.getState?.()?.peerSessionId || "";
  const genAfterBoot = drv._getStartupGeneration?.() || 0;
  const offersAfterBoot = getOfferCount();
  const ctrlAv = drv._getControllerAssignmentVersion?.() || 0;
  const syncedAv = drv._getSyncedAssignmentVersion?.() || 0;

  record(
    "bootstrap-0-to-server-av",
    ctrlAv === serverAv && syncedAv === serverAv ? "PASS" : "FAIL",
    `ctrlAv=${ctrlAv} syncedAv=${syncedAv} serverAv=${serverAv}`
  );
  record(
    "session-av-matches-authoritative",
    sessionRef?.getState?.()?.assignmentVersion === serverAv ? "PASS" : "FAIL",
    `sessionAv=${sessionRef?.getState?.()?.assignmentVersion}`
  );

  for (let i = 0; i < 10; i += 1) {
    drv.syncForRide({
      ride: { id: RIDE_A, status: "in_progress", vehicleId: VEHICLE_A },
      trackingSessionId: TRK_A,
    });
    await sleep(20);
  }
  await sleep(150);

  const sessionAfter = drv._getSessionForTest?.();
  record(
    "same-ride-resync-10x-same-session",
    sessionAfter === sessionRef &&
      sessionAfter?.getState?.()?.peerSessionId === peerSessionId
      ? "PASS"
      : "FAIL",
    `sameRef=${sessionAfter === sessionRef} peer=${sessionAfter?.getState?.()?.peerSessionId || ""}`
  );
  record(
    "same-ride-resync-10x-no-extra-offer",
    getOfferCount() === offersAfterBoot ? "PASS" : "FAIL",
    `offers=${offersAfterBoot}->${getOfferCount()}`
  );
  record(
    "same-ride-resync-10x-no-generation-churn",
    drv._getStartupGeneration?.() === genAfterBoot ? "PASS" : "FAIL",
    `gen=${genAfterBoot}->${drv._getStartupGeneration?.()}`
  );
  record(
    "authoritative-av-stable-after-resync",
    drv._getSyncedAssignmentVersion?.() === serverAv &&
      drv._getControllerAssignmentVersion?.() === serverAv
      ? "PASS"
      : "FAIL",
    `synced=${drv._getSyncedAssignmentVersion?.()} ctrl=${drv._getControllerAssignmentVersion?.()}`
  );

  await drv.stop({ closeRemote: false });
}

async function testPresenceAndSnapshotResyncNoRotation() {
  console.log("\n=== Presence / snapshot style resync ===\n");
  const serverAv = rideAv(VEHICLE_A, "ast_stage3_presence");
  const { drv, getOfferCount } = createDriver({ defaultServerAv: serverAv });
  const ride = { id: RIDE_A, status: "accepted", vehicleId: VEHICLE_A };

  drv.syncForRide({ ride, trackingSessionId: TRK_A });
  await sleep(200);
  const sessionRef = drv._getSessionForTest?.();
  const peer = sessionRef?.getState?.()?.peerSessionId;
  const offers = getOfferCount();
  const gen = drv._getStartupGeneration?.();

  // Simulate presence callback style sync (same ride, no AV).
  drv.syncForRide({ ride: { ...ride, status: "arrived" }, trackingSessionId: TRK_A });
  await sleep(50);
  // Simulate ride snapshot callback.
  drv.syncForRide({ ride: { ...ride, status: "in_progress" }, trackingSessionId: TRK_A });
  await sleep(50);
  drv.syncForRide({ ride: { ...ride, status: "in_progress" }, trackingSessionId: TRK_A });
  await sleep(100);

  record(
    "presence-callback-resync-no-rotation",
    drv._getSessionForTest?.() === sessionRef &&
      drv._getSessionForTest?.()?.getState?.()?.peerSessionId === peer &&
      getOfferCount() === offers &&
      drv._getStartupGeneration?.() === gen
      ? "PASS"
      : "FAIL",
    `offers=${offers}->${getOfferCount()} gen=${gen}->${drv._getStartupGeneration?.()}`
  );
  await drv.stop({ closeRemote: false });
}

async function testGenuineAvChangeInvalidates() {
  console.log("\n=== Genuine AV change invalidates session ===\n");
  // assignmentVersionFromRide binds driver|vehicle only — use explicit distinct AVs.
  const avA = 111001;
  const avB = 222002;
  let nextAv = avA;
  let offerCount = 0;

  const drv2 = createDriverP2pController({
    RTCPeerConnection: MockRTCPeerConnection,
    ensureIceConfiguration: async () => {},
    createRidePeerOfferClient: async (payload) => {
      offerCount += 1;
      return { assignmentVersion: nextAv, sessionId: payload.peerSessionId };
    },
    closeRidePeerSessionClient: async () => {},
    watchRidePeerSession: () => () => {},
  });

  drv2.syncForRide({
    ride: { id: RIDE_A, status: "in_progress", vehicleId: VEHICLE_A },
    trackingSessionId: TRK_A,
  });
  await sleep(200);
  const sessionA = drv2._getSessionForTest?.();
  const peerA = sessionA?.getState?.()?.peerSessionId;
  const syncedA = drv2._getSyncedAssignmentVersion?.();

  nextAv = avB;
  drv2.syncForRide({
    ride: { id: RIDE_A, status: "in_progress", vehicleId: VEHICLE_A },
    trackingSessionId: TRK_A,
    assignmentVersion: avB,
  });
  await sleep(250);

  const sessionB = drv2._getSessionForTest?.();
  record(
    "genuine-av-change-invalidates-old-session",
    sessionB !== sessionA &&
      sessionB?.getState?.()?.peerSessionId !== peerA &&
      drv2._getSyncedAssignmentVersion?.() === avB &&
      syncedA === avA &&
      offerCount >= 2
      ? "PASS"
      : "FAIL",
    `syncedA=${syncedA} syncedB=${drv2._getSyncedAssignmentVersion?.()} peerChanged=${sessionB?.getState?.()?.peerSessionId !== peerA} offers=${offerCount}`
  );
  await drv2.stop({ closeRemote: false });
}

async function testRideAToRideBRaceSafe() {
  console.log("\n=== Ride A → Ride B race ===\n");
  const avA = rideAv(VEHICLE_A, "ast_race_a");
  const avB = rideAv(VEHICLE_B, "ast_race_b");
  const { drv, getOffers } = createDriver({
    serverAvByRide: { [RIDE_A]: avA, [RIDE_B]: avB },
  });

  drv.syncForRide({
    ride: { id: RIDE_A, status: "in_progress", vehicleId: VEHICLE_A },
    trackingSessionId: TRK_A,
  });
  await sleep(80);
  drv.syncForRide({
    ride: { id: RIDE_B, status: "in_progress", vehicleId: VEHICLE_B },
    trackingSessionId: TRK_B,
  });
  await sleep(300);

  record(
    "ride-a-to-b-race-lands-on-b",
    drv._getRideId?.() === RIDE_B &&
      drv._getSyncedAssignmentVersion?.() === avB &&
      drv._getSessionForTest?.()?.getState?.()?.assignmentVersion === avB
      ? "PASS"
      : "FAIL",
    `ride=${drv._getRideId?.()} synced=${drv._getSyncedAssignmentVersion?.()} offers=${getOffers()
      .map((o) => o.rideId)
      .join(",")}`
  );
  await drv.stop({ closeRemote: false });
}

async function testLateServerACannotMutateB() {
  console.log("\n=== Late server A callback cannot mutate B ===\n");
  const avA = rideAv(VEHICLE_A, "ast_late_a");
  const avB = rideAv(VEHICLE_B, "ast_late_b");

  let resolveOfferA;
  const offerAGate = new Promise((r) => {
    resolveOfferA = r;
  });
  let offerBDone = false;

  const drv = createDriverP2pController({
    RTCPeerConnection: MockRTCPeerConnection,
    ensureIceConfiguration: async () => {},
    createRidePeerOfferClient: async (payload) => {
      if (payload.rideId === RIDE_A) {
        await offerAGate;
        return { assignmentVersion: avA, sessionId: payload.peerSessionId };
      }
      offerBDone = true;
      return { assignmentVersion: avB, sessionId: payload.peerSessionId };
    },
    closeRidePeerSessionClient: async () => {},
    watchRidePeerSession: () => () => {},
  });

  drv.syncForRide({
    ride: { id: RIDE_A, status: "in_progress", vehicleId: VEHICLE_A },
    trackingSessionId: TRK_A,
  });
  await sleep(40);
  drv.syncForRide({
    ride: { id: RIDE_B, status: "in_progress", vehicleId: VEHICLE_B },
    trackingSessionId: TRK_B,
  });
  await sleep(120);
  resolveOfferA();
  await sleep(200);

  record(
    "late-server-a-cannot-mutate-b",
    drv._getRideId?.() === RIDE_B &&
      drv._getSyncedAssignmentVersion?.() === avB &&
      drv._getControllerAssignmentVersion?.() === avB &&
      offerBDone
      ? "PASS"
      : "FAIL",
    `ride=${drv._getRideId?.()} synced=${drv._getSyncedAssignmentVersion?.()} ctrl=${drv._getControllerAssignmentVersion?.()}`
  );
  await drv.stop({ closeRemote: false });
}

async function testReconnectRetainsAuthoritativeAv() {
  console.log("\n=== Reconnect retains authoritative AV ===\n");
  const serverAv = rideAv(VEHICLE_A, "ast_reconnect");
  const { drv } = createDriver({ defaultServerAv: serverAv });

  drv.syncForRide({
    ride: { id: RIDE_A, status: "in_progress", vehicleId: VEHICLE_A },
    trackingSessionId: TRK_A,
  });
  await sleep(200);

  const session = drv._getSessionForTest?.();
  session._setChannelOpenForTest?.(true);
  // Force reconnect path via unhealthy closed-ish state by calling requestStart reuse:
  // simulate channel closed by setting session state via suspend then sync.
  session.suspend?.();
  drv.syncForRide({
    ride: { id: RIDE_A, status: "in_progress", vehicleId: VEHICLE_A },
    trackingSessionId: TRK_A,
  });
  await sleep(200);

  record(
    "reconnect-retains-authoritative-av",
    drv._getSyncedAssignmentVersion?.() === serverAv &&
      drv._getSessionForTest?.()?.getState?.()?.assignmentVersion === serverAv
      ? "PASS"
      : "FAIL",
    `synced=${drv._getSyncedAssignmentVersion?.()} sessionAv=${drv._getSessionForTest?.()?.getState?.()?.assignmentVersion} state=${drv.getState?.()?.state}`
  );
  await drv.stop({ closeRemote: false });
}

async function testInFlightStartSurvivesAvEstablish() {
  console.log("\n=== In-flight start remains valid when AV establishes ===\n");
  let resolveOffer;
  const gate = new Promise((r) => {
    resolveOffer = r;
  });
  const serverAv = rideAv(VEHICLE_A, "ast_inflight");
  let staleAborts = 0;

  const drv = createDriverP2pController({
    RTCPeerConnection: MockRTCPeerConnection,
    ensureIceConfiguration: async () => {},
    createRidePeerOfferClient: async (payload) => {
      await gate;
      return { assignmentVersion: serverAv, sessionId: payload.peerSessionId };
    },
    closeRidePeerSessionClient: async () => {},
    watchRidePeerSession: () => () => {},
  });

  drv.syncForRide({
    ride: { id: RIDE_A, status: "in_progress", vehicleId: VEHICLE_A },
    trackingSessionId: TRK_A,
  });
  await sleep(50);
  const sessionDuring = drv._getSessionForTest?.();
  resolveOffer();
  await sleep(200);

  staleAborts = drv.getCounters?.()?.staleAborts || 0;
  record(
    "inflight-start-survives-authoritative-av-sync",
    drv._getSessionForTest?.() === sessionDuring &&
      staleAborts === 0 &&
      drv._getSyncedAssignmentVersion?.() === serverAv &&
      String(drv.getState?.()?.state) !== P2P_STATE.CLOSED
      ? "PASS"
      : "FAIL",
    `sameSession=${drv._getSessionForTest?.() === sessionDuring} staleAborts=${staleAborts} synced=${drv._getSyncedAssignmentVersion?.()} state=${drv.getState?.()?.state}`
  );
  await drv.stop({ closeRemote: false });
}

async function main() {
  console.log("\n=== STAGE 3 — assignment identity stability ===\n");
  await testBootstrapThenResyncStable();
  await testPresenceAndSnapshotResyncNoRotation();
  await testGenuineAvChangeInvalidates();
  await testRideAToRideBRaceSafe();
  await testLateServerACannotMutateB();
  await testReconnectRetainsAuthoritativeAv();
  await testInFlightStartSurvivesAvEstablish();

  const pass = results.filter((r) => r.status === "PASS").length;
  const fail = results.filter((r) => r.status === "FAIL").length;
  const summary = {
    stage: 3,
    suite: "assignment-identity-stability",
    generatedAt: new Date().toISOString(),
    pass,
    fail,
    results,
  };
  fs.writeFileSync(OUT, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`\nStage 3 assignment identity: ${pass} PASS / ${fail} FAIL`);
  console.log(`Wrote ${OUT}\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
