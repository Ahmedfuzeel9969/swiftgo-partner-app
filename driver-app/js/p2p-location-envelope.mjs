/**
 * Phase 3 — P2P location envelope build/validate (data-channel messages).
 */

import {
  P2P_MAX_MESSAGE_BYTES,
  P2P_MESSAGE_TYPE,
  P2P_PROTOCOL_VERSION,
  isValidPeerSessionId,
} from "./p2p-protocol.mjs";

const MAX_ACCEPT_ACCURACY_M = 80;
const MAX_FIX_AGE_MS = 30_000;
const MAX_FIX_FUTURE_MS = 10_000;

export function isValidLatLng(lat, lng) {
  if (typeof lat === "string" || typeof lng === "string") return false;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return false;
  return true;
}

/**
 * @param {object} input
 * @param {{ peerSessionId: string, trackingSessionId: string, assignmentVersion: number, sequence: number, role?: string }} ctx
 */
export function buildP2pLocationMessage(input, ctx) {
  const lat = Number(input?.lat);
  const lng = Number(input?.lng);
  if (!isValidLatLng(lat, lng)) {
    return { ok: false, reason: "invalid_coords" };
  }
  if (!isValidPeerSessionId(ctx.peerSessionId)) {
    return { ok: false, reason: "invalid_peer_session" };
  }
  const trackingSessionId = String(ctx.trackingSessionId || "").trim();
  if (trackingSessionId.length < 3 || trackingSessionId.length > 64) {
    return { ok: false, reason: "invalid_tracking_session" };
  }
  const seq = Math.floor(Number(ctx.sequence));
  if (!Number.isFinite(seq) || seq < 1) {
    return { ok: false, reason: "invalid_sequence" };
  }
  const observedAt = Number(input?.observedAt) || Date.now();
  const msg = {
    v: P2P_PROTOCOL_VERSION,
    type: P2P_MESSAGE_TYPE.LOC,
    peerSessionId: ctx.peerSessionId,
    trackingSessionId,
    assignmentVersion: Math.max(1, Math.floor(Number(ctx.assignmentVersion) || 1)),
    seq,
    observedAt,
    lat,
    lng,
    accuracyM:
      Number.isFinite(Number(input?.accuracyM ?? input?.accuracy))
        ? Number(input.accuracyM ?? input.accuracy)
        : null,
    headingDeg: Number.isFinite(Number(input?.headingDeg ?? input?.heading))
      ? Number(input.headingDeg ?? input.heading)
      : null,
    speedMps: Number.isFinite(Number(input?.speedMps ?? input?.speed))
      ? Number(input.speedMps ?? input.speed)
      : null,
    role: ctx.role || "driver",
  };
  const serialized = JSON.stringify(msg);
  if (serialized.length > P2P_MAX_MESSAGE_BYTES) {
    return { ok: false, reason: "oversized" };
  }
  return { ok: true, message: msg, serialized };
}

export function buildP2pAckMessage(ctx) {
  const msg = {
    v: P2P_PROTOCOL_VERSION,
    type: P2P_MESSAGE_TYPE.ACK,
    peerSessionId: ctx.peerSessionId,
    trackingSessionId: String(ctx.trackingSessionId || ""),
    assignmentVersion: Math.max(1, Math.floor(Number(ctx.assignmentVersion) || 1)),
    seq: Math.floor(Number(ctx.sequence) || 0),
    observedAt: Date.now(),
    role: "customer",
  };
  return { ok: true, message: msg, serialized: JSON.stringify(msg) };
}

export function buildP2pHbMessage(ctx) {
  const msg = {
    v: P2P_PROTOCOL_VERSION,
    type: P2P_MESSAGE_TYPE.HB,
    peerSessionId: ctx.peerSessionId,
    trackingSessionId: String(ctx.trackingSessionId || ""),
    assignmentVersion: Math.max(1, Math.floor(Number(ctx.assignmentVersion) || 1)),
    seq: Math.floor(Number(ctx.sequence) || 0),
    observedAt: Date.now(),
    role: ctx.role || "driver",
  };
  const serialized = JSON.stringify(msg);
  if (serialized.length > P2P_MAX_MESSAGE_BYTES) {
    return { ok: false, reason: "oversized" };
  }
  return { ok: true, message: msg, serialized };
}

/**
 * @param {string|object} raw
 * @param {{
 *   peerSessionId: string,
 *   trackingSessionId: string,
 *   assignmentVersion: number,
 *   lastSequence?: number,
 *   expectRole?: string,
 *   nowMs?: number,
 *   closed?: boolean,
 * }} auth
 */
export function validateP2pMessage(raw, auth = {}) {
  if (auth.closed) return { ok: false, reason: "session_closed" };
  let obj = raw;
  if (typeof raw === "string") {
    if (raw.length > P2P_MAX_MESSAGE_BYTES) return { ok: false, reason: "oversized" };
    try {
      obj = JSON.parse(raw);
    } catch {
      return { ok: false, reason: "json_parse" };
    }
  }
  if (!obj || typeof obj !== "object") return { ok: false, reason: "not_object" };
  if (Number(obj.v) !== P2P_PROTOCOL_VERSION) {
    return { ok: false, reason: "unknown_protocol" };
  }
  const type = String(obj.type || "");
  if (!Object.values(P2P_MESSAGE_TYPE).includes(type)) {
    return { ok: false, reason: "unknown_type" };
  }
  if (String(obj.peerSessionId || "") !== String(auth.peerSessionId || "")) {
    return { ok: false, reason: "wrong_peer_session" };
  }
  if (String(obj.trackingSessionId || "") !== String(auth.trackingSessionId || "")) {
    return { ok: false, reason: "wrong_tracking_session" };
  }
  if (Math.floor(Number(obj.assignmentVersion) || 0) !== Math.floor(Number(auth.assignmentVersion) || 0)) {
    return { ok: false, reason: "wrong_assignment" };
  }
  if (auth.expectRole && String(obj.role || "") !== auth.expectRole) {
    return { ok: false, reason: "unexpected_role" };
  }

  if (type === P2P_MESSAGE_TYPE.ACK || type === P2P_MESSAGE_TYPE.HB || type === P2P_MESSAGE_TYPE.CLOSE) {
    return { ok: true, type, message: obj };
  }

  // LOC
  if (typeof obj.lat === "string" || typeof obj.lng === "string") {
    return { ok: false, reason: "numeric_string_coords" };
  }
  if (!isValidLatLng(obj.lat, obj.lng)) {
    return { ok: false, reason: "invalid_coords" };
  }
  const seq = Math.floor(Number(obj.seq));
  if (!Number.isFinite(seq) || seq < 1) return { ok: false, reason: "invalid_sequence" };
  const last = Math.floor(Number(auth.lastSequence) || 0);
  if (seq === last) return { ok: false, reason: "duplicate_sequence" };
  if (seq < last) return { ok: false, reason: "decreasing_sequence" };

  const nowMs = Number.isFinite(auth.nowMs) ? auth.nowMs : Date.now();
  const observedAt = Number(obj.observedAt);
  if (!Number.isFinite(observedAt)) return { ok: false, reason: "invalid_observedAt" };
  if (nowMs - observedAt > MAX_FIX_AGE_MS) return { ok: false, reason: "stale_observedAt" };
  if (observedAt - nowMs > MAX_FIX_FUTURE_MS) return { ok: false, reason: "future_observedAt" };

  if (obj.accuracyM != null) {
    const acc = Number(obj.accuracyM);
    if (!Number.isFinite(acc) || acc < 0 || acc > MAX_ACCEPT_ACCURACY_M * 4) {
      return { ok: false, reason: "invalid_accuracy" };
    }
  }

  return {
    ok: true,
    type,
    message: obj,
    fix: {
      lat: obj.lat,
      lng: obj.lng,
      observedAt,
      sequence: seq,
      accuracyM: obj.accuracyM ?? null,
      headingDeg: obj.headingDeg ?? null,
      speedMps: obj.speedMps ?? null,
      source: "p2p",
      peerSessionId: obj.peerSessionId,
      trackingSessionId: obj.trackingSessionId,
      assignmentVersion: obj.assignmentVersion,
    },
  };
}
