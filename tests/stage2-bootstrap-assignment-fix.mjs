/**
 * Stage 2 — initial assignmentVersion bootstrap fix regression.
 *
 * Run: node tests/stage2-bootstrap-assignment-fix.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createDriverP2pController } from "../driver-app/js/p2p-ride-controller.mjs";
import { createCustomerP2pController } from "../customer-app/js/p2p-ride-controller.mjs";
import {
  buildP2pLocationMessage,
  validateP2pMessage,
} from "../customer-app/js/p2p-location-envelope.mjs";

const require = createRequire(import.meta.url);
const {
  assignmentVersionFromRide,
  createRidePeerOffer,
} = require("../functions/ride-peer-session.js");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "tests/stage2-bootstrap-assignment-fix-results.json");

const DRIVER_UID = "drv_stage2_boot";
const CUSTOMER_UID = "cust_stage2_boot";
const RIDE_ID = "ride_stage2_boot";
const VEHICLE_ID = "veh_stage2_boot";
const TRACKING_SESSION_ID = "trk_stage2_boot";
const OFFER_SDP = "v=0\r\no=- stage2 offer\r\n";

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

function createMockDb(rideData) {
  const rides = new Map([[RIDE_ID, rideData]]);
  const sessions = new Map();
  return {
    collection(name) {
      return {
        doc(id) {
          return {
            async get() {
              if (name === "rides") {
                const data = rides.get(id);
                return data ? { exists: true, data: () => data } : { exists: false };
              }
              return { exists: false };
            },
            async set(payload) {
              if (name === "ridePeerSessions") sessions.set(id, payload);
            },
          };
        },
      };
    },
  };
}

function baseRide() {
  return {
    driverId: DRIVER_UID,
    userId: CUSTOMER_UID,
    vehicleId: VEHICLE_ID,
    status: "in_progress",
  };
}

function strictOfferClient(rideData) {
  return async (payload) => {
    const db = createMockDb(rideData);
    return createRidePeerOffer(db, {
      driverUid: DRIVER_UID,
      rideId: payload.rideId,
      offerSdp: payload.offerSdp,
      trackingSessionId: payload.trackingSessionId,
      peerSessionId: payload.peerSessionId,
      vehicleId: payload.vehicleId,
      assignmentVersion: payload.assignmentVersion,
    });
  };
}

function createSignalingHub(serverAv) {
  const docs = new Map();
  const customerWatches = new Map();
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
      const db = createMockDb(baseRide());
      const res = await createRidePeerOffer(db, {
        driverUid: DRIVER_UID,
        rideId: payload.rideId,
        offerSdp: payload.offerSdp,
        trackingSessionId: payload.trackingSessionId,
        peerSessionId: payload.peerSessionId,
        vehicleId: payload.vehicleId,
        assignmentVersion: payload.assignmentVersion,
      });
      const doc = {
        sessionId: payload.peerSessionId,
        offer: payload.offerSdp,
        trackingSessionId: payload.trackingSessionId,
        assignmentVersion: serverAv,
        state: "offered",
      };
      docs.set(payload.rideId, doc);
      notify(customerWatches, payload.rideId, doc);
      return res;
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
    watchForCustomer: (rideId, onData) => {
      if (!customerWatches.has(rideId)) customerWatches.set(rideId, new Set());
      customerWatches.get(rideId).add(onData);
      const doc = docs.get(rideId);
      if (doc?.offer) onData(doc);
      return () => customerWatches.get(rideId)?.delete(onData);
    },
    watchForDriver: (rideId, onData) => {
      if (!driverWatches.has(rideId)) driverWatches.set(rideId, new Set());
      driverWatches.get(rideId).add(onData);
      const doc = docs.get(rideId);
      if (doc?.answer) onData(doc);
      return () => driverWatches.get(rideId)?.delete(onData);
    },
    closeRidePeerSessionClient: async () => {},
  };
}

async function testInitialOfferBootstrap() {
  console.log("\n=== Initial offer bootstrap (strict server) ===\n");
  const ride = baseRide();
  const serverAv = assignmentVersionFromRide(ride);
  let captured = null;

  const drv = createDriverP2pController({
    RTCPeerConnection: MockRTCPeerConnection,
    ensureIceConfiguration: async () => {},
    createRidePeerOfferClient: async (payload) => {
      captured = { ...payload };
      return strictOfferClient(ride)(payload);
    },
    closeRidePeerSessionClient: async () => {},
    watchRidePeerSession: () => () => {},
  });

  drv.syncForRide({
    ride: { id: RIDE_ID, status: "in_progress", vehicleId: VEHICLE_ID, driverId: DRIVER_UID },
    trackingSessionId: TRACKING_SESSION_ID,
  });
  await sleep(200);

  const sentAv = Math.floor(Number(captured?.assignmentVersion) || 0);
  record(
    "initial-unknown-does-not-send-1-to-server",
    sentAv !== 1 && captured?.assignmentVersion == null ? "PASS" : "FAIL",
    `payloadAv=${String(captured?.assignmentVersion)}`
  );
  record(
    "first-strict-server-offer-succeeds",
    (drv.getCounters?.()?.offerPublishFailures || 0) === 0 &&
      drv._getControllerAssignmentVersion?.() === serverAv
      ? "PASS"
      : "FAIL",
    `ctrlAv=${drv._getControllerAssignmentVersion?.()} serverAv=${serverAv}`
  );
  record(
    "session-synced-authoritative-assignmentVersion",
    drv._getSessionForTest?.()?.getState?.()?.assignmentVersion === serverAv ? "PASS" : "FAIL",
    `sessionAv=${drv._getSessionForTest?.()?.getState?.()?.assignmentVersion}`
  );
  record(
    "loc-delivery-not-healthy-before-authoritative-av",
    !drv._getSessionForTest?.()?.getState?.()?.isLocDeliveryHealthy ? "PASS" : "FAIL",
    "checked pre-LOC via session state after bootstrap"
  );

  await drv.stop({ closeRemote: false });
}

async function testFirstLocAndCustomerAcceptance() {
  console.log("\n=== First LOC + customer acceptance ===\n");
  const ride = baseRide();
  const serverAv = assignmentVersionFromRide(ride);
  const hub = createSignalingHub(serverAv);
  let renders = [];

  const cust = createCustomerP2pController({
    RTCPeerConnection: MockRTCPeerConnection,
    ensureIceConfiguration: async () => {},
    onRenderFix: (fix) => renders.push(fix),
    publishRidePeerAnswerClient: hub.publishRidePeerAnswerClient,
    closeRidePeerSessionClient: hub.closeRidePeerSessionClient,
    watchRidePeerSession: (r, od) => hub.watchForCustomer(r, od),
  });

  const drv = createDriverP2pController({
    RTCPeerConnection: MockRTCPeerConnection,
    ensureIceConfiguration: async () => {},
    createRidePeerOfferClient: hub.createRidePeerOfferClient,
    closeRidePeerSessionClient: hub.closeRidePeerSessionClient,
    watchRidePeerSession: (r, od) => hub.watchForDriver(r, od),
  });

  const rideDoc = { id: RIDE_ID, status: "in_progress", vehicleId: VEHICLE_ID };
  cust.syncForRide(rideDoc, { isVisible: true });
  drv.syncForRide({ ride: rideDoc, trackingSessionId: TRACKING_SESSION_ID });
  await sleep(200);

  const driverSession = drv._getSessionForTest?.();
  const customerSession = cust._getSessionForTest?.();
  if (!driverSession || !customerSession) {
    record("first-loc-chain", "FAIL", "sessions missing");
    return;
  }

  driverSession._setChannelOpenForTest(true, (payload) => {
    customerSession._handleMessageForTest(String(payload), customerSession.getState().generation);
  });
  customerSession._setChannelOpenForTest(true, (payload) => {
    driverSession._handleMessageForTest(String(payload), driverSession.getState().generation);
  });

  drv.onLocationFix({ lat: 24.86, lng: 67.0, observedAt: Date.now(), accuracyM: 10 });
  driverSession._flushPendingForTest();
  await sleep(20);

  const built = buildP2pLocationMessage(
    { lat: 24.86, lng: 67.0, observedAt: Date.now(), accuracyM: 10 },
    {
      peerSessionId: driverSession.getState().peerSessionId,
      trackingSessionId: TRACKING_SESSION_ID,
      assignmentVersion: serverAv,
      sequence: 1,
      role: "driver",
    }
  );
  record(
    "first-loc-uses-authoritative-assignmentVersion",
    driverSession.getState().assignmentVersion === serverAv &&
      (drv.getCounters?.()?.fixesSent || 0) >= 1
      ? "PASS"
      : "FAIL",
    `sessionAv=${driverSession.getState().assignmentVersion} sent=${drv.getCounters?.()?.fixesSent || 0}`
  );
  record(
    "customer-accepts-first-loc",
    (cust.getCounters?.()?.fixesReceived || 0) >= 1 &&
      (cust.getCounters?.()?.invalidMessages || 0) === 0
      ? "PASS"
      : "FAIL",
    `recv=${cust.getCounters?.()?.fixesReceived || 0} invalid=${cust.getCounters?.()?.invalidMessages || 0}`
  );

  await drv.stop({ closeRemote: false });
  await cust.stop({ closeRemote: false });
}

async function testWrongAvStillRejected() {
  console.log("\n=== Wrong AV still rejected ===\n");
  const ride = baseRide();
  const serverAv = assignmentVersionFromRide(ride);
  let stale = false;
  try {
    await createRidePeerOffer(createMockDb(ride), {
      driverUid: DRIVER_UID,
      rideId: RIDE_ID,
      offerSdp: OFFER_SDP,
      trackingSessionId: TRACKING_SESSION_ID,
      peerSessionId: "ps_wrong_av",
      vehicleId: VEHICLE_ID,
      assignmentVersion: serverAv + 111,
    });
  } catch (err) {
    stale = err?.message === "STALE_ASSIGNMENT";
  }
  record("explicit-wrong-av-stale-assignment", stale ? "PASS" : "FAIL");

  const wrongLoc = buildP2pLocationMessage(
    { lat: 1, lng: 2, observedAt: Date.now() },
    {
      peerSessionId: "ps_testsession01",
      trackingSessionId: TRACKING_SESSION_ID,
      assignmentVersion: serverAv + 5,
      sequence: 1,
      role: "driver",
    }
  );
  const validated = validateP2pMessage(wrongLoc.serialized, {
    peerSessionId: "ps_testsession01",
    trackingSessionId: TRACKING_SESSION_ID,
    assignmentVersion: serverAv,
    expectRole: "driver",
  });
  record(
    "customer-rejects-wrong-assignment-loc",
    !validated.ok && validated.reason === "wrong_assignment" ? "PASS" : "FAIL",
    validated.reason || ""
  );
}

async function testReconnectAndRideSwitch() {
  console.log("\n=== Reconnect + ride switch ===\n");
  const ride = baseRide();
  const serverAv = assignmentVersionFromRide(ride);

  const drv = createDriverP2pController({
    RTCPeerConnection: MockRTCPeerConnection,
    ensureIceConfiguration: async () => {},
    createRidePeerOfferClient: strictOfferClient(ride),
    closeRidePeerSessionClient: async () => {},
    watchRidePeerSession: () => () => {},
  });

  drv.syncForRide({
    ride: { id: RIDE_ID, status: "in_progress", vehicleId: VEHICLE_ID },
    trackingSessionId: TRACKING_SESSION_ID,
  });
  await sleep(150);
  const avAfterBoot = drv._getControllerAssignmentVersion?.();
  drv._getSessionForTest?.()?.scheduleReconnect?.(() => {
    void drv._getSessionForTest?.()?.startAsDriver({
      trackingSessionId: TRACKING_SESSION_ID,
      assignmentVersion: avAfterBoot,
      reconnect: true,
    });
  });
  await sleep(50);
  record(
    "reconnect-preserves-authoritative-assignmentVersion",
    drv._getSessionForTest?.()?.getState?.()?.assignmentVersion === serverAv ? "PASS" : "FAIL",
    `sessionAv=${drv._getSessionForTest?.()?.getState?.()?.assignmentVersion}`
  );

  const rideBId = "ride_stage2_B";
  const rideBData = {
    driverId: DRIVER_UID,
    userId: CUSTOMER_UID,
    vehicleId: "veh_other",
    status: "in_progress",
  };
  const serverAvB = assignmentVersionFromRide(rideBData);
  let capturedB = null;
  const drv2 = createDriverP2pController({
    RTCPeerConnection: MockRTCPeerConnection,
    ensureIceConfiguration: async () => {},
    createRidePeerOfferClient: async (payload) => {
      capturedB = payload;
      const db = {
        collection(name) {
          return {
            doc(id) {
              return {
                async get() {
                  if (name === "rides" && id === rideBId) {
                    return { exists: true, data: () => rideBData };
                  }
                  return { exists: false };
                },
                async set() {},
              };
            },
          };
        },
      };
      return createRidePeerOffer(db, {
        driverUid: DRIVER_UID,
        rideId: payload.rideId,
        offerSdp: payload.offerSdp,
        trackingSessionId: payload.trackingSessionId,
        peerSessionId: payload.peerSessionId,
        vehicleId: "veh_other",
        assignmentVersion: payload.assignmentVersion,
      });
    },
    closeRidePeerSessionClient: async () => {},
    watchRidePeerSession: () => () => {},
  });
  drv2.syncForRide({ ride: { id: rideBId, status: "in_progress", vehicleId: "veh_other" }, trackingSessionId: "trk_B" });
  await sleep(150);
  record(
    "ride-switch-does-not-leak-previous-assignmentVersion-on-offer",
    capturedB?.assignmentVersion == null &&
      drv2._getControllerAssignmentVersion?.() === serverAvB
      ? "PASS"
      : "FAIL",
    `payloadAv=${String(capturedB?.assignmentVersion)} ctrlAv=${drv2._getControllerAssignmentVersion?.()} expected=${serverAvB}`
  );

  await drv.stop({ closeRemote: false });
  await drv2.stop({ closeRemote: false });
}

async function main() {
  console.log("\n=== STAGE 2 — bootstrap assignmentVersion fix ===\n");
  await testInitialOfferBootstrap();
  await testFirstLocAndCustomerAcceptance();
  await testWrongAvStillRejected();
  await testReconnectAndRideSwitch();

  const pass = results.filter((r) => r.status === "PASS").length;
  const fail = results.filter((r) => r.status === "FAIL").length;
  fs.writeFileSync(
    OUT,
    `${JSON.stringify({ stage: 2, suite: "bootstrap-assignment-fix", pass, fail, results }, null, 2)}\n`
  );
  console.log(`\nStage 2 bootstrap fix: ${pass} PASS / ${fail} FAIL`);
  console.log(`Wrote ${OUT}\n`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
