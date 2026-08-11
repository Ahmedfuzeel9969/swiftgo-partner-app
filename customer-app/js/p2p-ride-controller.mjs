/**
 * Phase 3 — customer P2P ride controller (answer + ingest) + source arbiter bridge.
 */

import { P2P_STATE, P2P_EXECUTION_STATUSES } from "./p2p-protocol.mjs";
import { createP2pPeerSession } from "./p2p-peer-session.mjs";
import { createLiveLocationSourceArbiter } from "./live-location-source-arbiter.mjs";

async function loadSignalingClient() {
  return import("./p2p-signaling-client.mjs");
}

function answerIdentity(rideId, docData, fallbackVersion = 0) {
  const rid = String(rideId || "").trim();
  const sid = String(docData?.sessionId || "").trim();
  const tid = String(docData?.trackingSessionId || "").trim();
  const av = Number(docData?.assignmentVersion) || Math.max(1, Math.floor(Number(fallbackVersion) || 0));
  return `${rid}|${sid}|${tid}|${av}`;
}

/**
 * @param {{
 *   onRenderFix?: (fix: object, meta: object) => void,
 *   onDiag?: (code: string) => void,
 *   RTCPeerConnection?: typeof RTCPeerConnection,
 *   watchRidePeerSession?: Function,
 *   publishRidePeerAnswerClient?: Function,
 *   closeRidePeerSessionClient?: Function,
 * }} [opts]
 */
export function createCustomerP2pController(opts = {}) {
  const diag = opts.onDiag || (() => {});
  const watchSession =
    typeof opts.watchRidePeerSession === "function"
      ? opts.watchRidePeerSession
      : async (...args) => {
          const { watchRidePeerSession } = await loadSignalingClient();
          return watchRidePeerSession(...args);
        };
  const publishAnswerClient =
    typeof opts.publishRidePeerAnswerClient === "function"
      ? opts.publishRidePeerAnswerClient
      : async (payload) => {
          const { publishRidePeerAnswerClient } = await loadSignalingClient();
          return publishRidePeerAnswerClient(payload);
        };
  const closeSignalingClient =
    typeof opts.closeRidePeerSessionClient === "function"
      ? opts.closeRidePeerSessionClient
      : async (payload) => {
          const { closeRidePeerSessionClient } = await loadSignalingClient();
          return closeRidePeerSessionClient(payload);
        };
  const arbiter = createLiveLocationSourceArbiter({
    onDiag: diag,
    onRender: (fix, meta) => opts.onRenderFix?.(fix, meta),
  });

  let session = null;
  let unwatch = () => {};
  let rideId = "";
  let boundSessionId = "";
  let closed = false;
  let answering = false;
  let visible = true;
  let watching = false;
  let pendingOfferDoc = null;
  let expectedAssignmentVersion = 0;
  let answerGeneration = 0;
  let watchGeneration = 0;
  let answerRequestCount = 0;
  /** @type {object | null} */
  let queuedAnswerDoc = null;

  function invokeUnwatch(fn) {
    if (typeof fn !== "function") return;
    try {
      fn();
    } catch {
      /* ignore */
    }
  }

  function detachWatch() {
    invokeUnwatch(unwatch);
    unwatch = () => {};
    watching = false;
  }

  function invalidateWatch() {
    watchGeneration += 1;
    detachWatch();
  }

  function destroySession() {
    const s = session;
    session = null;
    boundSessionId = "";
    if (s) void s.close({ reason: "destroy" });
    arbiter.noteP2pUnhealthy();
  }

  function invalidateAnswerState() {
    answerGeneration += 1;
    queuedAnswerDoc = null;
    pendingOfferDoc = null;
  }

  async function closeSignaling(forRideId = rideId) {
    const id = String(forRideId || "").trim();
    if (!id) return;
    try {
      await closeSignalingClient({ rideId: id });
    } catch {
      /* ignore */
    }
  }

  function isOfferCurrent(docData, forRideId = rideId) {
    if (!docData) return false;
    const contextRideId = String(forRideId || "").trim();
    if (!contextRideId || contextRideId !== String(rideId || "").trim()) return false;
    const sid = String(docData?.sessionId || "");
    const offer = String(docData?.offer || "");
    if (!sid || !offer) return false;
    if (String(docData.state || "") === "closed") return false;
    const docAv = Number(docData.assignmentVersion) || 0;
    if (expectedAssignmentVersion > 0 && docAv > 0 && docAv !== expectedAssignmentVersion) {
      return false;
    }
    return true;
  }

  function isWatchCurrent(gen, watchRideId) {
    return !closed && gen === watchGeneration && String(watchRideId || "").trim() === String(rideId || "").trim();
  }

  function isAnswerStillValid(gen, capturedRideId, docData) {
    if (closed || !visible || gen !== answerGeneration) return false;
    const rid = String(capturedRideId || "").trim();
    if (!rid || rid !== String(rideId || "").trim()) return false;
    return isOfferCurrent(docData, capturedRideId);
  }

  function abortStaleAnswer(localSession) {
    if (localSession && localSession !== session) {
      void localSession.close({ reason: "stale_answer" });
    } else if (localSession === session) {
      void localSession.close({ reason: "stale_answer" });
      session = null;
      boundSessionId = "";
    }
  }

  function invalidateAnswer() {
    invalidateAnswerState();
  }

  function resetRideContext({ closeRemote = false } = {}) {
    invalidateAnswerState();
    invalidateWatch();
    pendingOfferDoc = null;
    if (closeRemote) void closeSignaling();
    destroySession();
    expectedAssignmentVersion = 0;
    rideId = "";
    arbiter.reset();
  }

  function queueAnswer(docData) {
    if (!visible || closed || !isOfferCurrent(docData)) return;
    const sid = String(docData?.sessionId || "");
    if (boundSessionId === sid && session) return;

    const prevKey = queuedAnswerDoc
      ? answerIdentity(rideId, queuedAnswerDoc, expectedAssignmentVersion)
      : "";
    const newKey = answerIdentity(rideId, docData, expectedAssignmentVersion);
    queuedAnswerDoc = docData;
    pendingOfferDoc = docData;

    if (answering && prevKey && prevKey !== newKey) {
      answerGeneration += 1;
    }

    if (answering) return;
    void runAnswerLoop();
  }

  async function runAnswerLoop() {
    if (answering || closed || !visible) return;
    answering = true;
    try {
      while (queuedAnswerDoc && visible && !closed) {
        const docData = queuedAnswerDoc;
        queuedAnswerDoc = null;
        const capturedRideId = String(rideId || "").trim();
        if (!isOfferCurrent(docData, capturedRideId)) continue;

        answerGeneration += 1;
        const gen = answerGeneration;
        const sid = String(docData?.sessionId || "");
        const offer = String(docData?.offer || "");

        destroySession();
        boundSessionId = sid;

        const localSession = createP2pPeerSession({
          role: "customer",
          RTCPeerConnection: opts.RTCPeerConnection,
          onDiag: diag,
          onState: (st) => {
            if (localSession !== session) return;
            if (st === P2P_STATE.FIREBASE_FALLBACK || st === P2P_STATE.P2P_DEGRADED) {
              arbiter.noteP2pUnhealthy();
            }
          },
          onLocationFix: (fix) => {
            if (localSession === session) {
              arbiter.ingestP2p(fix, arbiter.getGeneration());
            }
          },
          onLocalDescription: async (kind, sdp, meta) => {
            if (kind !== "answer") return;
            if (!isAnswerStillValid(gen, capturedRideId, docData) || localSession !== session) return;
            await publishAnswerClient({
              rideId: capturedRideId,
              answerSdp: sdp,
              peerSessionId: meta.peerSessionId,
            });
            if (!isAnswerStillValid(gen, capturedRideId, docData) || localSession !== session) return;
            answerRequestCount += 1;
          },
        });

        session = localSession;

        await localSession.startAsCustomer({
          peerSessionId: sid,
          trackingSessionId: String(docData.trackingSessionId || ""),
          assignmentVersion: Number(docData.assignmentVersion) || expectedAssignmentVersion || 1,
          offerSdp: offer,
        });

        if (!isAnswerStillValid(gen, capturedRideId, docData)) {
          abortStaleAnswer(localSession);
          if (session === localSession) session = null;
          continue;
        }

        pendingOfferDoc = null;
      }
    } catch {
      destroySession();
    } finally {
      answering = false;
      if (queuedAnswerDoc && visible && !closed) {
        void runAnswerLoop();
      }
    }
  }

  async function answerOffer(docData) {
    queueAnswer(docData);
  }

  function attachWatch(rid) {
    invalidateWatch();

    watchGeneration += 1;
    const gen = watchGeneration;
    const watchRideId = String(rid || "").trim();
    watching = true;

    void (async () => {
      let localUnwatch = () => {};
      try {
        localUnwatch = await watchSession(
          watchRideId,
          (docData) => {
            if (!isWatchCurrent(gen, watchRideId)) return;
            if (!docData) {
              if (isWatchCurrent(gen, watchRideId)) pendingOfferDoc = null;
              return;
            }
            if (isOfferCurrent(docData, watchRideId)) {
              pendingOfferDoc = docData;
            } else if (
              expectedAssignmentVersion > 0 &&
              Number(docData.assignmentVersion) > 0 &&
              Number(docData.assignmentVersion) !== expectedAssignmentVersion
            ) {
              pendingOfferDoc = null;
              return;
            }
            if (!visible) return;
            queueAnswer(docData);
          },
          () => {
            if (!isWatchCurrent(gen, watchRideId)) return;
            arbiter.noteP2pUnhealthy();
          }
        );
      } catch {
        if (isWatchCurrent(gen, watchRideId)) watching = false;
        return;
      }

      if (!isWatchCurrent(gen, watchRideId)) {
        invokeUnwatch(localUnwatch);
        return;
      }

      unwatch = localUnwatch;
    })();
  }

  function bindRide(nextRideId) {
    if (closed) return;
    const rid = String(nextRideId || "").trim();
    if (!rid) {
      void stop({ closeRemote: false });
      return;
    }
    if (rideId === rid && watching) return;

    const switching = Boolean(rideId && rideId !== rid);
    if (switching) {
      invalidateAnswerState();
      pendingOfferDoc = null;
      destroySession();
    }

    rideId = rid;
    arbiter.reset();
    attachWatch(rid);
  }

  function ingestFirebaseLocation(loc, rideMeta = {}) {
    if (!loc || typeof loc.lat !== "number" || typeof loc.lng !== "number") return;
    const observedAt =
      Number(loc.observedAt) ||
      Number(rideMeta.driverLocationUpdatedAt) ||
      Date.now();
    arbiter.ingestFirebase(
      {
        lat: loc.lat,
        lng: loc.lng,
        observedAt,
        sequence: Number(loc.sequence) || 0,
        trackingSessionId: String(loc.trackingSessionId || rideMeta.trackingSessionId || ""),
        assignmentVersion: Number(rideMeta.assignmentVersion) || 0,
        accuracyM: loc.accuracyM ?? loc.accuracy ?? null,
        headingDeg: loc.headingDeg ?? loc.heading ?? null,
        speedMps: loc.speedMps ?? loc.speed ?? null,
      },
      arbiter.getGeneration()
    );
  }

  function setVisible(next) {
    visible = Boolean(next);
    if (!visible) {
      invalidateAnswer();
      session?.suspend?.();
      arbiter.noteP2pUnhealthy();
      return;
    }
    if (!rideId) return;
    if (!watching) {
      attachWatch(rideId);
    }
    if (pendingOfferDoc && isOfferCurrent(pendingOfferDoc)) {
      queueAnswer(pendingOfferDoc);
    }
  }

  function syncForRide(ride, { isVisible = true, assignmentVersion = 0 } = {}) {
    if (closed) return;
    const status = String(ride?.status || "");
    const rid = String(ride?.id || "").trim();
    const nextAv = Math.max(0, Math.floor(Number(assignmentVersion) || 0));
    const rideChanged = Boolean(rid && rideId && rid !== rideId);

    if (rideChanged) {
      invalidateAnswerState();
      invalidateWatch();
      pendingOfferDoc = null;
      destroySession();
    } else if (nextAv > 0 && nextAv !== expectedAssignmentVersion && (answering || session)) {
      invalidateAnswer();
    }

    expectedAssignmentVersion = nextAv;

    if (!rid || !P2P_EXECUTION_STATUSES.includes(status)) {
      setVisible(isVisible);
      void stop({ closeRemote: true });
      return;
    }

    bindRide(rid);
    setVisible(isVisible);

    if (ride?.driverLocation) {
      ingestFirebaseLocation(ride.driverLocation, ride);
    }
  }

  async function stop({ closeRemote = true } = {}) {
    const closingRideId = rideId;
    invalidateAnswerState();
    invalidateWatch();
    if (closeRemote) await closeSignaling(closingRideId);
    destroySession();
    pendingOfferDoc = null;
    expectedAssignmentVersion = 0;
    rideId = "";
    arbiter.reset();
  }

  function destroy() {
    closed = true;
    invalidateAnswerState();
    invalidateWatch();
    void stop({ closeRemote: true });
    arbiter.destroy();
  }

  return {
    bindRide,
    syncForRide,
    setVisible,
    ingestFirebaseLocation,
    stop,
    destroy,
    getArbiter: () => arbiter,
    getCounters: () => ({
      ...(session?.getCounters?.() || {}),
      ...(arbiter.getCounters?.() || {}),
    }),
    getState: () => session?.getState?.() || { state: P2P_STATE.DISABLED },
    getAnswerRequestCount: () => answerRequestCount,
    /** Test helpers */
    _getAnswerGeneration: () => answerGeneration,
    _getWatchGeneration: () => watchGeneration,
    _isAnswering: () => answering,
    _isWatching: () => watching,
    _getRideId: () => rideId,
  };
}
