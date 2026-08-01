/**
 * Phase 3 — driver P2P ride controller (offer + send locations).
 * One geolocation watch remains elsewhere; this only consumes validated fixes.
 */

import { P2P_STATE, P2P_EXECUTION_STATUSES } from "./p2p-protocol.mjs";
import { createP2pPeerSession } from "./p2p-peer-session.mjs";
import {
  createRidePeerOfferClient,
  closeRidePeerSessionClient,
  watchRidePeerSession,
} from "./p2p-signaling-client.mjs";

/**
 * @param {{
 *   onHealthyChange?: (healthy: boolean) => void,
 *   onDiag?: (code: string) => void,
 *   RTCPeerConnection?: typeof RTCPeerConnection,
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
      await closeRidePeerSessionClient({ rideId: id });
    } catch {
      /* ignore */
    }
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
    if (session && rideId === rid && trackingSessionId === tid) return;

    starting = true;
    try {
      destroySession();
      rideId = rid;
      trackingSessionId = tid;
      vehicleId = String(nextVehicleId || "");

      session = createP2pPeerSession({
        role: "driver",
        RTCPeerConnection: opts.RTCPeerConnection,
        onDiag: diag,
        onState: () => notifyHealth(),
        onAck: () => notifyHealth(),
        onLocalDescription: async (kind, sdp, meta) => {
          if (kind !== "offer") return;
          const res = await createRidePeerOfferClient({
            rideId,
            offerSdp: sdp,
            peerSessionId: meta.peerSessionId,
            trackingSessionId: meta.trackingSessionId,
            vehicleId: vehicleId || undefined,
            assignmentVersion: assignmentVersion || undefined,
          });
          assignmentVersion = Number(res?.assignmentVersion) || meta.assignmentVersion || 1;
        },
      });

      await session.startAsDriver({
        trackingSessionId: tid,
        assignmentVersion: assignmentVersion || 1,
      });

      unwatch = watchRidePeerSession(
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
  };
}
