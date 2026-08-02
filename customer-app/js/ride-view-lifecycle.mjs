/**
 * Phase 1 — customer ride view lifecycle (local).
 * Controls live ride listeners / rendering by visibility; does not throttle driver writes.
 *
 * States: VISIBLE | HIDDEN_GRACE | BACKGROUND | CLOSED_OR_EXPIRED | RESUMING
 */

export const VIEW_STATE = Object.freeze({
  VISIBLE: "VISIBLE",
  HIDDEN_GRACE: "HIDDEN_GRACE",
  BACKGROUND: "BACKGROUND",
  CLOSED_OR_EXPIRED: "CLOSED_OR_EXPIRED",
  RESUMING: "RESUMING",
});

export const VIEWER_DIAG = Object.freeze({
  VISIBLE: "viewer_visible",
  HIDDEN: "viewer_hidden",
  LISTENER_ATTACHED: "viewer_listener_attached",
  LISTENER_DETACHED: "viewer_listener_detached",
  RESUME_LATEST_LOADED: "viewer_resume_latest_loaded",
  PRESENCE_REFRESHED: "viewer_presence_refreshed",
  PRESENCE_FAILED: "viewer_presence_failed",
  PRESENCE_EXPIRED: "viewer_presence_expired",
  STALE_GENERATION: "viewer_stale_generation_ignored",
  TERMINAL_CLEANUP: "viewer_terminal_cleanup",
});

/** Short grace before tearing down live listeners after hide. */
export const HIDDEN_GRACE_MS = 1_500;

/**
 * @typedef {{
 *   subscribeLive: (rideId: string, generation: number) => void,
 *   unsubscribeLive: () => void,
 *   fetchLatestRide: (rideId: string) => Promise<object|null>,
 *   onLatestRide: (ride: object|null, generation: number) => void,
 *   startPresenceHeartbeat: (rideId: string, generation: number) => void,
 *   stopPresenceHeartbeat: () => void,
 *   isTrackableStatus?: (status: string) => boolean,
 *   isTerminalStatus?: (status: string) => boolean,
 *   diag?: (code: string, extra?: object) => void,
 *   nowMs?: () => number,
 *   setTimeoutFn?: typeof setTimeout,
 *   clearTimeoutFn?: typeof clearTimeout,
 * }} RideViewLifecycleDeps
 */

/**
 * @param {RideViewLifecycleDeps} deps
 */
export function createRideViewLifecycle(deps) {
  const nowMs = typeof deps.nowMs === "function" ? deps.nowMs : () => Date.now();
  const setT = typeof deps.setTimeoutFn === "function" ? deps.setTimeoutFn : setTimeout;
  const clearT = typeof deps.clearTimeoutFn === "function" ? deps.clearTimeoutFn : clearTimeout;
  const diag =
    typeof deps.diag === "function"
      ? deps.diag
      : (code) => {
          try {
            console.info(JSON.stringify({ type: "viewer_lifecycle_diag", reason: code }));
          } catch {
            /* ignore */
          }
        };

  const isTerminal =
    typeof deps.isTerminalStatus === "function"
      ? deps.isTerminalStatus
      : (s) =>
          ["completed", "cancelled", "cancelled_by_user", "expired", "declined"].includes(
            String(s || "")
          );

  let state = VIEW_STATE.CLOSED_OR_EXPIRED;
  let generation = 0;
  let boundRideId = "";
  let liveAttached = false;
  let graceTimer = 0;
  let destroyed = false;
  let resumeInFlight = false;
  let resumeToken = 0;

  /** Injectable counters for billing / tests (not written to Firestore). */
  const counters = {
    resumeReads: 0,
    listenerAttaches: 0,
    listenerDetaches: 0,
    snapshotEvents: 0,
    animationStops: 0,
    heartbeatAttempts: 0,
    heartbeatSuccess: 0,
    heartbeatFailure: 0,
  };

  function emit(code, extra) {
    diag(code, extra);
  }

  function clearGrace() {
    if (graceTimer) {
      clearT(graceTimer);
      graceTimer = 0;
    }
  }

  function detachLive(reason) {
    clearGrace();
    if (liveAttached) {
      deps.unsubscribeLive();
      liveAttached = false;
      counters.listenerDetaches += 1;
      counters.animationStops += 1;
      emit(VIEWER_DIAG.LISTENER_DETACHED, { reason: String(reason || "") });
    }
    deps.stopPresenceHeartbeat();
  }

  function attachLive(rideId, gen) {
    if (destroyed || gen !== generation || !rideId) return;
    if (liveAttached) return;
    deps.subscribeLive(rideId, gen);
    liveAttached = true;
    counters.listenerAttaches += 1;
    emit(VIEWER_DIAG.LISTENER_ATTACHED);
    deps.startPresenceHeartbeat(rideId, gen);
  }

  async function resumeVisible() {
    if (destroyed || !boundRideId) return;
    const gen = generation;
    const token = ++resumeToken;
    state = VIEW_STATE.RESUMING;
    resumeInFlight = true;
    try {
      counters.resumeReads += 1;
      const ride = await deps.fetchLatestRide(boundRideId);
      if (destroyed || gen !== generation || token !== resumeToken) {
        emit(VIEWER_DIAG.STALE_GENERATION);
        return;
      }
      emit(VIEWER_DIAG.RESUME_LATEST_LOADED);
      deps.onLatestRide(ride, gen);
      if (!ride || isTerminal(ride.status)) {
        state = VIEW_STATE.CLOSED_OR_EXPIRED;
        detachLive("terminal_or_missing");
        emit(VIEWER_DIAG.TERMINAL_CLEANUP);
        return;
      }
      state = VIEW_STATE.VISIBLE;
      emit(VIEWER_DIAG.VISIBLE);
      attachLive(boundRideId, gen);
    } catch {
      if (gen === generation && token === resumeToken && !destroyed) {
        // Still try to attach while visible; presence may fail separately.
        state = VIEW_STATE.VISIBLE;
        attachLive(boundRideId, gen);
      }
    } finally {
      if (gen === generation && token === resumeToken) resumeInFlight = false;
    }
  }

  function enterBackground() {
    if (destroyed) return;
    resumeToken += 1;
    resumeInFlight = false;
    state = VIEW_STATE.BACKGROUND;
    emit(VIEWER_DIAG.HIDDEN);
    detachLive("background");
  }

  function onHidden() {
    if (destroyed || !boundRideId) return;
    if (state === VIEW_STATE.BACKGROUND || state === VIEW_STATE.CLOSED_OR_EXPIRED) return;
    resumeToken += 1;
    resumeInFlight = false;
    state = VIEW_STATE.HIDDEN_GRACE;
    clearGrace();
    const gen = generation;
    graceTimer = setT(() => {
      graceTimer = 0;
      if (destroyed || gen !== generation) return;
      enterBackground();
    }, HIDDEN_GRACE_MS);
  }

  function onVisible() {
    if (destroyed || !boundRideId) return Promise.resolve();
    clearGrace();
    if (state === VIEW_STATE.VISIBLE && liveAttached) return Promise.resolve();
    if (state === VIEW_STATE.RESUMING && resumeInFlight) return Promise.resolve();
    return resumeVisible();
  }

  /**
   * Bind an active customer ride. Idempotent for the same rideId.
   * @param {{ rideId: string, forceRestart?: boolean }} opts
   * @returns {Promise<void>}
   */
  function bindRide({ rideId, forceRestart = false } = {}) {
    if (destroyed) return Promise.resolve();
    const id = String(rideId || "").trim();
    if (!id) {
      unbind();
      return Promise.resolve();
    }
    if (id === boundRideId && !forceRestart) {
      // Same ride — ensure visibility policy applied.
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        onHidden();
        return Promise.resolve();
      }
      if (!liveAttached) {
        return resumeVisible();
      }
      return Promise.resolve();
    }
    // Switch rides: bump generation so stale A cannot update B.
    generation += 1;
    detachLive("ride_switch");
    boundRideId = id;
    state = VIEW_STATE.CLOSED_OR_EXPIRED;
    if (typeof document !== "undefined" && document.visibilityState === "hidden") {
      state = VIEW_STATE.BACKGROUND;
      emit(VIEWER_DIAG.HIDDEN);
      return Promise.resolve();
    }
    return resumeVisible();
  }

  function unbind() {
    generation += 1;
    clearGrace();
    detachLive("unbind");
    boundRideId = "";
    state = VIEW_STATE.CLOSED_OR_EXPIRED;
    resumeInFlight = false;
  }

  function noteSnapshot() {
    if (liveAttached) counters.snapshotEvents += 1;
  }

  function getGeneration() {
    return generation;
  }

  function isLiveAttached() {
    return liveAttached;
  }

  function getState() {
    return state;
  }

  function getBoundRideId() {
    return boundRideId;
  }

  function getCounters() {
    return { ...counters };
  }

  function bumpHeartbeatAttempt() {
    counters.heartbeatAttempts += 1;
  }
  function bumpHeartbeatSuccess() {
    counters.heartbeatSuccess += 1;
  }
  function bumpHeartbeatFailure() {
    counters.heartbeatFailure += 1;
  }

  function isCurrentGeneration(gen) {
    return !destroyed && Number(gen) === generation;
  }

  function destroy() {
    destroyed = true;
    unbind();
  }

  return {
    VIEW_STATE,
    HIDDEN_GRACE_MS,
    bindRide,
    unbind,
    onVisible,
    onHidden,
    enterBackground,
    noteSnapshot,
    getGeneration,
    isLiveAttached,
    getState,
    getBoundRideId,
    getCounters,
    bumpHeartbeatAttempt,
    bumpHeartbeatSuccess,
    bumpHeartbeatFailure,
    isCurrentGeneration,
    destroy,
    /** Test helper: force detach without unbind */
    _detachLiveForTest: detachLive,
  };
}

/**
 * Wire document visibility / page lifecycle to a controller.
 * @param {ReturnType<typeof createRideViewLifecycle>} lifecycle
 * @param {Document} [doc]
 * @param {Window} [win]
 */
export function attachBrowserLifecycleListeners(lifecycle, doc = typeof document !== "undefined" ? document : null, win = typeof window !== "undefined" ? window : null) {
  if (!lifecycle || !doc) return () => {};

  const onVis = () => {
    if (doc.visibilityState === "hidden") lifecycle.onHidden();
    else void lifecycle.onVisible();
  };
  const onPageHide = () => lifecycle.enterBackground();
  const onPageShow = () => {
    void lifecycle.onVisible();
  };
  const onFreeze = () => lifecycle.enterBackground();
  const onResume = () => {
    void lifecycle.onVisible();
  };
  const onOnline = () => {
    if (doc.visibilityState !== "hidden") void lifecycle.onVisible();
  };

  doc.addEventListener("visibilitychange", onVis);
  win?.addEventListener?.("pagehide", onPageHide);
  win?.addEventListener?.("pageshow", onPageShow);
  doc.addEventListener?.("freeze", onFreeze);
  doc.addEventListener?.("resume", onResume);
  win?.addEventListener?.("online", onOnline);

  return () => {
    doc.removeEventListener("visibilitychange", onVis);
    win?.removeEventListener?.("pagehide", onPageHide);
    win?.removeEventListener?.("pageshow", onPageShow);
    doc.removeEventListener?.("freeze", onFreeze);
    doc.removeEventListener?.("resume", onResume);
    win?.removeEventListener?.("online", onOnline);
  };
}
