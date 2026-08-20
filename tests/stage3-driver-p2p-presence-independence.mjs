/**
 * Stage 3 — driver P2P must not be gated on customer viewer presence.
 *
 * Run: node tests/stage3-driver-p2p-presence-independence.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDriverP2pController } from "../driver-app/js/p2p-ride-controller.mjs";
import { P2P_EXECUTION_STATUSES, P2P_STATE } from "../driver-app/js/p2p-protocol.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "tests", "stage3-driver-p2p-presence-independence-results.json");
const DRIVER_APP = path.join(ROOT, "driver-app", "js", "driver-app.js");
const DRIVER_CTRL = path.join(ROOT, "driver-app", "js", "p2p-ride-controller.mjs");

const TRACKING_SESSION_ID = "trk_stage3_xyz";

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
    createDataChannel() {
      return {
        readyState: "connecting",
        bufferedAmount: 0,
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

function createTestDriver() {
  const offers = [];
  const stops = [];
  const drv = createDriverP2pController({
    RTCPeerConnection: MockRTCPeerConnection,
    ensureIceConfiguration: async () => {},
    createRidePeerOfferClient: async (payload) => {
      offers.push(payload);
      return { assignmentVersion: 42, sessionId: payload.peerSessionId };
    },
    closeRidePeerSessionClient: async () => {
      stops.push("closeRemote");
    },
    watchRidePeerSession: () => () => {},
  });
  return { drv, offers, stops };
}

function isSuspended(state) {
  return (
    state === P2P_STATE.FIREBASE_FALLBACK ||
    state === P2P_STATE.CLOSED ||
    state === P2P_STATE.DISABLED
  );
}

async function testActiveRideStartsP2pWithoutPresenceParam() {
  const { drv, offers } = createTestDriver();
  for (const status of P2P_EXECUTION_STATUSES) {
    await drv.stop({ closeRemote: false });
    offers.length = 0;
    drv.syncForRide({
      ride: { id: `ride_stage3_${status}`, status, vehicleId: "veh_s3" },
      trackingSessionId: TRACKING_SESSION_ID,
    });
    await new Promise((r) => setTimeout(r, 35));
    const st = drv.getState().state;
    record(
      `active-${status}-starts-p2p-without-presence`,
      !isSuspended(st) && offers.length >= 1 ? "PASS" : "FAIL",
      `state=${st} offers=${offers.length}`
    );
  }
  await drv.stop({ closeRemote: false });
}

async function testRepeatedSyncDoesNotStopHealthySession() {
  const { drv, offers } = createTestDriver();
  const ride = { id: "ride_stage3_repeat", status: "in_progress", vehicleId: "veh_s3" };
  drv.syncForRide({ ride, trackingSessionId: TRACKING_SESSION_ID });
  await new Promise((r) => setTimeout(r, 35));
  const offersAfterFirst = offers.length;
  for (let i = 0; i < 3; i += 1) {
    drv.syncForRide({ ride, trackingSessionId: TRACKING_SESSION_ID });
    await new Promise((r) => setTimeout(r, 10));
  }
  const st = drv.getState().state;
  record(
    "repeated-sync-does-not-suspend-active-p2p",
    !isSuspended(st) ? "PASS" : "FAIL",
    `state=${st} offers=${offers.length} first=${offersAfterFirst}`
  );
  await drv.stop({ closeRemote: false });
}

async function testTerminalRideStopsP2p() {
  const { drv, stops } = createTestDriver();
  await drv.start({
    rideId: "ride_stage3_terminal",
    trackingSessionId: TRACKING_SESSION_ID,
    vehicleId: "veh_s3",
  });
  await new Promise((r) => setTimeout(r, 30));

  for (const status of ["completed", "cancelled", "pending", ""]) {
    await drv.stop({ closeRemote: false });
    stops.length = 0;
    await drv.start({
      rideId: "ride_stage3_terminal",
      trackingSessionId: TRACKING_SESSION_ID,
      vehicleId: "veh_s3",
    });
    await new Promise((r) => setTimeout(r, 20));
    drv.syncForRide({
      ride: { id: "ride_stage3_terminal", status, vehicleId: "veh_s3" },
      trackingSessionId: TRACKING_SESSION_ID,
    });
    await new Promise((r) => setTimeout(r, 20));
    const st = drv.getState().state;
    record(
      `terminal-status-${status || "empty"}-stops-p2p`,
      st === P2P_STATE.DISABLED || st === P2P_STATE.CLOSED ? "PASS" : "FAIL",
      `state=${st}`
    );
  }
  void stops;
}

function staticDriverAppPresenceDecoupled() {
  const src = fs.readFileSync(DRIVER_APP, "utf8");
  const fn = src.slice(
    src.indexOf("function syncDriverP2pForActiveRide"),
    src.indexOf("function syncCheckpointPresenceForActiveRide")
  );
  record(
    "driver-app-syncDriverP2p-no-viewerVisible-param",
    !fn.includes("viewerVisible") ? "PASS" : "FAIL",
    fn.includes("viewerVisible") ? "still passes viewerVisible" : "decoupled"
  );
  record(
    "driver-app-no-driverP2p-suspend-calls",
    !src.includes("driverP2p.suspend") ? "PASS" : "FAIL"
  );
}

function staticControllerNoPresenceGate() {
  const src = fs.readFileSync(DRIVER_CTRL, "utf8");
  const fn = src.slice(src.indexOf("function syncForRide"), src.indexOf("function destroy()"));
  record(
    "controller-syncForRide-no-viewerVisible-param",
    !fn.includes("viewerVisible") && !fn.includes(".suspend(") ? "PASS" : "FAIL"
  );
  record(
    "controller-syncForRide-starts-for-execution-statuses",
    fn.includes("P2P_EXECUTION_STATUSES.includes(status)") && fn.includes("requestStart({")
      ? "PASS"
      : "FAIL"
  );
}

async function main() {
  console.log("\n=== STAGE 3 — driver P2P presence independence ===\n");
  await testActiveRideStartsP2pWithoutPresenceParam();
  await testRepeatedSyncDoesNotStopHealthySession();
  await testTerminalRideStopsP2p();
  staticDriverAppPresenceDecoupled();
  staticControllerNoPresenceGate();

  const pass = results.filter((r) => r.status === "PASS").length;
  const fail = results.filter((r) => r.status === "FAIL").length;
  const summary = {
    stage: 3,
    generatedAt: new Date().toISOString(),
    pass,
    fail,
    results,
  };
  fs.writeFileSync(OUT, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`\nStage 3 summary: ${pass} PASS / ${fail} FAIL`);
  console.log(`Wrote ${OUT}\n`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
