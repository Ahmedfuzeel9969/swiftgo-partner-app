/**
 * Stage 3 — same-ride reassignment / stale session safety.
 *
 * Proves: same rideId, new assignmentVersion must destroy old peer session so
 * stale driver LOC cannot update the customer marker; new assignment can establish.
 *
 * Run: node tests/stage3-same-ride-reassignment.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createCustomerP2pController } from "../customer-app/js/p2p-ride-controller.mjs";
import { P2P_STATE } from "../customer-app/js/p2p-protocol.mjs";

const require = createRequire(import.meta.url);
const { assignmentVersionFromRide } = require("../functions/ride-peer-session.js");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "tests/stage3-same-ride-reassignment-results.json");

const RIDE_ID = "ride_stage3_reassign";
const DRIVER_A = "drv_stage3_a";
const DRIVER_B = "drv_stage3_b";
const VEHICLE_A = "veh_stage3_a";
const VEHICLE_B = "veh_stage3_b";

const AV_A = assignmentVersionFromRide({ driverId: DRIVER_A, vehicleId: VEHICLE_A });
const AV_B = assignmentVersionFromRide({ driverId: DRIVER_B, vehicleId: VEHICLE_B });

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

function createHarness() {
  let watchCb = null;
  const renders = [];
  const cust = createCustomerP2pController({
    RTCPeerConnection: MockRTCPeerConnection,
    ensureIceConfiguration: async () => {},
    onRenderFix: (fix) => renders.push({ ...fix }),
    publishRidePeerAnswerClient: async () => ({ ok: true }),
    closeRidePeerSessionClient: async () => {},
    watchRidePeerSession: (_rid, onData) => {
      watchCb = onData;
      return () => {
        watchCb = null;
      };
    },
  });
  return { cust, renders, getWatchCb: () => watchCb };
}

function offerDoc({ sessionId, av, trackingSessionId = "trk_stage3" }) {
  return {
    sessionId,
    offer: `v=0\r\no=- offer-${sessionId}\r\n`,
    trackingSessionId,
    assignmentVersion: av,
    state: "offered",
  };
}

function staleLocMessage({ sessionId, av, lat, lng, seq = 99 }) {
  return JSON.stringify({
    v: 1,
    type: "loc",
    peerSessionId: sessionId,
    trackingSessionId: "trk_stage3",
    assignmentVersion: av,
    seq,
    observedAt: Date.now(),
    lat,
    lng,
    role: "driver",
  });
}

async function testSameRideReassignmentDestroysStaleSession() {
  const { cust, getWatchCb } = createHarness();
  const ride = { id: RIDE_ID, status: "in_progress", driverId: DRIVER_A, vehicleId: VEHICLE_A };

  cust.syncForRide(ride, { isVisible: true, assignmentVersion: AV_A });
  getWatchCb()?.(offerDoc({ sessionId: "ps_driver_a", av: AV_A }));
  await sleep(80);

  const sessionBefore = cust._getSessionForTest?.();
  const avBefore = sessionBefore?.getState?.()?.assignmentVersion;
  record(
    "initial-session-established-with-av-a",
    sessionBefore && avBefore === AV_A ? "PASS" : "FAIL",
    `session=${Boolean(sessionBefore)} av=${avBefore} expected=${AV_A}`
  );

  cust.syncForRide(
    { id: RIDE_ID, status: "in_progress", driverId: DRIVER_B, vehicleId: VEHICLE_B },
    { isVisible: true, assignmentVersion: AV_B }
  );
  await sleep(20);

  const sessionAfterSync = cust._getSessionForTest?.();
  record(
    "sync-reassignment-destroys-stale-session",
    !sessionAfterSync || sessionAfterSync !== sessionBefore ? "PASS" : "FAIL",
    `sameRef=${sessionAfterSync === sessionBefore} expectedAv=${AV_B}`
  );

  await cust.stop({ closeRemote: false });
}

async function testStaleLocBlockedAfterSameRideReassignment() {
  const { cust, renders, getWatchCb } = createHarness();
  cust.syncForRide(
    { id: RIDE_ID, status: "in_progress", driverId: DRIVER_A, vehicleId: VEHICLE_A },
    { isVisible: true, assignmentVersion: AV_A }
  );
  getWatchCb()?.(offerDoc({ sessionId: "ps_stale_a", av: AV_A }));
  await sleep(80);

  const staleSession = cust._getSessionForTest?.();
  renders.length = 0;

  cust.syncForRide(
    { id: RIDE_ID, status: "in_progress", driverId: DRIVER_B, vehicleId: VEHICLE_B },
    { isVisible: true, assignmentVersion: AV_B }
  );
  await sleep(20);

  if (staleSession?._handleMessageForTest) {
    staleSession._handleMessageForTest(
      staleLocMessage({ sessionId: "ps_stale_a", av: AV_A, lat: 24.91, lng: 67.01 }),
      staleSession.getState().generation
    );
  }
  await sleep(20);

  const leaked = renders.some((r) => r.lat === 24.91);
  record(
    "stale-loc-from-old-assignment-blocked",
    !leaked ? "PASS" : "FAIL",
    `renders=${renders.length} leaked=${leaked}`
  );
  await cust.stop({ closeRemote: false });
}

async function testNewAssignmentCanEstablishAfterReassignment() {
  const { cust, renders, getWatchCb } = createHarness();
  cust.syncForRide(
    { id: RIDE_ID, status: "in_progress", driverId: DRIVER_A, vehicleId: VEHICLE_A },
    { isVisible: true, assignmentVersion: AV_A }
  );
  getWatchCb()?.(offerDoc({ sessionId: "ps_old_a", av: AV_A }));
  await sleep(80);

  cust.syncForRide(
    { id: RIDE_ID, status: "in_progress", driverId: DRIVER_B, vehicleId: VEHICLE_B },
    { isVisible: true, assignmentVersion: AV_B }
  );
  getWatchCb()?.(offerDoc({ sessionId: "ps_new_b", av: AV_B }));
  await sleep(80);

  const newSession = cust._getSessionForTest?.();
  const newAv = newSession?.getState?.()?.assignmentVersion;
  record(
    "new-assignment-session-establishes",
    newSession && newAv === AV_B ? "PASS" : "FAIL",
    `session=${Boolean(newSession)} av=${newAv} expected=${AV_B}`
  );

  renders.length = 0;
  if (newSession?._handleMessageForTest) {
    newSession._handleMessageForTest(
      staleLocMessage({ sessionId: "ps_new_b", av: AV_B, lat: 24.92, lng: 67.02, seq: 1 }),
      newSession.getState().generation
    );
  }
  await sleep(20);
  const accepted = renders.some((r) => r.lat === 24.92);
  record(
    "new-assignment-loc-accepted",
    accepted ? "PASS" : "FAIL",
    `renders=${renders.length}`
  );
  await cust.stop({ closeRemote: false });
}

async function testWatchNewOfferDestroysStaleSession() {
  const { cust, getWatchCb } = createHarness();
  cust.syncForRide(
    { id: RIDE_ID, status: "in_progress", driverId: DRIVER_A, vehicleId: VEHICLE_A },
    { isVisible: true, assignmentVersion: AV_A }
  );
  getWatchCb()?.(offerDoc({ sessionId: "ps_watch_a", av: AV_A }));
  await sleep(80);
  const staleSession = cust._getSessionForTest?.();

  // Signaling delivers new driver offer before ride doc sync catches up.
  getWatchCb()?.(offerDoc({ sessionId: "ps_watch_b", av: AV_B }));
  await sleep(80);

  const current = cust._getSessionForTest?.();
  const destroyed = !current || current !== staleSession;
  record(
    "watch-new-offer-destroys-stale-session",
    destroyed ? "PASS" : "FAIL",
    `sameRef=${current === staleSession}`
  );
  await cust.stop({ closeRemote: false });
}

async function testNoCoordinateRollbackOnReassignment() {
  const { cust, renders, getWatchCb } = createHarness();
  cust.syncForRide(
    { id: RIDE_ID, status: "in_progress", driverId: DRIVER_A, vehicleId: VEHICLE_A },
    { isVisible: true, assignmentVersion: AV_A }
  );
  getWatchCb()?.(offerDoc({ sessionId: "ps_roll_a", av: AV_A }));
  await sleep(80);
  const staleSession = cust._getSessionForTest?.();

  cust.syncForRide(
    { id: RIDE_ID, status: "in_progress", driverId: DRIVER_B, vehicleId: VEHICLE_B },
    { isVisible: true, assignmentVersion: AV_B }
  );
  getWatchCb()?.(offerDoc({ sessionId: "ps_roll_b", av: AV_B }));
  await sleep(80);
  const newSession = cust._getSessionForTest?.();

  if (newSession?._handleMessageForTest) {
    newSession._handleMessageForTest(
      staleLocMessage({ sessionId: "ps_roll_b", av: AV_B, lat: 24.95, lng: 67.05, seq: 2 }),
      newSession.getState().generation
    );
  }
  await sleep(20);
  renders.length = 0;

  if (staleSession?._handleMessageForTest) {
    staleSession._handleMessageForTest(
      staleLocMessage({ sessionId: "ps_roll_a", av: AV_A, lat: 24.8, lng: 67.0, seq: 50 }),
      staleSession.getState().generation
    );
  }
  await sleep(20);

  const rollback = renders.some((r) => r.lat === 24.8);
  const kept = renders.some((r) => r.lat === 24.95) || cust.getArbiter?.()?.getState?.()?.lastRendered?.lat === 24.95;
  record(
    "no-coordinate-rollback-from-stale-assignment",
    !rollback ? "PASS" : "FAIL",
    `rollback=${rollback} keptNew=${kept} renders=${renders.length}`
  );
  await cust.stop({ closeRemote: false });
}

function testStaticReassignmentSafeguards() {
  const src = fs.readFileSync(path.join(ROOT, "customer-app/js/p2p-ride-controller.mjs"), "utf8");
  const rideFlow = fs.readFileSync(path.join(ROOT, "customer-app/js/ride-flow.js"), "utf8");
  const checks = [
    ["sync-destroys-on-av-change", /reassignmentSessionDestroys|sessionAv !== nextAv/],
    ["watch-destroys-stale-session", /destroySessionIfAssignmentMismatch\(docAv\)/],
    ["onLocationFix-stale-av-guard", /staleAssignmentFixes|fixAv !== expectedAssignmentVersion/],
    ["ride-flow-passes-assignmentVersion", /assignmentVersionFromRide/],
  ];
  for (const [name, re] of checks) {
    const hay = name.startsWith("ride-flow") ? rideFlow : src;
    record(`static-${name}`, re.test(hay) ? "PASS" : "FAIL");
  }
}

function testAvValuesDistinct() {
  record(
    "assignment-versions-distinct-for-different-drivers",
    AV_A !== AV_B && AV_A >= 1 && AV_B >= 1 ? "PASS" : "FAIL",
    `avA=${AV_A} avB=${AV_B}`
  );
}

async function main() {
  console.log("\n=== STAGE 3 — same-ride reassignment / stale session safety ===\n");
  testAvValuesDistinct();
  testStaticReassignmentSafeguards();
  await testSameRideReassignmentDestroysStaleSession();
  await testStaleLocBlockedAfterSameRideReassignment();
  await testNewAssignmentCanEstablishAfterReassignment();
  await testWatchNewOfferDestroysStaleSession();
  await testNoCoordinateRollbackOnReassignment();

  const pass = results.filter((r) => r.status === "PASS").length;
  const fail = results.filter((r) => r.status === "FAIL").length;
  const summary = {
    stage: 3,
    area: "same-ride-reassignment",
    generatedAt: new Date().toISOString(),
    avA: AV_A,
    avB: AV_B,
    pass,
    fail,
    results,
  };
  fs.writeFileSync(OUT, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`\nStage 3 same-ride reassignment: ${pass} PASS / ${fail} FAIL`);
  console.log(`Wrote ${OUT}\n`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
