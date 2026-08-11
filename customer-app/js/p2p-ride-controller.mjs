/**
 * Phase 3 — customer P2P ride controller (answer + ingest) + source arbiter bridge.
 */

import { P2P_STATE, P2P_EXECUTION_STATUSES } from "./p2p-protocol.mjs";
import { createP2pPeerSession } from "./p2p-peer-session.mjs";
import { createLiveLocationSourceArbiter } from "./live-location-source-arbiter.mjs";

async function loadSignalingClient() {
  return import("./p2p-signaling-client.mjs");
}

/**
 * @param {{
 *   onRenderFix?: (fix: object, meta: object) => void,
 *   onDiag?: (code: string) => void,
 *   RTCPeerConnection?: typeof RTCPeerConnection,
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
      await closeSignalingClient({ rideId: id });
    } catch {
      /* ignore */
    }
  }

  function isOfferCurrent(docData) {
    if (!docData) return false;
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

  async function answerOffer(docData) {
    if (!visible || closed || answering) return;
    if (!isOfferCurrent(docData)) return;
    const sid = String(docData?.sessionId || "");
    const offer = String(docData?.offer || "");
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
          await publishAnswerClient({
            rideId,
            answerSdp: sdp,
            peerSessionId: meta.peerSessionId,
          });
        },
      });
      await session.startAsCustomer({
        peerSessionId: sid,
        trackingSessionId: String(docData.trackingSessionId || ""),
        assignmentVersion: Number(docData.assignmentVersion) || expectedAssignmentVersion || 1,
        offerSdp: offer,
      });
      pendingOfferDoc = null;
    } catch {
      destroySession();
    } finally {
      answering = false;
    }
  }

  function attachWatch(rid) {
    unwatch();
    watching = true;
    void (async () => {
      unwatch = await watchSession(
        rid,
        (docData) => {
        if (!docData) {
          pendingOfferDoc = null;
          return;
        }
        if (isOfferCurrent(docData)) {
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
        void answerOffer(docData);
      },
      () => {
        arbiter.noteP2pUnhealthy();
      }
    );
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
      return;
    }
    if (!rideId) return;
    if (!watching) {
      attachWatch(rideId);
    }
    if (pendingOfferDoc) {
      void answerOffer(pendingOfferDoc);
    }
  }

  function syncForRide(ride, { isVisible = true, assignmentVersion = 0 } = {}) {
    if (closed) return;
    const status = String(ride?.status || "");
    const rid = String(ride?.id || "").trim();
    expectedAssignmentVersion = Math.max(0, Math.floor(Number(assignmentVersion) || 0));
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
    pendingOfferDoc = null;
    expectedAssignmentVersion = 0;
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
