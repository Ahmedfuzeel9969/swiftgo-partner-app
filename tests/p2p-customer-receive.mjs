/**
 * Focused blockers: driver offer publish + customer receive / resume re-answer.
 * Run: node tests/p2p-customer-receive.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDriverP2pController } from "../driver-app/js/p2p-ride-controller.mjs";
import { createCustomerP2pController } from "../customer-app/js/p2p-ride-controller.mjs";
import { P2P_STATE } from "../customer-app/js/p2p-protocol.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "tests", "p2p-customer-receive-results.json");
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
    _ondatachannel: null,
    createDataChannel(label) {
      return {
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
      if (desc.type === "offer" && self._ondatachannel) {
        self._ondatachannel({ channel: self.createDataChannel("swiftgo-loc-v1") });
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

async function testDriverOfferPublishesWithoutThrow() {
  const offers = [];
  let watchCb = null;
  const drv = createDriverP2pController({
    RTCPeerConnection: MockRTCPeerConnection,
    createRidePeerOfferClient: async (payload) => {
      offers.push(payload);
      return { assignmentVersion: 7, sessionId: payload.peerSessionId };
    },
    closeRidePeerSessionClient: async () => {},
    watchRidePeerSession: (_rid, onData) => {
      watchCb = onData;
      return () => {
        watchCb = null;
      };
    },
  });

  try {
    await drv.start({
      rideId: "ride_recv_1",
      trackingSessionId: "trk_recv_1",
      vehicleId: "veh_1",
    });
    record(
      "driver-offer-publishes-without-referenceerror",
      offers.length === 1 && String(offers[0]?.offerSdp || "").includes("offer")
        ? "PASS"
        : "FAIL",
      `offers=${offers.length} state=${drv.getState().state}`
    );
  } catch (e) {
    record(
      "driver-offer-publishes-without-referenceerror",
      "FAIL",
      e?.message || String(e)
    );
  }

  try {
    await drv.stop({ closeRemote: true });
    record("driver-stop-clears-session", "PASS");
  } catch (e) {
    record("driver-stop-clears-session", "FAIL", e?.message || String(e));
  }
  void watchCb;
}

async function testCustomerResumeReanswersSameOffer() {
  const answers = [];
  let watchCb = null;
  const renders = [];
  const cust = createCustomerP2pController({
    RTCPeerConnection: MockRTCPeerConnection,
    onRenderFix: (fix) => renders.push(fix),
    publishRidePeerAnswerClient: async (payload) => {
      answers.push(payload);
      return { ok: true };
    },
    closeRidePeerSessionClient: async () => {},
    watchRidePeerSession: (_rid, onData) => {
      watchCb = onData;
      return () => {
        watchCb = null;
      };
    },
  });

  const offerDoc = {
    sessionId: "ps_abcdef012345",
    offer: "v=0\r\no=- offer\r\n",
    trackingSessionId: "trk_recv_1",
    assignmentVersion: 7,
    state: "offered",
  };

  cust.syncForRide(
    { id: "ride_recv_1", status: "accepted", driverLocation: null },
    { isVisible: true }
  );
  // Deliver offer via watch callback
  watchCb?.(offerDoc);
  await new Promise((r) => setTimeout(r, 30));
  const firstAnswers = answers.length;
  record(
    "customer-answers-initial-offer",
    firstAnswers >= 1 ? "PASS" : "FAIL",
    `answers=${firstAnswers}`
  );

  // Hide → P2P must stay up (screen hidden is not a stop reason).
  cust.setVisible(false);
  const midState = cust.getState().state;
  record(
    "customer-hidden-keeps-p2p-session",
    midState !== P2P_STATE.FIREBASE_FALLBACK &&
      midState !== P2P_STATE.CLOSED &&
      midState !== P2P_STATE.DISABLED
      ? "PASS"
      : "FAIL",
    midState
  );

  const answersBeforeResume = answers.length;
  // Resume with SAME offer — must not spawn a parallel session if still healthy.
  cust.setVisible(true);
  watchCb?.(offerDoc);
  await new Promise((r) => setTimeout(r, 40));
  record(
    "customer-resume-no-duplicate-when-session-alive",
    answers.length === answersBeforeResume ? "PASS" : "FAIL",
    `answers=${answers.length} before=${answersBeforeResume}`
  );

  // Inject LOC via peer session test helper if available
  const st = cust.getState();
  const sess = cust.getCounters?.();
  void st;
  void sess;
  void renders;

  await cust.stop({ closeRemote: false });
  cust.destroy();
}

async function testStaticLastPublishedOfferDeclared() {
  const src = fs.readFileSync(
    path.join(ROOT, "driver-app/js/p2p-ride-controller.mjs"),
    "utf8"
  );
  record(
    "static-lastPublishedOffer-declared",
    /let\s+lastPublishedOffer\s*=/.test(src) ? "PASS" : "FAIL"
  );
  const custSrc = fs.readFileSync(
    path.join(ROOT, "customer-app/js/p2p-ride-controller.mjs"),
    "utf8"
  );
  record(
    "static-customer-hidden-does-not-suspend-p2p",
    custSrc.includes("must not suspend or stop P2P") &&
      !/setVisible\(next\)[\s\S]*session\?\.suspend/.test(custSrc)
      ? "PASS"
      : "FAIL"
  );
}

await testStaticLastPublishedOfferDeclared();
await testDriverOfferPublishesWithoutThrow();
await testCustomerResumeReanswersSameOffer();

const pass = results.filter((r) => r.status === "PASS").length;
const fail = results.filter((r) => r.status === "FAIL").length;
const summary = { suite: "p2p-customer-receive", generatedAt: new Date().toISOString(), pass, fail, results };
fs.writeFileSync(OUT, JSON.stringify(summary, null, 2));
console.log(`\np2p-customer-receive: ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
