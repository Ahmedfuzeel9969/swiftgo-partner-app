/**
 * Fetch server-issued TURN credentials and inject window.__SWIFTGO_P2P_ICE__.
 * Falls back to STUN-only when TURN is unavailable or fetch fails.
 */

/** @type {Promise<object>|null} */
let inflight = null;
/** @type {{ expiresAt: number } | null} */
let cache = null;

const REFRESH_SKEW_MS = 60_000;

/**
 * @param {{
 *   fetchTurnCredentials?: () => Promise<object>,
 *   globalObj?: typeof globalThis,
 * }} [opts]
 */
export function createP2pIceBootstrap(opts = {}) {
  const globalObj = opts.globalObj || (typeof globalThis !== "undefined" ? globalThis : {});
  const fetchTurnCredentials =
    typeof opts.fetchTurnCredentials === "function" ? opts.fetchTurnCredentials : async () => ({ configured: false });

  async function ensureP2pIceConfiguration() {
    if (cache && Date.now() < cache.expiresAt) {
      return globalObj.__SWIFTGO_P2P_ICE__ || {};
    }
    if (inflight) return inflight;

    inflight = (async () => {
      try {
        const res = await fetchTurnCredentials();
        const prev = globalObj.__SWIFTGO_P2P_ICE__ || {};
        if (res?.configured && res?.turn?.urls && res?.turn?.username && res?.turn?.credential) {
          globalObj.__SWIFTGO_P2P_ICE__ = {
            ...prev,
            turn: {
              urls: res.turn.urls,
              username: String(res.turn.username),
              credential: String(res.turn.credential),
            },
            ...(Array.isArray(res.stunUrls) && res.stunUrls.length
              ? { stunUrls: res.stunUrls.map((u) => String(u || "").trim()).filter(Boolean) }
              : {}),
          };
          cache = {
            expiresAt: Date.now() + Math.max(60_000, Number(res.ttlMs) || 3_600_000) - REFRESH_SKEW_MS,
          };
        } else {
          cache = { expiresAt: Date.now() + 5 * 60_000 };
        }
      } catch {
        cache = { expiresAt: Date.now() + 60_000 };
      }
      return globalObj.__SWIFTGO_P2P_ICE__ || {};
    })();

    try {
      return await inflight;
    } finally {
      inflight = null;
    }
  }

  function resetP2pIceBootstrapCache() {
    inflight = null;
    cache = null;
  }

  return { ensureP2pIceConfiguration, resetP2pIceBootstrapCache };
}
