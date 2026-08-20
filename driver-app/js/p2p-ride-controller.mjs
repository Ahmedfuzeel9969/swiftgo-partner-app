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

/**
 * @param {{
 *   onHealthyChange?: (healthy: boolean) => void,
 *   onChannelOpen?: () => void,
 *   onDiag?: (code: string) => void,
 *   RTCPeerConnection?: typeof RTCPeerConnection,
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
  let closed = false;
  let starting = false;
  let answeredSessionId = "";
  let lastAcceptedAnswer = "";
  let lastPublishedOffer = "";
  let signalingMod = null;
  let watchRetryTimer = null;
  let watchRetryAttempt = 0;
  const MAX_WATCH_RETRIES = 8;

  const ctrlCounters = {
    startAttempts: 0,
    startFailures: 0,
    offerPublishFailures: 0,
    watchErrors: 0,
    watchRetries: 0,
  };

  function clearWatchRetry() {
    if (watchRetryTimer) {
      clearTimeout(watchRetryTimer);
      watchRetryTimer = null;
    }
    watchRetryAttempt = 0;
  }

  function scheduleWatchRetry(rid) {
    if (closed || rideId !== rid) return;
    if (watchRetryAttempt >= MAX_WATCH_RETRIES) return;
    if (watchRetryTimer) return;
    const delayMs = Math.min(30_000, 1_000 * 2 ** watchRetryAttempt);
    watchRetryAttempt += 1;
    ctrlCounters.watchRetries += 1;
    watchRetryTimer = setTimeout(() => {
      watchRetryTimer = null;
      if (!closed && rideId === rid) attachAnswerWatch(rid);
    }, delayMs);
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
    return session?.getState?.()?.isHealthy === true;
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

  function attachAnswerWatch(rid) {
    if (watchRetryTimer) {
      clearTimeout(watchRetryTimer);
      watchRetryTimer = null;
    }
    unwatch();
    const onData = (docData) => {
      if (!session || !docData) return;
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
      ctrlCounters.watchErrors += 1;
      scheduleWatchRetry(rid);
    };
    if (typeof opts.watchRidePeerSession === "function") {
      unwatch = opts.watchRidePeerSession(rid, onData, onError);
      return;
    }
    void signaling().then((sig) => {
      if (closed || rideId !== rid) return;
      unwatch = sig.watchRidePeerSession(rid, onData, onError);
    });
  }

  function triggerReconnect() {
    if (closed || !rideId || !trackingSessionId || !session) return;
    answeredSessionId = "";
    session.scheduleReconnect(() => {
      void session.startAsDriver({
        trackingSessionId,
        assignmentVersion: assignmentVersion || 1,
        reconnect: true,
      });
    });
  }

  async function start({
    rideId: nextRideId,
    trackingSessionId: nextTracking,
    vehicleId: nextVehicleId = "",
  } = {}) {
    if (closed) return;
    const rid = String(nextRideId || "").trim();
    const tid = String(nextTracking || "").trim();
    if (!rid || !tid) return;
    if (starting) return;
    if (session && rideId === rid && trackingSessionId === tid) {
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
      // Recover from fallback/suspend without tearing signaling closed.
      triggerReconnect();
      return;
    }

    starting = true;
    ctrlCounters.startAttempts += 1;
    try {
      const sig = await signaling();
      destroySession();
      rideId = rid;
      trackingSessionId = tid;
      vehicleId = String(nextVehicleId || "");

      session = createP2pPeerSession({
        role: "driver",
        RTCPeerConnection: opts.RTCPeerConnection,
        ensureIceConfiguration: opts.ensureIceConfiguration || defaultEnsureIceConfiguration,
        onDiag: diag,
        onState: () => notifyHealth(),
        onAck: () => notifyHealth(),
        onNeedReconnect: () => triggerReconnect(),
        onChannelOpen: () => opts.onChannelOpen?.(),
        onLocalDescription: async (kind, sdp, meta) => {
          if (kind !== "offer") return;
          lastPublishedOffer = String(sdp || "");
          answeredSessionId = "";
          try {
            const res = await sig.createRidePeerOfferClient?.({
              rideId,
              offerSdp: sdp,
              peerSessionId: meta.peerSessionId,
              trackingSessionId: meta.trackingSessionId,
              vehicleId: vehicleId || undefined,
              assignmentVersion: assignmentVersion || undefined,
            });
            assignmentVersion = Number(res?.assignmentVersion) || meta.assignmentVersion || 1;
            session?.syncAssignmentVersion?.(assignmentVersion);
            session?.noteOfferUploaded?.(sdp);
          } catch {
            ctrlCounters.offerPublishFailures += 1;
            throw new Error("OFFER_PUBLISH_FAILED");
          }
        },
      });
      session.setPipelineRideId?.(rid);

      await session.startAsDriver({
        trackingSessionId: tid,
        assignmentVersion: assignmentVersion || 1,
      });

      attachAnswerWatch(rid);
    } catch {
      ctrlCounters.startFailures += 1;
      destroySession();
      opts.onHealthyChange?.(false);
    } finally {
      starting = false;
    }
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
    clearWatchRetry();
    if (closeRemote) await closeSignaling();
    destroySession();
    rideId = "";
    trackingSessionId = "";
    assignmentVersion = 0;
  }

  function syncForRide({ ride, trackingSessionId: tid }) {
    if (closed) return;
    const status = String(ride?.status || "");
    const rid = String(ride?.id || "").trim();
    if (!rid || !P2P_EXECUTION_STATUSES.includes(status) || !tid) {
      void stop({ closeRemote: true });
      return;
    }
    // Active execution rides keep P2P up regardless of customer viewer presence.
    void start({
      rideId: rid,
      trackingSessionId: tid,
      vehicleId: ride?.vehicleId,
    });
  }

  function destroy() {
    closed = true;
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
  };
}
