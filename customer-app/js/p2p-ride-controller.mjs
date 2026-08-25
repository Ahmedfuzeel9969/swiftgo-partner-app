/**
 * Phase 3 — customer P2P ride controller (answer + ingest) + source arbiter bridge.
 */

import { P2P_STATE, P2P_EXECUTION_STATUSES } from "./p2p-protocol.mjs";
import { createP2pPeerSession } from "./p2p-peer-session.mjs";
import { createLiveLocationSourceArbiter } from "./live-location-source-arbiter.mjs";
import { timestampToMs } from "./live-location-render.mjs";
import { getFieldDiagnostics } from "./field-diagnostics.mjs";

/** Lazy — app wrapper pulls Firebase https imports unsuitable for Node tests. */
async function defaultEnsureIceConfiguration() {
  const mod = await import("./p2p-ice-bootstrap.mjs");
  return mod.ensureP2pIceConfiguration();
}

function answerIdentity(rideId, docData, fallbackVersion = 0) {
  const rid = String(rideId || "").trim();
  const sid = String(docData?.sessionId || "").trim();
  const tid = String(docData?.trackingSessionId || "").trim();
  const av =
    Number(docData?.assignmentVersion) ||
    Math.max(1, Math.floor(Number(fallbackVersion) || 0));
  return `${rid}|${sid}|${tid}|${av}`;
}

/**
 * @param {{
 *   onRenderFix?: (fix: object, meta: object) => void,
 *   onChannelOpen?: () => void,
 *   onDiag?: (code: string) => void,
 *   RTCPeerConnection?: typeof RTCPeerConnection,
 *   ensureIceConfiguration?: Function,
 *   watchRidePeerSession?: Function,
 *   publishRidePeerAnswerClient?: Function,
 *   closeRidePeerSessionClient?: Function,
 * }} [opts]
 */
export function createCustomerP2pController(opts = {}) {
  const diag = opts.onDiag || (() => {});
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
  /** UI/map visibility only — must not tear down P2P when the screen is hidden. */
  let uiVisible = true;
  let watching = false;
  let lastOfferSdp = "";
  let pendingOfferDoc = null;
  let expectedAssignmentVersion = 0;
  let answerGeneration = 0;
  let watchGeneration = 0;
  let signalingMod = null;
  let watchRetryTimer = null;
  let watchRetryAttempt = 0;
  /** @type {object | null} */
  let queuedAnswerDoc = null;
  const MAX_WATCH_RETRIES = 8;

  const ctrlCounters = {
    offersReceived: 0,
    answerAttempts: 0,
    answerFailures: 0,
    watchErrors: 0,
    watchRetries: 0,
    staleAborts: 0,
    reassignmentSessionDestroys: 0,
    staleAssignmentFixes: 0,
  };

  function invokeUnwatch(fn) {
    if (typeof fn !== "function") return;
    try {
      fn();
    } catch {
      /* ignore */
    }
  }

  function clearWatchRetry() {
    if (watchRetryTimer) {
      clearTimeout(watchRetryTimer);
      watchRetryTimer = null;
    }
    watchRetryAttempt = 0;
  }

  function detachWatch() {
    invokeUnwatch(unwatch);
    unwatch = () => {};
    watching = false;
  }

  function invalidateWatch() {
    watchGeneration += 1;
    clearWatchRetry();
    detachWatch();
  }

  function invalidateAnswerState() {
    answerGeneration += 1;
    queuedAnswerDoc = null;
    pendingOfferDoc = null;
  }

  async function signaling() {
    if (opts.watchRidePeerSession || opts.publishRidePeerAnswerClient || opts.closeRidePeerSessionClient) {
      return {
        watchRidePeerSession: opts.watchRidePeerSession,
        publishRidePeerAnswerClient: opts.publishRidePeerAnswerClient,
        closeRidePeerSessionClient: opts.closeRidePeerSessionClient,
      };
    }
    if (!signalingMod) {
      signalingMod = await import("./p2p-signaling-client.mjs");
    }
    return signalingMod;
  }

  function destroySession() {
    const s = session;
    session = null;
    boundSessionId = "";
    lastOfferSdp = "";
    if (s) void s.close({ reason: "destroy" });
    arbiter.noteP2pUnhealthy();
  }

  function destroySessionIfAssignmentMismatch(nextAv) {
    if (!session || nextAv < 1) return;
    const sessionAv = Math.floor(Number(session.getState?.()?.assignmentVersion) || 0);
    if (sessionAv >= 1 && sessionAv !== nextAv) {
      ctrlCounters.reassignmentSessionDestroys += 1;
      destroySession();
    }
  }

  async function closeSignaling(forRideId = rideId) {
    const id = String(forRideId || "").trim();
    if (!id) return;
    try {
      const sig = await signaling();
      await sig.closeRidePeerSessionClient?.({ rideId: id });
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
    return (
      !closed &&
      gen === watchGeneration &&
      String(watchRideId || "").trim() === String(rideId || "").trim()
    );
  }

  function isAnswerStillValid(gen, capturedRideId, docData) {
    if (closed || gen !== answerGeneration) return false;
    const rid = String(capturedRideId || "").trim();
    if (!rid || rid !== String(rideId || "").trim()) return false;
    return isOfferCurrent(docData, capturedRideId);
  }

  function abortStaleAnswer(localSession) {
    ctrlCounters.staleAborts += 1;
    if (localSession && localSession !== session) {
      void localSession.close({ reason: "stale_answer" });
    } else if (localSession === session) {
      void localSession.close({ reason: "stale_answer" });
      session = null;
      boundSessionId = "";
      lastOfferSdp = "";
    }
  }

  function scheduleWatchRetry(rid, gen) {
    if (closed || !watching || rideId !== rid || gen !== watchGeneration) return;
    if (watchRetryAttempt >= MAX_WATCH_RETRIES) return;
    if (watchRetryTimer) return;
    const delayMs = Math.min(30_000, 1_000 * 2 ** watchRetryAttempt);
    watchRetryAttempt += 1;
    ctrlCounters.watchRetries += 1;
    watchRetryTimer = setTimeout(() => {
      watchRetryTimer = null;
      if (!closed && watching && rideId === rid && gen === watchGeneration) {
        attachWatch(rid);
      }
    }, delayMs);
  }

  function queueAnswer(docData) {
    if (closed || !isOfferCurrent(docData)) return;
    const sid = String(docData?.sessionId || "");
    const offer = String(docData?.offer || "");
    ctrlCounters.offersReceived += 1;

    if (boundSessionId === sid && session && offer === lastOfferSdp) {
      const st = String(session.getState?.()?.state || "");
      if (
        st !== P2P_STATE.FIREBASE_FALLBACK &&
        st !== P2P_STATE.CLOSED &&
        st !== P2P_STATE.DISABLED
      ) {
        return;
      }
    }

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
    if (answering || closed) return;
    answering = true;
    try {
      while (queuedAnswerDoc && !closed) {
        const docData = queuedAnswerDoc;
        queuedAnswerDoc = null;
        const capturedRideId = String(rideId || "").trim();
        if (!isOfferCurrent(docData, capturedRideId)) continue;

        answerGeneration += 1;
        const gen = answerGeneration;
        const sid = String(docData?.sessionId || "");
        const offer = String(docData?.offer || "");

        ctrlCounters.answerAttempts += 1;
        destroySession();
        boundSessionId = sid;
        lastOfferSdp = offer;

        const sig = await signaling();
        if (!isAnswerStillValid(gen, capturedRideId, docData)) continue;

        const localSession = createP2pPeerSession({
          role: "customer",
          RTCPeerConnection: opts.RTCPeerConnection,
          ensureIceConfiguration: opts.ensureIceConfiguration || defaultEnsureIceConfiguration,
          onDiag: diag,
          onChannelOpen: () => opts.onChannelOpen?.(),
          onState: (st) => {
            if (localSession !== session) return;
            if (st === P2P_STATE.FIREBASE_FALLBACK || st === P2P_STATE.P2P_DEGRADED) {
              arbiter.noteP2pUnhealthy();
            }
          },
          onLocationFix: (fix) => {
            if (localSession !== session) return;
            const fixAv = Math.floor(Number(fix?.assignmentVersion) || 0);
            if (
              expectedAssignmentVersion > 0 &&
              fixAv > 0 &&
              fixAv !== expectedAssignmentVersion
            ) {
              ctrlCounters.staleAssignmentFixes += 1;
              return;
            }
            try {
              getFieldDiagnostics()?.record("p2p_receive", {
                ok: true,
                lat: fix?.lat,
                lng: fix?.lng,
                observedAt: fix?.observedAt ?? null,
                sequence: fix?.sequence ?? null,
              });
            } catch {
              /* ignore */
            }
            arbiter.ingestP2p(fix, arbiter.getGeneration());
          },
          onLocalDescription: async (kind, sdp, meta) => {
            if (kind !== "answer") return;
            await Promise.resolve();
            if (!isAnswerStillValid(gen, capturedRideId, docData) || localSession !== session) {
              ctrlCounters.staleAborts += 1;
              return;
            }
            await sig.publishRidePeerAnswerClient?.({
              rideId: capturedRideId,
              answerSdp: sdp,
              peerSessionId: meta.peerSessionId,
            });
            if (!isAnswerStillValid(gen, capturedRideId, docData) || localSession !== session) {
              ctrlCounters.staleAborts += 1;
              return;
            }
            session?.noteAnswerUploaded?.(sdp);
          },
        });

        session = localSession;
        session.setPipelineRideId?.(capturedRideId);

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
      ctrlCounters.answerFailures += 1;
      destroySession();
    } finally {
      answering = false;
      if (queuedAnswerDoc && !closed) {
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

    const onData = (docData) => {
      if (!isWatchCurrent(gen, watchRideId)) return;
      if (!docData) {
        if (isWatchCurrent(gen, watchRideId)) pendingOfferDoc = null;
        return;
      }
      watchRetryAttempt = 0;
      const docAv = Math.floor(Number(docData.assignmentVersion) || 0);
      if (session) {
        destroySessionIfAssignmentMismatch(docAv);
      }
      if (isOfferCurrent(docData, watchRideId)) {
        pendingOfferDoc = docData;
      } else if (
        expectedAssignmentVersion > 0 &&
        docAv > 0 &&
        docAv !== expectedAssignmentVersion
      ) {
        pendingOfferDoc = null;
        return;
      }
      void queueAnswer(docData);
    };
    const onError = () => {
      if (!isWatchCurrent(gen, watchRideId)) return;
      arbiter.noteP2pUnhealthy();
      ctrlCounters.watchErrors += 1;
      scheduleWatchRetry(watchRideId, gen);
    };

    if (typeof opts.watchRidePeerSession === "function") {
      unwatch = opts.watchRidePeerSession(watchRideId, onData, onError);
      return;
    }
    void signaling().then((sig) => {
      if (!isWatchCurrent(gen, watchRideId)) return;
      unwatch = sig.watchRidePeerSession(watchRideId, onData, onError);
    });
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
    const lat = Number(loc?.lat);
    const lng = Number(loc?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    // Never use Number(FirestoreTimestamp) / Number(0) — both collapse to Date.now()
    // and poison the arbiter so later real GPS observedAt values look "stale".
    const observedAt =
      timestampToMs(loc?.observedAt) ??
      timestampToMs(loc?.receivedAt) ??
      timestampToMs(rideMeta?.driverLocationUpdatedAt) ??
      Date.now();
    arbiter.ingestFirebase(
      {
        lat,
        lng,
        observedAt,
        sequence: Number(loc.sequence) || 0,
        trackingSessionId: String(
          loc.trackingSessionId ||
            loc.sessionId ||
            rideMeta.driverTrackingSessionId ||
            rideMeta.trackingSessionId ||
            ""
        ),
        assignmentVersion: Number(rideMeta.assignmentVersion) || 0,
        accuracyM: loc.accuracyM ?? loc.accuracy ?? null,
        headingDeg: loc.headingDeg ?? loc.heading ?? null,
        speedMps: loc.speedMps ?? loc.speed ?? null,
      },
      arbiter.getGeneration()
    );
  }

  function setVisible(next) {
    uiVisible = Boolean(next);
    // Active-ride policy: screen hidden/background must not suspend or stop P2P.
    // Signaling watch stays attached; resume only re-answers if the session is dead.
  }

  function isUiVisible() {
    return uiVisible;
  }

  function syncForRide(ride, { isVisible = true, assignmentVersion: rideAssignmentVersion = 0 } = {}) {
    if (closed) return;
    const status = String(ride?.status || "");
    const rid = String(ride?.id || "").trim();
    const nextAv = Math.max(0, Math.floor(Number(rideAssignmentVersion) || 0));
    const rideChanged = Boolean(rid && rideId && rid !== rideId);

    // Invalidate before bind/visibility so stale answer/watch cannot race the new ride.
    if (rideChanged) {
      invalidateAnswerState();
      invalidateWatch();
      pendingOfferDoc = null;
      destroySession();
    } else if (nextAv > 0 && nextAv !== expectedAssignmentVersion) {
      invalidateAnswerState();
      destroySessionIfAssignmentMismatch(nextAv);
    }

    expectedAssignmentVersion = nextAv;

    if (!rid || !P2P_EXECUTION_STATUSES.includes(status)) {
      setVisible(isVisible);
      void stop({ closeRemote: true });
      return;
    }

    // Bind ride identity before visibility updates (main a1d82e4 ordering).
    // Branch keeps P2P alive while hidden; setVisible must not tear down the session.
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
    isUiVisible,
    ingestFirebaseLocation,
    stop,
    destroy,
    getArbiter: () => arbiter,
    createCommTransport: () => session?.createCommTransport?.() || null,
    createMediaBridge: () => session?.createMediaBridge?.() || null,
    getCounters: () => ({
      ...(session?.getCounters?.() || {}),
      ...(arbiter.getCounters?.() || {}),
      ...ctrlCounters,
    }),
    getState: () => session?.getState?.() || { state: P2P_STATE.DISABLED },
    getPipeline: () => session?.getPipeline?.() || [],
    getPipelineReport: () => session?.getPipelineReport?.() || null,
    /** Test helpers */
    _getAnswerGeneration: () => answerGeneration,
    _getWatchGeneration: () => watchGeneration,
    _isAnswering: () => answering,
    _isWatching: () => watching,
    _getRideId: () => rideId,
    _getSessionForTest: () => session,
  };
}
