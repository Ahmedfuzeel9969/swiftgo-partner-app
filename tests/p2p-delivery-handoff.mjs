/**
 * P2P-2 — OPEN-channel delivery handoff, ACK validation, fallback safety.
 * Run: npm run test:p2p-delivery-handoff
 */
import { createP2pPeerSession } from "../driver-app/js/p2p-peer-session.mjs";
import {
  buildP2pLocationMessage,
  buildP2pAckMessage,
} from "../driver-app/js/p2p-location-envelope.mjs";
import {
  P2P_CHANNEL_OPEN_TIMEOUT_MS,
  P2P_FIRST_ACK_TIMEOUT_MS,
  P2P_STATE,
} from "../driver-app/js/p2p-protocol.mjs";
import { createLiveLocationSourceArbiter } from "../customer-app/js/live-location-source-arbiter.mjs";

const results = [];
function record(name, status, detail = "") {
  results.push({ name, status, detail });
  console.log(`${status === "PASS" ? "✓" : status === "BLOCKED" ? "·" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

function createFakeTimers() {
  let now = 0;
  let nextId = 1;
  /** @type {Map<number, { fn: Function, at: number }>} */
  const scheduled = new Map();
  return {
    nowMs: () => now,
    setTimeoutFn: (fn, ms) => {
      const id = nextId++;
      scheduled.set(id, { fn, at: now + ms });
      return id;
    },
    clearTimeoutFn: (id) => {
      scheduled.delete(id);
    },
    advance(ms) {
      now += ms;
      for (const [id, task] of [...scheduled.entries()]) {
        if (task.at <= now) {
          scheduled.delete(id);
          task.fn();
        }
      }
    },
  };
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
  peerSessionId: "ps_handoff01",
  trackingSessionId: "trk_handoff",
  assignmentVersion: 7,
};

function sampleFix(lat = 24.86, lng = 67.01, observedAt = Date.now()) {
  return { lat, lng, observedAt };
}

function validLocSerialized(seq = 1, fix = sampleFix()) {
  return buildP2pLocationMessage(fix, {
    ...PEER_CTX,
    sequence: seq,
    role: "driver",
  }).serialized;
}

async function driverSession(extra = {}) {
  return createP2pPeerSession({
    role: "driver",
    RTCPeerConnection: MockRTCPeerConnection,
    onLocalDescription: async () => {},
    ...extra,
  });
}

async function customerSession(extra = {}) {
  return createP2pPeerSession({
    role: "customer",
    RTCPeerConnection: MockRTCPeerConnection,
    onLocalDescription: async () => {},
    ...extra,
  });
}

async function test1PreOpenFrameRetainedNotSent() {
  const session = await driverSession();
  await session.startAsDriver(PEER_CTX);
  session.enqueueLocationFix(sampleFix());
  const c = session.getCounters();
  return c.fixesSent === 0 && c.fixesAttempted === 0 && session._getPendingForTest() != null;
}

async function test2MultiplePreOpenCoalesced() {
  const session = await driverSession();
  await session.startAsDriver(PEER_CTX);
  session.enqueueLocationFix(sampleFix(1, 1));
  session.enqueueLocationFix(sampleFix(2, 2));
  session.enqueueLocationFix(sampleFix(3, 3));
  const c = session.getCounters();
  const pending = session._getPendingForTest();
  return (
    c.fixesSent === 0 &&
    c.fixesAttempted === 0 &&
    c.pendingCoalesces === 2 &&
    pending?.lat === 3 &&
    pending?.lng === 3
  );
}

async function test3OpenFlushesLatestOnce() {
  const session = await driverSession();
  await session.startAsDriver(PEER_CTX);
  session.enqueueLocationFix(sampleFix(1, 1));
  session.enqueueLocationFix(sampleFix(9, 9));
  session._setChannelOpenForTest(true);
  const c = session.getCounters();
  return c.fixesAttempted === 1 && c.fixesSent === 1 && session._getPendingForTest() == null;
}

async function test4AssignmentChangeDiscardsPending() {
  const session = await driverSession();
  await session.startAsDriver(PEER_CTX);
  session.enqueueLocationFix(sampleFix());
  await session.startAsDriver({ ...PEER_CTX, peerSessionId: "ps_handoff02", assignmentVersion: 8 });
  session._setChannelOpenForTest(true);
  const c = session.getCounters();
  return c.fixesSent === 0 && c.fixesAttempted === 0;
}

async function test5NeverSendUnlessOpen() {
  const session = await driverSession();
  await session.startAsDriver(PEER_CTX);
  let sendCalls = 0;
  session._setChannelForTest({
    readyState: "connecting",
    bufferedAmount: 0,
    send: () => {
      sendCalls += 1;
    },
    close: () => {},
  });
  session.enqueueLocationFix(sampleFix());
  session._flushPendingForTest();
  session._setChannelForTest({
    readyState: "closed",
    bufferedAmount: 0,
    send: () => {
      sendCalls += 1;
    },
    close: () => {},
  });
  session._flushPendingForTest();
  return sendCalls === 0 && session.getCounters().fixesSent === 0;
}

async function test6OpenSendIncrementsSent() {
  const session = await driverSession();
  await session.startAsDriver(PEER_CTX);
  session._setChannelOpenForTest(true);
  session.enqueueLocationFix(sampleFix());
  const c = session.getCounters();
  return c.fixesAttempted === 1 && c.fixesSent === 1;
}

async function test7SendThrowFailureRecoverable() {
  const session = await driverSession();
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
  return c.fixesSent === 0 && c.sendFailures === 1 && c.healthySessions === 0 && session._getPendingForTest() != null;
}

async function test8BackpressureCoalesceAndFlush() {
  const timers = createFakeTimers();
  let buffered = 128 * 1024;
  const session = createP2pPeerSession({
    role: "driver",
    RTCPeerConnection: MockRTCPeerConnection,
    onLocalDescription: async () => {},
    ...timers,
  });
  await session.startAsDriver(PEER_CTX);
  session._setChannelForTest({
    readyState: "open",
    get bufferedAmount() {
      return buffered;
    },
    send: () => {},
    close: () => {},
  });
  session.enqueueLocationFix(sampleFix(1, 1));
  session.enqueueLocationFix(sampleFix(2, 2));
  const mid = session.getCounters();
  buffered = 0;
  timers.advance(600);
  const after = session.getCounters();
  return (
    mid.fixesSent === 0 &&
    mid.backpressureCoalesces >= 1 &&
    after.fixesSent === 1 &&
    after.fixesAttempted === 1
  );
}

async function test9ValidCustomerFrameAcked() {
  const arbiter = createLiveLocationSourceArbiter({ onRender: () => {} });
  const session = await customerSession({
    onLocationFix: (fix) => arbiter.ingestP2p(fix, arbiter.getGeneration()),
  });
  await session.startAsCustomer({
    ...PEER_CTX,
    offerSdp: "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n",
  });
  session._setChannelOpenForTest(true);
  session._handleMessageForTest(validLocSerialized(1), session.getState().generation);
  const c = session.getCounters();
  return c.fixesReceived === 1 && c.acksSent === 1 && arbiter.getCounters().p2pAccepted === 1;
}

async function test10InvalidDuplicateStaleNoRenderNoAck() {
  const arbiter = createLiveLocationSourceArbiter({ onRender: () => {} });
  const session = await customerSession({
    onLocationFix: (fix) => arbiter.ingestP2p(fix, arbiter.getGeneration()),
  });
  await session.startAsCustomer({
    ...PEER_CTX,
    offerSdp: "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n",
  });
  session._setChannelOpenForTest(true);
  session._handleMessageForTest(JSON.stringify({ type: "loc", v: 99 }), session.getState().generation);
  session._handleMessageForTest(validLocSerialized(1), session.getState().generation);
  session._handleMessageForTest(validLocSerialized(1), session.getState().generation);
  session._handleMessageForTest(
    validLocSerialized(1, sampleFix(0, 0)),
    session.getState().generation
  );
  const c = session.getCounters();
  return c.fixesReceived === 1 && c.acksSent === 1 && c.invalidMessages >= 2;
}

async function test11ValidAckHealthyOnce() {
  const session = await driverSession();
  await session.startAsDriver(PEER_CTX);
  session._setChannelOpenForTest(true);
  session.enqueueLocationFix(sampleFix());
  const ack = buildP2pAckMessage({ ...PEER_CTX, sequence: 1 });
  session._handleMessageForTest(ack.serialized, session.getState().generation);
  const c = session.getCounters();
  return c.acknowledgementsReceived === 1 && c.healthySessions === 1 && c.fixesSent === 1;
}

async function test12ForgedAckIgnored() {
  const session = await driverSession();
  await session.startAsDriver(PEER_CTX);
  session._setChannelOpenForTest(true);
  const forged = buildP2pAckMessage({ ...PEER_CTX, sequence: 99 });
  session._handleMessageForTest(forged.serialized, session.getState().generation);
  const ack = buildP2pAckMessage({ ...PEER_CTX, sequence: 1 });
  session.enqueueLocationFix(sampleFix());
  session._handleMessageForTest(ack.serialized, session.getState().generation);
  session._handleMessageForTest(ack.serialized, session.getState().generation);
  const c = session.getCounters();
  return c.healthySessions === 1 && c.acknowledgementsReceived === 1 && c.invalidMessages >= 1;
}

async function test13ChannelOpenTimeoutFallback() {
  const timers = createFakeTimers();
  const session = createP2pPeerSession({
    role: "driver",
    RTCPeerConnection: MockRTCPeerConnection,
    onLocalDescription: async () => {},
    ...timers,
  });
  await session.startAsDriver(PEER_CTX);
  timers.advance(P2P_CHANNEL_OPEN_TIMEOUT_MS + 1);
  return session.getState().state === P2P_STATE.FIREBASE_FALLBACK && session.getCounters().channelsOpened === 0;
}

async function test14AckTimeoutNoHealth() {
  const timers = createFakeTimers();
  const session = createP2pPeerSession({
    role: "driver",
    RTCPeerConnection: MockRTCPeerConnection,
    onLocalDescription: async () => {},
    ...timers,
  });
  await session.startAsDriver(PEER_CTX);
  session._setChannelOpenForTest(true);
  session.enqueueLocationFix(sampleFix());
  timers.advance(P2P_FIRST_ACK_TIMEOUT_MS + 1);
  const c = session.getCounters();
  return c.healthySessions === 0 && session.getState().state === P2P_STATE.FIREBASE_FALLBACK;
}

async function test15SessionRestartIsolated() {
  const session = await driverSession();
  await session.startAsDriver(PEER_CTX);
  session.enqueueLocationFix(sampleFix());
  await session.startAsDriver({ ...PEER_CTX, peerSessionId: "ps_handoff03" });
  session._setChannelOpenForTest(true);
  const c = session.getCounters();
  return c.sessionsStarted === 2 && c.fixesSent === 0 && session._getPendingForTest() == null;
}

async function test16CloseCleanup() {
  const timers = createFakeTimers();
  const session = createP2pPeerSession({
    role: "driver",
    RTCPeerConnection: MockRTCPeerConnection,
    onLocalDescription: async () => {},
    ...timers,
  });
  await session.startAsDriver(PEER_CTX);
  session.enqueueLocationFix(sampleFix());
  await session.close();
  timers.advance(P2P_CHANNEL_OPEN_TIMEOUT_MS + P2P_FIRST_ACK_TIMEOUT_MS);
  return session.getState().state === P2P_STATE.CLOSED && session._getPendingForTest() == null;
}

async function test17NoDuplicateReconnectLoop() {
  const session = await driverSession();
  await session.startAsDriver(PEER_CTX);
  await session.startAsDriver({ ...PEER_CTX, peerSessionId: "ps_handoff04" });
  const c = session.getCounters();
  return c.sessionsStarted === 2 && c.reconnectAttempts === 0;
}

async function test18FirebaseOnlyRideUnaffected() {
  const session = createP2pPeerSession({ role: "driver", RTCPeerConnection: null });
  await session.startAsDriver(PEER_CTX);
  session.enqueueLocationFix(sampleFix());
  return session.getState().state === P2P_STATE.FIREBASE_FALLBACK && session.getCounters().fixesSent === 0;
}

async function main() {
  record("1-pre-open-retained-not-sent", (await test1PreOpenFrameRetainedNotSent()) ? "PASS" : "FAIL");
  record("2-multiple-pre-open-coalesced", (await test2MultiplePreOpenCoalesced()) ? "PASS" : "FAIL");
  record("3-open-flushes-latest-once", (await test3OpenFlushesLatestOnce()) ? "PASS" : "FAIL");
  record("4-assignment-change-discards-pending", (await test4AssignmentChangeDiscardsPending()) ? "PASS" : "FAIL");
  record("5-never-send-unless-open", (await test5NeverSendUnlessOpen()) ? "PASS" : "FAIL");
  record("6-open-send-increments-sent", (await test6OpenSendIncrementsSent()) ? "PASS" : "FAIL");
  record("7-send-throw-recoverable", (await test7SendThrowFailureRecoverable()) ? "PASS" : "FAIL");
  record("8-backpressure-coalesce-flush", (await test8BackpressureCoalesceAndFlush()) ? "PASS" : "FAIL");
  record("9-valid-customer-frame-acked", (await test9ValidCustomerFrameAcked()) ? "PASS" : "FAIL");
  record("10-invalid-duplicate-stale-no-ack", (await test10InvalidDuplicateStaleNoRenderNoAck()) ? "PASS" : "FAIL");
  record("11-valid-ack-healthy-once", (await test11ValidAckHealthyOnce()) ? "PASS" : "FAIL");
  record("12-forged-duplicate-ack-ignored", (await test12ForgedAckIgnored()) ? "PASS" : "FAIL");
  record("13-channel-open-timeout-fallback", (await test13ChannelOpenTimeoutFallback()) ? "PASS" : "FAIL");
  record("14-ack-timeout-no-health", (await test14AckTimeoutNoHealth()) ? "PASS" : "FAIL");
  record("15-session-restart-isolated", (await test15SessionRestartIsolated()) ? "PASS" : "FAIL");
  record("16-close-complete-cleanup", (await test16CloseCleanup()) ? "PASS" : "FAIL");
  record("17-no-duplicate-reconnect-loop", (await test17NoDuplicateReconnectLoop()) ? "PASS" : "FAIL");
  record("18-firebase-only-ride-unaffected", (await test18FirebaseOnlyRideUnaffected()) ? "PASS" : "FAIL");
  record(
    "manual-two-device-p2p",
    "BLOCKED",
    "Requires physical two-browser validation after deployment"
  );

  const pass = results.filter((r) => r.status === "PASS").length;
  const fail = results.filter((r) => r.status === "FAIL").length;
  const blocked = results.filter((r) => r.status === "BLOCKED").length;
  console.log(`\nP2P delivery handoff: ${pass} PASS / ${fail} FAIL / ${blocked} BLOCKED`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
