/**
 * Phase 3 — driver P2P ride controller (offer + send locations).
 * One geolocation watch remains elsewhere; this only consumes validated fixes.
 *
 * Startup-attempt identity (rideId + trackingSessionId + generation) is immutable
 * for in-flight stale checks. Established assignment identity (syncedAssignmentVersion)
 * is updated when the server returns an authoritative AV and drives same-ride reuse.
 */

import { P2P_STATE, P2P_EXECUTION_STATUSES } from "./p2p-protocol.mjs";
import { createP2pPeerSession } from "./p2p-peer-session.mjs";
import { createLiveLocationSourceArbiter } from "../../shared/js/live-location-source-arbiter.mjs";
import { rideLocationAssignmentVersion, validateRideLocationFix } from "../../shared/js/ride-location-contract.mjs";
import { createPeerSessionLease } from "../../shared/js/p2p-session-lease.mjs";
import { createFallbackLocationWatch } from "../../shared/js/fallback-location-watch.mjs";
import { normalizeRuntimeDeliveryPolicy, resolveLocationDeliveryPolicy } from "../../shared/js/location-delivery-policy.mjs";

/** Lazy — app wrapper pulls Firebase https imports unsuitable for Node tests. */
async function defaultEnsureIceConfiguration(context) {
  const mod = await import("./p2p-ice-bootstrap.mjs");
  return mod.ensureP2pIceConfiguration(context);
}

function assignmentKey(rideId, trackingSessionId, assignmentVersion) {
  const av = Math.max(0, Math.floor(Number(assignmentVersion) || 0));
  return `${String(rideId || "").trim()}|${String(trackingSessionId || "").trim()}|${av}`;
}

/** Immutable in-flight start identity — deliberately excludes assignmentVersion. */
function attemptIdentityKey(rideId, trackingSessionId) {
  return `${String(rideId || "").trim()}|${String(trackingSessionId || "").trim()}`;
}

/** Known authoritative AV (>=1) or 0 when bootstrap has not completed yet. */
function normalizeAssignmentVersion(raw, ...fallbacks) {
  const explicit = Math.floor(Number(raw) || 0);
  if (explicit >= 1) return explicit;
  for (const fb of fallbacks) {
    const n = Math.floor(Number(fb) || 0);
    if (n >= 1) return n;
  }
  return 0;
}

function serverOfferAssignmentVersion(av) {
  const n = Math.floor(Number(av) || 0);
  return n >= 1 ? n : undefined;
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
  const nowMs = opts.nowMs || Date.now;
  const setT = opts.setTimeoutFn || setTimeout, clearT = opts.clearTimeoutFn || clearTimeout;
  let currentRide = null;
  let deliveryPolicy = resolveLocationDeliveryPolicy();
  const customerWatch = createFallbackLocationWatch({
    setTimeoutFn: setT, clearTimeoutFn: clearT,
    subscribe: (target, next, error) => opts.watchCustomerLocation?.(target.rideId, next, error, target.assignmentId),
    onData: (data) => { if (currentRide && data?.location) customerArbiter.ingestFirebase(data.location, customerArbiter.getGeneration()); },
    onError: () => diag("customer_firebase_listen_failed"),
  });
  const customerArbiter = createLiveLocationSourceArbiter({
    nowMs, p2pFirstGraceMs: 12_000,
    onFallbackDemand: (needed) => customerWatch.setNeeded(needed),
    setTimeoutFn: opts.setTimeoutFn, clearTimeoutFn: opts.clearTimeoutFn,
    validateFix: (fix, previous) => validateRideLocationFix(fix, {
      nowMs: nowMs(), previous, rideId: currentRide?.id,
      assignmentVersion: currentRide ? rideLocationAssignmentVersion(currentRide) : 0,
      assignmentId: currentRide?.assignmentSessionToken, role: "customer",
    }),
    onRender: (fix) => { if (currentRide) opts.onCustomerLocation?.(fix); },
  });
  let session = null;
  let unwatch = () => {};
  let rideId = "";
  let trackingSessionId = "";
  let vehicleId = "";
  let assignmentVersion = 0;
  /** Server-authoritative assignment identity for reconnect + same-ride reuse. */
  let syncedAssignmentVersion = 0;
  let closed = false;
  let starting = false;
  let answeredSessionId = "";
  let lastAcceptedAnswer = "";
  let lastPublishedOffer = "";
  let lastPublishedOfferFingerprint = "";
  let signalingMod = null;
  let watchRetryTimer = null;
  let watchRetryAttempt = 0;
  let startRetryTimer = null;
  let startRetryAttempt = 0;
  let fallbackAfterMs = deliveryPolicy.p2pFallbackAfterMs;
  let startupGeneration = 0;
  /** @type {{ rideId: string, trackingSessionId: string, assignmentVersion: number, vehicleId?: string } | null} */
  let pendingTarget = null;
  const MAX_WATCH_RETRIES = 8;
  const MAX_START_RETRIES = 8;
  const lease = createPeerSessionLease({ nowMs, setTimeoutFn: setT, clearTimeoutFn: clearT,
    renew: async () => {
      const target = session, sid = target?.getState?.().peerSessionId;
      const payload = { rideId, peerSessionId: sid, offerFingerprint: lastPublishedOfferFingerprint, assignmentId: currentRide?.assignmentSessionToken };
      const sig = await signaling();
      if (target !== session) return null;
      return sig.renewRidePeerSessionClient?.(payload);
    },
    onExpired: () => { session?.suspend?.(); notifyHealth(); triggerReconnect(); },
  });

  const ctrlCounters = {
    startAttempts: 0,
    startFailures: 0,
    offerPublishFailures: 0,
    watchErrors: 0,
    watchRetries: 0,
    staleAborts: 0,
  };
  const completedSessionCounters = {};
  let counterRideId = "";

  function beginCounterRide(nextRideId) {
    const rid = String(nextRideId || "").trim();
    if (!rid || rid === counterRideId) return;
    for (const key of Object.keys(completedSessionCounters)) delete completedSessionCounters[key];
    counterRideId = rid;
  }

  function archiveSessionCounters(target) {
    const snapshot = target?.getCounters?.() || {};
    for (const [key, raw] of Object.entries(snapshot)) {
      const value = Number(raw);
      if (!Number.isFinite(value) || value < 0) continue;
      completedSessionCounters[key] = (Number(completedSessionCounters[key]) || 0) + value;
    }
  }

  function allSessionCounters() {
    const combined = { ...completedSessionCounters };
    const current = session?.getCounters?.() || {};
    for (const [key, raw] of Object.entries(current)) {
      const value = Number(raw);
      if (!Number.isFinite(value) || value < 0) continue;
      combined[key] = (Number(combined[key]) || 0) + value;
    }
    return combined;
  }

  function clearWatchRetry() {
    if (watchRetryTimer) {
      clearT(watchRetryTimer);
      watchRetryTimer = null;
    }
    watchRetryAttempt = 0;
  }

  function clearStartRetry({ resetAttempt = true } = {}) {
    if (startRetryTimer) {
      clearT(startRetryTimer);
      startRetryTimer = null;
    }
    if (resetAttempt) startRetryAttempt = 0;
  }

  function scheduleStartRetry(target) {
    if (closed || !target?.rideId || !target?.trackingSessionId) return;
    if (startRetryTimer) return;
    const captured = { ...target };
    const retryGeneration = startupGeneration;
    const cooldown = startRetryAttempt >= MAX_START_RETRIES;
    const delayMs = cooldown ? 120000 : Math.min(30_000, 1_000 * 2 ** startRetryAttempt);
    startRetryAttempt += 1;
    ctrlCounters.startRetries = (Number(ctrlCounters.startRetries) || 0) + 1;
    startRetryTimer = setT(() => {
      startRetryTimer = null;
      if (closed || retryGeneration !== startupGeneration) return;
      if (cooldown) startRetryAttempt = 0;
      requestStart(captured);
    }, delayMs);
  }

  function currentAssignmentKey() {
    return assignmentKey(rideId, trackingSessionId, syncedAssignmentVersion);
  }

  function currentAttemptKey() {
    return attemptIdentityKey(rideId, trackingSessionId);
  }

  /**
   * In-flight start remains valid when generation matches and the attempt's
   * ride/tracking identity still owns the controller — not when AV is later
   * established from the server.
   */
  function isStartCurrent(gen, attemptKey) {
    return (
      !closed &&
      gen === startupGeneration &&
      attemptKey === currentAttemptKey()
    );
  }

  function applyAuthoritativeAssignmentVersion(nextAv) {
    const av = Math.floor(Number(nextAv) || 0);
    if (av < 1) return;
    assignmentVersion = av;
    syncedAssignmentVersion = av;
    session?.syncAssignmentVersion?.(av);
  }

  /**
   * Same live session should be reused when ride+tracking match and either:
   * - incoming AV is unknown (0) while we already own this ride, or
   * - incoming AV matches the established authoritative AV, or
   * - both sides are still in bootstrap (AV unknown).
   * A genuine different authoritative AV invalidates the session.
   */
  function shouldReuseLiveSession(rid, tid, incomingAv) {
    if (!session) return false;
    if (rideId !== rid || trackingSessionId !== tid) return false;
    const incoming = Math.floor(Number(incomingAv) || 0);
    if (syncedAssignmentVersion >= 1) {
      return incoming < 1 || incoming === syncedAssignmentVersion;
    }
    return incoming < 1 || incoming === assignmentVersion;
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
      lastPublishedOfferFingerprint = "";
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
        renewRidePeerSessionClient: opts.renewRidePeerSessionClient,
        getRidePeerOfferRevisionClient: opts.getRidePeerOfferRevisionClient,
        watchRidePeerSession: opts.watchRidePeerSession,
      };
    }
    if (!signalingMod) {
      signalingMod = await import("./p2p-signaling-client.mjs");
    }
    return signalingMod;
  }

  function isHealthy() {
    return session?.getState?.()?.isOutboundLocationHealthy === true;
  }

  function notifyHealth() {
    opts.onHealthyChange?.(isHealthy());
  }

  function destroySession() {
    lease.stop();
    clearWatchRetry();
    unwatch();
    unwatch = () => {};
    const s = session;
    session = null;
    answeredSessionId = "";
    lastAcceptedAnswer = "";
    lastPublishedOffer = "";
    lastPublishedOfferFingerprint = "";
    if (s) {
      void s.close({ reason: "destroy" });
      archiveSessionCounters(s);
    }
    notifyHealth();
  }

  async function closeSignaling() {
    const id = rideId;
    const closingSessionId = String(session?.getState?.()?.peerSessionId || "");
    const closingFingerprint = lastPublishedOfferFingerprint;
    if (!id || !closingSessionId) return;
    try {
      const sig = await signaling();
      await sig.closeRidePeerSessionClient?.({
        rideId: id,
        peerSessionId: closingSessionId,
        offerFingerprint: closingFingerprint,
      });
    } catch {
      /* ignore */
    }
  }

  function invalidateInFlight() {
    startupGeneration += 1;
    pendingTarget = null;
  }

  function scheduleWatchRetry(rid, gen, attemptKey) {
    if (closed || rideId !== rid || !isStartCurrent(gen, attemptKey)) return;
    const cooldown = watchRetryAttempt >= MAX_WATCH_RETRIES;
    if (watchRetryTimer) return;
    const delayMs = cooldown ? 120000 : Math.min(30_000, 1_000 * 2 ** watchRetryAttempt);
    watchRetryAttempt += 1;
    ctrlCounters.watchRetries += 1;
    watchRetryTimer = setT(() => {
      watchRetryTimer = null;
      if (cooldown) watchRetryAttempt = 0;
      if (!closed && rideId === rid && isStartCurrent(gen, attemptKey)) {
        void attachAnswerWatch(rid, gen, attemptKey);
      }
    }, delayMs);
  }

  async function attachAnswerWatch(rid, gen, attemptKey) {
    if (watchRetryTimer) {
      clearT(watchRetryTimer);
      watchRetryTimer = null;
    }
    unwatch();
    const localSession = session;
    const onData = (docData) => {
      if (!isStartCurrent(gen, attemptKey) || localSession !== session || !docData) return;
      watchRetryAttempt = 0;
      const sid = String(docData.sessionId || "");
      if (String(docData.state || "") === "closed") {
        // The customer closes a stalled signaling session to request fresh
        // offer/answer identity. Ignoring this left both peers stuck on the
        // same unusable SDP for the remainder of the ride.
        // A delayed close snapshot for an older offer must not rotate the
        // currently active peer connection.
        if (sid && sid === String(session.getState?.()?.peerSessionId || "")) {
          triggerReconnect();
        }
        return;
      }
      const answer = String(docData.answer || "");
      if (sid === session.getState().peerSessionId && docData.offerFingerprint === lastPublishedOfferFingerprint) {
        lease.observe(`${sid}|${lastPublishedOfferFingerprint}`, docData.expiresAt);
      }
      if (!answer || !sid) return;
      if (sid !== session.getState().peerSessionId) return;
      const answeredFingerprint = String(docData.answeredOfferFingerprint || "");
      if (
        lastPublishedOfferFingerprint &&
        (answeredFingerprint || lastPublishedOfferFingerprint.startsWith("sha256_")) &&
        answeredFingerprint !== lastPublishedOfferFingerprint
      ) return;
      if (answeredSessionId === sid && answer === lastAcceptedAnswer) return;
      const nextAv = Math.floor(Number(docData.assignmentVersion) || 0);
      if (nextAv >= 1) {
        applyAuthoritativeAssignmentVersion(nextAv);
      }
      session.noteAnswerDownloaded?.(answer);
      const answerSession = session, answerGeneration = answerSession.getState().generation;
      void answerSession.acceptRemoteAnswer(answer, answerGeneration).then((accepted) => {
        if (session !== answerSession || answerSession.getState().generation !== answerGeneration) return;
        if (accepted) { answeredSessionId = sid; lastAcceptedAnswer = answer; }
        else triggerReconnect();
      });
    };
    const onError = () => {
      if (!isStartCurrent(gen, attemptKey) || localSession !== session) return;
      ctrlCounters.watchErrors += 1;
      scheduleWatchRetry(rid, gen, attemptKey);
    };
    const sig = await signaling();
    if (!isStartCurrent(gen, attemptKey) || localSession !== session || closed || rideId !== rid) {
      return;
    }
    if (typeof sig.watchRidePeerSession === "function") {
      unwatch = sig.watchRidePeerSession(rid, onData, onError);
    }
  }

  function triggerReconnect() {
    if (closed || !rideId || !trackingSessionId || !session) return;
    answeredSessionId = "";
    const av = normalizeAssignmentVersion(assignmentVersion, syncedAssignmentVersion);
    if (av < 1) return;
    const reconnectSession = session;
    session.scheduleReconnect(() => {
      if (reconnectSession !== session) return null;
      return reconnectSession.startAsDriver({
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
    const av = normalizeAssignmentVersion(
      target?.assignmentVersion,
      syncedAssignmentVersion,
      rideId === rid ? assignmentVersion : 0
    );
    if (!rid || !tid) return;

    if (shouldReuseLiveSession(rid, tid, av)) {
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
      ? attemptIdentityKey(pendingTarget.rideId, pendingTarget.trackingSessionId)
      : null;
    const nextAttemptKey = attemptIdentityKey(rid, tid);
    const establishedChanged =
      syncedAssignmentVersion >= 1 &&
      av >= 1 &&
      av !== syncedAssignmentVersion &&
      rideId === rid &&
      trackingSessionId === tid;

    pendingTarget = {
      rideId: rid,
      trackingSessionId: tid,
      assignmentVersion: av,
      assignmentId: target?.assignmentId || "",
      vehicleId: String(target?.vehicleId || ""),
    };

    if (starting && (prevPendingKey !== nextAttemptKey || establishedChanged || currentAttemptKey() !== nextAttemptKey)) {
      startupGeneration += 1;
    } else if (prevPendingKey && prevPendingKey !== nextAttemptKey) {
      startupGeneration += 1;
    } else if (establishedChanged && !starting) {
      // Genuine AV change on same ride/tracking — bump so any in-flight start aborts.
      startupGeneration += 1;
    }

    if (starting) return;
    void runStartLoop();
  }

  async function runStartLoop() {
    if (starting || closed) return;
    starting = true;
    let failedTarget = null;
    try {
      while (pendingTarget && !closed) {
        const target = pendingTarget;
        failedTarget = target;
        pendingTarget = null;

        startupGeneration += 1;
        const gen = startupGeneration;
        const attemptKey = attemptIdentityKey(target.rideId, target.trackingSessionId);

        ctrlCounters.startAttempts += 1;
        destroySession();
        beginCounterRide(target.rideId);
        rideId = target.rideId;
        trackingSessionId = target.trackingSessionId;
        vehicleId = target.vehicleId || "";
        assignmentVersion = target.assignmentVersion;
        syncedAssignmentVersion = target.assignmentVersion;

        let localUnwatch = () => {};
        const sig = await signaling();
        if (!isStartCurrent(gen, attemptKey)) continue;

        const localSession = createP2pPeerSession({
          role: "driver",
          rideId: target.rideId,
          assignmentId: target.assignmentId,
          nowMs,
          setTimeoutFn: setT, clearTimeoutFn: clearT,
          fallbackAfterMs,
          RTCPeerConnection: opts.RTCPeerConnection,
          ensureIceConfiguration: opts.ensureIceConfiguration || defaultEnsureIceConfiguration,
          onDiag: diag,
          onState: () => {
            if (localSession === session) notifyHealth();
          },
          onLocationFix: (fix) => Boolean(localSession === session && currentRide &&
            customerArbiter.ingestP2p(fix, customerArbiter.getGeneration())),
          onAck: () => {
            if (localSession === session) notifyHealth();
          },
          onNeedReconnect: () => {
            if (localSession === session) triggerReconnect();
          },
          onChannelOpen: () => opts.onChannelOpen?.(),
          onLocalDescription: async (kind, sdp, meta) => {
            if (kind !== "offer") return;
            const current = () => isStartCurrent(gen, attemptKey) && localSession === session && localSession.getState().generation === meta.generation;
            if (!current()) return;
            lastPublishedOffer = String(sdp || "");
            lastPublishedOfferFingerprint = "";
            lease.stop();
            answeredSessionId = "";
            try {
              const revision = await sig.getRidePeerOfferRevisionClient?.({ rideId: target.rideId, assignmentId: target.assignmentId });
              if (!current()) return;
              const offerPayload = {
                rideId: target.rideId,
                assignmentId: target.assignmentId,
                offerSdp: sdp,
                peerSessionId: meta.peerSessionId,
                trackingSessionId: meta.trackingSessionId,
                vehicleId: target.vehicleId || undefined,
                ...(revision || {}),
              };
              const offerAv = serverOfferAssignmentVersion(target.assignmentVersion);
              if (offerAv != null) offerPayload.assignmentVersion = offerAv;
              const res = await sig.createRidePeerOfferClient?.(offerPayload);
              if (!current()) return;
              const nextAv = Math.floor(Number(res?.assignmentVersion) || 0);
              if (nextAv >= 1) {
                applyAuthoritativeAssignmentVersion(nextAv);
              }
              if (res?.offerFingerprint) {
                lastPublishedOfferFingerprint = String(res.offerFingerprint);
              }
              lease.observe(`${meta.peerSessionId}|${lastPublishedOfferFingerprint}`, res?.expiresAtMs);
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
          assignmentVersion: target.assignmentVersion >= 1 ? target.assignmentVersion : 0,
        });

        if (!isStartCurrent(gen, attemptKey)) {
          abortStaleAttempt(localSession, localUnwatch);
          session = null;
          continue;
        }

        await attachAnswerWatch(target.rideId, gen, attemptKey);
        localUnwatch = unwatch;

        if (!isStartCurrent(gen, attemptKey)) {
          abortStaleAttempt(localSession, localUnwatch);
          session = null;
          continue;
        }

        notifyHealth();
        failedTarget = null;
        clearStartRetry();
      }
    } catch (error) {
      ctrlCounters.startFailures += 1;
      ctrlCounters.lastStartFailure = String(error?.message || error || "P2P_START_FAILED").slice(0, 80);
      destroySession();
      opts.onHealthyChange?.(false);
      scheduleStartRetry(failedTarget);
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
    assignmentId: nextAssignmentId = "",
  } = {}) {
    requestStart({
      rideId: nextRideId,
      trackingSessionId: nextTracking,
      vehicleId: nextVehicleId,
      assignmentVersion: nextAv,
      assignmentId: nextAssignmentId,
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
    const remoteClose = closeRemote ? closeSignaling() : null;
    invalidateInFlight();
    clearWatchRetry();
    clearStartRetry();
    currentRide = null;
    customerWatch.stop();
    customerArbiter.reset();
    opts.onCustomerLocation?.(null);
    destroySession();
    rideId = "";
    trackingSessionId = "";
    assignmentVersion = 0;
    syncedAssignmentVersion = 0;
    vehicleId = "";
    await remoteClose;
  }

  function syncForRide({ ride, trackingSessionId: tid, assignmentVersion: rideAssignmentVersion = 0 }) {
    if (closed) return;
    const status = String(ride?.status || "");
    const rid = String(ride?.id || "").trim();
    if (!rid || !P2P_EXECUTION_STATUSES.includes(status) || !tid) {
      void stop({ closeRemote: true });
      return;
    }
    if (currentRide?.id !== rid || currentRide?.assignmentSessionToken !== ride.assignmentSessionToken) {
      invalidateInFlight();
      destroySession();
      customerArbiter.reset();
      opts.onCustomerLocation?.(null);
      currentRide = ride;
      customerWatch.setBinding({ key: `${rid}|${ride.assignmentSessionToken}`, rideId: rid, assignmentId: ride.assignmentSessionToken });
      customerArbiter.beginP2pFirstWindow();
    }
    currentRide = ride;
    // Active execution rides keep P2P up regardless of customer viewer presence.
    requestStart({
      rideId: rid,
      trackingSessionId: tid,
      vehicleId: ride?.vehicleId,
      assignmentVersion: rideAssignmentVersion || rideLocationAssignmentVersion(ride),
      assignmentId: ride.assignmentSessionToken || "",
    });
  }

  function destroy() {
    closed = true;
    invalidateInFlight();
    void stop({ closeRemote: true });
    customerArbiter.destroy();
  }

  function createCommTransport() {
    return session?.createCommTransport?.() || null;
  }

  function createMediaBridge() {
    return session?.createMediaBridge?.() || null;
  }

  function configureDeliveryPolicy(policy = {}) {
    deliveryPolicy = normalizeRuntimeDeliveryPolicy(policy, deliveryPolicy);
    customerArbiter.configureDeliveryPolicy(deliveryPolicy);
    fallbackAfterMs = deliveryPolicy.p2pFallbackAfterMs;
    session?.configureHealthPolicy?.({ fallbackAfterMs });
    notifyHealth();
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
    configureDeliveryPolicy,
    getCounters: () => ({
      ...allSessionCounters(),
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
    _getCustomerLocationWatchState: () => customerWatch.getState(),
    _getControllerAssignmentVersion: () => assignmentVersion,
    _getSyncedAssignmentVersion: () => syncedAssignmentVersion,
    _getCurrentAssignmentKey: () => currentAssignmentKey(),
    _getCurrentAttemptKey: () => currentAttemptKey(),
  };
}
