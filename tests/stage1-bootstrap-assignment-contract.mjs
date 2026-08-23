/**
 * Stage 1 — prove initial P2P offer assignmentVersion bootstrap mismatch (audit only).
 *
 * Uses REAL functions/ride-peer-session.js createRidePeerOffer + assignmentVersionFromRide.
 * Does NOT change production code.
 *
 * Run: node tests/stage1-bootstrap-assignment-contract.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createDriverP2pController } from "../driver-app/js/p2p-ride-controller.mjs";

const require = createRequire(import.meta.url);
const {
  assignmentVersionFromRide,
  createRidePeerOffer,
} = require("../functions/ride-peer-session.js");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "tests", "stage1-bootstrap-assignment-contract-results.json");

const DRIVER_UID = "drv_bootstrap_stage1";
const CUSTOMER_UID = "cust_bootstrap_stage1";
const RIDE_ID = "ride_bootstrap_stage1";
const VEHICLE_ID = "veh_bootstrap_stage1";
const TRACKING_SESSION_ID = "trk_bootstrap_s1";
const OFFER_SDP = "v=0\r\no=- bootstrap offer\r\n";
const PEER_SESSION_ID = "ps_bootstrap01";

const results = [];
function record(id, name, status, detail = "", category = "contract") {
  results.push({ id, name, status, detail, category });
  const mark = status === "PASS" ? "✓" : status === "FAIL" ? "✗" : status === "EXPECTED-FAIL" ? "!" : "·";
  console.log(`${mark} [${id}] ${name} — ${status}${detail ? `: ${detail}` : ""}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
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
      return { type: "offer", sdp: OFFER_SDP };
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

/** Minimal Firestore harness for createRidePeerOffer. */
function createMockDb(rideData) {
  const rides = new Map([[RIDE_ID, rideData]]);
  const sessions = new Map();
  return {
    sessions,
    collection(name) {
      return {
        doc(id) {
          return {
            async get() {
              if (name === "rides") {
                const data = rides.get(id);
                return data ? { exists: true, data: () => data } : { exists: false };
              }
              if (name === "ridePeerSessions") {
                const data = sessions.get(id);
                return data ? { exists: true, data: () => data } : { exists: false };
              }
              return { exists: false };
            },
            async set(payload) {
              if (name === "ridePeerSessions") sessions.set(id, payload);
            },
          };
        },
      };
    },
  };
}

function baseRide() {
  return {
    driverId: DRIVER_UID,
    userId: CUSTOMER_UID,
    vehicleId: VEHICLE_ID,
    status: "in_progress",
  };
}

function staticAudit() {
  console.log("\n=== Static audit — bootstrap contract sources ===\n");

  const controller = read("driver-app/js/p2p-ride-controller.mjs");
  const driverApp = read("driver-app/js/driver-app.js");
  const stage5 = read("tests/stage5-full-chain-marker-motion.mjs");
  const stage2Av = read("tests/stage2-assignment-version-sync.mjs");

  record(
    "S1",
    "controller-requestStart-coerces-unknown-to-1",
    /Math\.max\(1,\s*Math\.floor\(Number\(target\?\.assignmentVersion\)/.test(controller)
      ? "PASS"
      : "FAIL",
    "requestStart uses Math.max(1, … || 0)",
    "static"
  );
  record(
    "S2",
    "controller-offer-publish-sends-truthy-assignmentVersion",
    /assignmentVersion:\s*target\.assignmentVersion\s*\|\|\s*undefined/.test(controller)
      ? "PASS"
      : "FAIL",
    "when internal AV=1, payload includes assignmentVersion: 1",
    "static"
  );
  record(
    "S3",
    "peer-session-startAsDriver-floors-unknown-to-1",
    /assignmentVersion\s*=\s*Math\.max\(1,\s*Math\.floor\(Number\(meta\.assignmentVersion\)\s*\|\|\s*1\)\)/.test(
      read("driver-app/js/p2p-peer-session.mjs")
    )
      ? "PASS"
      : "FAIL",
    "session bootstrap uses placeholder 1 before server AV",
    "static"
  );
  record(
    "S4",
    "driver-app-syncForRide-omits-assignmentVersion",
    driverApp.includes("driverP2p.syncForRide({") &&
      !/driverP2p\.syncForRide\([\s\S]{0,200}assignmentVersion:/.test(driverApp)
      ? "PASS"
      : "FAIL",
    "production path passes ride+trackingSessionId only",
    "static"
  );
  record(
    "S5",
    "server-STALE-when-clientAv-nonzero-and-differs",
    read("functions/ride-peer-session.js").includes('new Error("STALE_ASSIGNMENT")') &&
      read("functions/ride-peer-session.js").includes("if (clientAv && clientAv !== assignmentVersion)")
      ? "PASS"
      : "FAIL",
    "authoritative server check present",
    "static"
  );
  record(
    "S6",
    "stage5-mock-skips-STALE_ASSIGNMENT",
    stage5.includes("createRidePeerOfferClient") &&
      !stage5.includes("STALE_ASSIGNMENT")
      ? "PASS"
      : "FAIL",
    "permissive hub always accepts offer",
    "static"
  );
  record(
    "S7",
    "stage2-mock-skips-STALE_ASSIGNMENT",
    stage2Av.includes("createRidePeerOfferClient") && !stage2Av.includes("STALE_ASSIGNMENT")
      ? "PASS"
      : "FAIL",
    "returns serverAv without enforcing clientAv gate",
    "static"
  );
}

async function serverContractTests() {
  console.log("\n=== Real server contract (createRidePeerOffer) ===\n");

  const ride = baseRide();
  const serverAv = assignmentVersionFromRide(ride);
  record(
    "B0",
    "authoritative-assignmentVersion-not-1-for-real-ride",
    serverAv !== 1 ? "PASS" : "FAIL",
    `serverAv=${serverAv}`,
    "contract"
  );

  const db = createMockDb(ride);
  const baseInput = {
    driverUid: DRIVER_UID,
    rideId: RIDE_ID,
    offerSdp: OFFER_SDP,
    trackingSessionId: TRACKING_SESSION_ID,
    peerSessionId: PEER_SESSION_ID,
    vehicleId: VEHICLE_ID,
  };

  // B — client sends placeholder 1 → STALE_ASSIGNMENT when serverAv != 1
  if (serverAv !== 1) {
    let staleThrown = false;
    try {
      await createRidePeerOffer(db, { ...baseInput, assignmentVersion: 1 });
    } catch (err) {
      staleThrown = err?.message === "STALE_ASSIGNMENT" && err?.code === "failed-precondition";
    }
    record(
      "B",
      "server-rejects-client-assignmentVersion-1-when-authoritative-differs",
      staleThrown ? "PASS" : "FAIL",
      `clientAv=1 serverAv=${serverAv}`,
      "contract"
    );
  } else {
    record(
      "B",
      "server-rejects-client-assignmentVersion-1-when-authoritative-differs",
      "SKIP",
      "degenerate serverAv=1 for fixture ride",
      "contract"
    );
  }

  // C — explicit wrong non-zero
  let wrongRejected = false;
  try {
    await createRidePeerOffer(db, { ...baseInput, assignmentVersion: serverAv + 999 });
  } catch (err) {
    wrongRejected = err?.message === "STALE_ASSIGNMENT";
  }
  record(
    "C",
    "server-rejects-explicit-wrong-nonzero-assignmentVersion",
    wrongRejected ? "PASS" : "FAIL",
    `wrong=${serverAv + 999} expected=${serverAv}`,
    "contract"
  );

  // D — bootstrap: omit / zero client AV succeeds
  let bootstrapOk = false;
  let bootstrapAv = 0;
  try {
    const resOmit = await createRidePeerOffer(createMockDb(ride), {
      ...baseInput,
      peerSessionId: "ps_bootstrap02",
    });
    bootstrapOk =
      resOmit?.ok === true && Number(resOmit.assignmentVersion) === serverAv;
    bootstrapAv = Number(resOmit?.assignmentVersion) || 0;
  } catch (err) {
    record(
      "D",
      "server-bootstrap-omitted-client-assignmentVersion-succeeds",
      "FAIL",
      String(err?.message || err),
      "contract"
    );
  }
  if (bootstrapOk) {
    record(
      "D",
      "server-bootstrap-omitted-client-assignmentVersion-succeeds",
      "PASS",
      `returnedAv=${bootstrapAv}`,
      "contract"
    );
  }

  let zeroOk = false;
  try {
    const resZero = await createRidePeerOffer(createMockDb(ride), {
      ...baseInput,
      peerSessionId: "ps_bootstrap03",
      assignmentVersion: 0,
    });
    zeroOk =
      resZero?.ok === true && Number(resZero.assignmentVersion) === serverAv;
  } catch (err) {
    record(
      "D2",
      "server-bootstrap-zero-client-assignmentVersion-succeeds",
      "FAIL",
      String(err?.message || err),
      "contract"
    );
  }
  if (zeroOk) {
    record(
      "D2",
      "server-bootstrap-zero-client-assignmentVersion-succeeds",
      "PASS",
      `returnedAv=${serverAv}`,
      "contract"
    );
  }
}

async function controllerBootstrapEvidence() {
  console.log("\n=== Driver controller first-offer payload (production path) ===\n");

  const ride = {
    id: RIDE_ID,
    driverId: DRIVER_UID,
    vehicleId: VEHICLE_ID,
    status: "in_progress",
  };
  const serverAv = assignmentVersionFromRide(ride);

  /** @type {object|null} */
  let capturedOfferPayload = null;
  let serverRejected = false;

  const drv = createDriverP2pController({
    RTCPeerConnection: MockRTCPeerConnection,
    ensureIceConfiguration: async () => {},
    createRidePeerOfferClient: async (payload) => {
      capturedOfferPayload = { ...payload };
      const db = createMockDb(baseRide());
      try {
        return await createRidePeerOffer(db, {
          driverUid: DRIVER_UID,
          rideId: payload.rideId,
          offerSdp: payload.offerSdp,
          trackingSessionId: payload.trackingSessionId,
          peerSessionId: payload.peerSessionId,
          vehicleId: payload.vehicleId,
          assignmentVersion: payload.assignmentVersion,
        });
      } catch (err) {
        if (err?.message === "STALE_ASSIGNMENT") serverRejected = true;
        throw err;
      }
    },
    closeRidePeerSessionClient: async () => {},
    watchRidePeerSession: () => () => {},
  });

  // Mirrors driver-app.js syncDriverP2pForActiveRide — no assignmentVersion passed
  drv.syncForRide({
    ride,
    trackingSessionId: TRACKING_SESSION_ID,
  });
  await sleep(200);

  const sentAv = Math.floor(Number(capturedOfferPayload?.assignmentVersion) || 0);
  const sessionAv = Math.floor(Number(drv.getState().assignmentVersion) || 0);

  record(
    "A1",
    "production-syncForRide-omits-assignmentVersion-on-offer-payload",
    capturedOfferPayload &&
      (capturedOfferPayload.assignmentVersion === undefined ||
        capturedOfferPayload.assignmentVersion === null)
      ? "PASS"
      : sentAv === 1
        ? "EXPECTED-FAIL"
        : "FAIL",
    `payloadAssignmentVersion=${String(capturedOfferPayload?.assignmentVersion)} sentAv=${sentAv}`,
    "controller"
  );

  record(
    "A2",
    "controller-internal-normalizes-unknown-to-1-before-offer",
    sentAv === 1 || sessionAv === 1 ? "EXPECTED-FAIL" : "PASS",
    `payloadAv=${sentAv} sessionAv=${sessionAv} (bug: unknown→1)`,
    "controller"
  );

  record(
    "A3",
    "strict-server-rejects-controller-first-offer-when-sends-1",
    serverAv !== 1 && sentAv === 1 && serverRejected ? "PASS" : sentAv !== 1 ? "SKIP" : "FAIL",
    `serverAv=${serverAv} sentAv=${sentAv} rejected=${serverRejected}`,
    "controller"
  );

  record(
    "A4",
    "offer-publish-failure-recorded-on-STALE_ASSIGNMENT",
    serverRejected && (drv.getCounters?.()?.offerPublishFailures || 0) >= 1 ? "PASS" : "FAIL",
    `offerPublishFailures=${drv.getCounters?.()?.offerPublishFailures || 0}`,
    "controller"
  );

  await drv.stop({ closeRemote: false });
}

async function main() {
  console.log("\n=== STAGE 1 — bootstrap assignmentVersion contract (audit only) ===\n");
  console.log("No production changes in this stage.\n");

  staticAudit();
  await serverContractTests();
  await controllerBootstrapEvidence();

  const pass = results.filter((r) => r.status === "PASS").length;
  const expectedFail = results.filter((r) => r.status === "EXPECTED-FAIL").length;
  const fail = results.filter((r) => r.status === "FAIL").length;
  const skip = results.filter((r) => r.status === "SKIP").length;

  const summary = {
    stage: 1,
    suite: "bootstrap-assignment-contract",
    productionChanges: false,
    generatedAt: new Date().toISOString(),
    pass,
    expectedFail,
    fail,
    skip,
    rootCause:
      "Driver p2p-ride-controller requestStart uses Math.max(1, …||0), so unknown assignmentVersion becomes 1; " +
      "createRidePeerOffer payload then includes assignmentVersion: 1; real server STALE_ASSIGNMENT rejects when authoritative AV != 1.",
    evidence: {
      controllerCoercionLine: "driver-app/js/p2p-ride-controller.mjs requestStart: Math.max(1, floor(target.assignmentVersion || synced || 0))",
      offerPayloadLine:
        "onLocalDescription offer publish: assignmentVersion: target.assignmentVersion || undefined",
      productionPath: "driver-app.js syncDriverP2pForActiveRide → syncForRide without assignmentVersion",
      serverGate: "functions/ride-peer-session.js createRidePeerOffer: if (clientAv && clientAv !== assignmentVersion) throw STALE_ASSIGNMENT",
      priorTestsGap: "stage2/stage5 mocks never enforce STALE_ASSIGNMENT on clientAv mismatch",
    },
    results,
  };

  fs.writeFileSync(OUT, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`\nStage 1 bootstrap contract: ${pass} PASS, ${expectedFail} EXPECTED-FAIL (bug proven), ${fail} FAIL, ${skip} SKIP`);
  console.log(`Wrote ${OUT}\n`);

  // Stage 1 succeeds when bug is proven (EXPECTED-FAIL on A2) and contracts B/C/D pass
  const bugProven = results.some((r) => r.id === "A2" && r.status === "EXPECTED-FAIL") &&
    results.some((r) => r.id === "B" && r.status === "PASS") &&
    results.some((r) => r.id === "A3" && r.status === "PASS");
  if (!bugProven || fail > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
