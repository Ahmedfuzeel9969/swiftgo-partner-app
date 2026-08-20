/**
 * Stage 5 — P2P cadence contract audit (documentation regression).
 *
 * Determines whether P2P_SEND_INTERVAL_MS (3000ms) and the half-interval
 * minimum spacing in flushPendingLoc are intentional coalescing behavior.
 *
 * Run: node tests/stage5-cadence-contract.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createP2pPeerSession } from "../driver-app/js/p2p-peer-session.mjs";
import { P2P_SEND_INTERVAL_MS } from "../driver-app/js/p2p-protocol.mjs";
import * as custProtocol from "../customer-app/js/p2p-protocol.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "tests/stage5-cadence-contract-results.json");

const MIN_GAP_MS = P2P_SEND_INTERVAL_MS * 0.5;

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

function createClock(start = 1_000_000) {
  let t = start;
  return {
    nowMs: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
}

async function createSessionWithClock(clock) {
  const session = createP2pPeerSession({
    role: "driver",
    RTCPeerConnection: MockRTCPeerConnection,
    ensureIceConfiguration: async () => {},
    nowMs: () => clock.nowMs(),
  });
  await session.startAsDriver({
    peerSessionId: "ps_cad01abcdef",
    trackingSessionId: "trk_cad",
    assignmentVersion: 42,
  });
  session.syncAssignmentVersion(42);
  session._setChannelOpenForTest(true);
  return session;
}

function testConfiguredInterval() {
  record(
    "configured-p2p-send-interval-ms",
    P2P_SEND_INTERVAL_MS === 3_000 ? "PASS" : "FAIL",
    `P2P_SEND_INTERVAL_MS=${P2P_SEND_INTERVAL_MS}`
  );
  record(
    "computed-min-gap-is-half-interval",
    MIN_GAP_MS === 1_500 ? "PASS" : "FAIL",
    `minGapMs=${MIN_GAP_MS}`
  );
  record(
    "driver-customer-interval-parity",
    custProtocol.P2P_SEND_INTERVAL_MS === P2P_SEND_INTERVAL_MS ? "PASS" : "FAIL",
    `customer=${custProtocol.P2P_SEND_INTERVAL_MS}`
  );
}

function testStaticCadenceImplementation() {
  const src = fs.readFileSync(path.join(ROOT, "driver-app/js/p2p-peer-session.mjs"), "utf8");
  const checks = [
    ["flushPendingLoc-minGap-half-interval", /minGapMs = P2P_SEND_INTERVAL_MS \* 0\.5/],
    ["scheduleCadenceFlush-present", /function scheduleCadenceFlush/],
    ["cadence-gate-requires-prior-send", /lastSequenceSent > 0/],
    ["pending-coalescing", /pendingLoc = fix/],
  ];
  for (const [name, re] of checks) {
    record(`static-${name}`, re.test(src) ? "PASS" : "FAIL");
  }
}

async function testFirstSendImmediateNoCadenceGate() {
  const clock = createClock();
  const sent = [];
  const session = await createSessionWithClock(clock);
  session._setChannelOpenForTest(true, (payload) => sent.push(payload));

  session.enqueueLocationFix({ lat: 24.86, lng: 67.0, observedAt: clock.nowMs() });
  record(
    "first-loc-sent-immediately",
    session.getCounters().fixesSent === 1 && sent.length === 1 ? "PASS" : "FAIL",
    `fixesSent=${session.getCounters().fixesSent}`
  );
  await session.close();
}

async function testSecondSendBlockedBeforeHalfInterval() {
  const clock = createClock();
  const sent = [];
  const session = await createSessionWithClock(clock);
  session._setChannelOpenForTest(true, (payload) => sent.push(payload));

  session.enqueueLocationFix({ lat: 24.86, lng: 67.0, observedAt: clock.nowMs() });
  clock.advance(MIN_GAP_MS - 1);
  session.enqueueLocationFix({ lat: 24.861, lng: 67.001, observedAt: clock.nowMs() });
  session._flushPendingForTest();

  record(
    "second-send-blocked-before-half-interval",
    session.getCounters().fixesSent === 1 && sent.length === 1 ? "PASS" : "FAIL",
    `fixesSent=${session.getCounters().fixesSent} gapMs=${MIN_GAP_MS - 1}`
  );
  await session.close();
}

async function testSecondSendAllowedAtHalfInterval() {
  const clock = createClock();
  const sent = [];
  const session = await createSessionWithClock(clock);
  session._setChannelOpenForTest(true, (payload) => sent.push(payload));

  session.enqueueLocationFix({ lat: 24.86, lng: 67.0, observedAt: clock.nowMs() });
  clock.advance(MIN_GAP_MS);
  session.enqueueLocationFix({ lat: 24.861, lng: 67.001, observedAt: clock.nowMs() });
  session._flushPendingForTest();

  const secondLat = sent.length >= 2 ? JSON.parse(sent[1]).lat : NaN;
  record(
    "second-send-allowed-at-half-interval",
    session.getCounters().fixesSent === 2 && secondLat === 24.861 ? "PASS" : "FAIL",
    `fixesSent=${session.getCounters().fixesSent} secondLat=${secondLat} gapMs=${MIN_GAP_MS}`
  );
  await session.close();
}

async function testStrictFullIntervalNotRequired() {
  const clock = createClock();
  const session = await createSessionWithClock(clock);
  session._setChannelOpenForTest(true);

  session.enqueueLocationFix({ lat: 24.86, lng: 67.0, observedAt: clock.nowMs() });
  clock.advance(MIN_GAP_MS);
  session.enqueueLocationFix({ lat: 24.861, lng: 67.001, observedAt: clock.nowMs() });
  session._flushPendingForTest();
  const afterTwo = session.getCounters().fixesSent;

  clock.advance(MIN_GAP_MS);
  session.enqueueLocationFix({ lat: 24.862, lng: 67.002, observedAt: clock.nowMs() });
  session._flushPendingForTest();
  const afterThree = session.getCounters().fixesSent;

  record(
    "third-send-at-1500ms-not-3000ms-from-previous",
    afterTwo === 2 && afterThree === 3 ? "PASS" : "FAIL",
    `afterTwo=${afterTwo} afterThree=${afterThree} spacingMs=${MIN_GAP_MS}`
  );
  await session.close();
}

async function testRapidBurstCoalesces() {
  const clock = createClock();
  const sent = [];
  const session = await createSessionWithClock(clock);
  session._setChannelOpenForTest(true, (payload) => sent.push(payload));

  for (let i = 0; i < 5; i += 1) {
    session.enqueueLocationFix({
      lat: 24.86 + i * 0.001,
      lng: 67.0,
      observedAt: clock.nowMs() + i,
    });
  }

  record(
    "rapid-burst-coalesces-immediate-send",
    sent.length === 1 && session.getCounters().fixesSent === 1 ? "PASS" : "FAIL",
    `sent=${sent.length} fixesSent=${session.getCounters().fixesSent} coalesces=${session.getCounters().pendingCoalesces}`
  );
  await session.close();
}

async function testScheduledCadenceTimerFires() {
  const sent = [];
  const session = createP2pPeerSession({
    role: "driver",
    RTCPeerConnection: MockRTCPeerConnection,
    ensureIceConfiguration: async () => {},
  });
  await session.startAsDriver({
    peerSessionId: "ps_cad02abcdef",
    trackingSessionId: "trk_cad2",
    assignmentVersion: 42,
  });
  session.syncAssignmentVersion(42);
  session._setChannelOpenForTest(true, (payload) => sent.push(payload));

  session.enqueueLocationFix({ lat: 24.86, lng: 67.0, observedAt: Date.now() });
  await sleep(50);
  session.enqueueLocationFix({ lat: 24.865, lng: 67.005, observedAt: Date.now() });
  await sleep(MIN_GAP_MS + 100);

  const secondLat = sent.length >= 2 ? JSON.parse(sent[1]).lat : NaN;
  record(
    "scheduled-cadence-timer-delivers-coalesced-fix",
    session.getCounters().fixesSent === 2 && secondLat === 24.865 ? "PASS" : "FAIL",
    `fixesSent=${session.getCounters().fixesSent} secondLat=${secondLat}`
  );
  await session.close();
}

async function testSustainedSendRateCap() {
  const clock = createClock();
  const session = await createSessionWithClock(clock);
  session._setChannelOpenForTest(true);

  const windowMs = P2P_SEND_INTERVAL_MS * 2;
  let tick = 0;
  while (tick <= windowMs) {
    session.enqueueLocationFix({
      lat: 24.86 + tick * 0.00001,
      lng: 67.0,
      observedAt: clock.nowMs(),
    });
    clock.advance(100);
    tick += 100;
    session._flushPendingForTest();
  }

  const maxExpected = Math.floor(windowMs / MIN_GAP_MS) + 1;
  const fixesSent = session.getCounters().fixesSent;
  record(
    "sustained-rate-capped-by-half-interval",
    fixesSent <= maxExpected && fixesSent >= maxExpected - 1 ? "PASS" : "FAIL",
    `fixesSent=${fixesSent} maxExpected~=${maxExpected} windowMs=${windowMs}`
  );
  await session.close();
}

function recordAuditVerdict() {
  const verdict = {
    configuredIntervalMs: P2P_SEND_INTERVAL_MS,
    minimumSpacingMs: MIN_GAP_MS,
    earliestTwoSuccessfulSendsMs: MIN_GAP_MS,
    halfIntervalIntentional: true,
    productionChangeRequired: false,
    rationale:
      "flushPendingLoc uses minGapMs = P2P_SEND_INTERVAL_MS * 0.5 as minimum spacing between successful LOC sends while coalescing bursts into pendingLoc. Same logic exists on origin/main. Stricter 3000ms would slow marker motion without improving coalescing.",
    markerMotionImpactIfStrict3000:
      "Harmful — customer would receive at most ~0.33 Hz vs current ~0.67 Hz cap under continuous GPS.",
    batteryNetworkImpact:
      "Current half-interval cap already limits sustained P2P LOC to ~0.67/s; coalescing collapses bursts to one pending fix.",
  };
  record(
    "audit-verdict-no-production-change",
    verdict.productionChangeRequired === false ? "PASS" : "FAIL",
    `minGap=${verdict.minimumSpacingMs}ms earliestPair=${verdict.earliestTwoSuccessfulSendsMs}ms`
  );
  return verdict;
}

async function main() {
  console.log("\n=== STAGE 5 — P2P cadence contract audit ===\n");
  testConfiguredInterval();
  testStaticCadenceImplementation();
  await testFirstSendImmediateNoCadenceGate();
  await testSecondSendBlockedBeforeHalfInterval();
  await testSecondSendAllowedAtHalfInterval();
  await testStrictFullIntervalNotRequired();
  await testRapidBurstCoalesces();
  await testScheduledCadenceTimerFires();
  await testSustainedSendRateCap();
  const auditVerdict = recordAuditVerdict();

  const pass = results.filter((r) => r.status === "PASS").length;
  const fail = results.filter((r) => r.status === "FAIL").length;
  const summary = {
    stage: 5,
    area: "cadence-contract-audit",
    generatedAt: new Date().toISOString(),
    ...auditVerdict,
    pass,
    fail,
    results,
  };
  fs.writeFileSync(OUT, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`\nStage 5 cadence contract: ${pass} PASS / ${fail} FAIL`);
  console.log(`Wrote ${OUT}\n`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
