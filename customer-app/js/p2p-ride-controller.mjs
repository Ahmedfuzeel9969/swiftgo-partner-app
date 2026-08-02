/**
 * Phase 3 — customer P2P ride controller (answer + ingest) + source arbiter bridge.
 */

import { P2P_STATE, P2P_EXECUTION_STATUSES } from "./p2p-protocol.mjs";
import { createP2pPeerSession } from "./p2p-peer-session.mjs";
import { createLiveLocationSourceArbiter } from "./live-location-source-arbiter.mjs";
import {
  publishRidePeerAnswerClient,
  closeRidePeerSessionClient,
  watchRidePeerSession,
} from "./p2p-signaling-client.mjs";

/**
 * @param {{
 *   onRenderFix?: (fix: object, meta: object) => void,
 *   onDiag?: (code: string) => void,
 *   RTCPeerConnection?: typeof RTCPeerConnection,
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
  let visible = true;
  let watching = false;

  function destroySession() {
    unwatch();
    unwatch = () => {};
    watching = false;
    const s = session;
    session = null;
    boundSessionId = "";
    if (s) void s.close({ reason: "destroy" });
    arbiter.noteP2pUnhealthy();
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

  async function answerOffer(docData) {
    if (!visible || closed || answering) return;
    const sid = String(docData?.sessionId || "");
    const offer = String(docData?.offer || "");
    if (!sid || !offer) return;
    if (String(docData.state || "") === "closed") return;
    if (boundSessionId === sid && session) return;

    answering = true;
    try {
      destroySession();
      boundSessionId = sid;
      session = createP2pPeerSession({
        role: "customer",
        RTCPeerConnection: opts.RTCPeerConnection,
        onDiag: diag,
        onState: (st) => {
          if (st === P2P_STATE.FIREBASE_FALLBACK || st === P2P_STATE.P2P_DEGRADED) {
            arbiter.noteP2pUnhealthy();
          }
        },
        onLocationFix: (fix) => {
          arbiter.ingestP2p(fix, arbiter.getGeneration());
        },
        onLocalDescription: async (kind, sdp, meta) => {
          if (kind !== "answer") return;
          await publishRidePeerAnswerClient({
            rideId,
            answerSdp: sdp,
            peerSessionId: meta.peerSessionId,
          });
        },
      });
      await session.startAsCustomer({
        peerSessionId: sid,
        trackingSessionId: String(docData.trackingSessionId || ""),
        assignmentVersion: Number(docData.assignmentVersion) || 1,
        offerSdp: offer,
      });
    } catch {
      destroySession();
    } finally {
      answering = false;
    }
  }

  function attachWatch(rid) {
    unwatch();
    watching = true;
    unwatch = watchRidePeerSession(
      rid,
      (docData) => {
        if (!docData || !visible) return;
        void answerOffer(docData);
      },
      () => {
        arbiter.noteP2pUnhealthy();
      }
    );
  }

  function bindRide(nextRideId) {
    if (closed) return;
    const rid = String(nextRideId || "").trim();
    if (!rid) {
      void stop({ closeRemote: false });
      return;
    }
    if (rideId === rid && watching) return;
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
      session?.suspend?.();
      arbiter.noteP2pUnhealthy();
    } else if (rideId) {
      attachWatch(rideId);
    }
  }

  function syncForRide(ride, { isVisible = true } = {}) {
    if (closed) return;
    const status = String(ride?.status || "");
    const rid = String(ride?.id || "").trim();
    setVisible(isVisible);
    if (!rid || !P2P_EXECUTION_STATUSES.includes(status)) {
      void stop({ closeRemote: true });
      return;
    }
    bindRide(rid);
    if (ride?.driverLocation) {
      ingestFirebaseLocation(ride.driverLocation, ride);
    }
  }

  async function stop({ closeRemote = true } = {}) {
    if (closeRemote) await closeSignaling();
    destroySession();
    rideId = "";
    arbiter.reset();
  }

  function destroy() {
    closed = true;
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
  };
}
