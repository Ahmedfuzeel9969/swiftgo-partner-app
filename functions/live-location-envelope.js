/**
 * Phase 1 live-location foundation — normalize / validate GPS envelopes.
 * Privacy: never log coordinates, ride IDs, or driver IDs from this module.
 */

"use strict";

/** Reject fixes with worse horizontal accuracy than this (metres). */
const MAX_ACCEPT_ACCURACY_M = 80;

/** Generous max ground speed for Karachi urban GPS (m/s ≈ 160 km/h). */
const MAX_PLAUSIBLE_SPEED_MPS = 45;

/** Ignore jump checks when previous accuracy was worse than this. */
const JUMP_SKIP_IF_PREV_ACCURACY_M = 60;

/** Minimum elapsed ms before jump speed is evaluated (avoids divide-by-near-zero). */
const MIN_JUMP_ELAPSED_MS = 800;

const LOCATION_DIAG = Object.freeze({
  ACCEPTED: "location_fix_accepted",
  DUPLICATE: "location_fix_duplicate",
  OUT_OF_ORDER: "location_fix_out_of_order",
  INVALID: "location_fix_invalid",
  POOR_ACCURACY: "location_fix_poor_accuracy",
  IMPOSSIBLE_JUMP: "location_fix_impossible_jump",
  MIRRORED: "ride_location_mirrored",
  NOOP_UNCHANGED: "ride_location_noop_unchanged",
});

function haversineM(a, b) {
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) *
      Math.cos((b.lat * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

function normalizeHeadingDeg(raw) {
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  // Browser Geolocation: heading NaN or negative when unavailable.
  if (n < 0 || n > 360) return null;
  if (n === 360) return 0;
  return Math.round((n % 360) * 1000) / 1000;
}

function isValidLatLng(lat, lng) {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  );
}

/**
 * Normalize a raw GPS sample into a canonical envelope (no server receivedAt).
 * @param {object} raw
 * @param {{ sessionId: string, sequence: number, nowMs?: number }} ctx
 */
function normalizeLocationFix(raw, ctx) {
  const lat = Number(raw?.latitude ?? raw?.lat);
  const lng = Number(raw?.longitude ?? raw?.lng);
  if (!isValidLatLng(lat, lng)) {
    return { ok: false, reason: LOCATION_DIAG.INVALID, envelope: null };
  }

  const accuracyM =
    raw?.accuracyM != null
      ? Number(raw.accuracyM)
      : raw?.accuracy != null
        ? Number(raw.accuracy)
        : null;
  if (Number.isFinite(accuracyM) && accuracyM > MAX_ACCEPT_ACCURACY_M) {
    return { ok: false, reason: LOCATION_DIAG.POOR_ACCURACY, envelope: null };
  }

  const observedAt =
    Number(raw?.observedAt) ||
    Number(raw?.timestamp) ||
    Number(ctx?.nowMs) ||
    Date.now();
  if (!Number.isFinite(observedAt) || observedAt <= 0) {
    return { ok: false, reason: LOCATION_DIAG.INVALID, envelope: null };
  }

  const sequence = Math.max(1, Math.floor(Number(ctx?.sequence) || 1));
  const sessionId = String(ctx?.sessionId || "").trim();
  if (!sessionId) {
    return { ok: false, reason: LOCATION_DIAG.INVALID, envelope: null };
  }

  const speedMps =
    raw?.speedMps != null
      ? Number(raw.speedMps)
      : raw?.speed != null && Number(raw.speed) >= 0
        ? Number(raw.speed)
        : null;

  const headingDeg = normalizeHeadingDeg(raw?.headingDeg ?? raw?.heading);

  /** @type {Record<string, unknown>} */
  const envelope = {
    lat: Math.round(lat * 1e7) / 1e7,
    lng: Math.round(lng * 1e7) / 1e7,
    observedAt,
    sequence,
    sessionId,
    source: String(raw?.source || "gps"),
  };
  if (Number.isFinite(accuracyM) && accuracyM >= 0) {
    envelope.accuracyM = Math.round(accuracyM * 10) / 10;
  }
  if (headingDeg != null) envelope.headingDeg = headingDeg;
  if (Number.isFinite(speedMps) && speedMps >= 0) {
    envelope.speedMps = Math.round(speedMps * 100) / 100;
  }

  return { ok: true, reason: LOCATION_DIAG.ACCEPTED, envelope };
}

/**
 * Ordering / duplicate / jump gate against a previously accepted fix.
 * New sessionId always resets ordering (page reload / new online activation).
 * @param {object|null} previous envelope-like
 * @param {object} next envelope
 */
function evaluateFixAgainstPrevious(previous, next) {
  if (!next || !isValidLatLng(Number(next.lat), Number(next.lng))) {
    return { accept: false, reason: LOCATION_DIAG.INVALID };
  }
  if (!previous || !isValidLatLng(Number(previous.lat), Number(previous.lng))) {
    return { accept: true, reason: LOCATION_DIAG.ACCEPTED };
  }

  const prevSession = String(previous.sessionId || "");
  const nextSession = String(next.sessionId || "");
  if (prevSession && nextSession && prevSession !== nextSession) {
    return { accept: true, reason: LOCATION_DIAG.ACCEPTED };
  }

  const prevObs = Number(previous.observedAt) || 0;
  const nextObs = Number(next.observedAt) || 0;
  const prevSeq = Number(previous.sequence) || 0;
  const nextSeq = Number(next.sequence) || 0;

  // Same session: reject lower sequence.
  if (prevSession && nextSession && prevSession === nextSession && nextSeq < prevSeq) {
    return { accept: false, reason: LOCATION_DIAG.OUT_OF_ORDER };
  }

  // Same session: reject older observedAt when sequence did not increase.
  if (
    prevSession &&
    nextSession &&
    prevSession === nextSession &&
    nextObs < prevObs &&
    nextSeq <= prevSeq
  ) {
    return { accept: false, reason: LOCATION_DIAG.OUT_OF_ORDER };
  }

  const sameCoords =
    Math.abs(Number(previous.lat) - Number(next.lat)) < 1e-7 &&
    Math.abs(Number(previous.lng) - Number(next.lng)) < 1e-7;
  if (
    sameCoords &&
    nextObs === prevObs &&
    nextSeq === prevSeq &&
    prevSession === nextSession
  ) {
    return { accept: false, reason: LOCATION_DIAG.DUPLICATE };
  }

  // Impossible jump (same session only).
  if (prevSession && nextSession && prevSession === nextSession && nextObs > prevObs) {
    const elapsed = nextObs - prevObs;
    if (elapsed >= MIN_JUMP_ELAPSED_MS) {
      const prevAcc = Number(previous.accuracyM);
      const skipJump =
        Number.isFinite(prevAcc) && prevAcc > JUMP_SKIP_IF_PREV_ACCURACY_M;
      if (!skipJump) {
        const distM = haversineM(
          { lat: Number(previous.lat), lng: Number(previous.lng) },
          { lat: Number(next.lat), lng: Number(next.lng) }
        );
        const speed = distM / (elapsed / 1000);
        if (speed > MAX_PLAUSIBLE_SPEED_MPS) {
          return { accept: false, reason: LOCATION_DIAG.IMPOSSIBLE_JUMP };
        }
      }
    }
  }

  return { accept: true, reason: LOCATION_DIAG.ACCEPTED };
}

/**
 * Bearing between two accepted fixes for display when GPS heading is null.
 * Distinct from actual GPS headingDeg.
 */
function derivedDisplayBearingDeg(from, to) {
  if (!from || !to) return null;
  if (!isValidLatLng(Number(from.lat), Number(from.lng))) return null;
  if (!isValidLatLng(Number(to.lat), Number(to.lng))) return null;
  const φ1 = (Number(from.lat) * Math.PI) / 180;
  const φ2 = (Number(to.lat) * Math.PI) / 180;
  const Δλ = ((Number(to.lng) - Number(from.lng)) * Math.PI) / 180;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x =
    Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  const deg = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  return Math.round(deg * 1000) / 1000;
}

/** Strip to Firestore-safe vehicle.location map (lat/lng required). */
function toVehicleLocationField(envelope) {
  if (!envelope) return null;
  const out = {
    lat: envelope.lat,
    lng: envelope.lng,
    observedAt: envelope.observedAt,
    sequence: envelope.sequence,
    sessionId: envelope.sessionId,
    source: envelope.source || "gps",
  };
  if (envelope.accuracyM != null) out.accuracyM = envelope.accuracyM;
  if (envelope.headingDeg != null) out.headingDeg = envelope.headingDeg;
  if (envelope.speedMps != null) out.speedMps = envelope.speedMps;
  return out;
}

/** Privacy-safe structured log helper (no coords / ids). */
function logLocationDiag(reason, extra = {}) {
  try {
    console.info(
      JSON.stringify({
        type: "live_location_diag",
        reason: String(reason || ""),
        ...extra,
      })
    );
  } catch {
    /* ignore */
  }
}

module.exports = {
  MAX_ACCEPT_ACCURACY_M,
  MAX_PLAUSIBLE_SPEED_MPS,
  LOCATION_DIAG,
  haversineM,
  normalizeHeadingDeg,
  isValidLatLng,
  normalizeLocationFix,
  evaluateFixAgainstPrevious,
  derivedDisplayBearingDeg,
  toVehicleLocationField,
  logLocationDiag,
};
