/**
 * Stage 4 — failed send must retry newest pending fix (bounded).
 *
 * Proves: when channel.send fails and no new GPS arrives, the retained
 * pending fix is automatically retried within a bounded delay.
 *
 * Run: node tests/stage4-failed-send-retry.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createP2pPeerSession } from "../driver-app/js/p2p-peer-session.mjs";
import {
  P2P_BACKPRESSURE_FLUSH_MS,
  P2P_SEND_FAILURE_RETRY_MS,
  P2P_SEND_INTERVAL_MS,
} from "../driver-app/js/p2p-protocol.mjs";
import { buildP2pAckMessage } from "../customer-app/js/p2p-location-envelope.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "tests/stage4-failed-send-retry-results.json");

const results = [];
function record(name, status, detail = "") {
  results.push({ name, status, detail });
  console.log(`${status === "PASS" ? "✓" : "✗"} ${name} — ${status}${detail ? `: ${detail}` : ""}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseLocLat(payload) {
  try {
    return Number(JSON.parse(payload).lat);
  } catch {
    return NaN;
  }
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

async function createOpenDriverSession() {
  const session = createP2pPeerSession({
    role: "driver",
    RTCPeerConnection: MockRTCPeerConnection,
    ensureIceConfiguration: async () => {},
  });
  await session.startAsDriver({
    peerSessionId: "ps_retry01abcdef",
    trackingSessionId: "trk_retry",
    assignmentVersion: 42,
  });
  session.syncAssignmentVersion(42);
  session._setChannelOpenForTest(true);
  return session;
}

async function testFailedSendRetriesWithoutNewGps() {
  let attempts = 0;
  const sent = [];
  const session = await createOpenDriverSession();
  session._setChannelOpenForTest(true, (payload) => {
    attempts += 1;
    if (attempts === 1) throw new Error("send_fail");
    sent.push(payload);
  });

  session.enqueueLocationFix({ lat: 24.86, lng: 67.0, observedAt: Date.now() });
  await sleep(30);
  const afterFirst = session.getCounters().fixesSent;

  await sleep(P2P_SEND_FAILURE_RETRY_MS + 250);
  const afterRetry = session.getCounters().fixesSent;
  const lat = sent.length ? parseLocLat(sent[0]) : NaN;

  record(
    "failed-send-retries-without-new-gps",
    afterFirst === 0 && afterRetry === 1 && lat === 24.86 ? "PASS" : "FAIL",
    `afterFirst=${afterFirst} afterRetry=${afterRetry} attempts=${attempts} lat=${lat}`
  );
  await session.close();
}

async function testRetrySendsNewestCoalescedFix() {
  let attempts = 0;
  const sent = [];
  const session = await createOpenDriverSession();
  session._setChannelOpenForTest(true, (payload) => {
    attempts += 1;
    if (attempts === 1) throw new Error("send_fail");
    sent.push(payload);
  });

  session.enqueueLocationFix({ lat: 24.86, lng: 67.0, observedAt: Date.now() });
  session.enqueueLocationFix({ lat: 24.861, lng: 67.001, observedAt: Date.now() + 1 });
  await sleep(P2P_SEND_FAILURE_RETRY_MS + 250);

  const lat = sent.length ? parseLocLat(sent[0]) : NaN;
  record(
    "retry-sends-newest-coalesced-fix",
    session.getCounters().fixesSent === 1 && lat === 24.861 ? "PASS" : "FAIL",
    `fixesSent=${session.getCounters().fixesSent} lat=${lat} coalesces=${session.getCounters().pendingCoalesces}`
  );
  await session.close();
}

async function testCloseCancelsPendingRetry() {
  let attempts = 0;
  const session = await createOpenDriverSession();
  session._setChannelOpenForTest(true, () => {
    attempts += 1;
    if (attempts === 1) throw new Error("send_fail");
  });

  session.enqueueLocationFix({ lat: 24.86, lng: 67.0, observedAt: Date.now() });
  await sleep(20);
  await session.close();
  await sleep(P2P_SEND_FAILURE_RETRY_MS + 250);

  record(
    "close-cancels-pending-retry",
    session.getCounters().fixesSent === 0 && attempts === 1 ? "PASS" : "FAIL",
    `fixesSent=${session.getCounters().fixesSent} attempts=${attempts}`
  );
}

async function testGenerationBumpCancelsStaleRetry() {
  let attempts = 0;
  const sent = [];
  const session = await createOpenDriverSession();
  session._setChannelOpenForTest(true, (payload) => {
    attempts += 1;
    if (attempts === 1) throw new Error("send_fail");
    sent.push(payload);
  });

  session.enqueueLocationFix({ lat: 24.86, lng: 67.0, observedAt: Date.now() });
  await sleep(20);
  await session.startAsDriver({
    peerSessionId: "ps_retry02abcdef",
    trackingSessionId: "trk_retry_b",
    assignmentVersion: 43,
  });
  session.syncAssignmentVersion(43);
  session._setChannelOpenForTest(true, (payload) => sent.push(payload));
  await sleep(P2P_SEND_FAILURE_RETRY_MS + 250);

  record(
    "generation-bump-cancels-stale-retry",
    attempts === 1 && sent.length === 0 ? "PASS" : "FAIL",
    `attempts=${attempts} sent=${sent.length}`
  );
  await session.close();
}

async function testBackpressureStillDefersSend() {
  const sent = [];
  const session = await createOpenDriverSession();
  session._setChannelOpenForTest(true, (payload) => sent.push(payload), {
    bufferedAmount: 128 * 1024,
  });

  session.enqueueLocationFix({ lat: 24.86, lng: 67.0, observedAt: Date.now() });
  await sleep(30);

  record(
    "backpressure-still-defers-send",
    sent.length === 0 && session.getCounters().backpressureCoalesces >= 0 ? "PASS" : "FAIL",
    `sent=${sent.length} backpressureCoalesces=${session.getCounters().backpressureCoalesces}`
  );

  session._setChannelOpenForTest(true, (payload) => sent.push(payload), {
    bufferedAmount: 0,
  });
  session._flushPendingForTest();
  await sleep(20);
  record(
    "backpressure-flush-still-delivers",
    session.getCounters().fixesSent === 1 ? "PASS" : "FAIL",
    `fixesSent=${session.getCounters().fixesSent}`
  );
  await session.close();
}

async function testAckValidationUnchangedAfterRetry() {
  const session = await createOpenDriverSession();
  let attempts = 0;
  session._setChannelOpenForTest(true, () => {
    attempts += 1;
    if (attempts === 1) throw new Error("send_fail");
  });

  session.enqueueLocationFix({ lat: 24.86, lng: 67.0, observedAt: Date.now() });
  await sleep(P2P_SEND_FAILURE_RETRY_MS + 250);

  const st = session.getState();
  const futureAck = buildP2pAckMessage({
    peerSessionId: st.peerSessionId,
    trackingSessionId: st.trackingSessionId,
    assignmentVersion: st.assignmentVersion,
    sequence: 99,
  }).message;

  session._handleMessageForTest(JSON.stringify(futureAck), st.generation);
  record(
    "ack-validation-rejects-future-sequence",
    session.getCounters().invalidMessages >= 1 ? "PASS" : "FAIL",
    `invalid=${session.getCounters().invalidMessages}`
  );

  const validAck = buildP2pAckMessage({
    peerSessionId: st.peerSessionId,
    trackingSessionId: st.trackingSessionId,
    assignmentVersion: st.assignmentVersion,
    sequence: 1,
  }).message;
  session._handleMessageForTest(JSON.stringify(validAck), st.generation);
  record(
    "ack-validation-accepts-sent-sequence",
    session.getCounters().acks >= 1 ? "PASS" : "FAIL",
    `acks=${session.getCounters().acks}`
  );
  await session.close();
}

function testStaticSendFailureRetry() {
  const src = fs.readFileSync(path.join(ROOT, "driver-app/js/p2p-peer-session.mjs"), "utf8");
  const proto = fs.readFileSync(path.join(ROOT, "driver-app/js/p2p-protocol.mjs"), "utf8");
  record(
    "static-scheduleSendFailureRetry",
    /function scheduleSendFailureRetry/.test(src) ? "PASS" : "FAIL"
  );
  record(
    "static-send-failure-retry-constant",
    /P2P_SEND_FAILURE_RETRY_MS/.test(proto) ? "PASS" : "FAIL"
  );
  record(
    "static-cadence-half-interval-preserved",
    src.includes("P2P_MIN_LOC_GAP_MS") &&
      proto.includes("P2P_MIN_LOC_GAP_MS = P2P_SEND_INTERVAL_MS * 0.5")
      ? "PASS"
      : "FAIL",
    `intervalMs=${P2P_SEND_INTERVAL_MS}`
  );
}

async function main() {
  console.log("\n=== STAGE 4 — failed send retry (bounded) ===\n");
  testStaticSendFailureRetry();
  await testFailedSendRetriesWithoutNewGps();
  await testRetrySendsNewestCoalescedFix();
  await testCloseCancelsPendingRetry();
  await testGenerationBumpCancelsStaleRetry();
  await testBackpressureStillDefersSend();
  await testAckValidationUnchangedAfterRetry();

  const pass = results.filter((r) => r.status === "PASS").length;
  const fail = results.filter((r) => r.status === "FAIL").length;
  const summary = {
    stage: 4,
    area: "failed-send-retry",
    generatedAt: new Date().toISOString(),
    retryDelayMs: P2P_SEND_FAILURE_RETRY_MS,
    pass,
    fail,
    results,
  };
  fs.writeFileSync(OUT, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`\nStage 4 failed send retry: ${pass} PASS / ${fail} FAIL`);
  console.log(`Wrote ${OUT}\n`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
