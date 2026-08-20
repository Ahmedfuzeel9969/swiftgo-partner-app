/**
 * Phase 3 — driver P2P ride controller (offer + send locations).
 * One geolocation watch remains elsewhere; this only consumes validated fixes.
 */

import { P2P_STATE, P2P_EXECUTION_STATUSES } from "./p2p-protocol.mjs";
import { createP2pPeerSession } from "./p2p-peer-session.mjs";

/** Lazy — app wrapper pulls Firebase https imports unsuitable for Node tests. */
async function defaultEnsureIceConfiguration() {
  const mod = await import("./p2p-ice-bootstrap.mjs");
  return mod.ensureP2pIceConfiguration();
}

function assignmentKey(rideId, trackingSessionId, assignmentVersion) {
  return `${String(rideId || "").trim()}|${String(trackingSessionId || "").trim()}|${Math.max(
    1,
    Math.floor(Number(assignmentVersion) || 0)
  )}`;
}

/**
 * @param {{
 *   onHealthyChange?: (healthy: boolean) => void,
 *   onChannelOpen?: () => void,
 *   onDiag?: (code: string) => void,
 *   RTCPeerConnection?: typeof RTCPeerConnection,
 *   ensureIceConfiguration?: Function,
 *   createRidePeerOfferClient?: Function,
 *   closeRidePeerSessionClient?: Function,
 *   watchRidePeerSession?: Function,
 * }} [opts]
 */
export function createDriverP2pController(opts = {}) {
  const diag = opts.onDiag || (() => {});
  let session = null;
  let unwatch = () => {};
  let rideId = "";
  let trackingSessionId = "";
  let vehicleId = "";
  let assignmentVersion = 0;
  /** Server-authoritative assignment identity for reconnect + stale guards. */
  let syncedAssignmentVersion = 0;
  let closed = false;
  let starting = false;
  let answeredSessionId = "";
  let lastAcceptedAnswer = "";
  let lastPublishedOffer = "";
  let signalingMod = null;
  let watchRetryTimer = null;
  let watchRetryAttempt = 0;
  let startupGeneration = 0;
  /** @type {{ rideId: string, trackingSessionId: string, assignmentVersion: number, vehicleId?: string } | null} */
  let pendingTarget = null;
  const MAX_WATCH_RETRIES = 8;

  const ctrlCounters = {
    startAttempts: 0,
    startFailures: 0,
    offerPublishFailures: 0,
    watchErrors: 0,
    watchRetries: 0,
    staleAborts: 0,
  };

  function clearWatchRetry() {
    if (watchRetryTimer) {
      clearTimeout(watchRetryTimer);
      watchRetryTimer = null;
    }
    watchRetryAttempt = 0;
  }

  function currentAssignmentKey() {
    return assignmentKey(rideId, trackingSessionId, syncedAssignmentVersion);
  }

  function isStartCurrent(gen, key) {
    return !closed && gen === startupGeneration && key === currentAssignmentKey();
  }

  function abortStaleAttempt(localSession, localUnwatch) {
    ctrlCounters.staleAborts += 1;
    try {
      localUnwatch?.();
    } catch {
      /* ignore */
    }
    if (!localSession) return;
    void localSession.close({ reason: "stale_start" });
    if (localSession === session) {
      session = null;
      answeredSessionId = "";
      lastAcceptedAnswer = "";
      lastPublishedOffer = "";
    }
  }

  async function signaling() {
    if (
      opts.createRidePeerOfferClient ||
      opts.closeRidePeerSessionClient ||
      opts.watchRidePeerSession
    ) {
      return {
        createRidePeerOfferClient: opts.createRidePeerOfferClient,
        closeRidePeerSessionClient: opts.closeRidePeerSessionClient,
        watchRidePeerSession: opts.watchRidePeerSession,
      };
    }
    if (!signalingMod) {
      signalingMod = await import("./p2p-signaling-client.mjs");
    }
    return signalingMod;
  }

  function isHealthy() {
    return session?.getState?.()?.isLocDeliveryHealthy === true;
  }

  function notifyHealth() {
    opts.onHealthyChange?.(isHealthy());
  }

  function destroySession() {
    clearWatchRetry();
    unwatch();
    unwatch = () => {};
    const s = session;
    session = null;
    answeredSessionId = "";
    lastAcceptedAnswer = "";
    lastPublishedOffer = "";
    if (s) void s.close({ reason: "destroy" });
    notifyHealth();
  }

  async function closeSignaling() {
    const id = rideId;
    if (!id) return;
    try {
      const sig = await signaling();
      await sig.closeRidePeerSessionClient?.({ rideId: id });
    } catch {
      /* ignore */
    }
  }

  function invalidateInFlight() {
    startupGeneration += 1;
    pendingTarget = null;
  }

  function scheduleWatchRetry(rid, gen, key) {
    if (closed || rideId !== rid || !isStartCurrent(gen, key)) return;
    if (watchRetryAttempt >= MAX_WATCH_RETRIES) return;
    if (watchRetryTimer) return;
    const delayMs = Math.min(30_000, 1_000 * 2 ** watchRetryAttempt);
    watchRetryAttempt += 1;
    ctrlCounters.watchRetries += 1;
    watchRetryTimer = setTimeout(() => {
      watchRetryTimer = null;
      if (!closed && rideId === rid && isStartCurrent(gen, key)) {
        void attachAnswerWatch(rid, gen, key);
      }
    }, delayMs);
  }

  async function attachAnswerWatch(rid, gen, key) {
    if (watchRetryTimer) {
      clearTimeout(watchRetryTimer);
      watchRetryTimer = null;
    }
    unwatch();
    const localSession = session;
    const onData = (docData) => {
      if (!isStartCurrent(gen, key) || localSession !== session || !docData) return;
      watchRetryAttempt = 0;
      if (String(docData.state || "") === "closed") return;
      const sid = String(docData.sessionId || "");
      const answer = String(docData.answer || "");
      if (!answer || !sid) return;
      if (sid !== session.getState().peerSessionId) return;
      if (answeredSessionId === sid && answer === lastAcceptedAnswer) return;
      answeredSessionId = sid;
      lastAcceptedAnswer = answer;
      const nextAv = Number(docData.assignmentVersion) || assignmentVersion;
      if (nextAv !== assignmentVersion) {
        assignmentVersion = nextAv;
        session.syncAssignmentVersion?.(assignmentVersion);
      }
      session.noteAnswerDownloaded?.(answer);
      void session.acceptRemoteAnswer(answer);
    };
    const onError = () => {
      if (!isStartCurrent(gen, key) || localSession !== session) return;
      ctrlCounters.watchErrors += 1;
      scheduleWatchRetry(rid, gen, key);
    };
    const sig = await signaling();
    if (!isStartCurrent(gen, key) || localSession !== session || closed || rideId !== rid) return;
    if (typeof sig.watchRidePeerSession === "function") {
      unwatch = sig.watchRidePeerSession(rid, onData, onError);
    }
  }

  function triggerReconnect() {
    if (closed || !rideId || !trackingSessionId || !session) return;
    answeredSessionId = "";
    const av = assignmentVersion || syncedAssignmentVersion || 1;
    session.scheduleReconnect(() => {
      void session.startAsDriver({
        trackingSessionId,
        assignmentVersion: av,
        reconnect: true,
      });
    });
  }

  function requestStart(target) {
    if (closed) return;
    const rid = String(target?.rideId || "").trim();
    const tid = String(target?.trackingSessionId || "").trim();
    const av = Math.max(1, Math.floor(Number(target?.assignmentVersion) || syncedAssignmentVersion || 0));
    if (!rid || !tid) return;

    const key = assignmentKey(rid, tid, av);

    if (session && currentAssignmentKey() === key) {
      const st = String(session.getState?.()?.state || "");
      if (
        st === P2P_STATE.P2P_HEALTHY ||
        st === P2P_STATE.P2P_DEGRADED ||
        st === P2P_STATE.CONNECTING ||
        st === P2P_STATE.SIGNALING ||
        st === P2P_STATE.RECONNECTING
      ) {
        return;
      }
      triggerReconnect();
      return;
    }

    const prevPendingKey = pendingTarget
      ? assignmentKey(
          pendingTarget.rideId,
          pendingTarget.trackingSessionId,
          pendingTarget.assignmentVersion
        )
      : null;

    pendingTarget = {
      rideId: rid,
      trackingSessionId: tid,
      assignmentVersion: av,
      vehicleId: String(target?.vehicleId || ""),
    };

    if (starting && (prevPendingKey !== key || currentAssignmentKey() !== key)) {
      startupGeneration += 1;
    } else if (prevPendingKey && prevPendingKey !== key) {
      startupGeneration += 1;
    }

    if (starting) return;
    void runStartLoop();
  }

  async function runStartLoop() {
    if (starting || closed) return;
    starting = true;
    try {
      while (pendingTarget && !closed) {
        const target = pendingTarget;
        pendingTarget = null;

        startupGeneration += 1;
        const gen = startupGeneration;
        const key = assignmentKey(
          target.rideId,
          target.trackingSessionId,
          target.assignmentVersion
        );

        ctrlCounters.startAttempts += 1;
        destroySession();
        rideId = target.rideId;
        trackingSessionId = target.trackingSessionId;
        vehicleId = target.vehicleId || "";
        assignmentVersion = target.assignmentVersion;
        syncedAssignmentVersion = target.assignmentVersion;

        let localUnwatch = () => {};
        const sig = await signaling();
        if (!isStartCurrent(gen, key)) continue;

        const localSession = createP2pPeerSession({
          role: "driver",
          RTCPeerConnection: opts.RTCPeerConnection,
          ensureIceConfiguration: opts.ensureIceConfiguration || defaultEnsureIceConfiguration,
          onDiag: diag,
          onState: () => {
            if (localSession === session) notifyHealth();
          },
          onAck: () => {
            if (localSession === session) notifyHealth();
          },
          onNeedReconnect: () => {
            if (localSession === session) triggerReconnect();
          },
          onChannelOpen: () => opts.onChannelOpen?.(),
          onLocalDescription: async (kind, sdp, meta) => {
            if (kind !== "offer") return;
            if (!isStartCurrent(gen, key) || localSession !== session) return;
            lastPublishedOffer = String(sdp || "");
            answeredSessionId = "";
            try {
              const res = await sig.createRidePeerOfferClient?.({
                rideId: target.rideId,
                offerSdp: sdp,
                peerSessionId: meta.peerSessionId,
                trackingSessionId: meta.trackingSessionId,
                vehicleId: target.vehicleId || undefined,
                assignmentVersion: target.assignmentVersion || undefined,
              });
              if (!isStartCurrent(gen, key) || localSession !== session) return;
              const nextAv =
                Number(res?.assignmentVersion) ||
                meta.assignmentVersion ||
                target.assignmentVersion ||
                1;
              assignmentVersion = nextAv;
              session?.syncAssignmentVersion?.(nextAv);
              session?.noteOfferUploaded?.(sdp);
            } catch {
              ctrlCounters.offerPublishFailures += 1;
              throw new Error("OFFER_PUBLISH_FAILED");
            }
          },
        });

        session = localSession;
        session.setPipelineRideId?.(target.rideId);

        await localSession.startAsDriver({
          trackingSessionId: target.trackingSessionId,
          assignmentVersion: target.assignmentVersion || 1,
        });

        if (!isStartCurrent(gen, key)) {
          abortStaleAttempt(localSession, localUnwatch);
          session = null;
          continue;
        }

        await attachAnswerWatch(target.rideId, gen, key);
        localUnwatch = unwatch;

        if (!isStartCurrent(gen, key)) {
          abortStaleAttempt(localSession, localUnwatch);
          session = null;
          continue;
        }

        notifyHealth();
      }
    } catch {
      ctrlCounters.startFailures += 1;
      destroySession();
      opts.onHealthyChange?.(false);
    } finally {
      starting = false;
      if (pendingTarget && !closed) {
        void runStartLoop();
      }
    }
  }

  async function start({
    rideId: nextRideId,
    trackingSessionId: nextTracking,
    vehicleId: nextVehicleId = "",
    assignmentVersion: nextAv = 0,
  } = {}) {
    requestStart({
      rideId: nextRideId,
      trackingSessionId: nextTracking,
      vehicleId: nextVehicleId,
      assignmentVersion: nextAv,
    });
  }

  function onLocationFix(fix) {
    if (!session) return;
    if (session.getState().state === P2P_STATE.CLOSED) return;
    session.enqueueLocationFix(fix);
  }

  function suspend() {
    session?.suspend?.();
    notifyHealth();
  }

  async function stop({ closeRemote = true } = {}) {
    invalidateInFlight();
    clearWatchRetry();
    if (closeRemote) await closeSignaling();
    destroySession();
    rideId = "";
    trackingSessionId = "";
    assignmentVersion = 0;
    syncedAssignmentVersion = 0;
    vehicleId = "";
  }

  function syncForRide({ ride, trackingSessionId: tid, assignmentVersion: rideAssignmentVersion = 0 }) {
    if (closed) return;
    const status = String(ride?.status || "");
    const rid = String(ride?.id || "").trim();
    if (!rid || !P2P_EXECUTION_STATUSES.includes(status) || !tid) {
      void stop({ closeRemote: true });
      return;
    }
    // Active execution rides keep P2P up regardless of customer viewer presence.
    requestStart({
      rideId: rid,
      trackingSessionId: tid,
      vehicleId: ride?.vehicleId,
      assignmentVersion: rideAssignmentVersion,
    });
  }

  function destroy() {
    closed = true;
    invalidateInFlight();
    void stop({ closeRemote: true });
  }

  function createCommTransport() {
    return session?.createCommTransport?.() || null;
  }

  function createMediaBridge() {
    return session?.createMediaBridge?.() || null;
  }

  return {
    start,
    stop,
    suspend,
    syncForRide,
    onLocationFix,
    destroy,
    isHealthy,
    createCommTransport,
    createMediaBridge,
    getCounters: () => ({
      ...(session?.getCounters?.() || {}),
      ...ctrlCounters,
    }),
    getState: () => session?.getState?.() || { state: P2P_STATE.DISABLED },
    getPipeline: () => session?.getPipeline?.() || [],
    getPipelineReport: () => session?.getPipelineReport?.() || null,
    /** Test helpers */
    _getStartupGeneration: () => startupGeneration,
    _isStarting: () => starting,
    _getPendingTarget: () => (pendingTarget ? { ...pendingTarget } : null),
    _getRideId: () => rideId,
    _getSessionForTest: () => session,
  };
}
