/**
 * Phase 3 — P2P protocol constants and state machine (shared driver/customer).
 *
 * Direct WebRTC is best-effort. Firebase remains signaling + safety fallback.
 * No paid TURN in this phase; missing ICE servers → Firebase fallback.
 */

export const P2P_PROTOCOL_VERSION = 1;
export const P2P_MESSAGE_TYPE = Object.freeze({
  LOC: "loc",
  ACK: "ack",
  HB: "hb",
  CLOSE: "close",
});

export const P2P_STATE = Object.freeze({
  DISABLED: "DISABLED",
  SIGNALING: "SIGNALING",
  CONNECTING: "CONNECTING",
  P2P_HEALTHY: "P2P_HEALTHY",
  P2P_DEGRADED: "P2P_DEGRADED",
  FIREBASE_FALLBACK: "FIREBASE_FALLBACK",
  RECONNECTING: "RECONNECTING",
  CLOSED: "CLOSED",
});

export const P2P_DIAG = Object.freeze({
  SIGNALING_STARTED: "p2p_signaling_started",
  OFFER_READY: "p2p_offer_ready",
  ANSWER_READY: "p2p_answer_ready",
  CHANNEL_OPEN: "p2p_channel_open",
  FIRST_VALID_FIX: "p2p_first_valid_fix",
  HEALTHY: "p2p_healthy",
  DEGRADED: "p2p_degraded",
  FIREBASE_FALLBACK: "p2p_firebase_fallback",
  RECONNECT_SCHEDULED: "p2p_reconnect_scheduled",
  SESSION_CLOSED: "p2p_session_closed",
  INVALID_MESSAGE: "p2p_invalid_message",
  STALE_GENERATION: "p2p_stale_generation_ignored",
  BACKPRESSURE_COALESCED: "p2p_backpressure_coalesced",
  SOURCE_P2P: "location_source_p2p",
  SOURCE_FIREBASE: "location_source_firebase",
});

/** Expected direct fix cadence while healthy. */
export const P2P_SEND_INTERVAL_MS = 3_000;
/** Channel open but no valid fix → degraded. */
export const P2P_DEGRADED_AFTER_MS = 9_000;
/** No valid direct fix → Firebase fallback. */
export const P2P_FALLBACK_AFTER_MS = 12_000;
/** Require healthy this long before sparse Firebase (anti-flap). */
export const P2P_HEALTHY_HYSTERESIS_MS = 5_000;
/** Require unhealthy this long before leaving sparse → responsive. */
export const P2P_UNHEALTHY_HYSTERESIS_MS = 3_000;
export const P2P_RECONNECT_BASE_MS = 1_000;
export const P2P_RECONNECT_MAX_MS = 30_000;
export const P2P_RECONNECT_MAX_ATTEMPTS = 8;
export const P2P_MAX_MESSAGE_BYTES = 2_048;
export const P2P_MAX_SDP_CHARS = 16_384;
export const P2P_SESSION_TTL_MS = 15 * 60_000;
export const P2P_DATA_CHANNEL_LABEL = "swiftgo-loc-v1";
export const P2P_BUFFERED_AMOUNT_HIGH = 64 * 1024;

export const P2P_EXECUTION_STATUSES = Object.freeze([
  "accepted",
  "arrived",
  "in_progress",
]);

export function createPeerSessionId(now = Date.now()) {
  const rand =
    typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function"
      ? Array.from(crypto.getRandomValues(new Uint8Array(12)))
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("")
      : Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  return `ps_${now.toString(36)}_${rand.slice(0, 24)}`;
}

export function isValidPeerSessionId(id) {
  if (typeof id !== "string") return false;
  const s = id.trim();
  return s.length >= 8 && s.length <= 96 && /^[A-Za-z0-9_-]+$/.test(s);
}

export function nextReconnectDelayMs(attempt, random = Math.random) {
  const exp = Math.min(
    P2P_RECONNECT_MAX_MS,
    P2P_RECONNECT_BASE_MS * 2 ** Math.max(0, attempt)
  );
  const jitter = Math.round(random() * 400);
  return Math.min(P2P_RECONNECT_MAX_MS, exp + jitter);
}

/**
 * Provider-neutral ICE config. No TURN secrets in source.
 * Empty iceServers → connection may fail → Firebase fallback (correct).
 * @param {{ stunUrls?: string[], turn?: { urls: string|string[], username: string, credential: string }|null }} [opts]
 */
export function buildIceServers(opts = {}) {
  const servers = [];
  const stuns = Array.isArray(opts.stunUrls) ? opts.stunUrls : [];
  for (const url of stuns) {
    const u = String(url || "").trim();
    if (u) servers.push({ urls: u });
  }
  if (opts.turn?.urls && opts.turn.username && opts.turn.credential) {
    servers.push({
      urls: opts.turn.urls,
      username: String(opts.turn.username),
      credential: String(opts.turn.credential),
    });
  }
  return servers;
}

/**
 * Runtime ICE configuration from optional window/env injection (never hardcode secrets).
 */
export function resolveIceConfiguration(globalObj = typeof globalThis !== "undefined" ? globalThis : {}) {
  const cfg = globalObj?.__SWIFTGO_P2P_ICE__ || {};
  const iceServers = buildIceServers({
    stunUrls: cfg.stunUrls,
    turn: cfg.turn || null,
  });
  return {
    iceServers,
    iceCandidatePoolSize: 0,
    hasStun: iceServers.some((s) => String(s.urls || "").includes("stun:")),
    hasTurn: iceServers.some((s) => String(s.urls || "").includes("turn:")),
  };
}
