/**
 * P2P-3 — startup wiring: decouple driver offer from viewer lease.
 * Run: npm run test:p2p-startup-wiring
 */
import { createDriverP2pController } from "../driver-app/js/p2p-ride-controller.mjs";
import { createCustomerP2pController } from "../customer-app/js/p2p-ride-controller.mjs";
import { P2P_STATE } from "../driver-app/js/p2p-protocol.mjs";
import {
  VIEWER_LEASE,
  resolveCheckpointPolicy,
} from "../driver-app/js/location-checkpoint-policy.mjs";

const results = [];
/** @type {Array<{ stop: (opts?: object) => Promise<void> }>} */
const openControllers = [];

function record(name, status, detail = "") {
  results.push({ name, status, detail });
  const mark = status === "PASS" ? "✓" : status === "BLOCKED" ? "·" : "✗";
  console.log(`${mark} ${name}${detail ? ` — ${detail}` : ""}`);
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
        close() {},
        _open() {
          this.readyState = "open";
          this.onopen?.();
        },
      };
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

const RIDE = {
  id: "ride_startup01",
  status: "accepted",
  vehicleId: "veh1",
  assignmentSessionToken: "tok_v3",
};

const RIDE_B = {
  id: "ride_startup02",
  status: "accepted",
  vehicleId: "veh1",
  assignmentSessionToken: "tok_v3",
};

const TRACKING = "trk_startup01";
const ASSIGNMENT_V = 42;

function trackController(ctrl) {
  openControllers.push(ctrl);
  return ctrl;
}

async function cleanupControllers() {
  const stopping = openControllers.splice(0).map((ctrl) => ctrl.stop({ closeRemote: false }));
  await Promise.all(stopping);
}

function driverHarness() {
  let offerCalls = 0;
  const ctrl = trackController(createDriverP2pController({
    RTCPeerConnection: MockRTCPeerConnection,
    createRidePeerOfferClient: async () => {
      offerCalls += 1;
      return { assignmentVersion: ASSIGNMENT_V };
    },
    watchRidePeerSession: () => () => {},
  }));
  return { ctrl, getOfferCalls: () => offerCalls };
}

function customerHarness() {
  let answerCalls = 0;
  let watchCb = null;
  const ctrl = trackController(createCustomerP2pController({
    RTCPeerConnection: MockRTCPeerConnection,
    publishRidePeerAnswerClient: async () => {
      answerCalls += 1;
    },
    watchRidePeerSession: (_rid, onData) => {
      watchCb = onData;
      return () => {
        watchCb = null;
      };
    },
  }));
  return {
    ctrl,
    getAnswerCalls: () => answerCalls,
    emitOffer: (doc) => watchCb?.(doc),
  };
}

const OFFER_DOC = {
  sessionId: "ps_startup01",
  offer: "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n",
  trackingSessionId: TRACKING,
  assignmentVersion: ASSIGNMENT_V,
  state: "open",
};

async function test1UnknownLeaseStarts() {
  const { ctrl, getOfferCalls } = driverHarness();
  ctrl.syncForRide({
    ride: RIDE,
    trackingSessionId: TRACKING,
    assignmentVersion: ASSIGNMENT_V,
  });
  await new Promise((r) => setTimeout(r, 20));
  const c = ctrl.getCounters();
  return (c.sessionsStarted || 0) === 1 && getOfferCalls() === 1;
}

async function test2ExpiredLeaseStillStartsOnce() {
  const { ctrl, getOfferCalls } = driverHarness();
  for (let i = 0; i < 3; i += 1) {
    ctrl.syncForRide({
      ride: { ...RIDE, status: "arrived" },
      trackingSessionId: TRACKING,
      assignmentVersion: ASSIGNMENT_V,
    });
  }
  await new Promise((r) => setTimeout(r, 20));
  return (ctrl.getCounters().sessionsStarted || 0) === 1 && getOfferCalls() === 1;
}

async function test3HiddenViewerNoDuplicateOffers() {
  const { ctrl, getOfferCalls } = driverHarness();
  for (let i = 0; i < 5; i += 1) {
    ctrl.syncForRide({
      ride: { ...RIDE, status: "in_progress" },
      trackingSessionId: TRACKING,
      assignmentVersion: ASSIGNMENT_V,
    });
  }
  await new Promise((r) => setTimeout(r, 20));
  return (ctrl.getCounters().sessionsStarted || 0) === 1 && getOfferCalls() === 1;
}

async function test4UnknownToVisibleSameSession() {
  const { ctrl, getOfferCalls } = driverHarness();
  ctrl.syncForRide({
    ride: RIDE,
    trackingSessionId: TRACKING,
    assignmentVersion: ASSIGNMENT_V,
  });
  await new Promise((r) => setTimeout(r, 10));
  const started = ctrl.getCounters().sessionsStarted || 0;
  ctrl.syncForRide({
    ride: { ...RIDE, status: "arrived" },
    trackingSessionId: TRACKING,
    assignmentVersion: ASSIGNMENT_V,
  });
  await new Promise((r) => setTimeout(r, 10));
  return started === 1 && (ctrl.getCounters().sessionsStarted || 0) === 1 && getOfferCalls() === 1;
}

async function test5CustomerHiddenNoAnswer() {
  const { ctrl, getAnswerCalls, emitOffer } = customerHarness();
  ctrl.syncForRide(RIDE, { isVisible: false, assignmentVersion: ASSIGNMENT_V });
  emitOffer(OFFER_DOC);
  await new Promise((r) => setTimeout(r, 20));
  return (ctrl.getCounters().sessionsStarted || 0) === 0 && getAnswerCalls() === 0;
}

async function test6CustomerLaterVisibleAnswers() {
  const { ctrl, getAnswerCalls, emitOffer } = customerHarness();
  ctrl.syncForRide(RIDE, { isVisible: false, assignmentVersion: ASSIGNMENT_V });
  emitOffer(OFFER_DOC);
  await new Promise((r) => setTimeout(r, 10));
  ctrl.setVisible(true);
  await new Promise((r) => setTimeout(r, 30));
  return (ctrl.getCounters().sessionsStarted || 0) === 1 && getAnswerCalls() === 1;
}

async function test7RepeatedVisibilityNoDuplicateAnswer() {
  const { ctrl, getAnswerCalls, emitOffer } = customerHarness();
  ctrl.syncForRide(RIDE, { isVisible: false, assignmentVersion: ASSIGNMENT_V });
  emitOffer(OFFER_DOC);
  ctrl.setVisible(true);
  await new Promise((r) => setTimeout(r, 30));
  ctrl.setVisible(false);
  ctrl.setVisible(true);
  await new Promise((r) => setTimeout(r, 20));
  return (ctrl.getCounters().sessionsStarted || 0) === 1 && getAnswerCalls() === 1;
}

async function test8RematchClosesOldSession() {
  const { ctrl, getOfferCalls } = driverHarness();
  ctrl.syncForRide({
    ride: RIDE,
    trackingSessionId: TRACKING,
    assignmentVersion: ASSIGNMENT_V,
  });
  await new Promise((r) => setTimeout(r, 15));
  ctrl.syncForRide({
    ride: RIDE,
    trackingSessionId: "trk_startup02",
    assignmentVersion: ASSIGNMENT_V + 1,
  });
  await new Promise((r) => setTimeout(r, 25));
  return (ctrl.getCounters().sessionsStarted || 0) === 1 && getOfferCalls() === 2;
}

async function test9StaleOfferRejected() {
  const { ctrl, getAnswerCalls, emitOffer } = customerHarness();
  ctrl.syncForRide(RIDE, { isVisible: true, assignmentVersion: ASSIGNMENT_V });
  emitOffer({ ...OFFER_DOC, assignmentVersion: ASSIGNMENT_V - 1 });
  await new Promise((r) => setTimeout(r, 20));
  return (ctrl.getCounters().sessionsStarted || 0) === 0 && getAnswerCalls() === 0;
}

async function test10TerminalStopsSession() {
  const { ctrl } = driverHarness();
  ctrl.syncForRide({
    ride: RIDE,
    trackingSessionId: TRACKING,
    assignmentVersion: ASSIGNMENT_V,
  });
  await new Promise((r) => setTimeout(r, 15));
  ctrl.syncForRide({
    ride: { ...RIDE, status: "completed" },
    trackingSessionId: TRACKING,
    assignmentVersion: ASSIGNMENT_V,
  });
  await new Promise((r) => setTimeout(r, 15));
  const st = ctrl.getState().state;
  return st === P2P_STATE.DISABLED || st === P2P_STATE.CLOSED;
}

async function test11MissingTrackingNoStart() {
  const { ctrl, getOfferCalls } = driverHarness();
  ctrl.syncForRide({
    ride: RIDE,
    trackingSessionId: "",
    assignmentVersion: ASSIGNMENT_V,
  });
  await new Promise((r) => setTimeout(r, 10));
  return (ctrl.getCounters().sessionsStarted || 0) === 0 && getOfferCalls() === 0;
}

async function test12NoPeerGracefulFallback() {
  const ctrl = trackController(createDriverP2pController({
    RTCPeerConnection: undefined,
    createRidePeerOfferClient: async () => ({ assignmentVersion: 1 }),
    watchRidePeerSession: () => () => {},
  }));
  ctrl.syncForRide({
    ride: RIDE,
    trackingSessionId: TRACKING,
    assignmentVersion: ASSIGNMENT_V,
  });
  await new Promise((r) => setTimeout(r, 10));
  return ctrl.getState().state === P2P_STATE.FIREBASE_FALLBACK;
}

function test13OfferDoesNotChangeCheckpointCadence() {
  const base = {
    hasActiveRide: true,
    rideStatus: "accepted",
    viewerLease: VIEWER_LEASE.UNKNOWN,
  };
  const a = resolveCheckpointPolicy({ ...base, p2pHealthy: false });
  const b = resolveCheckpointPolicy({ ...base, p2pHealthy: true });
  return a.policy === b.policy && a.intervalMs === b.intervalMs;
}

async function test14OfferAloneNotHealthy() {
  const { ctrl } = driverHarness();
  ctrl.syncForRide({
    ride: RIDE,
    trackingSessionId: TRACKING,
    assignmentVersion: ASSIGNMENT_V,
  });
  await new Promise((r) => setTimeout(r, 20));
  const c = ctrl.getCounters();
  return (
    (c.sessionsStarted || 0) === 1 &&
    c.channelsOpened === 0 &&
    c.healthySessions === 0 &&
    !ctrl.isHealthy()
  );
}

async function test15LifecycleOneDriverSession() {
  const { ctrl, getOfferCalls } = driverHarness();
  for (const status of ["accepted", "arrived", "in_progress"]) {
    ctrl.syncForRide({
      ride: { ...RIDE, status },
      trackingSessionId: TRACKING,
      assignmentVersion: ASSIGNMENT_V,
    });
  }
  await new Promise((r) => setTimeout(r, 25));
  return (ctrl.getCounters().sessionsStarted || 0) === 1 && getOfferCalls() === 1;
}

async function test16VisibleViewerPathStillWorks() {
  const { ctrl, getOfferCalls } = driverHarness();
  ctrl.syncForRide({
    ride: RIDE,
    trackingSessionId: TRACKING,
    assignmentVersion: ASSIGNMENT_V,
  });
  await new Promise((r) => setTimeout(r, 20));
  const { ctrl: cust, emitOffer, getAnswerCalls } = customerHarness();
  cust.syncForRide(RIDE, { isVisible: true, assignmentVersion: ASSIGNMENT_V });
  emitOffer(OFFER_DOC);
  await new Promise((r) => setTimeout(r, 30));
  return (
    (ctrl.getCounters().sessionsStarted || 0) === 1 &&
    getOfferCalls() === 1 &&
    (cust.getCounters().sessionsStarted || 0) === 1 &&
    getAnswerCalls() === 1
  );
}

function deferredDriverHarness() {
  let offerCalls = 0;
  let releaseOffer = () => {};
  const offerGate = new Promise((resolve) => {
    releaseOffer = () => resolve(undefined);
  });
  const ctrl = trackController(createDriverP2pController({
    RTCPeerConnection: MockRTCPeerConnection,
    createRidePeerOfferClient: async () => {
      await offerGate;
      offerCalls += 1;
      return { assignmentVersion: ASSIGNMENT_V };
    },
    watchRidePeerSession: async () => () => {},
  }));
  return { ctrl, getOfferCalls: () => offerCalls, releaseOffer };
}

async function test17StopDuringStart() {
  const { ctrl, getOfferCalls, releaseOffer } = deferredDriverHarness();
  ctrl.syncForRide({
    ride: RIDE,
    trackingSessionId: TRACKING,
    assignmentVersion: ASSIGNMENT_V,
  });
  await new Promise((r) => setTimeout(r, 15));
  await ctrl.stop({ closeRemote: false });
  releaseOffer();
  await new Promise((r) => setTimeout(r, 30));
  const st = ctrl.getState().state;
  return ctrl.getOfferRequestCount() === 0 && (st === P2P_STATE.DISABLED || st === P2P_STATE.CLOSED);
}

async function test18TerminalDuringStart() {
  const { ctrl, getOfferCalls, releaseOffer } = deferredDriverHarness();
  ctrl.syncForRide({
    ride: RIDE,
    trackingSessionId: TRACKING,
    assignmentVersion: ASSIGNMENT_V,
  });
  await new Promise((r) => setTimeout(r, 15));
  ctrl.syncForRide({
    ride: { ...RIDE, status: "completed" },
    trackingSessionId: TRACKING,
    assignmentVersion: ASSIGNMENT_V,
  });
  releaseOffer();
  await new Promise((r) => setTimeout(r, 30));
  return ctrl.getOfferRequestCount() === 0 && ctrl.getState().state === P2P_STATE.DISABLED;
}

async function test19RematchDuringStart() {
  const { ctrl, getOfferCalls, releaseOffer } = deferredDriverHarness();
  ctrl.syncForRide({
    ride: RIDE,
    trackingSessionId: TRACKING,
    assignmentVersion: ASSIGNMENT_V,
  });
  await new Promise((r) => setTimeout(r, 15));
  ctrl.syncForRide({
    ride: RIDE,
    trackingSessionId: "trk_rematch_async",
    assignmentVersion: ASSIGNMENT_V + 1,
  });
  releaseOffer();
  await new Promise((r) => setTimeout(r, 40));
  return ctrl.getOfferRequestCount() === 1 && (ctrl.getCounters().sessionsStarted || 0) === 1;
}

async function test20AssignmentVersionChangeDuringStart() {
  const { ctrl, getOfferCalls, releaseOffer } = deferredDriverHarness();
  ctrl.syncForRide({
    ride: RIDE,
    trackingSessionId: TRACKING,
    assignmentVersion: ASSIGNMENT_V,
  });
  await new Promise((r) => setTimeout(r, 15));
  ctrl.syncForRide({
    ride: RIDE,
    trackingSessionId: TRACKING,
    assignmentVersion: ASSIGNMENT_V + 5,
  });
  releaseOffer();
  await new Promise((r) => setTimeout(r, 40));
  return ctrl.getOfferRequestCount() === 1;
}

function deferredCustomerHarness() {
  let answerCalls = 0;
  let releaseAnswer = () => {};
  const answerGate = new Promise((resolve) => {
    releaseAnswer = () => resolve(undefined);
  });
  let watchCb = null;
  const ctrl = trackController(createCustomerP2pController({
    RTCPeerConnection: MockRTCPeerConnection,
    publishRidePeerAnswerClient: async () => {
      await answerGate;
      answerCalls += 1;
    },
    watchRidePeerSession: (_rid, onData) => {
      watchCb = onData;
      return () => {
        watchCb = null;
      };
    },
  }));
  return { ctrl, getAnswerCalls: () => answerCalls, releaseAnswer, emitOffer: (doc) => watchCb?.(doc) };
}

async function test21StaleOfferCallbackAfterNewerAssignment() {
  const { ctrl, getAnswerCalls, releaseAnswer, emitOffer } = deferredCustomerHarness();
  ctrl.syncForRide(RIDE, { isVisible: true, assignmentVersion: ASSIGNMENT_V });
  emitOffer(OFFER_DOC);
  await new Promise((r) => setTimeout(r, 20));
  ctrl.syncForRide(RIDE, { isVisible: true, assignmentVersion: ASSIGNMENT_V + 9 });
  emitOffer({
    ...OFFER_DOC,
    sessionId: "ps_new_assignment",
    assignmentVersion: ASSIGNMENT_V + 9,
  });
  releaseAnswer();
  await new Promise((r) => setTimeout(r, 50));
  return ctrl.getAnswerRequestCount() === 1 && (ctrl.getCounters().sessionsStarted || 0) === 1;
}

async function test22RepeatedSnapshotsOneOfferCurrentAssignment() {
  const { ctrl, getOfferCalls, releaseOffer } = deferredDriverHarness();
  for (let i = 0; i < 4; i += 1) {
    ctrl.syncForRide({
      ride: { ...RIDE, status: i % 2 === 0 ? "accepted" : "arrived" },
      trackingSessionId: TRACKING,
      assignmentVersion: ASSIGNMENT_V,
    });
  }
  releaseOffer();
  await new Promise((r) => setTimeout(r, 40));
  return ctrl.getOfferRequestCount() === 1 && (ctrl.getCounters().sessionsStarted || 0) === 1;
}

function rideCaptureCustomerHarness({ deferAnswer = false } = {}) {
  let answerCalls = 0;
  const publishedRideIds = [];
  let releaseAnswer = () => {};
  const answerGate = deferAnswer
    ? new Promise((resolve) => {
        releaseAnswer = () => resolve(undefined);
      })
    : null;
  let watchCb = null;
  const ctrl = trackController(createCustomerP2pController({
    RTCPeerConnection: MockRTCPeerConnection,
    publishRidePeerAnswerClient: async ({ rideId }) => {
      if (answerGate) await answerGate;
      publishedRideIds.push(String(rideId || ""));
      answerCalls += 1;
    },
    watchRidePeerSession: (_rid, onData) => {
      watchCb = onData;
      return () => {
        watchCb = null;
      };
    },
  }));
  return {
    ctrl,
    getAnswerCalls: () => answerCalls,
    getPublishedRideIds: () => [...publishedRideIds],
    releaseAnswer,
    emitOffer: (doc) => watchCb?.(doc),
  };
}

function deferredWatchCustomerHarness() {
  let answerCalls = 0;
  const publishedRideIds = [];
  /** @type {Array<{ rid: string, onData: Function, complete: Function, unsubbed: boolean }>} */
  const pendingWatches = [];
  const ctrl = trackController(createCustomerP2pController({
    RTCPeerConnection: MockRTCPeerConnection,
    publishRidePeerAnswerClient: async ({ rideId }) => {
      publishedRideIds.push(String(rideId || ""));
      answerCalls += 1;
    },
    watchRidePeerSession: async (rid, onData) => {
      await new Promise((resolve) => {
        pendingWatches.push({
          rid: String(rid || ""),
          onData,
          complete: resolve,
          unsubbed: false,
        });
      });
      return () => {
        const entry = pendingWatches.find((w) => w.onData === onData);
        if (entry) entry.unsubbed = true;
      };
    },
  }));

  function resolveWatch(index) {
    const entry = pendingWatches[index];
    if (!entry) return false;
    entry.complete(undefined);
    return true;
  }

  return {
    ctrl,
    pendingWatches,
    resolveWatch,
    getAnswerCalls: () => answerCalls,
    getPublishedRideIds: () => [...publishedRideIds],
    emitCurrentOffer: (doc) => {
      const last = pendingWatches[pendingWatches.length - 1];
      last?.onData?.(doc);
    },
    staleEmit: (index, doc) => pendingWatches[index]?.onData?.(doc),
  };
}

function multiCallbackCustomerHarness() {
  let answerCalls = 0;
  /** @type {Array<{ rid: string, onData: Function }>} */
  const watchCallbacks = [];
  const ctrl = trackController(createCustomerP2pController({
    RTCPeerConnection: MockRTCPeerConnection,
    publishRidePeerAnswerClient: async () => {
      answerCalls += 1;
    },
    watchRidePeerSession: (rid, onData) => {
      watchCallbacks.push({ rid: String(rid || ""), onData });
      return () => {};
    },
  }));
  return {
    ctrl,
    watchCallbacks,
    getAnswerCalls: () => answerCalls,
    emitOnWatch: (index, doc) => watchCallbacks[index]?.onData?.(doc),
  };
}

async function waitUntil(fn, timeoutMs = 500) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 5));
  }
  return fn();
}

/** Ride switch during in-flight answer creation with same assignmentVersion invalidates publish. */
async function test23RideSwitchDuringAnswerSameAssignment() {
  const { ctrl, releaseAnswer, emitOffer, getPublishedRideIds, getAnswerCalls } =
    rideCaptureCustomerHarness({ deferAnswer: true });
  ctrl.syncForRide(RIDE, { isVisible: true, assignmentVersion: ASSIGNMENT_V });
  emitOffer(OFFER_DOC);
  const answering = await waitUntil(() => ctrl._isAnswering());
  if (!answering) return false;
  ctrl.syncForRide(RIDE_B, { isVisible: true, assignmentVersion: ASSIGNMENT_V });
  releaseAnswer();
  await new Promise((r) => setTimeout(r, 40));
  return (
    ctrl._getRideId() === RIDE_B.id &&
    getAnswerCalls() === 0 &&
    getPublishedRideIds().every((id) => id !== RIDE_B.id)
  );
}

/** Captured rideId ensures stale answer never targets the new ride during publish await. */
async function test24OldAnswerNeverPublishesToNewRide() {
  const { ctrl, releaseAnswer, emitOffer, getPublishedRideIds } =
    rideCaptureCustomerHarness({ deferAnswer: true });
  ctrl.syncForRide(RIDE, { isVisible: true, assignmentVersion: ASSIGNMENT_V });
  emitOffer(OFFER_DOC);
  await waitUntil(() => ctrl._isAnswering());
  ctrl.syncForRide(RIDE_B, { isVisible: true, assignmentVersion: ASSIGNMENT_V });
  releaseAnswer();
  await new Promise((r) => setTimeout(r, 40));
  const ids = getPublishedRideIds();
  return !ids.includes(RIDE_B.id) && ids.every((id) => id === RIDE.id || id === "");
}

/** Delayed watcher from old ride must not install after new ride binding. */
async function test25DelayedOldWatcherAfterRideSwitch() {
  const h = deferredWatchCustomerHarness();
  h.ctrl.syncForRide(RIDE, { isVisible: true, assignmentVersion: ASSIGNMENT_V });
  await new Promise((r) => setTimeout(r, 10));
  if (h.pendingWatches.length !== 1) return false;
  h.ctrl.syncForRide(RIDE_B, { isVisible: true, assignmentVersion: ASSIGNMENT_V });
  await new Promise((r) => setTimeout(r, 10));
  if (h.pendingWatches.length !== 2) return false;
  h.resolveWatch(0);
  await new Promise((r) => setTimeout(r, 15));
  const staleUnsubbed = h.pendingWatches[0]?.unsubbed === true;
  h.resolveWatch(1);
  await new Promise((r) => setTimeout(r, 15));
  return (
    staleUnsubbed &&
    h.ctrl._getRideId() === RIDE_B.id &&
    h.ctrl._isWatching() === true
  );
}

/** Delayed watcher resolving after stop must invoke stale unsubscribe immediately. */
async function test26DelayedWatcherAfterStop() {
  const h = deferredWatchCustomerHarness();
  h.ctrl.syncForRide(RIDE, { isVisible: true, assignmentVersion: ASSIGNMENT_V });
  await new Promise((r) => setTimeout(r, 10));
  await h.ctrl.stop({ closeRemote: false });
  h.resolveWatch(0);
  await new Promise((r) => setTimeout(r, 15));
  return h.pendingWatches[0]?.unsubbed === true && h.ctrl._isWatching() === false;
}

/** Stale watcher callback after ride switch must not start answers. */
async function test27StaleWatcherCallbackAfterRideSwitch() {
  const h = multiCallbackCustomerHarness();
  h.ctrl.syncForRide(RIDE, { isVisible: true, assignmentVersion: ASSIGNMENT_V });
  await new Promise((r) => setTimeout(r, 10));
  const staleCb = h.watchCallbacks[0]?.onData;
  if (!staleCb) return false;
  h.ctrl.syncForRide(RIDE_B, { isVisible: true, assignmentVersion: ASSIGNMENT_V });
  await new Promise((r) => setTimeout(r, 10));
  staleCb(OFFER_DOC);
  await new Promise((r) => setTimeout(r, 20));
  h.emitOnWatch(h.watchCallbacks.length - 1, {
    ...OFFER_DOC,
    sessionId: "ps_ride_b",
  });
  await new Promise((r) => setTimeout(r, 30));
  return h.getAnswerCalls() === 1 && (h.ctrl.getCounters().sessionsStarted || 0) === 1;
}

/** Current ride retains exactly one active watcher and one answer. */
async function test28OneWatcherOneAnswerForCurrentRide() {
  const h = multiCallbackCustomerHarness();
  h.ctrl.syncForRide(RIDE, { isVisible: true, assignmentVersion: ASSIGNMENT_V });
  await new Promise((r) => setTimeout(r, 10));
  h.ctrl.syncForRide(RIDE_B, { isVisible: true, assignmentVersion: ASSIGNMENT_V });
  await new Promise((r) => setTimeout(r, 10));
  if (h.watchCallbacks.length !== 2) return false;
  h.emitOnWatch(1, { ...OFFER_DOC, sessionId: "ps_current_ride" });
  await new Promise((r) => setTimeout(r, 30));
  return (
    h.ctrl._getRideId() === RIDE_B.id &&
    h.ctrl._isWatching() === true &&
    h.getAnswerCalls() === 1 &&
    (h.ctrl.getCounters().sessionsStarted || 0) === 1
  );
}

async function main() {
  try {
    record("1-unknown-lease-starts-offer", (await test1UnknownLeaseStarts()) ? "PASS" : "FAIL");
    record("2-expired-lease-starts-once", (await test2ExpiredLeaseStillStartsOnce()) ? "PASS" : "FAIL");
    record("3-hidden-viewer-no-duplicate-offers", (await test3HiddenViewerNoDuplicateOffers()) ? "PASS" : "FAIL");
    record("4-unknown-to-visible-same-session", (await test4UnknownToVisibleSameSession()) ? "PASS" : "FAIL");
    record("5-customer-hidden-no-answer", (await test5CustomerHiddenNoAnswer()) ? "PASS" : "FAIL");
    record("6-customer-later-visible-answers", (await test6CustomerLaterVisibleAnswers()) ? "PASS" : "FAIL");
    record("7-repeated-visibility-no-duplicate-answer", (await test7RepeatedVisibilityNoDuplicateAnswer()) ? "PASS" : "FAIL");
    record("8-rematch-new-session", (await test8RematchClosesOldSession()) ? "PASS" : "FAIL");
    record("9-stale-offer-rejected", (await test9StaleOfferRejected()) ? "PASS" : "FAIL");
    record("10-terminal-cleanup", (await test10TerminalStopsSession()) ? "PASS" : "FAIL");
    record("11-missing-tracking-no-start", (await test11MissingTrackingNoStart()) ? "PASS" : "FAIL");
    record("12-no-rtc-fallback", (await test12NoPeerGracefulFallback()) ? "PASS" : "FAIL");
    record("13-offer-not-checkpoint-cadence", test13OfferDoesNotChangeCheckpointCadence() ? "PASS" : "FAIL");
    record("14-offer-alone-not-healthy", (await test14OfferAloneNotHealthy()) ? "PASS" : "FAIL");
    record("15-lifecycle-one-driver-session", (await test15LifecycleOneDriverSession()) ? "PASS" : "FAIL");
    record("16-visible-viewer-path", (await test16VisibleViewerPathStillWorks()) ? "PASS" : "FAIL");
    record("17-stop-during-start", (await test17StopDuringStart()) ? "PASS" : "FAIL");
    record("18-terminal-during-start", (await test18TerminalDuringStart()) ? "PASS" : "FAIL");
    record("19-rematch-during-start", (await test19RematchDuringStart()) ? "PASS" : "FAIL");
    record("20-assignment-version-change-during-start", (await test20AssignmentVersionChangeDuringStart()) ? "PASS" : "FAIL");
    record("21-stale-offer-after-newer-assignment", (await test21StaleOfferCallbackAfterNewerAssignment()) ? "PASS" : "FAIL");
    record("22-repeated-snapshots-one-offer", (await test22RepeatedSnapshotsOneOfferCurrentAssignment()) ? "PASS" : "FAIL");
    record("23-ride-switch-during-answer-same-av", (await test23RideSwitchDuringAnswerSameAssignment()) ? "PASS" : "FAIL");
    record("24-old-answer-not-new-ride", (await test24OldAnswerNeverPublishesToNewRide()) ? "PASS" : "FAIL");
    record("25-delayed-old-watcher-ride-switch", (await test25DelayedOldWatcherAfterRideSwitch()) ? "PASS" : "FAIL");
    record("26-delayed-watcher-after-stop", (await test26DelayedWatcherAfterStop()) ? "PASS" : "FAIL");
    record("27-stale-watcher-callback-ride-switch", (await test27StaleWatcherCallbackAfterRideSwitch()) ? "PASS" : "FAIL");
    record("28-one-watcher-one-answer-current-ride", (await test28OneWatcherOneAnswerForCurrentRide()) ? "PASS" : "FAIL");
    record(
      "manual-two-device-p2p",
      "BLOCKED",
      "Requires physical two-browser validation"
    );
  } finally {
    await cleanupControllers();
  }

  const pass = results.filter((r) => r.status === "PASS").length;
  const fail = results.filter((r) => r.status === "FAIL").length;
  const blocked = results.filter((r) => r.status === "BLOCKED").length;
  console.log(`\nP2P startup wiring: ${pass} PASS / ${fail} FAIL / ${blocked} BLOCKED`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
