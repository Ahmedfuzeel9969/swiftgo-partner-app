import { normalizeRuntimeDeliveryPolicy } from "./location-delivery-policy.mjs";

/** One marker pipeline, latest-only fallback, monotonic GPS, cancellable deadlines.
 * onFallbackDemand gates a LOCATION-ONLY subscription, never the ride lifecycle.
 */
export function createLiveLocationSourceArbiter(opts = {}) {
  const nowMs = opts.nowMs || Date.now;
  const setT = opts.setTimeoutFn || setTimeout, clearT = opts.clearTimeoutFn || clearTimeout;
  let policy = normalizeRuntimeDeliveryPolicy({
    ...opts,
    ...(opts.fallbackAfterMs == null ? {} : { p2pFallbackAfterMs: opts.fallbackAfterMs }),
  });
  // Standalone legacy consumers may choose no startup window; app controllers opt in.
  let graceMs = opts.p2pFirstGraceMs ?? 0;
  let generation = 0, closed = false, active = false;
  let lastRendered = null, lastFirebase = null, lastP2pAt = null, lastFirebaseRenderAt = null;
  let preferred = "firebase", p2pHealthy = false, startedAt = null, firstDone = false;
  let timer = null, notifiedDemand = null;
  const diag = opts.onDiag || (() => {});
  const counters = {
    p2pReceived: 0, firebaseReceived: 0,
    p2pAccepted: 0, p2pRendered: 0, firebaseAccepted: 0, firebaseRendered: 0,
    firebaseThrottled: 0, firebaseIgnoredWhileP2p: 0, staleRejected: 0,
    sourceSwitches: 0, sourceSwitchP2pToFirebase: 0, sourceSwitchFirebaseToP2p: 0,
  };
  const current = (gen) => !closed && Number(gen) === generation;
  const firstWaiting = () => !firstDone && startedAt != null && nowMs() < startedAt + graceMs;
  const demand = () => active && !closed && policy.firebaseFallbackEnabled && !p2pHealthy && !firstWaiting();

  function notifyDemand() {
    const next = demand();
    if (next === notifiedDemand) return;
    notifiedDemand = next;
    opts.onFallbackDemand?.(next);
  }
  function shouldReplace(prev, next) {
    if (!next || !Number.isFinite(next.lat) || !Number.isFinite(next.lng) ||
        Math.abs(next.lat) > 90 || Math.abs(next.lng) > 180 ||
        !Number.isFinite(next.observedAt) || next.observedAt <= 0) return false;
    if (opts.validateFix && !opts.validateFix(next, prev).ok) return false;
    if (!prev) return true;
    if (next.observedAt <= prev.observedAt) return false;
    return !(next.trackingSessionId === prev.trackingSessionId &&
      next.sequence && prev.sequence && next.sequence <= prev.sequence);
  }
  function render(fix, reason) {
    if (!shouldReplace(lastRendered, fix)) { counters.staleRejected++; return false; }
    const previousSource = lastRendered?.source;
    lastRendered = fix;
    if (previousSource && previousSource !== fix.source) {
      counters.sourceSwitches++;
      counters[fix.source === "p2p" ? "sourceSwitchFirebaseToP2p" : "sourceSwitchP2pToFirebase"]++;
      diag(`location_source_${fix.source}`);
    }
    counters[`${fix.source}Accepted`]++;
    counters[`${fix.source}Rendered`]++;
    if (fix.source === "firebase") lastFirebaseRenderAt = nowMs();
    opts.onRender?.(fix, { reason, preferred, p2pHealthy, generation });
    return true;
  }
  function activateFallback() {
    if (p2pHealthy) { lastFirebaseRenderAt = null; diag("p2p_firebase_fallback"); }
    p2pHealthy = false; preferred = "firebase";
  }
  function renderLatest(reason) {
    if (!demand() || !lastFirebase) return false;
    if (lastFirebaseRenderAt != null && nowMs() - lastFirebaseRenderAt < policy.firebaseBackupReadIntervalMs) return false;
    const fix = lastFirebase;
    // Revalidate at delivery time; a buffered GPS point may now be stale.
    lastFirebase = null;
    return render(fix, reason);
  }
  function reconcile(reason = "firebase_deadline") {
    if (timer != null) clearT(timer);
    timer = null;
    if (closed) return;
    if (p2pHealthy && lastP2pAt != null && nowMs() - lastP2pAt >= policy.p2pFallbackAfterMs) activateFallback();
    if (startedAt != null && !firstWaiting()) firstDone = true;
    notifyDemand();
    renderLatest(reason);
    // A subscription may synchronously deliver its cached snapshot and re-enter.
    if (timer != null) clearT(timer);
    timer = null;
    const due = [];
    if (p2pHealthy && lastP2pAt != null) due.push(lastP2pAt + policy.p2pFallbackAfterMs);
    if (firstWaiting()) due.push(startedAt + graceMs);
    if (demand() && lastFirebase && lastFirebaseRenderAt != null) due.push(lastFirebaseRenderAt + policy.firebaseBackupReadIntervalMs);
    if (due.length) {
      const gen = generation;
      timer = setT(() => { if (current(gen)) reconcile(); }, Math.max(1, Math.min(...due) - nowMs()));
    }
  }
  function beginP2pFirstWindow() {
    active = true; startedAt = nowMs(); firstDone = false;
    reconcile();
  }
  function ingestP2p(fix, gen) {
    if (!current(gen) || !fix) { diag("p2p_stale_generation_ignored"); return false; }
    counters.p2pReceived++;
    if (!shouldReplace(lastRendered, fix)) { counters.staleRejected++; return false; }
    active = true; firstDone = true; lastP2pAt = nowMs(); p2pHealthy = true; preferred = "p2p";
    const rendered = render({ ...fix, source: "p2p" }, "p2p");
    reconcile();
    return rendered;
  }
  function ingestFirebase(fix, gen) {
    if (!current(gen) || !fix) { diag("p2p_stale_generation_ignored"); return false; }
    counters.firebaseReceived++;
    if (!shouldReplace(lastRendered, fix) || !shouldReplace(lastFirebase, fix)) { counters.staleRejected++; return false; }
    active = true;
    if (!policy.firebaseFallbackEnabled) return false;
    lastFirebase = { ...fix, source: "firebase" };
    const before = counters.firebaseRendered;
    reconcile("firebase");
    if (counters.firebaseRendered === before) {
      if (p2pHealthy) counters.firebaseIgnoredWhileP2p++;
      else counters.firebaseThrottled++;
    }
    return counters.firebaseRendered > before;
  }
  function noteP2pUnhealthy() { activateFallback(); reconcile("fallback"); }
  function reset({ clearCounters = false } = {}) {
    if (timer != null) clearT(timer);
    timer = null; generation++; active = false;
    lastRendered = lastFirebase = lastP2pAt = lastFirebaseRenderAt = startedAt = null;
    preferred = "firebase"; p2pHealthy = false; firstDone = false;
    if (clearCounters) for (const key of Object.keys(counters)) counters[key] = 0;
    notifyDemand();
  }
  function configureDeliveryPolicy(next = {}) {
    policy = normalizeRuntimeDeliveryPolicy(next, policy);
    if (next.p2pFirstGraceMs != null) graceMs = policy.p2pFirstGraceMs;
    if (!policy.firebaseFallbackEnabled) lastFirebase = null;
    // Recompute from original start/last accepted point, not a fresh waiting window.
    reconcile();
  }
  return {
    bumpGeneration: () => { generation++; reconcile(); return generation; },
    beginP2pFirstWindow, configureDeliveryPolicy,
    getGeneration: () => generation, isCurrent: current, ingestP2p, ingestFirebase, noteP2pUnhealthy,
    ensureP2pHealth: () => reconcile(), isFirebaseFallbackNeeded: demand,
    getState: () => ({ generation, closed, preferred, p2pHealthy, lastRendered, lastP2pAt: lastP2pAt ?? 0,
      lastFirebaseRenderAt: lastFirebaseRenderAt ?? 0, firebaseFallbackNeeded: demand(), counters: { ...counters } }),
    reset, destroy: () => { reset(); closed = true; }, getCounters: () => ({ ...counters }),
  };
}
