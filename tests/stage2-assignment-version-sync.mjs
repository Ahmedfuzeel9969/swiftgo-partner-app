/**
 * Stage 2 — authoritative assignmentVersion sync regression.
 *
 * Run: node tests/stage2-assignment-version-sync.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createP2pPeerSession } from "../driver-app/js/p2p-peer-session.mjs";
import { createDriverP2pController } from "../driver-app/js/p2p-ride-controller.mjs";
import {
  buildP2pLocationMessage,
  validateP2pMessage,
} from "../customer-app/js/p2p-location-envelope.mjs";

const require = createRequire(import.meta.url);
const { assignmentVersionFromRide } = require("../functions/ride-peer-session.js");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "tests", "stage2-assignment-version-sync-results.json");

const PEER_SESSION_ID = "ps_stage2abcdef01";
const TRACKING_SESSION_ID = "trk_stage2_xyz";

const results = [];
function record(name, status, detail = "") {
  results.push({ name, status, detail });
  const mark = status === "PASS" ? "✓" : "✗";
  console.log(`${mark} ${name} — ${status}${detail ? `: ${detail}` : ""}`);
}

function MockRTCPeerConnection() {
  const self = {
    iceGatheringState: "complete",
    localDescription: null,
    remoteDescription: null,
    createDataChannel(label) {
      return {
        label,
        readyState: "connecting",
        bufferedAmount: 0,
        onopen: null,
        onclose: null,
        onmessage: null,
        send() {},
        close() {
          this.readyState = "closed";
        },
      };
    },
    async createOffer() {
      return { type: "offer", sdp: "v=0\r\no=- offer\r\n" };
    },
    async createAnswer() {
      return { type: "answer", sdp: "v=0\r\no=- answer\r\n" };
    },
    async setLocalDescription(desc) {
      self.localDescription = desc;
      self.iceGatheringState = "complete";
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

async function testControllerSyncsSessionAfterOffer() {
  const ride = {
    driverId: "drv_stage2",
    vehicleId: "veh_stage2",
    status: "accepted",
  };
  const serverAv = assignmentVersionFromRide(ride);

  const drv = createDriverP2pController({
    RTCPeerConnection: MockRTCPeerConnection,
    ensureIceConfiguration: async () => {},
    createRidePeerOfferClient: async () => ({
      assignmentVersion: serverAv,
      sessionId: PEER_SESSION_ID,
    }),
    closeRidePeerSessionClient: async () => {},
    watchRidePeerSession: () => () => {},
  });

  await drv.start({
    rideId: "ride_stage2",
    trackingSessionId: TRACKING_SESSION_ID,
    vehicleId: ride.vehicleId,
  });
  await new Promise((r) => setTimeout(r, 30));

  const sessionAv = drv.getState().assignmentVersion;
  record(
    "controller-syncs-session-assignmentVersion-after-offer",
    sessionAv === serverAv && serverAv !== 1 ? "PASS" : "FAIL",
    `sessionAv=${sessionAv} serverAv=${serverAv}`
  );

  await drv.stop({ closeRemote: false });
}

async function testDriverLocAcceptedByCustomer() {
  const ride = {
    driverId: "drv_stage2_b",
    vehicleId: "veh_stage2_b",
  };
  const serverAv = assignmentVersionFromRide(ride);

  const session = createP2pPeerSession({
    role: "driver",
    RTCPeerConnection: MockRTCPeerConnection,
    ensureIceConfiguration: async () => {},
    onLocalDescription: async () => {},
    onDiag: () => {},
  });

  await session.startAsDriver({
    peerSessionId: PEER_SESSION_ID,
    trackingSessionId: TRACKING_SESSION_ID,
    assignmentVersion: 1,
  });
  session.syncAssignmentVersion(serverAv);

  session._setChannelOpenForTest(true);

  session.enqueueLocationFix({
    lat: 24.861,
    lng: 67.001,
    observedAt: Date.now(),
    accuracyM: 10,
  });

  const st = session.getState();
  const built = buildP2pLocationMessage(
    { lat: 24.861, lng: 67.001, observedAt: Date.now(), accuracyM: 10 },
    {
      peerSessionId: st.peerSessionId,
      trackingSessionId: st.trackingSessionId,
      assignmentVersion: st.assignmentVersion,
      sequence: 1,
      role: "driver",
    }
  );

  record(
    "driver-loc-uses-authoritative-assignmentVersion",
    built.ok && built.message.assignmentVersion === serverAv ? "PASS" : "FAIL",
    `locAv=${built.message?.assignmentVersion} serverAv=${serverAv}`
  );

  const validated = validateP2pMessage(built.serialized, {
    peerSessionId: st.peerSessionId,
    trackingSessionId: st.trackingSessionId,
    assignmentVersion: serverAv,
    lastSequence: 0,
    expectRole: "driver",
    nowMs: Date.now(),
  });

  record(
    "customer-accepts-driver-loc-with-authoritative-assignmentVersion",
    validated.ok && validated.type === "loc" ? "PASS" : "FAIL",
    validated.ok ? "accepted" : validated.reason
  );

  await session.close();
}

function testWrongAssignmentStillRejected() {
  const ride = {
    driverId: "drv_stage2_c",
    vehicleId: "veh_stage2_c",
  };
  const serverAv = assignmentVersionFromRide(ride);
  const ctx = {
    peerSessionId: PEER_SESSION_ID,
    trackingSessionId: TRACKING_SESSION_ID,
    assignmentVersion: serverAv,
    sequence: 1,
    role: "driver",
  };
  const built = buildP2pLocationMessage(
    { lat: 24.86, lng: 67.0, observedAt: Date.now() },
    { ...ctx, assignmentVersion: serverAv + 99 }
  );
  const validated = validateP2pMessage(built.serialized, {
    peerSessionId: PEER_SESSION_ID,
    trackingSessionId: TRACKING_SESSION_ID,
    assignmentVersion: serverAv,
    lastSequence: 0,
    expectRole: "driver",
    nowMs: Date.now(),
  });
  record(
    "wrong-assignment-still-rejected",
    !validated.ok && validated.reason === "wrong_assignment" ? "PASS" : "FAIL",
    validated.reason || "accepted unexpectedly"
  );

  const stale = buildP2pLocationMessage(
    { lat: 24.86, lng: 67.0, observedAt: Date.now() },
    { ...ctx, assignmentVersion: 1 }
  );
  const staleVal = validateP2pMessage(stale.serialized, {
    peerSessionId: PEER_SESSION_ID,
    trackingSessionId: TRACKING_SESSION_ID,
    assignmentVersion: serverAv,
    lastSequence: 0,
    expectRole: "driver",
    nowMs: Date.now(),
  });
  record(
    "stale-assignmentVersion-1-rejected-when-serverAv-differs",
    !staleVal.ok && staleVal.reason === "wrong_assignment" ? "PASS" : "FAIL",
    staleVal.reason || "accepted unexpectedly"
  );
}

async function testReconnectPreservesAssignmentVersion() {
  const serverAv = assignmentVersionFromRide({
    driverId: "drv_stage2_d",
    vehicleId: "veh_stage2_d",
  });

  const session = createP2pPeerSession({
    role: "driver",
    RTCPeerConnection: MockRTCPeerConnection,
    ensureIceConfiguration: async () => {},
    onLocalDescription: async () => {
      session.syncAssignmentVersion(serverAv);
    },
    onDiag: () => {},
  });

  await session.startAsDriver({
    trackingSessionId: TRACKING_SESSION_ID,
    assignmentVersion: 1,
  });
  session.syncAssignmentVersion(serverAv);

  await session.startAsDriver({
    trackingSessionId: TRACKING_SESSION_ID,
    assignmentVersion: serverAv,
    reconnect: true,
  });
  await new Promise((r) => setTimeout(r, 20));

  const st = session.getState();
  record(
    "reconnect-preserves-authoritative-assignmentVersion",
    st.assignmentVersion === serverAv ? "PASS" : "FAIL",
    `sessionAv=${st.assignmentVersion} serverAv=${serverAv}`
  );

  await session.close();
}

async function main() {
  console.log("\n=== STAGE 2 — assignmentVersion sync regression ===\n");
  await testControllerSyncsSessionAfterOffer();
  await testDriverLocAcceptedByCustomer();
  testWrongAssignmentStillRejected();
  await testReconnectPreservesAssignmentVersion();

  const pass = results.filter((r) => r.status === "PASS").length;
  const fail = results.filter((r) => r.status === "FAIL").length;
  const summary = {
    stage: 2,
    generatedAt: new Date().toISOString(),
    pass,
    fail,
    results,
  };
  fs.writeFileSync(OUT, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`\nStage 2 summary: ${pass} PASS / ${fail} FAIL`);
  console.log(`Wrote ${OUT}\n`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
