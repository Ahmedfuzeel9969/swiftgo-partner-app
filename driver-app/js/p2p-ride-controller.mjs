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

async function loadSignalingClient() {
  return import("./p2p-signaling-client.mjs");
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
 *   onDiag?: (code: string) => void,
 *   RTCPeerConnection?: typeof RTCPeerConnection,
 *   createRidePeerOfferClient?: Function,
 *   watchRidePeerSession?: Function,
 *   closeRidePeerSessionClient?: Function,
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
  /** Authoritative assignment version from ride sync — not mutated by offer/answer payloads. */
  let syncedAssignmentVersion = 0;
  let closed = false;
  let starting = false;
  let answeredSessionId = "";
  let offerRequestCount = 0;
  let startupGeneration = 0;
  /** @type {{ rideId: string, trackingSessionId: string, assignmentVersion: number, vehicleId?: string } | null} */
  let pendingTarget = null;

  function isHealthy() {
    return session?.getState?.()?.isHealthy === true;
  }

  function notifyHealth() {
    opts.onHealthyChange?.(isHealthy());
  }

  function currentAssignmentKey() {
    return assignmentKey(rideId, trackingSessionId, syncedAssignmentVersion);
  }

  function isStartCurrent(gen, key) {
    return !closed && gen === startupGeneration && key === currentAssignmentKey();
  }

  function abortStaleAttempt(localSession, localUnwatch) {
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
    }
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

  function invalidateInFlight() {
    startupGeneration += 1;
    pendingTarget = null;
  }

  function requestStart(target) {
    if (closed) return;
    const rid = String(target?.rideId || "").trim();
    const tid = String(target?.trackingSessionId || "").trim();
    const av = Math.max(1, Math.floor(Number(target?.assignmentVersion) || 0));
    if (!rid || !tid) return;

    const key = assignmentKey(rid, tid, av);
    if (session && currentAssignmentKey() === key) return;

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
        const key = assignmentKey(target.rideId, target.trackingSessionId, target.assignmentVersion);

        destroySession();
        rideId = target.rideId;
        trackingSessionId = target.trackingSessionId;
        vehicleId = target.vehicleId || "";
        assignmentVersion = target.assignmentVersion;
        syncedAssignmentVersion = target.assignmentVersion;

        let localUnwatch = () => {};
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
          onLocalDescription: async (kind, sdp, meta) => {
            if (kind !== "offer") return;
            if (!isStartCurrent(gen, key) || localSession !== session) return;
            const res = await createOfferClient({
              rideId: target.rideId,
              offerSdp: sdp,
              peerSessionId: meta.peerSessionId,
              trackingSessionId: meta.trackingSessionId,
              vehicleId: target.vehicleId || undefined,
              assignmentVersion: target.assignmentVersion || undefined,
            });
            if (!isStartCurrent(gen, key) || localSession !== session) return;
            offerRequestCount += 1;
            assignmentVersion =
              Number(res?.assignmentVersion) || meta.assignmentVersion || target.assignmentVersion || 1;
          },
        });

        session = localSession;

        await localSession.startAsDriver({
          trackingSessionId: target.trackingSessionId,
          assignmentVersion: target.assignmentVersion || 1,
        });
        if (!isStartCurrent(gen, key)) {
          abortStaleAttempt(localSession, localUnwatch);
          session = null;
          continue;
        }

        localUnwatch = await watchSession(
          target.rideId,
          (docData) => {
            if (!isStartCurrent(gen, key) || localSession !== session || !docData) return;
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
            if (localSession === session) {
              /* permission / network → Firebase fallback via peer state */
            }
          }
        );

        if (!isStartCurrent(gen, key)) {
          abortStaleAttempt(localSession, localUnwatch);
          session = null;
          continue;
        }

        unwatch = localUnwatch;
        notifyHealth();
      }
    } catch {
      destroySession();
      opts.onHealthyChange?.(false);
    } finally {
      starting = false;
      if (pendingTarget && !closed) {
        void runStartLoop();
      }
    }
  }

  async function start(target = {}) {
    requestStart(target);
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
    getOfferRequestCount: () => offerRequestCount,
    /** Test helpers */
    _getStartupGeneration: () => startupGeneration,
    _isStarting: () => starting,
    _getPendingTarget: () => (pendingTarget ? { ...pendingTarget } : null),
  };
}
