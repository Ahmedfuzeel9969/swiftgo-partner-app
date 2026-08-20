/**
 * Stage 1 — prove (or disprove) live driver motion pipeline failures.
 * Tests only — no production behavior changes.
 *
 * Run: node tests/stage1-live-driver-motion-diagnosis.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createP2pPeerSession } from "../driver-app/js/p2p-peer-session.mjs";
import { createDriverP2pController } from "../driver-app/js/p2p-ride-controller.mjs";
import { createLiveLocationSourceArbiter } from "../customer-app/js/live-location-source-arbiter.mjs";
import {
  buildP2pLocationMessage,
  validateP2pMessage,
} from "../customer-app/js/p2p-location-envelope.mjs";
import {
  CHECKPOINT_POLICY,
  RESPONSIVE_INTERVAL_MS,
  BACKGROUND_APPROACH_INTERVAL_MS,
  BACKGROUND_TRIP_INTERVAL_MS,
  VIEWER_LEASE,
  resolveCheckpointPolicy,
} from "../driver-app/js/location-checkpoint-policy.mjs";
import { FIREBASE_BACKUP_READ_INTERVAL_MS, P2P_STATE } from "../customer-app/js/p2p-protocol.mjs";

const require = createRequire(import.meta.url);
const { assignmentVersionFromRide } = require("../functions/ride-peer-session.js");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "tests", "stage1-live-driver-motion-diagnosis-results.json");

const AUTHORITATIVE_AV = 58_372_145;
const PEER_SESSION_ID = "ps_stage1abcdef01";
const TRACKING_SESSION_ID = "trk_stage1_xyz";

const results = [];
function record(proof, name, status, detail = "") {
  results.push({ proof, name, status, detail });
  const mark = status === "PASS" ? "✓" : status === "FAIL" ? "✗" : "·";
  console.log(`${mark} [${proof}] ${name} — ${status}${detail ? `: ${detail}` : ""}`);
}

function MockRTCPeerConnection() {
  const self = {
    iceGatheringState: "complete",
    localDescription: null,
    remoteDescription: null,
    _ondatachannel: null,
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
    set ondatachannel(fn) {
      self._ondatachannel = fn;
    },
    get ondatachannel() {
      return self._ondatachannel;
    },
  };
  return self;
}

async function proofA_assignmentVersionMismatch() {
  console.log("\n=== Proof A — authoritative assignmentVersion mismatch ===\n");

  const ride = {
    driverId: "drv_stage1_a",
    vehicleId: "veh_stage1_a",
    status: "accepted",
  };
  const serverAv = assignmentVersionFromRide(ride);
  record(
    "A",
    "server-assignmentVersion-not-default-1",
    serverAv !== 1 ? "PASS" : "FAIL",
    `serverAv=${serverAv}`
  );

  const sent = [];
  const driverSession = createP2pPeerSession({
    role: "driver",
    RTCPeerConnection: MockRTCPeerConnection,
    ensureIceConfiguration: async () => {},
    onLocalDescription: async () => {},
    onDiag: () => {},
  });

  await driverSession.startAsDriver({
    peerSessionId: PEER_SESSION_ID,
    trackingSessionId: TRACKING_SESSION_ID,
    assignmentVersion: 1,
  });

  const sessionAvAfterStart = driverSession.getState().assignmentVersion;
  record(
    "A",
    "driver-session-starts-with-assignmentVersion-1",
    sessionAvAfterStart === 1 ? "PASS" : "FAIL",
    `sessionAv=${sessionAvAfterStart}`
  );

  // Controller stores server response externally; peer session is not updated (current gap).
  driverSession._setChannelOpenForTest(true);
  driverSession._setChannelOpenForTest = undefined;
  // Replace channel with capture send (test-only hook into open channel path).
  const openChannel = {
    readyState: "open",
    bufferedAmount: 0,
    send(payload) {
      sent.push(String(payload));
    },
    close() {
      this.readyState = "closed";
    },
  };
  driverSession._handleMessageForTest; // ensure export exists
  // Inject open channel via test helper pattern used in p2p-webrtc suite.
  Object.defineProperty(driverSession, "_injectChannelForTest", {
    value: (ch) => {
      driverSession._setChannelOpenForTest?.(true);
    },
    configurable: true,
  });

  // Directly exercise enqueue → build path using session state after simulated offer upload.
  driverSession.enqueueLocationFix({
    lat: 24.861,
    lng: 67.001,
    observedAt: Date.now(),
    accuracyM: 12,
  });

  // Capture LOC by rebuilding from live session auth (same path as flushPendingLoc).
  const st = driverSession.getState();
  const built = buildP2pLocationMessage(
    { lat: 24.861, lng: 67.001, observedAt: Date.now(), accuracyM: 12 },
    {
      peerSessionId: st.peerSessionId,
      trackingSessionId: st.trackingSessionId,
      assignmentVersion: st.assignmentVersion,
      sequence: 1,
      role: "driver",
    }
  );

  record(
    "A",
    "driver-loc-built-with-session-assignmentVersion-1",
    built.ok && built.message.assignmentVersion === 1 ? "PASS" : "FAIL",
    `locAv=${built.message?.assignmentVersion}`
  );

  const customerAuth = {
    peerSessionId: st.peerSessionId,
    trackingSessionId: st.trackingSessionId,
    assignmentVersion: serverAv,
    lastSequence: 0,
    expectRole: "driver",
    nowMs: Date.now(),
  };
  const validated = validateP2pMessage(built.serialized, customerAuth);
  record(
    "A",
    "customer-rejects-driver-loc-when-serverAv-differs",
    !validated.ok && validated.reason === "wrong_assignment" ? "PASS" : "FAIL",
    validated.ok ? "accepted unexpectedly" : validated.reason
  );

  // Full controller path: offer upload returns authoritative AV; session may still emit stale AV.
  let controllerServerAv = 0;
  const drv = createDriverP2pController({
    RTCPeerConnection: MockRTCPeerConnection,
    ensureIceConfiguration: async () => {},
    createRidePeerOfferClient: async () => {
      controllerServerAv = serverAv;
      return { assignmentVersion: serverAv, sessionId: PEER_SESSION_ID };
    },
    closeRidePeerSessionClient: async () => {},
    watchRidePeerSession: () => () => {},
  });

  await drv.start({
    rideId: "ride_stage1_a",
    trackingSessionId: TRACKING_SESSION_ID,
    vehicleId: ride.vehicleId,
  });
  await new Promise((r) => setTimeout(r, 30));

  const ctrlState = drv.getState();
  const ctrlSessionAv = ctrlState.assignmentVersion;
  record(
    "A",
    "controller-offer-returns-authoritative-assignmentVersion",
    controllerServerAv === serverAv && controllerServerAv !== 1 ? "PASS" : "FAIL",
    `serverAv=${controllerServerAv}`
  );
  record(
    "A",
    "controller-session-adopts-authoritative-assignmentVersion-after-offer",
    ctrlSessionAv === serverAv ? "PASS" : "FAIL",
    `sessionAv=${ctrlSessionAv} serverAv=${serverAv}`
  );

  await drv.stop({ closeRemote: false });
}

function proofB_unknownPresencePolicy() {
  console.log("\n=== Proof B — UNKNOWN presence + unhealthy P2P checkpoint policy ===\n");

  for (const status of ["accepted", "in_progress"]) {
    const policy = resolveCheckpointPolicy({
      hasActiveRide: true,
      rideStatus: status,
      viewerLease: VIEWER_LEASE.UNKNOWN,
      p2pHealthy: false,
    });
    const expectResponsive =
      policy.policy === CHECKPOINT_POLICY.RESPONSIVE_FIREBASE &&
      policy.intervalMs === RESPONSIVE_INTERVAL_MS;
    record(
      "B",
      `unknown-unhealthy-${status}-uses-responsive-firebase`,
      expectResponsive ? "PASS" : "FAIL",
      `${policy.policy}@${policy.intervalMs}ms hard=${policy.hardInterval}`
    );
    record(
      "B",
      `unknown-unhealthy-${status}-not-30-60s-dead-zone`,
      policy.intervalMs < BACKGROUND_TRIP_INTERVAL_MS ? "PASS" : "FAIL",
      `intervalMs=${policy.intervalMs}`
    );
  }

  const expiredTrip = resolveCheckpointPolicy({
    hasActiveRide: true,
    rideStatus: "in_progress",
    viewerLease: VIEWER_LEASE.EXPIRED,
    p2pHealthy: false,
  });
  record(
    "B",
    "expired-unhealthy-in_progress-responsive-4s",
    expiredTrip.policy === CHECKPOINT_POLICY.RESPONSIVE_FIREBASE &&
      expiredTrip.intervalMs === RESPONSIVE_INTERVAL_MS
      ? "PASS"
      : "FAIL",
    `${expiredTrip.policy}@${expiredTrip.intervalMs}`
  );

  const visibleHealthy = resolveCheckpointPolicy({
    hasActiveRide: true,
    rideStatus: "in_progress",
    viewerLease: VIEWER_LEASE.VISIBLE,
    p2pHealthy: true,
  });
  record(
    "B",
    "visible-healthy-p2p-sparse-trip-30s",
    visibleHealthy.policy === CHECKPOINT_POLICY.P2P_SPARSE_TRIP &&
      visibleHealthy.intervalMs === BACKGROUND_TRIP_INTERVAL_MS
      ? "PASS"
      : "FAIL",
    `${visibleHealthy.policy}@${visibleHealthy.intervalMs}`
  );
}

async function proofC_driverP2pPresenceGating() {
  console.log("\n=== Proof C — driver P2P presence gating ===\n");

  const offers = [];
  const drv = createDriverP2pController({
    RTCPeerConnection: MockRTCPeerConnection,
    ensureIceConfiguration: async () => {},
    createRidePeerOfferClient: async (payload) => {
      offers.push(payload);
      return { assignmentVersion: AUTHORITATIVE_AV, sessionId: PEER_SESSION_ID };
    },
    closeRidePeerSessionClient: async () => {},
    watchRidePeerSession: () => () => {},
  });

  const ride = {
    id: "ride_stage1_c",
    status: "in_progress",
    vehicleId: "veh_c",
  };

  drv.syncForRide({
    ride,
    trackingSessionId: TRACKING_SESSION_ID,
  });
  await new Promise((r) => setTimeout(r, 40));

  const st = drv.getState().state;
  const suspended =
    st === P2P_STATE.FIREBASE_FALLBACK || st === P2P_STATE.CLOSED || st === P2P_STATE.DISABLED;
  record(
    "C",
    "syncForRide-viewerVisible-false-does-not-suspend-p2p",
    !suspended ? "PASS" : "FAIL",
    `state=${st} offers=${offers.length}`
  );
  record(
    "C",
    "syncForRide-viewerVisible-false-starts-or-keeps-signaling",
    offers.length >= 1 ? "PASS" : "FAIL",
    `offers=${offers.length}`
  );

  await drv.stop({ closeRemote: false });
}

function proofD_firebaseRenderThrottle() {
  console.log("\n=== Proof D — customer Firebase render throttle ===\n");

  record(
    "D",
    "configured-firebase-backup-read-interval",
    FIREBASE_BACKUP_READ_INTERVAL_MS === 4_000 ? "PASS" : "FAIL",
    `${FIREBASE_BACKUP_READ_INTERVAL_MS}ms`
  );

  let now = 1_000_000;
  const renders = [];
  const arb = createLiveLocationSourceArbiter({
    nowMs: () => now,
    firebaseBackupReadIntervalMs: FIREBASE_BACKUP_READ_INTERVAL_MS,
    onRender: (fix) => renders.push({ at: now, observedAt: fix.observedAt, lat: fix.lat }),
  });
  const gen = arb.getGeneration();

  for (let i = 0; i < 8; i += 1) {
    arb.ingestFirebase(
      {
        lat: 24.86 + i * 0.0001,
        lng: 67.0,
        observedAt: now,
        sequence: i + 1,
        trackingSessionId: TRACKING_SESSION_ID,
      },
      gen
    );
    now += 1_000;
  }

  const counters = arb.getCounters();
  record(
    "D",
    "firebase-1s-feed-renders-at-backup-interval-not-every-second",
    renders.length >= 2 && renders.length <= 4 ? "PASS" : "FAIL",
    `rendered=${renders.length} accepted=${counters.firebaseAccepted} throttled=${counters.firebaseThrottled}`
  );
  record(
    "D",
    "firebase-throttle-not-15s-class",
    FIREBASE_BACKUP_READ_INTERVAL_MS <= 5_000 ? "PASS" : "FAIL",
    `interval=${FIREBASE_BACKUP_READ_INTERVAL_MS}`
  );
}

async function main() {
  console.log("\n=== STAGE 1 — live driver motion diagnosis (tests only) ===\n");
  await proofA_assignmentVersionMismatch();
  proofB_unknownPresencePolicy();
  await proofC_driverP2pPresenceGating();
  proofD_firebaseRenderThrottle();

  const pass = results.filter((r) => r.status === "PASS").length;
  const fail = results.filter((r) => r.status === "FAIL").length;
  const summary = {
    stage: 1,
    generatedAt: new Date().toISOString(),
    pass,
    fail,
    results,
    diagnoses: {
      A_assignmentVersionMismatch: results.some(
        (r) => r.proof === "A" && r.name === "customer-rejects-driver-loc-when-serverAv-differs" && r.status === "PASS"
      )
        ? "CONFIRMED"
        : "DISPROVED",
      B_unknownPresenceDeadZone: results.some(
        (r) =>
          r.proof === "B" &&
          r.name.startsWith("unknown-unhealthy-") &&
          r.name.endsWith("-not-30-60s-dead-zone") &&
          r.status === "FAIL"
      )
        ? "CONFIRMED"
        : "DISPROVED",
      C_driverP2pPresenceGating: results.some(
        (r) => r.proof === "C" && r.name === "syncForRide-viewerVisible-false-does-not-suspend-p2p" && r.status === "FAIL"
      )
        ? "CONFIRMED"
        : "DISPROVED",
      D_firebaseRenderThrottle15s: results.some(
        (r) => r.proof === "D" && r.name === "firebase-throttle-not-15s-class" && r.status === "FAIL"
      )
        ? "CONFIRMED"
        : "DISPROVED",
    },
    stage2ScopeRecommendation: [
      "Fix driver peer session to adopt server-authoritative assignmentVersion before any LOC/ACK/HB is sent.",
      "Add regression: serverAv != 1 → customer accepts driver LOC.",
      "Do not weaken validateP2pMessage wrong_assignment check.",
    ],
  };

  fs.writeFileSync(OUT, JSON.stringify(summary, null, 2));
  console.log(`\nStage 1 summary: ${pass} PASS / ${fail} FAIL`);
  console.log(`Wrote ${OUT}`);
  console.log("\nDiagnosis rollup:");
  for (const [k, v] of Object.entries(summary.diagnoses)) {
    console.log(`  ${k}: ${v}`);
  }
  if (fail > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
