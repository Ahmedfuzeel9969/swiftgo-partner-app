/**
 * Phase 3 — customer P2P ride controller (answer + ingest) + source arbiter bridge.
 */

import { P2P_STATE, P2P_EXECUTION_STATUSES } from "./p2p-protocol.mjs";
import { createP2pPeerSession } from "./p2p-peer-session.mjs";
import { createLiveLocationSourceArbiter } from "./live-location-source-arbiter.mjs";
import { getFieldDiagnostics } from "./field-diagnostics.mjs";

/** Lazy — app wrapper pulls Firebase https imports unsuitable for Node tests. */
async function defaultEnsureIceConfiguration() {
  const mod = await import("./p2p-ice-bootstrap.mjs");
  return mod.ensureP2pIceConfiguration();
}

/**
 * @param {{
 *   onRenderFix?: (fix: object, meta: object) => void,
 *   onChannelOpen?: () => void,
 *   onDiag?: (code: string) => void,
 *   RTCPeerConnection?: typeof RTCPeerConnection,
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
  let signalingMod = null;

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
    unwatch();
    unwatch = () => {};
    watching = false;
    const s = session;
    session = null;
    boundSessionId = "";
    lastOfferSdp = "";
    if (s) void s.close({ reason: "destroy" });
    arbiter.noteP2pUnhealthy();
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

  async function answerOffer(docData) {
    if (closed || answering) return;
    const sid = String(docData?.sessionId || "");
    const offer = String(docData?.offer || "");
    if (!sid || !offer) return;
    if (String(docData.state || "") === "closed") return;
    // Same offer + live session: skip. Re-answer only when PC is actually gone.
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

    answering = true;
    try {
      const sig = await signaling();
      destroySession();
      boundSessionId = sid;
      lastOfferSdp = offer;
      session = createP2pPeerSession({
        role: "customer",
        RTCPeerConnection: opts.RTCPeerConnection,
        ensureIceConfiguration: opts.ensureIceConfiguration || defaultEnsureIceConfiguration,
        onDiag: diag,
        onChannelOpen: () => opts.onChannelOpen?.(),
        onState: (st) => {
          if (st === P2P_STATE.FIREBASE_FALLBACK || st === P2P_STATE.P2P_DEGRADED) {
            arbiter.noteP2pUnhealthy();
          }
        },
        onLocationFix: (fix) => {
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
          await sig.publishRidePeerAnswerClient?.({
            rideId,
            answerSdp: sdp,
            peerSessionId: meta.peerSessionId,
          });
          session?.noteAnswerUploaded?.(sdp);
        },
      });
      session.setPipelineRideId?.(rideId);
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
    const onData = (docData) => {
      if (!docData) return;
      void answerOffer(docData);
    };
    const onError = () => {
      arbiter.noteP2pUnhealthy();
    };
    if (typeof opts.watchRidePeerSession === "function") {
      unwatch = opts.watchRidePeerSession(rid, onData, onError);
      return;
    }
    void signaling().then((sig) => {
      if (!watching || rideId !== rid || closed) return;
      unwatch = sig.watchRidePeerSession(rid, onData, onError);
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
    uiVisible = Boolean(next);
    // Active-ride policy: screen hidden/background must not suspend or stop P2P.
    // Signaling watch stays attached; resume only re-answers if the session is dead.
  }

  function isUiVisible() {
    return uiVisible;
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
    }),
    getState: () => session?.getState?.() || { state: P2P_STATE.DISABLED },
    getPipeline: () => session?.getPipeline?.() || [],
    getPipelineReport: () => session?.getPipelineReport?.() || null,
  };
}
