/**
 * Stage 2 — explicit ACK semantics (loc vs hb transport response).
 *
 * Run: node tests/stage2-ack-semantics.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createP2pPeerSession as createDriverPeerSession } from "../driver-app/js/p2p-peer-session.mjs";
import { createP2pPeerSession as createCustomerPeerSession } from "../customer-app/js/p2p-peer-session.mjs";
import {
  buildP2pAckMessage,
  buildP2pHbMessage,
  P2P_ACK_KIND,
} from "../customer-app/js/p2p-location-envelope.mjs";
import {
  CHECKPOINT_POLICY,
  P2P_SPARSE_ENTER_HYSTERESIS_MS,
  VIEWER_LEASE,
  createCheckpointPolicyController,
} from "../driver-app/js/location-checkpoint-policy.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "tests", "stage2-ack-semantics-results.json");

const FIXED_NOW = 3_000_000;
const PEER_SESSION_ID = "ps_stg2ack01ab";
const TRACKING_SESSION_ID = "trk_stg2_ack";
const AV = 42;

const results = [];
function record(name, status, detail = "") {
  results.push({ name, status, detail });
  console.log(`${status === "PASS" ? "✓" : "✗"} ${name} — ${status}${detail ? `: ${detail}` : ""}`);
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

function wireBidirectionalChannel(driverSession, customerSession) {
  driverSession._setChannelOpenForTest(true, (payload) => {
    customerSession._handleMessageForTest(
      String(payload),
      customerSession.getState().generation
    );
  });
  customerSession._setChannelOpenForTest(true, (payload) => {
    driverSession._handleMessageForTest(String(payload), driverSession.getState().generation);
  });
}

async function pairSessions() {
  const driver = createDriverPeerSession({
    role: "driver",
    RTCPeerConnection: MockRTCPeerConnection,
    ensureIceConfiguration: async () => {},
    nowMs: () => FIXED_NOW,
  });
  const customer = createCustomerPeerSession({
    role: "customer",
    RTCPeerConnection: MockRTCPeerConnection,
    ensureIceConfiguration: async () => {},
    nowMs: () => FIXED_NOW,
    onLocationFix: () => {},
  });
  await driver.startAsDriver({
    peerSessionId: PEER_SESSION_ID,
    trackingSessionId: TRACKING_SESSION_ID,
    assignmentVersion: AV,
  });
  await customer.startAsCustomer({
    peerSessionId: PEER_SESSION_ID,
    trackingSessionId: TRACKING_SESSION_ID,
    assignmentVersion: AV,
  });
  wireBidirectionalChannel(driver, customer);
  return { driver, customer };
}

async function testValidLocAckHealthy() {
  const { driver, customer } = await pairSessions();
  driver.enqueueLocationFix({
    lat: 24.86,
    lng: 67.0,
    observedAt: FIXED_NOW,
    accuracyM: 10,
  });
  driver._flushPendingForTest();
  driver.evaluateHealth();

  const custFixes = customer.getCounters().fixesReceived;
  const drv = driver.getState();
  record(
    "valid-loc-loc-ack-establishes-loc-delivery",
    custFixes >= 1 && drv.isLocDeliveryHealthy ? "PASS" : "FAIL",
    `custFixes=${custFixes} locHealthy=${drv.isLocDeliveryHealthy} locAcks=${driver.getCounters().acknowledgementsReceived}`
  );
  await driver.close();
  await customer.close();
}

async function testRejectedLocHbNotLocHealthy() {
  const { driver, customer } = await pairSessions();
  driver.enqueueLocationFix({
    lat: 24.86,
    lng: 67.0,
    observedAt: FIXED_NOW - 60_000,
    accuracyM: 10,
  });
  driver._flushPendingForTest();

  const hbBuilt = buildP2pHbMessage({
    peerSessionId: PEER_SESSION_ID,
    trackingSessionId: TRACKING_SESSION_ID,
    assignmentVersion: AV,
    sequence: 1,
    role: "driver",
  });
  customer._handleMessageForTest(hbBuilt.serialized, customer.getState().generation);
  driver.evaluateHealth();

  const st = driver.getState();
  const falseHealth =
    !st.isLocDeliveryHealthy &&
    customer.getCounters().fixesReceived === 0 &&
    driver.getCounters().acks >= 1;
  record(
    "rejected-loc-then-hb-response-not-loc-healthy",
    falseHealth ? "PASS" : "FAIL",
    `locHealthy=${st.isLocDeliveryHealthy} custFixes=${customer.getCounters().fixesReceived} locAcks=${driver.getCounters().acknowledgementsReceived}`
  );
  await driver.close();
  await customer.close();
}

async function testHbAloneTransportNotLocHealthy() {
  const driver = createDriverPeerSession({
    role: "driver",
    RTCPeerConnection: MockRTCPeerConnection,
    ensureIceConfiguration: async () => {},
    nowMs: () => FIXED_NOW,
  });
  await driver.startAsDriver({
    peerSessionId: "ps_stg2hb01ab",
    trackingSessionId: TRACKING_SESSION_ID,
    assignmentVersion: AV,
  });
  driver._setChannelOpenForTest(true);
  const hb = buildP2pHbMessage({
    peerSessionId: "ps_stg2hb01ab",
    trackingSessionId: TRACKING_SESSION_ID,
    assignmentVersion: AV,
    sequence: 0,
    role: "customer",
  });
  driver._handleMessageForTest(hb.serialized, driver.getState().generation);
  driver.evaluateHealth();
  const st = driver.getState();
  record(
    "hb-alone-transport-alive-not-loc-healthy",
    st.isTransportAlive && !st.isLocDeliveryHealthy ? "PASS" : "FAIL",
    `transport=${st.isTransportAlive} locHealthy=${st.isLocDeliveryHealthy}`
  );
  await driver.close();
}

async function testLegacyUntypedAckNotLocHealthy() {
  const driver = createDriverPeerSession({
    role: "driver",
    RTCPeerConnection: MockRTCPeerConnection,
    ensureIceConfiguration: async () => {},
    nowMs: () => FIXED_NOW,
  });
  await driver.startAsDriver({
    peerSessionId: "ps_stg2leg01ab",
    trackingSessionId: TRACKING_SESSION_ID,
    assignmentVersion: AV,
  });
  driver._setChannelOpenForTest(true);
  driver.enqueueLocationFix({ lat: 1, lng: 2, observedAt: FIXED_NOW });
  driver._flushPendingForTest();
  const st0 = driver.getState();
  const gen = st0.generation;
  const legacyAck = {
    v: 1,
    type: "ack",
    peerSessionId: st0.peerSessionId,
    trackingSessionId: TRACKING_SESSION_ID,
    assignmentVersion: AV,
    seq: 1,
    observedAt: FIXED_NOW,
    role: "customer",
  };
  driver._handleMessageForTest(JSON.stringify(legacyAck), gen);
  driver.evaluateHealth();
  const st = driver.getState();
  record(
    "legacy-untyped-ack-not-loc-delivery-healthy",
    !st.isLocDeliveryHealthy && st.isTransportAlive ? "PASS" : "FAIL",
    `locHealthy=${st.isLocDeliveryHealthy} locAcks=${driver.getCounters().acknowledgementsReceived}`
  );
  await driver.close();
}

async function testLocAckTrustStillRejectsBadSeq() {
  const session = createDriverPeerSession({
    role: "driver",
    RTCPeerConnection: MockRTCPeerConnection,
    ensureIceConfiguration: async () => {},
    nowMs: () => FIXED_NOW,
  });
  await session.startAsDriver({
    peerSessionId: "ps_stg2tr01ab",
    trackingSessionId: TRACKING_SESSION_ID,
    assignmentVersion: AV,
  });
  session._setChannelOpenForTest(true);
  session.enqueueLocationFix({ lat: 1, lng: 2, observedAt: FIXED_NOW });
  session._flushPendingForTest();
  const st = session.getState();
  const gen = st.generation;
  const mkAck = (seq, ackKind = P2P_ACK_KIND.LOC) => {
    const built = buildP2pAckMessage({
      peerSessionId: st.peerSessionId,
      trackingSessionId: TRACKING_SESSION_ID,
      assignmentVersion: AV,
      sequence: seq,
      ackKind,
    });
    return JSON.parse(built.serialized);
  };
  session._handleMessageForTest(JSON.stringify({ ...mkAck(99), type: "ack", seq: 99 }), gen);
  session._handleMessageForTest(JSON.stringify({ ...mkAck(1), type: "ack", seq: 1 }), gen);
  session._handleMessageForTest(JSON.stringify({ ...mkAck(1), type: "ack", seq: 1 }), gen);
  session._handleMessageForTest(JSON.stringify({ ...mkAck(2), type: "ack", seq: 2 }), gen);
  const invalid = session.getCounters().invalidMessages;
  record(
    "loc-ack-trust-rejects-future-duplicate-unsent",
    invalid >= 3 ? "PASS" : "FAIL",
    `invalidMessages=${invalid}`
  );
  await session.close();
}

async function testCustomerAcceptedLocRenders() {
  let rendered = null;
  const customer = createCustomerPeerSession({
    role: "customer",
    RTCPeerConnection: MockRTCPeerConnection,
    ensureIceConfiguration: async () => {},
    nowMs: () => FIXED_NOW,
    onLocationFix: (fix) => {
      rendered = fix;
    },
  });
  const driver = createDriverPeerSession({
    role: "driver",
    RTCPeerConnection: MockRTCPeerConnection,
    ensureIceConfiguration: async () => {},
    nowMs: () => FIXED_NOW,
  });
  await driver.startAsDriver({
    peerSessionId: "ps_stg2rnd01ab",
    trackingSessionId: TRACKING_SESSION_ID,
    assignmentVersion: AV,
  });
  await customer.startAsCustomer({
    peerSessionId: "ps_stg2rnd01ab",
    trackingSessionId: TRACKING_SESSION_ID,
    assignmentVersion: AV,
  });
  wireBidirectionalChannel(driver, customer);
  driver.enqueueLocationFix({ lat: 24.9, lng: 67.1, observedAt: FIXED_NOW, accuracyM: 8 });
  driver._flushPendingForTest();
  record(
    "customer-accepted-loc-still-renders",
    rendered?.lat === 24.9 && customer.getCounters().fixesReceived >= 1 ? "PASS" : "FAIL",
    `rendered=${rendered?.lat} recv=${customer.getCounters().fixesReceived}`
  );
  await driver.close();
  await customer.close();
}

async function testCheckpointResponsiveWhenTransportOnly() {
  let t = FIXED_NOW;
  const policy = createCheckpointPolicyController({ nowMs: () => t });
  policy.setActiveRide({ rideId: "ride_cp", status: "in_progress", active: true });
  policy.setViewerLease(VIEWER_LEASE.EXPIRED);

  policy.setP2pHealthy(false);
  let decision = policy.currentDecision();
  record(
    "checkpoint-responsive-when-not-loc-healthy",
    decision.intervalMs === 4_000 && decision.hardInterval === false ? "PASS" : "FAIL",
    `${decision.policy}@${decision.intervalMs} hard=${decision.hardInterval}`
  );

  policy.setP2pHealthy(true);
  t += P2P_SPARSE_ENTER_HYSTERESIS_MS + 1;
  decision = policy.currentDecision();
  record(
    "checkpoint-sparse-only-after-explicit-loc-healthy-hysteresis",
    decision.policy === CHECKPOINT_POLICY.P2P_SPARSE_TRIP ? "PASS" : "FAIL",
    `${decision.policy}@${decision.intervalMs}`
  );
}

async function main() {
  console.log("\n=== STAGE 2 — ACK semantics (loc vs hb) ===\n");
  await testValidLocAckHealthy();
  await testRejectedLocHbNotLocHealthy();
  await testHbAloneTransportNotLocHealthy();
  await testLegacyUntypedAckNotLocHealthy();
  await testLocAckTrustStillRejectsBadSeq();
  await testCustomerAcceptedLocRenders();
  await testCheckpointResponsiveWhenTransportOnly();

  const pass = results.filter((r) => r.status === "PASS").length;
  const fail = results.filter((r) => r.status === "FAIL").length;
  const summary = {
    stage: 2,
    suite: "ack-semantics",
    generatedAt: new Date().toISOString(),
    pass,
    fail,
    results,
  };
  fs.writeFileSync(OUT, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`\nStage 2 ACK semantics: ${pass} PASS / ${fail} FAIL`);
  console.log(`Wrote ${OUT}\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
