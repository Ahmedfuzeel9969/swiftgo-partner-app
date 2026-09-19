#!/usr/bin/env node
/**
 * Root-cause tests for customer marker freeze while the vehicle is moving.
 *
 * Failures this suite pins:
 * 1. Incomplete assignment hash (driverId XOR vehicleId) disagrees with complete hash.
 * 2. Customer must not send loc ACK unless onLocationFix actually ingested.
 * 3. Answer must key off signaling AV, not a stale local hash.
 * 4. Loc tagged with session AV is ingested even if local expected AV is wrong.
 * 5. Vehicle mirror recovers rideId from partner.activeRideId when vehicle.activeRideId is empty.
 */
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { assignmentVersionFromRide } from "../shared/js/breadcrumb-schema.mjs";
import { createCustomerP2pController } from "../customer-app/js/p2p-ride-controller.mjs";
import { createP2pPeerSession } from "../customer-app/js/p2p-peer-session.mjs";
import { P2P_PROTOCOL_VERSION, P2P_STATE } from "../customer-app/js/p2p-protocol.mjs";

const require = createRequire(import.meta.url);
const { resolveRideIdForVehicleMirror } = require("../functions/driver-location.js");

const __dirname = dirname(fileURLToPath(import.meta.url));
const results = [];

function record(name, status, detail) {
  results.push({ name, status, detail: detail || "" });
  const tag = status === "PASS" ? "PASS" : status === "FAIL" ? "FAIL" : status;
  console.log(`${tag.padEnd(6)} ${name}${detail ? ` — ${detail}` : ""}`);
}

function locMsg(overrides = {}) {
  return {
    v: P2P_PROTOCOL_VERSION,
    type: "loc",
    peerSessionId: "ps_motion01",
    trackingSessionId: "trk_motion",
    assignmentVersion: 7,
    seq: 1,
    observedAt: Date.now(),
    lat: 24.86,
    lng: 67.01,
    accuracyM: 8,
    headingDeg: 90,
    speedMps: 12,
    role: "driver",
    ...overrides,
  };
}

function MockRTC() {
  this.localDescription = { type: "offer", sdp: "v=0" };
  this.remoteDescription = null;
  this.iceGatheringState = "complete";
  this.signalingState = "have-remote-offer";
  this.connectionState = "new";
  this.iceConnectionState = "new";
  this.onicecandidate = null;
  this.onicecandidateerror = null;
  this.ontrack = null;
  this.ondatachannel = null;
  this.onicecandidate = null;
  this.addEventListener = () => {};
  this.removeEventListener = () => {};
  this.addIceCandidate = async () => {};
  this.setRemoteDescription = async (d) => {
    this.remoteDescription = d;
  };
  this.setLocalDescription = async (d) => {
    this.localDescription = d;
  };
  this.createAnswer = async () => ({ type: "answer", sdp: "v=0\r\no=- ans\r\n" });
  this.createOffer = async () => ({ type: "offer", sdp: "v=0\r\no=- off\r\n" });
  this.createDataChannel = () => ({
    readyState: "connecting",
    bufferedAmount: 0,
    send() {},
    close() {},
    addEventListener() {},
  });
  this.close = () => {};
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function src(rel) {
  return readFileSync(join(__dirname, "..", rel), "utf8");
}

function testIncompleteHashDisagrees() {
  const driverId = "drv_1";
  const vehicleId = "veh_1";
  const complete = assignmentVersionFromRide({ driverId, vehicleId });
  const driverOnly = assignmentVersionFromRide({ driverId });
  const vehicleOnly = assignmentVersionFromRide({ vehicleId });
  record(
    "incomplete-hash-disagrees-with-complete",
    complete !== driverOnly && complete !== vehicleOnly ? "PASS" : "FAIL",
    `complete=${complete} driverOnly=${driverOnly} vehicleOnly=${vehicleOnly}`
  );
}

function testStaticBothIdsRequired() {
  const cust = src("customer-app/js/ride-flow.js");
  const drv = src("driver-app/js/driver-app.js");
  const custOk =
    /ride\?\.driverId\s*&&\s*ride\?\.vehicleId/.test(cust) &&
    /assignmentVersionFromRide\(ride\)/.test(cust);
  const drvOk =
    /ride\.driverId\s*&&\s*ride\.vehicleId/.test(drv) &&
    /assignmentVersionFromRide\(ride\)/.test(drv);
  record(
    "static-customer-av-requires-both-ids",
    custOk ? "PASS" : "FAIL",
    custOk ? "ride-flow gates AV on driverId && vehicleId" : "customer ride-flow missing both-id gate"
  );
  record(
    "static-driver-av-requires-both-ids",
    drvOk ? "PASS" : "FAIL",
    drvOk ? "driver-app gates AV on driverId && vehicleId" : "driver-app missing both-id gate"
  );
}

function testStaticAckSkipOnFalse() {
  const custSess = src("customer-app/js/p2p-peer-session.mjs");
  const drvSess = src("driver-app/js/p2p-peer-session.mjs");
  const re = /accepted\s*===\s*false/;
  record(
    "static-customer-ack-skips-when-onLocationFix-false",
    re.test(custSess) ? "PASS" : "FAIL"
  );
  record(
    "static-driver-ack-skips-when-onLocationFix-false",
    /accepted\s*===\s*false/.test(drvSess) || re.test(drvSess) ? "PASS" : "FAIL"
  );
}

function testStaticOfferUsesSessionAv() {
  const ctrl = src("customer-app/js/p2p-ride-controller.mjs");
  const start = ctrl.indexOf("function isOfferCurrent");
  const end = ctrl.indexOf("function isWatchCurrent", start);
  const body = start >= 0 && end > start ? ctrl.slice(start, end) : "";
  const usesSession =
    /sessionAv/.test(body) &&
    /docAv/.test(body) &&
    !/expectedAssignmentVersion/.test(body);
  const locBound = /boundAv\s*=\s*sessionAv\s*>=\s*1\s*\?\s*sessionAv/.test(ctrl);
  record(
    "static-isOfferCurrent-uses-session-av",
    usesSession ? "PASS" : "FAIL",
    usesSession ? "offer gate uses session/doc AV only" : "isOfferCurrent still keys off local expected AV"
  );
  record("static-onLocationFix-binds-session-av", locBound ? "PASS" : "FAIL");
}

async function testControllerAnswersDespiteWrongLocalAv() {
  const published = [];
  const cust = createCustomerP2pController({
    RTCPeerConnection: MockRTC,
    ensureIceConfiguration: async () => {},
    publishRidePeerAnswerClient: async (payload) => {
      published.push(payload);
      return { ok: true };
    },
    closeRidePeerSessionClient: async () => {},
    watchRidePeerSession: (_rid, onData) => {
      onData({
        sessionId: "ps_motion01",
        offer: "v=0\r\no=- offer\r\n",
        trackingSessionId: "trk_motion",
        assignmentVersion: 7,
        state: "offered",
      });
      return () => {};
    },
  });
  cust.syncForRide(
    { id: "ride_motion", status: "accepted", driverId: "drv_1" },
    { isVisible: true, assignmentVersion: 111 }
  );
  await sleep(160);
  record(
    "controller-answers-when-local-expected-av-wrong",
    published.length === 1 && published[0]?.rideId === "ride_motion" ? "PASS" : "FAIL",
    `published=${published.length} rideId=${published[0]?.rideId || "none"}`
  );
  await cust.stop({ closeRemote: false });
}

async function testSessionAvLocIngestedDespiteWrongExpected() {
  const renders = [];
  let watchCb = null;
  const cust = createCustomerP2pController({
    RTCPeerConnection: MockRTC,
    ensureIceConfiguration: async () => {},
    onRenderFix: (fix) => renders.push(fix),
    publishRidePeerAnswerClient: async () => ({ ok: true }),
    closeRidePeerSessionClient: async () => {},
    watchRidePeerSession: (_rid, onData) => {
      watchCb = onData;
      return () => {
        watchCb = null;
      };
    },
  });
  cust.syncForRide(
    { id: "ride_motion2", status: "in_progress", driverId: "drv_1" },
    { isVisible: true, assignmentVersion: 111 }
  );
  await sleep(40);
  watchCb?.({
    sessionId: "ps_motion01",
    offer: "v=0\r\no=- offer\r\n",
    trackingSessionId: "trk_motion",
    assignmentVersion: 7,
    state: "offered",
  });
  await sleep(160);
  const session = cust._getSessionForTest();
  if (!session) {
    record("loc-with-session-av-ingested-despite-wrong-expected", "FAIL", "no session after offer");
    await cust.stop({ closeRemote: false });
    return;
  }
  session._handleMessageForTest(
    JSON.stringify(
      locMsg({
        peerSessionId: "ps_motion01",
        trackingSessionId: "trk_motion",
        assignmentVersion: 7,
      })
    )
  );
  record(
    "loc-with-session-av-ingested-despite-wrong-expected",
    renders.length >= 1 ? "PASS" : "FAIL",
    `renders=${renders.length} locDrops=${cust.getCounters().locDrops || 0} staleAv=${cust.getCounters().staleAssignmentFixes || 0}`
  );
  await cust.stop({ closeRemote: false });
}

async function testOnLocationFixFalseDoesNotAck() {
  const sent = [];
  const session = createP2pPeerSession({
    role: "customer",
    RTCPeerConnection: MockRTC,
    ensureIceConfiguration: async () => {},
    onLocationFix: () => false,
  });
  await session.startAsCustomer({
    peerSessionId: "ps_acktest01",
    trackingSessionId: "trk_motion",
    assignmentVersion: 7,
    offerSdp: "v=0\r\no=- offer\r\n",
  });
  session._setChannelOpenForTest(true, (raw) => sent.push(String(raw)));
  session._handleMessageForTest(
    JSON.stringify(
      locMsg({
        peerSessionId: "ps_acktest01",
        trackingSessionId: "trk_motion",
        assignmentVersion: 7,
      })
    )
  );
  const acks = sent.filter((s) => {
    try {
      const m = JSON.parse(s);
      return m.type === "ack" && (m.ackKind === "loc" || m.kind === "ack");
    } catch {
      return false;
    }
  }).length;
  record(
    "onLocationFix-false-does-not-ack",
    acks === 0 ? "PASS" : "FAIL",
    `acks=${acks} sent=${sent.length} state=${session.getState?.().state || P2P_STATE.DISABLED}`
  );
  await session.close({ reason: "test" });
}

async function testOnLocationFixTrueDoesAck() {
  const sent = [];
  const session = createP2pPeerSession({
    role: "customer",
    RTCPeerConnection: MockRTC,
    ensureIceConfiguration: async () => {},
    onLocationFix: () => true,
  });
  await session.startAsCustomer({
    peerSessionId: "ps_acktest02",
    trackingSessionId: "trk_motion",
    assignmentVersion: 7,
    offerSdp: "v=0\r\no=- offer\r\n",
  });
  session._setChannelOpenForTest(true, (raw) => sent.push(String(raw)));
  session._handleMessageForTest(
    JSON.stringify(
      locMsg({
        peerSessionId: "ps_acktest02",
        trackingSessionId: "trk_motion",
        assignmentVersion: 7,
      })
    )
  );
  const acks = sent.filter((s) => {
    try {
      const m = JSON.parse(s);
      return m.type === "ack";
    } catch {
      return false;
    }
  }).length;
  record(
    "onLocationFix-true-does-ack",
    acks === 1 ? "PASS" : "FAIL",
    `acks=${acks} sent=${JSON.stringify(sent).slice(0, 180)}`
  );
  await session.close({ reason: "test" });
}

function mockDb({ partners = new Map(), rides = new Map() }) {
  return {
    collection(name) {
      const map = name === "partners" ? partners : name === "rides" ? rides : new Map();
      return {
        doc(id) {
          return {
            async get() {
              const data = map.get(id);
              return { exists: Boolean(data), data: () => data };
            },
          };
        },
      };
    },
  };
}

async function testMirrorResolvesPartnerPointer() {
  const partners = new Map([
    ["drv_1", { activeRideId: "ride_live", status: "in_ride" }],
  ]);
  const rides = new Map([
    [
      "ride_live",
      {
        driverId: "drv_1",
        vehicleId: "veh_1",
        status: "in_progress",
      },
    ],
  ]);
  const db = mockDb({ partners, rides });
  const fromVehicle = await resolveRideIdForVehicleMirror(db, "veh_1", {
    activeRideId: "ride_live",
    driverId: "drv_1",
  });
  const fromPartner = await resolveRideIdForVehicleMirror(db, "veh_1", {
    driverId: "drv_1",
    status: "in_ride",
  });
  record(
    "mirror-uses-vehicle-activeRideId",
    fromVehicle === "ride_live" ? "PASS" : "FAIL",
    `rideId=${fromVehicle}`
  );
  record(
    "mirror-recovers-partner-pointer-when-vehicle-activeRideId-empty",
    fromPartner === "ride_live" ? "PASS" : "FAIL",
    `rideId=${fromPartner}`
  );

  const dbMismatch = mockDb({
    partners,
    rides: new Map([
      [
        "ride_live",
        { driverId: "drv_other", vehicleId: "veh_1", status: "in_progress" },
      ],
    ]),
  });
  const rejected = await resolveRideIdForVehicleMirror(dbMismatch, "veh_1", {
    driverId: "drv_1",
    status: "in_ride",
  });
  record(
    "mirror-rejects-partner-pointer-when-ride-driver-mismatch",
    rejected == null || rejected === "" ? "PASS" : "FAIL",
    `rideId=${rejected}`
  );

  const skippedOnline = await resolveRideIdForVehicleMirror(db, "veh_1", {
    driverId: "drv_1",
    status: "online",
  });
  record(
    "mirror-skips-partner-pointer-when-vehicle-not-in-ride",
    !skippedOnline ? "PASS" : "FAIL",
    `rideId=${skippedOnline}`
  );
}

async function main() {
  testIncompleteHashDisagrees();
  testStaticBothIdsRequired();
  testStaticAckSkipOnFalse();
  testStaticOfferUsesSessionAv();
  await testControllerAnswersDespiteWrongLocalAv();
  await testSessionAvLocIngestedDespiteWrongExpected();
  await testOnLocationFixFalseDoesNotAck();
  await testOnLocationFixTrueDoesAck();
  await testMirrorResolvesPartnerPointer();

  const failed = results.filter((r) => r.status === "FAIL").length;
  const passed = results.filter((r) => r.status === "PASS").length;
  const out = {
    generatedAt: new Date().toISOString(),
    passed,
    failed,
    results,
  };
  writeFileSync(
    join(__dirname, "customer-motion-root-cause-results.json"),
    JSON.stringify(out, null, 2)
  );
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
