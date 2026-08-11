/**
 * Phase 3 — driver P2P ride controller (offer + send locations).
 * One geolocation watch remains elsewhere; this only consumes validated fixes.
 */

import { P2P_STATE, P2P_EXECUTION_STATUSES } from "./p2p-protocol.mjs";
import { createP2pPeerSession } from "./p2p-peer-session.mjs";

async function loadSignalingClient() {
  return import("./p2p-signaling-client.mjs");
}

/**
 * @param {{
 *   onHealthyChange?: (healthy: boolean) => void,
 *   onDiag?: (code: string) => void,
 *   RTCPeerConnection?: typeof RTCPeerConnection,
 * }} [opts]
 */
export function createDriverP2pController(opts = {}) {
  const diag = opts.onDiag || (() => {});
  const createOfferClient =
    typeof opts.createRidePeerOfferClient === "function"
      ? opts.createRidePeerOfferClient
      : async (payload) => {
          const { createRidePeerOfferClient } = await loadSignalingClient();
          return createRidePeerOfferClient(payload);
        };
  const watchSession =
    typeof opts.watchRidePeerSession === "function"
      ? opts.watchRidePeerSession
      : async (...args) => {
          const { watchRidePeerSession } = await loadSignalingClient();
          return watchRidePeerSession(...args);
        };
  const closeSignalingClient =
    typeof opts.closeRidePeerSessionClient === "function"
      ? opts.closeRidePeerSessionClient
      : async (payload) => {
          const { closeRidePeerSessionClient } = await loadSignalingClient();
          return closeRidePeerSessionClient(payload);
        };
  let session = null;
  let unwatch = () => {};
  let rideId = "";
  let trackingSessionId = "";
  let vehicleId = "";
  let assignmentVersion = 0;
  let closed = false;
  let starting = false;
  let answeredSessionId = "";
  let offerRequestCount = 0;

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
    if (s) void s.close({ reason: "destroy" });
    notifyHealth();
  }

  async function closeSignaling() {
    const id = rideId;
    if (!id) return;
    try {
      await closeSignalingClient({ rideId: id });
    } catch {
      /* ignore */
    }
  }

  async function start({
    rideId: nextRideId,
    trackingSessionId: nextTracking,
    vehicleId: nextVehicleId = "",
    assignmentVersion: nextAssignmentVersion = 0,
  } = {}) {
    if (closed) return;
    const rid = String(nextRideId || "").trim();
    const tid = String(nextTracking || "").trim();
    const nextAv = Math.max(1, Math.floor(Number(nextAssignmentVersion) || 0));
    if (!rid || !tid) return;
    if (starting) return;
    if (
      session &&
      rideId === rid &&
      trackingSessionId === tid &&
      assignmentVersion === nextAv
    ) {
      return;
    }

    starting = true;
    try {
      destroySession();
      rideId = rid;
      trackingSessionId = tid;
      vehicleId = String(nextVehicleId || "");
      assignmentVersion = nextAv;

      session = createP2pPeerSession({
        role: "driver",
        RTCPeerConnection: opts.RTCPeerConnection,
        onDiag: diag,
        onState: () => notifyHealth(),
        onAck: () => notifyHealth(),
        onLocalDescription: async (kind, sdp, meta) => {
          if (kind !== "offer") return;
          offerRequestCount += 1;
          const res = await createOfferClient({
            rideId,
            offerSdp: sdp,
            peerSessionId: meta.peerSessionId,
            trackingSessionId: meta.trackingSessionId,
            vehicleId: vehicleId || undefined,
            assignmentVersion: assignmentVersion || undefined,
          });
          assignmentVersion = Number(res?.assignmentVersion) || meta.assignmentVersion || assignmentVersion || 1;
        },
      });

      await session.startAsDriver({
        trackingSessionId: tid,
        assignmentVersion: assignmentVersion || 1,
      });

      unwatch = await watchSession(
        rid,
        (docData) => {
          if (!session || !docData) return;
          if (String(docData.state || "") === "closed") return;
          const sid = String(docData.sessionId || "");
          const answer = String(docData.answer || "");
          if (!answer || !sid) return;
          if (sid !== session.getState().peerSessionId) return;
          if (answeredSessionId === sid) return;
          answeredSessionId = sid;
          assignmentVersion = Number(docData.assignmentVersion) || assignmentVersion;
          void session.acceptRemoteAnswer(answer);
        },
        () => {
          /* permission / network → Firebase fallback via peer state */
        }
      );
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

  function syncForRide({ ride, trackingSessionId: tid, assignmentVersion: rideAssignmentVersion = 0 }) {
    if (closed) return;
    const status = String(ride?.status || "");
    const rid = String(ride?.id || "").trim();
    if (!rid || !P2P_EXECUTION_STATUSES.includes(status) || !tid) {
      void stop({ closeRemote: true });
      return;
    }
    // P2P offer startup is independent of customer viewer lease; checkpoint cadence remains viewer-gated.
    void start({
      rideId: rid,
      trackingSessionId: tid,
      vehicleId: ride?.vehicleId,
      assignmentVersion: rideAssignmentVersion,
    });
  }

  function destroy() {
    closed = true;
    void stop({ closeRemote: true });
  }

  return {
    start,
    stop,
    suspend,
    syncForRide,
    onLocationFix,
    destroy,
    isHealthy,
    getCounters: () => session?.getCounters?.() || {},
    getState: () => session?.getState?.() || { state: P2P_STATE.DISABLED },
    /** Test / diagnostics — bounded offer requests for current assignment. */
    getOfferRequestCount: () => offerRequestCount,
  };
}
