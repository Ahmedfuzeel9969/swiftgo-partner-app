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
    unwatch();
    const onData = (docData) => {
      if (!session || !docData) return;
      if (String(docData.state || "") === "closed") return;
      const sid = String(docData.sessionId || "");
      const answer = String(docData.answer || "");
      if (!answer || !sid) return;
      if (sid !== session.getState().peerSessionId) return;
      if (answeredSessionId === sid && answer === lastAcceptedAnswer) return;
      answeredSessionId = sid;
      lastAcceptedAnswer = answer;
      assignmentVersion = Number(docData.assignmentVersion) || assignmentVersion;
      session.noteAnswerDownloaded?.(answer);
      void session.acceptRemoteAnswer(answer);
    };
    const onError = () => {
      /* permission / network → Firebase fallback via peer state */
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
          const res = await sig.createRidePeerOfferClient?.({
            rideId,
            offerSdp: sdp,
            peerSessionId: meta.peerSessionId,
            trackingSessionId: meta.trackingSessionId,
            vehicleId: vehicleId || undefined,
            assignmentVersion: assignmentVersion || undefined,
          });
          assignmentVersion = Number(res?.assignmentVersion) || meta.assignmentVersion || 1;
          session?.noteOfferUploaded?.(sdp);
        },
      });
      session.setPipelineRideId?.(rid);

      await session.startAsDriver({
        trackingSessionId: tid,
        assignmentVersion: assignmentVersion || 1,
      });

      attachAnswerWatch(rid);
    } catch {
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
    if (closeRemote) await closeSignaling();
    destroySession();
    rideId = "";
    trackingSessionId = "";
    assignmentVersion = 0;
  }

  function syncForRide({ ride, trackingSessionId: tid, viewerVisible }) {
    if (closed) return;
    const status = String(ride?.status || "");
    const rid = String(ride?.id || "").trim();
    if (!rid || !P2P_EXECUTION_STATUSES.includes(status) || !tid) {
      void stop({ closeRemote: true });
      return;
    }
    if (!viewerVisible) {
      suspend();
      return;
    }
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
    getCounters: () => session?.getCounters?.() || {},
    getState: () => session?.getState?.() || { state: P2P_STATE.DISABLED },
    getPipeline: () => session?.getPipeline?.() || [],
    getPipelineReport: () => session?.getPipelineReport?.() || null,
  };
}
