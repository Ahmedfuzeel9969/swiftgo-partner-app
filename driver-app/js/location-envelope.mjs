/** Driver-app Phase 1 location envelope — keep aligned with functions/live-location-envelope.js */

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
  RETIRED_SESSION: "location_fix_retired_session",
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
  if (n < 0 || n > 360) return null;
  if (n === 360) return 0;
  return Math.round((n % 360) * 1000) / 1000;
}

/**
 * Coordinate policy: only finite JS numbers in range are valid.
 * Numeric strings, NaN, and out-of-range values are rejected.
 */
function isValidLatLng(lat, lng) {
  return (
    typeof lat === "number" &&
    typeof lng === "number" &&
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  );
}

/** Coerce raw lat/lng only when already a finite number (strings rejected). */
function coerceCoordNumber(v) {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return v;
}

function timestampToMs(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value.toMillis === "function") {
    const ms = value.toMillis();
    return Number.isFinite(ms) && ms > 0 ? ms : null;
  }
  if (typeof value.seconds === "number" && Number.isFinite(value.seconds)) {
    const nanos = typeof value.nanoseconds === "number" ? value.nanoseconds : 0;
    const ms = value.seconds * 1000 + Math.floor(nanos / 1e6);
    return ms > 0 ? ms : null;
  }
  // Do not use Number(FirestoreTimestamp) — it yields NaN.
  return null;
}

function normalizeLocationFix(raw, ctx) {
  const lat = coerceCoordNumber(raw?.latitude ?? raw?.lat);
  const lng = coerceCoordNumber(raw?.longitude ?? raw?.lng);
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
 * @param {object|null} previous
 * @param {object} next
 * @param {{
 *   vehicleSessionId?: string,
 *   vehicleSessionStartedMs?: number|null,
 *   previousSessionStartedMs?: number|null,
 * }} [sessionCtx]
 */
function evaluateFixAgainstPrevious(previous, next, sessionCtx = {}) {
  if (!next || !isValidLatLng(next.lat, next.lng)) {
    return { accept: false, reason: LOCATION_DIAG.INVALID };
  }

  if (!previous || !isValidLatLng(previous.lat, previous.lng)) {
    return { accept: true, reason: LOCATION_DIAG.ACCEPTED };
  }

  const prevSession = String(previous.sessionId || "");
  const nextSession = String(next.sessionId || "");
  const vehicleSessionId = String(sessionCtx.vehicleSessionId || nextSession || "");
  const vehicleSessionStartedMs = Number(sessionCtx.vehicleSessionStartedMs) || 0;
  const previousSessionStartedMs = Number(sessionCtx.previousSessionStartedMs) || 0;

  // --- Session transition (not lexicographic sessionId compare) ---
  if (prevSession && nextSession && prevSession !== nextSession) {
    // Incoming fix must belong to the vehicle's current authoritative session.
    if (vehicleSessionId && nextSession !== vehicleSessionId) {
      return { accept: false, reason: LOCATION_DIAG.RETIRED_SESSION };
    }
    if (!vehicleSessionStartedMs) {
      return { accept: false, reason: LOCATION_DIAG.INVALID };
    }
    if (previousSessionStartedMs && vehicleSessionStartedMs <= previousSessionStartedMs) {
      return { accept: false, reason: LOCATION_DIAG.RETIRED_SESSION };
    }
    // Legitimate new session: server session start is newer than previous mirrored session.
    return { accept: true, reason: LOCATION_DIAG.ACCEPTED };
  }

  // Delayed fix claiming the previous session while vehicle already moved on.
  if (
    prevSession &&
    nextSession &&
    prevSession === nextSession &&
    vehicleSessionId &&
    vehicleSessionId !== nextSession
  ) {
    return { accept: false, reason: LOCATION_DIAG.RETIRED_SESSION };
  }

  const prevObs = Number(previous.observedAt) || 0;
  const nextObs = Number(next.observedAt) || 0;
  const prevSeq = Number(previous.sequence) || 0;
  const nextSeq = Number(next.sequence) || 0;

  const sameCoords =
    Math.abs(Number(previous.lat) - Number(next.lat)) < 1e-7 &&
    Math.abs(Number(previous.lng) - Number(next.lng)) < 1e-7;

  // Exact duplicate (same session + seq + observedAt + coords).
  if (
    prevSession === nextSession &&
    nextSeq === prevSeq &&
    nextObs === prevObs &&
    sameCoords
  ) {
    return { accept: false, reason: LOCATION_DIAG.DUPLICATE };
  }

  // Same session: both sequence and observedAt must strictly increase.
  if (prevSession && nextSession && prevSession === nextSession) {
    if (nextSeq <= prevSeq) {
      return { accept: false, reason: LOCATION_DIAG.OUT_OF_ORDER };
    }
    if (nextObs <= prevObs) {
      return { accept: false, reason: LOCATION_DIAG.OUT_OF_ORDER };
    }
  } else if (!prevSession || !nextSession) {
    // Legacy path without session ids: observedAt must strictly increase; equal → duplicate/out_of_order.
    if (nextObs < prevObs) {
      return { accept: false, reason: LOCATION_DIAG.OUT_OF_ORDER };
    }
    if (nextObs === prevObs && sameCoords) {
      return { accept: false, reason: LOCATION_DIAG.DUPLICATE };
    }
    if (nextObs === prevObs && !sameCoords) {
      return { accept: false, reason: LOCATION_DIAG.OUT_OF_ORDER };
    }
  }

  // Impossible jump (same session only, after ordering passed).
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

function derivedDisplayBearingDeg(from, to) {
  if (!from || !to) return null;
  if (!isValidLatLng(from.lat, from.lng)) return null;
  if (!isValidLatLng(to.lat, to.lng)) return null;
  const φ1 = (from.lat * Math.PI) / 180;
  const φ2 = (to.lat * Math.PI) / 180;
  const Δλ = ((to.lng - from.lng) * Math.PI) / 180;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x =
    Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  const deg = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  return Math.round(deg * 1000) / 1000;
}

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


export function createLocationDiagCounters() {
  return {
    gpsFixesReceived: 0,
    fixesRejected: 0,
    vehicleWritesAttempted: 0,
    vehicleWritesCompleted: 0,
    rideMirrorWritesCompleted: 0,
    duplicateRideWritesPrevented: 0,
  };
}

export function estimateLocationWriteComparison(activeRideMinutes = 20, fixEverySec = 4) {
  const fixes = Math.ceil((activeRideMinutes * 60) / fixEverySec);
  return {
    estimate: true,
    activeRideMinutes,
    fixEverySec,
    currentArchitecture: {
      vehicleWrites: fixes,
      clientRideWrites: fixes,
      cfMirrorWrites: fixes,
      totalFirestoreLocationWrites: fixes * 3,
    },
    phase1Repaired: {
      vehicleWrites: fixes,
      clientRideWrites: 0,
      cfMirrorWrites: fixes,
      totalFirestoreLocationWrites: fixes * 2,
    },
    futureP2PFallback: {
      vehicleWrites: Math.ceil(fixes * 0.15),
      clientRideWrites: 0,
      cfMirrorWrites: Math.ceil(fixes * 0.15),
      p2pUpdates: Math.ceil(fixes * 0.85),
      totalFirestoreLocationWrites: Math.ceil(fixes * 0.3),
      note: "Estimate only — P2P not implemented in Phase 1",
    },
  };
}

export {
  MAX_ACCEPT_ACCURACY_M,
  MAX_PLAUSIBLE_SPEED_MPS,
  LOCATION_DIAG,
  haversineM,
  normalizeHeadingDeg,
  isValidLatLng,
  coerceCoordNumber,
  timestampToMs,
  normalizeLocationFix,
  evaluateFixAgainstPrevious,
  derivedDisplayBearingDeg,
  toVehicleLocationField,
  logLocationDiag,
};
