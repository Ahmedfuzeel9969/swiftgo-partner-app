/**
 * Per-auth/ride, bounded TURN lookup. Only ephemeral credentials enter the client.
 * Reset/switch invalidates late responses; expired credentials are never reused.
 */
import { normalizeTurnServer } from "./p2p-ice-config.mjs";

export function createP2pIceBootstrap(opts = {}) {
  const globalObj = opts.globalObj || globalThis;
  const nowMs = opts.nowMs || Date.now;
  const setT = opts.setTimeoutFn || setTimeout, clearT = opts.clearTimeoutFn || clearTimeout;
  const fetchCredentials = opts.fetchTurnCredentials || (async () => ({ configured: false }));
  let inflight = null, generation = 0, cacheUntil = 0, contextKey = null;
  let cancelPending = null;

  function clearCredentials() {
    const { turn, turnExpiresAtMs, ...safe } = globalObj.__SWIFTGO_P2P_ICE__ || {};
    globalObj.__SWIFTGO_P2P_ICE__ = safe;
  }
  function currentConfig() {
    const config = globalObj.__SWIFTGO_P2P_ICE__ || {};
    if (config.turn && Number(config.turnExpiresAtMs) <= nowMs()) clearCredentials();
    return globalObj.__SWIFTGO_P2P_ICE__ || {};
  }
  function resetP2pIceBootstrapCache() {
    generation++; cancelPending?.(); cancelPending = null;
    inflight = null; cacheUntil = 0; contextKey = null;
    clearCredentials();
  }
  async function boundedFetch(context) {
    return new Promise((resolve) => {
      let timer, settled = false;
      const finish = (result) => {
        if (settled) return; settled = true; clearT(timer);
        if (cancelPending === cancel) cancelPending = null;
        resolve(result);
      };
      const cancel = () => finish(null);
      cancelPending = cancel;
      timer = setT(cancel, 5000);
      Promise.resolve().then(() => fetchCredentials(context)).then(finish, () => finish(null));
    });
  }
  async function ensureP2pIceConfiguration(context = {}) {
    const key = typeof opts.getContextKey === "function" ? String(opts.getContextKey(context)) :
      JSON.stringify([context.rideId || "", context.assignmentId || ""]);
    if (contextKey !== key) { resetP2pIceBootstrapCache(); contextKey = key; }
    currentConfig();
    if (nowMs() < cacheUntil) return currentConfig();
    if (inflight) return inflight;
    const gen = generation, started = nowMs();
    const promise = (async () => {
      const res = await boundedFetch(context);
      if (gen !== generation) return {};
      const turn = res?.configured ? normalizeTurnServer(res.turn) : null;
      const ttl = Number(res?.ttlMs);
      if (turn && Number.isFinite(ttl) && ttl >= 60000 && ttl <= 48 * 3600000 && started + ttl > nowMs()) {
        globalObj.__SWIFTGO_P2P_ICE__ = { ...currentConfig(), turn, turnExpiresAtMs: started + ttl };
        cacheUntil = Math.max(nowMs() + 1000, started + ttl - 60000);
      } else {
        // A disabled/unauthorized provider explicitly revokes the cached config.
        if (res?.configured === false) clearCredentials();
        currentConfig();
        cacheUntil = nowMs() + 30000;
      }
      return currentConfig();
    })();
    inflight = promise;
    try { return await promise; }
    finally { if (gen === generation && inflight === promise) inflight = null; }
  }
  return { ensureP2pIceConfiguration, resetP2pIceBootstrapCache };
}
