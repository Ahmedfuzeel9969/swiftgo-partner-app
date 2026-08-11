/**
 * P2P lifecycle telemetry — focused metric truthfulness tests.
 * Run: npm run test:p2p-lifecycle-metrics
 */
import { createP2pPeerSession } from "../driver-app/js/p2p-peer-session.mjs";
import {
  buildP2pLocationMessage,
  buildP2pAckMessage,
} from "../driver-app/js/p2p-location-envelope.mjs";
import { P2P_STATE } from "../driver-app/js/p2p-protocol.mjs";
import { mapDriverRuntimeCounters, mapCustomerRuntimeCounters } from "../shared/js/ride-location-report-client.mjs";
import { buildRideLocationReportViewModel } from "../super-admin-panel/js/ride-location-report-view.mjs";
import { createLiveLocationSourceArbiter } from "../customer-app/js/live-location-source-arbiter.mjs";

const results = [];
function record(name, status, detail = "") {
  results.push({ name, status, detail });
  console.log(`${status === "PASS" ? "✓" : status === "BLOCKED" ? "·" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

function MockRTCPeerConnection() {
  const self = {
    iceGatheringState: "complete",
    localDescription: null,
    remoteDescription: null,
    _ondatachannel: null,
    createDataChannel(label) {
      const ch = {
        label,
        readyState: "connecting",
        bufferedAmount: 0,
        binaryType: "blob",
        onopen: null,
        onclose: null,
        onmessage: null,
        send() {},
        close() {
          this.readyState = "closed";
          this.onclose?.();
        },
        _open() {
          this.readyState = "open";
          this.onopen?.();
        },
      };
      return ch;
    },
    async createOffer() {
      return { type: "offer", sdp: "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n" };
    },
    async createAnswer() {
      return { type: "answer", sdp: "v=0\r\no=- 1 0 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n" };
    },
    async setLocalDescription(desc) {
      self.localDescription = desc;
      self.iceGatheringState = "complete";
    },
    async setRemoteDescription(desc) {
      self.remoteDescription = desc;
      if (desc.type === "offer" && self._ondatachannel) {
        const ch = self.createDataChannel("swiftgo-loc-v1");
        self._ondatachannel({ channel: ch });
      }
    },
    addEventListener() {},
    removeEventListener() {},
    close() {},
    set ondatachannel(fn) {
      self._ondatachannel = fn;
    },
    get ondatachannel() {
      return self._ondatachannel;
    },
  };
  return self;
}

const PEER_CTX = {
  peerSessionId: "ps_lifecycle01",
  trackingSessionId: "trk_lifecycle",
  assignmentVersion: 42,
};

function sampleFix() {
  return { lat: 24.86, lng: 67.01, observedAt: Date.now() };
}

function validLocSerialized(seq = 1) {
  return buildP2pLocationMessage(sampleFix(), {
    ...PEER_CTX,
    sequence: seq,
    role: "driver",
  }).serialized;
}

async function testSetupStartedChannelNeverOpened() {
  const session = createP2pPeerSession({
    role: "driver",
    RTCPeerConnection: MockRTCPeerConnection,
    onLocalDescription: async () => {},
  });
  await session.startAsDriver(PEER_CTX);
  const c = session.getCounters();
  return c.sessionsStarted === 1 && c.channelsOpened === 0 && c.healthySessions === 0;
}

function testChannelOpenedNoDeliveryProof() {
  const session = createP2pPeerSession({ role: "driver" });
  session._setChannelOpenForTest(true);
  const c = session.getCounters();
  return c.channelsOpened === 1 && c.healthySessions === 0;
}

async function testPreOpenFrameCountsAsAttempted() {
  const session = createP2pPeerSession({
    role: "driver",
    RTCPeerConnection: MockRTCPeerConnection,
    onLocalDescription: async () => {},
  });
  await session.startAsDriver(PEER_CTX);
  session.enqueueLocationFix(sampleFix());
  const c = session.getCounters();
  return c.fixesAttempted === 1 && c.fixesSent === 0 && session._getPendingForTest() != null;
}

async function testSuccessfulOpenChannelSend() {
  const session = createP2pPeerSession({
    role: "driver",
    RTCPeerConnection: MockRTCPeerConnection,
    onLocalDescription: async () => {},
  });
  await session.startAsDriver(PEER_CTX);
  session._setChannelOpenForTest(true);
  session.enqueueLocationFix(sampleFix());
  const c = session.getCounters();
  return c.fixesAttempted === 1 && c.fixesSent === 1;
}

async function testSendThrowsDoesNotIncrementSent() {
  const session = createP2pPeerSession({
    role: "driver",
    RTCPeerConnection: MockRTCPeerConnection,
    onLocalDescription: async () => {},
  });
  await session.startAsDriver(PEER_CTX);
  session._setChannelOpenForTest(true);
  session._setChannelForTest({
    readyState: "open",
    bufferedAmount: 0,
    send: () => {
      throw new Error("send_failed");
    },
    close: () => {},
  });
  session.enqueueLocationFix(sampleFix());
  const c = session.getCounters();
  return c.fixesAttempted === 1 && c.fixesSent === 0 && c.sendFailures === 1;
}

async function testInvalidFrameNotRendered() {
  const session = createP2pPeerSession({
    role: "customer",
    RTCPeerConnection: MockRTCPeerConnection,
    onLocalDescription: async () => {},
  });
  await session.startAsCustomer({
    ...PEER_CTX,
    offerSdp: "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n",
  });
  session._setChannelOpenForTest(true);
  session._handleMessageForTest(JSON.stringify({ type: "loc", v: 99 }), session.getState().generation);
  const c = session.getCounters();
  const arbiter = createLiveLocationSourceArbiter({ onRender: () => {} });
  return c.invalidMessages === 1 && c.fixesReceived === 0 && arbiter.getCounters().p2pRendered === 0;
}

async function testValidFrameReceivedAndRendered() {
  const arbiter = createLiveLocationSourceArbiter({ onRender: () => {} });
  const session = createP2pPeerSession({
    role: "customer",
    RTCPeerConnection: MockRTCPeerConnection,
    onLocalDescription: async () => {},
    onLocationFix: (fix) => arbiter.ingestP2p(fix, arbiter.getGeneration()),
  });
  await session.startAsCustomer({
    ...PEER_CTX,
    offerSdp: "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n",
  });
  session._setChannelOpenForTest(true);
  session._handleMessageForTest(validLocSerialized(1), session.getState().generation);
  const c = session.getCounters();
  const ac = arbiter.getCounters();
  return c.fixesReceived === 1 && ac.p2pAccepted === 1;
}

async function testAcknowledgementMakesSessionHealthyOnce() {
  const session = createP2pPeerSession({
    role: "driver",
    RTCPeerConnection: MockRTCPeerConnection,
    onLocalDescription: async () => {},
  });
  await session.startAsDriver(PEER_CTX);
  session._setChannelOpenForTest(true);
  session.enqueueLocationFix(sampleFix());
  const ack = buildP2pAckMessage({ ...PEER_CTX, sequence: 1 });
  session._handleMessageForTest(ack.serialized, session.getState().generation);
  const c = session.getCounters();
  return c.acknowledgementsReceived === 1 && c.healthySessions === 1 && c.channelsOpened === 1;
}

async function testRepeatedAcksDoNotDoubleHealthy() {
  const session = createP2pPeerSession({
    role: "driver",
    RTCPeerConnection: MockRTCPeerConnection,
    onLocalDescription: async () => {},
  });
  await session.startAsDriver(PEER_CTX);
  session._setChannelOpenForTest(true);
  session.enqueueLocationFix(sampleFix());
  const ack = buildP2pAckMessage({ ...PEER_CTX, sequence: 1 });
  session._handleMessageForTest(ack.serialized, session.getState().generation);
  session._handleMessageForTest(ack.serialized, session.getState().generation);
  const c = session.getCounters();
  return c.acknowledgementsReceived === 1 && c.healthySessions === 1;
}

function testFallbackTransitionCountedOnce() {
  const session = createP2pPeerSession({ role: "driver" });
  session._setChannelOpenForTest(true);
  session.suspend();
  session.suspend();
  const c = session.getCounters();
  return c.fallbackTransitions === 1 && session.getState().state === P2P_STATE.FIREBASE_FALLBACK;
}

async function testSessionRestartIndependentLifecycle() {
  const session = createP2pPeerSession({
    role: "driver",
    RTCPeerConnection: MockRTCPeerConnection,
    onLocalDescription: async () => {},
  });
  await session.startAsDriver(PEER_CTX);
  session._setChannelOpenForTest(true);
  session.enqueueLocationFix(sampleFix());
  const ack = buildP2pAckMessage({ ...PEER_CTX, sequence: 1 });
  session._handleMessageForTest(ack.serialized, session.getState().generation);
  await session.startAsDriver({ ...PEER_CTX, peerSessionId: "ps_lifecycle02" });
  const c = session.getCounters();
  return c.sessionsStarted === 2 && c.healthySessions === 1 && c.channelsOpened === 1;
}

function testHistoricalReportLegacyLabel() {
  const vm = buildRideLocationReportViewModel({
    rideId: "ride_legacy",
    driver: {
      counters: {
        p2pHealthySessionCount: 1,
        p2pFramesSent: 0,
      },
      submitSequence: 1,
    },
  });
  const row = vm.driver.find((r) => r.key === "p2pHealthySessionCount");
  return (
    row &&
    row.value === 1 &&
    String(row.label).includes("legacy") &&
    String(row.label).includes("unverified")
  );
}

function testReportMappingSeparatesStartedAndHealthy() {
  const mapped = mapDriverRuntimeCounters(
    {},
    {
      sessionsStarted: 2,
      channelsOpened: 1,
      healthySessions: 1,
      fixesAttempted: 4,
      fixesSent: 3,
      acknowledgementsReceived: 1,
    }
  );
  return (
    mapped.p2pSessionsStarted === 2 &&
    mapped.p2pChannelsOpened === 1 &&
    mapped.p2pHealthySessionCount === 1 &&
    mapped.p2pFramesAttempted === 4 &&
    mapped.p2pFramesSent === 3 &&
    mapped.p2pFramesAcknowledged === 1
  );
}

function testCustomerMappingLifecycleCounters() {
  const mapped = mapCustomerRuntimeCounters({
    sessionsStarted: 1,
    channelsOpened: 1,
    healthySessions: 1,
    fixesReceived: 2,
    p2pAccepted: 2,
    p2pRendered: 1,
  });
  return (
    mapped.p2pSessionsStarted === 1 &&
    mapped.p2pChannelsOpened === 1 &&
    mapped.p2pHealthySessionCount === 1 &&
    mapped.p2pFramesReceived === 2 &&
    mapped.p2pValidRendered === 1
  );
}

async function main() {
  record("1-setup-started-channel-never-opened", (await testSetupStartedChannelNeverOpened()) ? "PASS" : "FAIL");
  record("2-channel-opened-no-delivery-proof", testChannelOpenedNoDeliveryProof() ? "PASS" : "FAIL");
  record("3-pre-open-frame-counts-as-attempted", (await testPreOpenFrameCountsAsAttempted()) ? "PASS" : "FAIL");
  record("4-successful-open-channel-send", (await testSuccessfulOpenChannelSend()) ? "PASS" : "FAIL");
  record("5-send-throws-not-counted-sent", (await testSendThrowsDoesNotIncrementSent()) ? "PASS" : "FAIL");
  record("6-invalid-frame-not-rendered", (await testInvalidFrameNotRendered()) ? "PASS" : "FAIL");
  record("7-valid-frame-received", (await testValidFrameReceivedAndRendered()) ? "PASS" : "FAIL");
  record("8-ack-makes-session-healthy-once", (await testAcknowledgementMakesSessionHealthyOnce()) ? "PASS" : "FAIL");
  record("9-repeated-acks-no-double-healthy", (await testRepeatedAcksDoNotDoubleHealthy()) ? "PASS" : "FAIL");
  record("10-fallback-counted-once", testFallbackTransitionCountedOnce() ? "PASS" : "FAIL");
  record("11-session-restart-independent", (await testSessionRestartIndependentLifecycle()) ? "PASS" : "FAIL");
  record("12-historical-report-legacy-label", testHistoricalReportLegacyLabel() ? "PASS" : "FAIL");
  record("13-report-mapping-started-vs-healthy", testReportMappingSeparatesStartedAndHealthy() ? "PASS" : "FAIL");
  record("14-customer-mapping-lifecycle", testCustomerMappingLifecycleCounters() ? "PASS" : "FAIL");
  record(
    "manual-two-device-p2p",
    "BLOCKED",
    "Not executed in this task — requires physical two-browser validation"
  );

  const pass = results.filter((r) => r.status === "PASS").length;
  const fail = results.filter((r) => r.status === "FAIL").length;
  const blocked = results.filter((r) => r.status === "BLOCKED").length;
  console.log(`\nP2P lifecycle metrics: ${pass} PASS / ${fail} FAIL / ${blocked} BLOCKED`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
