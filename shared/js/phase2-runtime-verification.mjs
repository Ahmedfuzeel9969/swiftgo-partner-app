/**
 * Phase 2 — runtime verification helpers (lightweight facade).
 * Report builders live in phase2-runtime-reports.mjs (lazy-loaded).
 */

import {
  CFG_RESPONSIVE_INTERVAL_MS,
  CFG_P2P_FALLBACK_AFTER_MS,
} from "./phase1-billing-diagnostics.mjs";

/** Timing tolerances for PASS (device / listener jitter — not policy changes). */
export const PHASE2_WRITE_TOLERANCE_MS = 500;
export const PHASE2_P2P_FALLBACK_TOLERANCE_MS = 2_000;

function fmtClock(ms) {
  if (!Number.isFinite(ms)) return "—";
  try {
    return new Date(ms).toLocaleTimeString();
  } catch {
    return String(ms);
  }
}

function sec(ms) {
  if (!Number.isFinite(ms)) return null;
  return Math.round((ms / 1000) * 10) / 10;
}

/**
 * Explain write timing vs the configured responsive 4s interval.
 */
export function explainWriteIntervalTiming({
  actualIntervalMs = null,
  expectedResponsiveMs = CFG_RESPONSIVE_INTERVAL_MS,
  policyIntervalMs = null,
  policyName = "",
  writeReasonCode = "",
  writeReasonLabel = "",
  writeGateReason = "",
} = {}) {
  const expected = expectedResponsiveMs;
  const policy = Number.isFinite(policyIntervalMs) ? policyIntervalMs : expected;

  if (!Number.isFinite(actualIntervalMs)) {
    return {
      timingClass: "first_write",
      differenceMs: null,
      expectedIntervalMs: expected,
      policyIntervalMs: policy,
      beforeResponsiveInterval: false,
      afterResponsiveInterval: false,
      pass: true,
      explanation:
        "First Firebase write in this diagnostic window — no previous write interval to compare.",
    };
  }

  const differenceMs = Math.round(actualIntervalMs - expected);
  const before = actualIntervalMs < expected - PHASE2_WRITE_TOLERANCE_MS;
  const after = actualIntervalMs > expected + PHASE2_WRITE_TOLERANCE_MS;

  if (before) {
    let explanation = `Write occurred before the configured ${sec(expected)}s responsive interval.`;
    const code = writeReasonCode || writeGateReason;
    if (code === "forced_write" || writeGateReason === "force") {
      explanation +=
        " Reason: forced/immediate checkpoint (presence visible, status, or explicit force) — allowed by current policy.";
    } else if (code === "ride_state_changed" || writeGateReason === "status_changed") {
      explanation += " Reason: vehicle/ride status changed — allowed before the interval.";
    } else if (
      code === "minimum_movement_reached" ||
      code === "both_interval_and_movement" ||
      writeGateReason === "responsive_gate"
    ) {
      explanation +=
        " Reason: driver moved ≥ minimum distance (or zone/cell change) under the responsive gate — interval is OR'd with movement, so writes before 4s are allowed.";
    } else if (code === "other_zone_or_cell") {
      explanation += " Reason: location grid / match geo-cell changed — allowed before the interval.";
    } else if (code === "minimum_interval_reached" || writeGateReason === "interval_elapsed") {
      explanation +=
        " Unexpected: labeled as interval-elapsed but occurred early vs 4s — investigate clock/policy mismatch.";
      return {
        timingClass: "before_4s_unexpected",
        differenceMs,
        expectedIntervalMs: expected,
        policyIntervalMs: policy,
        beforeResponsiveInterval: true,
        afterResponsiveInterval: false,
        pass: false,
        explanation,
      };
    } else {
      explanation += ` Reason code: ${writeReasonLabel || code || "other"}.`;
    }
    return {
      timingClass: "before_4s",
      differenceMs,
      expectedIntervalMs: expected,
      policyIntervalMs: policy,
      beforeResponsiveInterval: true,
      afterResponsiveInterval: false,
      pass: true,
      explanation,
    };
  }

  if (after) {
    let explanation = `Write occurred after the configured ${sec(expected)}s responsive interval (actual ${sec(actualIntervalMs)}s).`;
    if (policy > expected + PHASE2_WRITE_TOLERANCE_MS) {
      explanation += ` Active checkpoint policy interval was ${sec(policy)}s (${policyName || "sparse/background"}) — longer than 4s is expected under that policy.`;
      if (actualIntervalMs + PHASE2_WRITE_TOLERANCE_MS < policy) {
        explanation +=
          " Note: wrote somewhat before the full policy interval (force/status/move may still apply in non-hard modes).";
      }
    } else {
      explanation +=
        " Under responsive 4s policy this usually means GPS fixes were sparse, prior writes were skipped by the gate, or the device paused callbacks — not a config change.";
    }
    return {
      timingClass: "after_4s",
      differenceMs,
      expectedIntervalMs: expected,
      policyIntervalMs: policy,
      beforeResponsiveInterval: false,
      afterResponsiveInterval: true,
      pass: true,
      explanation,
    };
  }

  return {
    timingClass: "about_4s",
    differenceMs,
    expectedIntervalMs: expected,
    policyIntervalMs: policy,
    beforeResponsiveInterval: false,
    afterResponsiveInterval: false,
    pass: true,
    explanation: `Write interval (~${sec(actualIntervalMs)}s) matches the configured responsive ${sec(expected)}s interval within tolerance.`,
  };
}

/**
 * Classify why a duplicate Firebase receive happened (heuristic, observe-only).
 */
export function classifyDuplicateReceiveReason({
  classification = "",
  intervalSincePreviousReceiveMs = null,
  rideStatusChanged = false,
  sameSequence = false,
  sameGpsTimestamp = false,
  sameCoordinates = false,
} = {}) {
  const isDup =
    classification === "duplicate_document" ||
    classification === "duplicate_location" ||
    classification === "same_coordinates";

  if (!isDup) {
    return {
      code: "not_duplicate",
      label: "Not a duplicate",
      plain: "This receive contained a new driver location (or empty).",
    };
  }

  if (rideStatusChanged) {
    return {
      code: "metadata_update",
      label: "Metadata update",
      plain:
        "Duplicate Firebase data received.\n\nDriver location fields did not change, but the ride document status (or other metadata) changed, so Firestore delivered another snapshot.",
    };
  }

  const gap = Number(intervalSincePreviousReceiveMs);
  if (Number.isFinite(gap) && gap < 400) {
    return {
      code: "listener_replay",
      label: "Listener replay",
      plain:
        "Duplicate Firebase data received.\n\nReason: Listener replay (onSnapshot re-fired almost immediately with the same location).",
    };
  }
  if (Number.isFinite(gap) && gap >= 5_000) {
    return {
      code: "connection_restored",
      label: "Connection restored",
      plain:
        "Duplicate Firebase data received.\n\nReason: Connection restored / listener resumed after a gap, re-delivering the last known location without a new driver write.",
    };
  }
  if (Number.isFinite(gap) && gap >= 400 && gap < 2_000) {
    return {
      code: "offline_cache_replay",
      label: "Offline cache replay",
      plain:
        "Duplicate Firebase data received.\n\nReason: Likely offline cache / local snapshot replay — same location returned shortly after a prior receive without a new write sequence.",
    };
  }
  if (sameSequence && sameGpsTimestamp && sameCoordinates) {
    return {
      code: "document_modified",
      label: "Document modified",
      plain:
        "Duplicate Firebase data received.\n\nSame coordinates, GPS timestamp, and sequence.\n\nReason: Ride document was modified (non-location field or mirror echo) while driverLocation identity stayed the same, so the continuous listener produced another snapshot.",
    };
  }
  return {
    code: "document_modified",
    label: "Document modified",
    plain:
      "Duplicate Firebase data received.\n\nNo new driver location.\n\nReason: Document modified — continuous onSnapshot delivered another ride-document callback while driverLocation lat/lng/sequence/observedAt were unchanged (non-location field update or listener echo).",
  };
}

/**
 * Build write↔read link key from location identity.
 */
export function writeReadLinkKey(sequence, gpsTimestamp) {
  const seq = Number(sequence);
  const gps = Number(gpsTimestamp);
  if (Number.isFinite(seq) && seq > 0) return `seq:${seq}`;
  if (Number.isFinite(gps) && gps > 0) return `gps:${gps}`;
  return null;
}

export function recordP2pFallbackDetail(
  diag,
  {
    p2pStoppedAt = null,
    firebaseFallbackStartedAt = Date.now(),
    expectedDelayMs = CFG_P2P_FALLBACK_AFTER_MS,
    triggerPath = "unknown",
    diagCode = "",
  } = {}
) {
  if (!diag?.record) return;
  const started = firebaseFallbackStartedAt || Date.now();
  const actual =
    Number.isFinite(p2pStoppedAt) && p2pStoppedAt > 0 ? Math.max(0, started - p2pStoppedAt) : null;
  const plain = [
    "P2P Firebase fallback observed.",
    "",
    `P2P last healthy / stopped at: ${fmtClock(p2pStoppedAt)}`,
    `Firebase fallback started: ${fmtClock(started)}`,
    `Actual delay: ${actual == null ? "—" : sec(actual) + " seconds"}`,
    `Expected delay: ${sec(expectedDelayMs)} seconds`,
    `Trigger path: ${triggerPath}`,
    diagCode ? `Diag code: ${diagCode}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  diag.record("p2p_fallback_detail", {
    p2pStoppedAt: p2pStoppedAt || null,
    firebaseFallbackStartedAt: started,
    actualDelayMs: actual,
    expectedDelayMs,
    differenceMs: actual == null ? null : actual - expectedDelayMs,
    triggerPath,
    diagCode: String(diagCode || ""),
    plainText: plain,
  });
}
