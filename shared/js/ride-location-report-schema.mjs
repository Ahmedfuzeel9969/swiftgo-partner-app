/**
 * Per-ride location delivery report schema (rideLocationReports/{rideId}).
 * Diagnostic only — aggregates only; no coordinates, tokens, or PII.
 * Mirrored in functions/ride-location-report-schema.js for Cloud Functions.
 */

import { buildLocationReportingConfigSnapshot } from "./location-reporting-config.mjs";

export const RIDE_LOCATION_REPORT_SCHEMA_VERSION = 1;

export const REPORT_DOC_STATUS = Object.freeze(["open", "partial", "final"]);

export const REPORT_COMPLETENESS = Object.freeze([
  "complete",
  "partial_driver_only",
  "partial_customer_only",
  "server_only",
  "missing",
]);

export const REPORT_HEALTH_STATUS = Object.freeze([
  "healthy",
  "warning",
  "critical",
  "insufficient_data",
]);

/** Keys that must never appear in client submit payloads. */
export const FORBIDDEN_REPORT_PAYLOAD_KEYS = Object.freeze([
  "lat",
  "lng",
  "latitude",
  "longitude",
  "email",
  "phone",
  "assignmentSessionToken",
  "sdp",
  "ip",
  "userAgent",
  "coordinates",
]);

export const DRIVER_COUNTER_KEYS = Object.freeze([
  "gpsFixesReceived",
  "validFixesAccepted",
  "invalidFixesRejected",
  "duplicateOrOutOfOrderRejected",
  "vehicleWritesAttempted",
  "vehicleWritesAcknowledged",
  "vehicleWritesFailed",
  "p2pFramesAttempted",
  "p2pFramesSent",
  "p2pHealthySessionCount",
  "p2pDegradedOrFallbackTransitions",
]);

export const SERVER_COUNTER_KEYS = Object.freeze([
  "mirrorAttempts",
  "mirrorAccepted",
  "mirrorSkippedInvalid",
  "mirrorSkippedInactive",
  "mirrorSkippedSessionMismatch",
  "mirrorSkippedDuplicate",
  "mirrorSkippedOutOfOrder",
  "mirrorSkippedNoop",
  "mirrorFailed",
]);

export const CUSTOMER_COUNTER_KEYS = Object.freeze([
  "firebaseSnapshotsReceived",
  "firebaseValidRendered",
  "p2pFramesReceived",
  "p2pValidRendered",
  "staleRejected",
  "duplicateRejected",
  "rollbackRejected",
  "sourceSwitchP2pToFirebase",
  "sourceSwitchFirebaseToP2p",
]);

export const HEALTH_WARNING_GAP_MS = 30_000;
export const HEALTH_CRITICAL_GAP_MS = 120_000;

function isStrictNonNegativeInteger(value) {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= 0
  );
}

function isStrictPositiveInteger(value) {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= 1
  );
}

function createZeroCounters(keys) {
  const counters = {};
  for (const key of keys) counters[key] = 0;
  return Object.freeze(counters);
}

export function createEmptyDriverCounters() {
  return { ...createZeroCounters(DRIVER_COUNTER_KEYS) };
}

export function createEmptyServerCounters() {
  return { ...createZeroCounters(SERVER_COUNTER_KEYS) };
}

export function createEmptyCustomerCounters() {
  return { ...createZeroCounters(CUSTOMER_COUNTER_KEYS) };
}

export function createEmptyDriverSection() {
  return {
    counters: createEmptyDriverCounters(),
    firstFixAtMs: null,
    lastFixAtMs: null,
    longestGapMs: null,
    submittedAtMs: null,
    submitSequence: 0,
  };
}

export function createEmptyServerSection() {
  return {
    counters: createEmptyServerCounters(),
    firstMirrorAtMs: null,
    lastMirrorAtMs: null,
    longestGapMs: null,
  };
}

export function createEmptyCustomerSection() {
  return {
    counters: createEmptyCustomerCounters(),
    firstRenderedAtMs: null,
    lastRenderedAtMs: null,
    longestGapMs: null,
    visibleDurationMs: 0,
    backgroundDurationMs: 0,
    submittedAtMs: null,
    submitSequence: 0,
  };
}

export function createEmptyLifecycleSection() {
  return {
    bookingCreatedAtMs: null,
    matchedAtMs: null,
    assignedAtMs: null,
    driverArrivedAtMs: null,
    tripStartedAtMs: null,
    settledAtMs: null,
    bookingToAssignmentMs: null,
    driverApproachMs: null,
    inProgressMs: null,
    totalLifecycleMs: null,
  };
}

export function createEmptyDerivedSection() {
  return {
    avgDriverGpsIntervalMs: null,
    avgFirebaseWriteIntervalMs: null,
    avgMirrorIntervalMs: null,
    avgCustomerFirebaseReceiveIntervalMs: null,
    avgP2pReceiveIntervalMs: null,
    avgMapRefreshIntervalMs: null,
    deliveryRatios: {
      mirrorToGps: null,
      customerFirebaseToMirror: null,
      customerP2pToSent: null,
      renderedToReceived: null,
    },
  };
}

export function createEmptyHealthSection() {
  return {
    status: "insufficient_data",
    reasons: [],
  };
}

function validateCounterMap(raw, allowedKeys) {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "invalid_counters" };
  }
  const counters = {};
  for (const key of allowedKeys) {
    const value = raw[key];
    if (value == null) {
      counters[key] = 0;
      continue;
    }
    if (!isStrictNonNegativeInteger(value)) {
      return { ok: false, reason: `invalid_counter_${key}` };
    }
    counters[key] = value;
  }
  for (const key of Object.keys(raw)) {
    if (!allowedKeys.includes(key)) {
      return { ok: false, reason: `unknown_counter_${key}` };
    }
  }
  return { ok: true, counters };
}

function containsForbiddenKeys(raw) {
  if (raw == null || typeof raw !== "object") return false;
  for (const key of Object.keys(raw)) {
    if (FORBIDDEN_REPORT_PAYLOAD_KEYS.includes(key)) return true;
    const nested = raw[key];
    if (nested != null && typeof nested === "object" && !Array.isArray(nested)) {
      if (containsForbiddenKeys(nested)) return true;
    }
  }
  return false;
}

function parseOptionalTimestampMs(value) {
  if (value == null) return null;
  if (!isStrictNonNegativeInteger(value) || value === 0) return null;
  return value;
}

function parseOptionalGapMs(value) {
  if (value == null) return null;
  if (!isStrictNonNegativeInteger(value)) return null;
  return value;
}

/** Average interval from first/last timestamps and event count; null when fewer than 2 events. */
export function averageIntervalMs(firstMs, lastMs, count) {
  if (!isStrictNonNegativeInteger(count) || count < 2) return null;
  if (!isStrictNonNegativeInteger(firstMs) || !isStrictNonNegativeInteger(lastMs)) return null;
  if (lastMs < firstMs) return null;
  const span = lastMs - firstMs;
  if (span <= 0) return null;
  return Math.round(span / (count - 1));
}

/** Safe ratio; null when denominator is zero or invalid. */
export function safeRatio(numerator, denominator) {
  if (!isStrictNonNegativeInteger(numerator) || !isStrictNonNegativeInteger(denominator)) {
    return null;
  }
  if (denominator === 0) return null;
  return Math.round((numerator / denominator) * 1000) / 1000;
}

/**
 * @param {{ driver?: object, server?: object, customer?: object }} sections
 */
export function computeDerivedMetrics(sections = {}) {
  const driver = sections.driver || {};
  const server = sections.server || {};
  const customer = sections.customer || {};
  const driverCounters = driver.counters || {};
  const customerCounters = customer.counters || {};

  const avgDriverGpsIntervalMs = averageIntervalMs(
    driver.firstFixAtMs,
    driver.lastFixAtMs,
    driverCounters.gpsFixesReceived
  );
  const avgFirebaseWriteIntervalMs = averageIntervalMs(
    driver.firstFixAtMs,
    driver.lastFixAtMs,
    driverCounters.vehicleWritesAcknowledged
  );
  const avgMirrorIntervalMs = averageIntervalMs(
    server.firstMirrorAtMs,
    server.lastMirrorAtMs,
    server.counters?.mirrorAccepted
  );
  const avgCustomerFirebaseReceiveIntervalMs = averageIntervalMs(
    customer.firstRenderedAtMs,
    customer.lastRenderedAtMs,
    customerCounters.firebaseSnapshotsReceived
  );
  const avgP2pReceiveIntervalMs = averageIntervalMs(
    customer.firstRenderedAtMs,
    customer.lastRenderedAtMs,
    customerCounters.p2pFramesReceived
  );
  const renderedCount =
    (customerCounters.firebaseValidRendered || 0) + (customerCounters.p2pValidRendered || 0);
  const receivedCount =
    (customerCounters.firebaseSnapshotsReceived || 0) + (customerCounters.p2pFramesReceived || 0);
  const avgMapRefreshIntervalMs = averageIntervalMs(
    customer.firstRenderedAtMs,
    customer.lastRenderedAtMs,
    renderedCount
  );

  return {
    avgDriverGpsIntervalMs,
    avgFirebaseWriteIntervalMs,
    avgMirrorIntervalMs,
    avgCustomerFirebaseReceiveIntervalMs,
    avgP2pReceiveIntervalMs,
    avgMapRefreshIntervalMs,
    deliveryRatios: {
      mirrorToGps: safeRatio(server.counters?.mirrorAccepted, driverCounters.gpsFixesReceived),
      customerFirebaseToMirror: safeRatio(
        customerCounters.firebaseSnapshotsReceived,
        server.counters?.mirrorAccepted
      ),
      customerP2pToSent: safeRatio(customerCounters.p2pFramesReceived, driverCounters.p2pFramesSent),
      renderedToReceived: safeRatio(renderedCount, receivedCount),
    },
  };
}

function durationMs(startMs, endMs) {
  if (!isStrictNonNegativeInteger(startMs) || !isStrictNonNegativeInteger(endMs)) return null;
  if (endMs < startMs) return null;
  return endMs - startMs;
}

/** Derive lifecycle durations from timestamp endpoints. */
export function computeLifecycleDurations(lifecycle = {}) {
  const bookingCreatedAtMs = parseOptionalTimestampMs(lifecycle.bookingCreatedAtMs);
  const matchedAtMs = parseOptionalTimestampMs(lifecycle.matchedAtMs);
  const assignedAtMs = parseOptionalTimestampMs(lifecycle.assignedAtMs);
  const driverArrivedAtMs = parseOptionalTimestampMs(lifecycle.driverArrivedAtMs);
  const tripStartedAtMs = parseOptionalTimestampMs(lifecycle.tripStartedAtMs);
  const settledAtMs = parseOptionalTimestampMs(lifecycle.settledAtMs);

  return {
    bookingCreatedAtMs,
    matchedAtMs,
    assignedAtMs,
    driverArrivedAtMs,
    tripStartedAtMs,
    settledAtMs,
    bookingToAssignmentMs: durationMs(bookingCreatedAtMs, assignedAtMs),
    driverApproachMs: durationMs(assignedAtMs, tripStartedAtMs),
    inProgressMs: durationMs(tripStartedAtMs, settledAtMs),
    totalLifecycleMs: durationMs(bookingCreatedAtMs, settledAtMs),
  };
}

/**
 * @param {{ driver?: object, server?: object, customer?: object, derived?: object }} input
 */
export function classifyReportHealth(input = {}) {
  const reasons = [];
  const driver = input.driver || {};
  const server = input.server || {};
  const customer = input.customer || {};
  const driverCount = driver.counters?.gpsFixesReceived || 0;
  const mirrorCount = server.counters?.mirrorAccepted || 0;
  const customerRendered =
    (customer.counters?.firebaseValidRendered || 0) + (customer.counters?.p2pValidRendered || 0);

  if (driverCount === 0 && mirrorCount === 0 && customerRendered === 0) {
    return { status: "insufficient_data", reasons: ["no_location_events"] };
  }

  const gaps = [
    ["driver_longest_gap_ms", driver.longestGapMs],
    ["server_longest_gap_ms", server.longestGapMs],
    ["customer_longest_gap_ms", customer.longestGapMs],
  ];
  for (const [label, gapMs] of gaps) {
    if (gapMs == null) continue;
    if (gapMs >= HEALTH_CRITICAL_GAP_MS) reasons.push(`${label}>=${HEALTH_CRITICAL_GAP_MS}`);
    else if (gapMs >= HEALTH_WARNING_GAP_MS) reasons.push(`${label}>=${HEALTH_WARNING_GAP_MS}`);
  }

  const ratios = input.derived?.deliveryRatios || computeDerivedMetrics(input).deliveryRatios;
  if (ratios.mirrorToGps != null && ratios.mirrorToGps < 0.5) {
    reasons.push("mirror_to_gps_ratio_low");
  }
  if (ratios.renderedToReceived != null && ratios.renderedToReceived < 0.5) {
    reasons.push("rendered_to_received_ratio_low");
  }

  const hasCritical = reasons.some((r) => r.includes(String(HEALTH_CRITICAL_GAP_MS)) || r.includes("_low"));
  const hasWarning = reasons.some((r) => r.includes(String(HEALTH_WARNING_GAP_MS)));

  if (hasCritical) return { status: "critical", reasons };
  if (hasWarning || reasons.length > 0) return { status: "warning", reasons };
  return { status: "healthy", reasons: [] };
}

/** @param {unknown} hash */
export function isValidAssignmentSessionTokenHash(hash) {
  return typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash);
}

/** @param {unknown} rideId */
export function isValidRideIdForReport(rideId) {
  return typeof rideId === "string" && rideId.length >= 6 && rideId.length <= 128;
}

/**
 * Validate driver client submit section (counters + timing only).
 * @param {Record<string, unknown>} raw
 */
export function validateDriverSubmitSection(raw = {}) {
  if (containsForbiddenKeys(raw)) return { ok: false, reason: "forbidden_field" };
  const counterResult = validateCounterMap(raw.counters, DRIVER_COUNTER_KEYS);
  if (!counterResult.ok) return counterResult;

  if (raw.submitSequence != null && !isStrictNonNegativeInteger(raw.submitSequence)) {
    return { ok: false, reason: "invalid_submit_sequence" };
  }

  return {
    ok: true,
    section: {
      counters: counterResult.counters,
      firstFixAtMs: parseOptionalTimestampMs(raw.firstFixAtMs),
      lastFixAtMs: parseOptionalTimestampMs(raw.lastFixAtMs),
      longestGapMs: parseOptionalGapMs(raw.longestGapMs),
      submittedAtMs: parseOptionalTimestampMs(raw.submittedAtMs),
      submitSequence: raw.submitSequence == null ? 0 : raw.submitSequence,
    },
  };
}

/**
 * Validate customer client submit section (counters + timing only).
 * @param {Record<string, unknown>} raw
 */
export function validateCustomerSubmitSection(raw = {}) {
  if (containsForbiddenKeys(raw)) return { ok: false, reason: "forbidden_field" };
  const counterResult = validateCounterMap(raw.counters, CUSTOMER_COUNTER_KEYS);
  if (!counterResult.ok) return counterResult;

  if (raw.submitSequence != null && !isStrictNonNegativeInteger(raw.submitSequence)) {
    return { ok: false, reason: "invalid_submit_sequence" };
  }
  if (raw.visibleDurationMs != null && !isStrictNonNegativeInteger(raw.visibleDurationMs)) {
    return { ok: false, reason: "invalid_visible_duration" };
  }
  if (raw.backgroundDurationMs != null && !isStrictNonNegativeInteger(raw.backgroundDurationMs)) {
    return { ok: false, reason: "invalid_background_duration" };
  }

  return {
    ok: true,
    section: {
      counters: counterResult.counters,
      firstRenderedAtMs: parseOptionalTimestampMs(raw.firstRenderedAtMs),
      lastRenderedAtMs: parseOptionalTimestampMs(raw.lastRenderedAtMs),
      longestGapMs: parseOptionalGapMs(raw.longestGapMs),
      visibleDurationMs: raw.visibleDurationMs == null ? 0 : raw.visibleDurationMs,
      backgroundDurationMs: raw.backgroundDurationMs == null ? 0 : raw.backgroundDurationMs,
      submittedAtMs: parseOptionalTimestampMs(raw.submittedAtMs),
      submitSequence: raw.submitSequence == null ? 0 : raw.submitSequence,
    },
  };
}

/**
 * Build a local-only summary payload (not yet persisted to Firestore).
 * @param {{
 *   rideId: string,
 *   assignmentSessionTokenHash: string,
 *   role: "driver" | "customer",
 *   section: object,
 *   config?: object,
 * }} input
 */
export function buildLocalReportSummary(input) {
  const { rideId, assignmentSessionTokenHash, role, section, config } = input || {};
  if (!isValidRideIdForReport(rideId)) return { ok: false, reason: "invalid_ride_id" };
  if (!isValidAssignmentSessionTokenHash(assignmentSessionTokenHash)) {
    return { ok: false, reason: "invalid_assignment_session_token_hash" };
  }
  if (role !== "driver" && role !== "customer") return { ok: false, reason: "invalid_role" };

  const validated =
    role === "driver"
      ? validateDriverSubmitSection(section)
      : validateCustomerSubmitSection(section);
  if (!validated.ok) return validated;

  return {
    ok: true,
    summary: {
      schemaVersion: RIDE_LOCATION_REPORT_SCHEMA_VERSION,
      rideId,
      assignmentSessionTokenHash,
      role,
      section: validated.section,
      configSnapshot: buildLocationReportingConfigSnapshot(config),
      preparedAtMs: Date.now(),
    },
  };
}

/** Monotonic merge: keep max per counter and max submitSequence. */
export function mergeMonotonicCounters(existing = {}, incoming = {}) {
  const merged = { ...existing };
  for (const key of Object.keys(incoming)) {
    const prev = merged[key];
    const next = incoming[key];
    if (!isStrictNonNegativeInteger(next)) continue;
    if (!isStrictNonNegativeInteger(prev) || next > prev) merged[key] = next;
  }
  return merged;
}

export function mergeSubmitSections(existing = {}, incoming = {}) {
  const mergedCounters = mergeMonotonicCounters(existing.counters || {}, incoming.counters || {});
  const pickMin = (a, b) => {
    if (a == null) return b ?? null;
    if (b == null) return a;
    return Math.min(a, b);
  };
  const pickMax = (a, b) => {
    if (a == null) return b ?? null;
    if (b == null) return a;
    return Math.max(a, b);
  };

  return {
    counters: mergedCounters,
    firstFixAtMs: pickMin(existing.firstFixAtMs, incoming.firstFixAtMs),
    lastFixAtMs: pickMax(existing.lastFixAtMs, incoming.lastFixAtMs),
    firstRenderedAtMs: pickMin(existing.firstRenderedAtMs, incoming.firstRenderedAtMs),
    lastRenderedAtMs: pickMax(existing.lastRenderedAtMs, incoming.lastRenderedAtMs),
    longestGapMs: pickMax(existing.longestGapMs, incoming.longestGapMs),
    visibleDurationMs: Math.max(existing.visibleDurationMs || 0, incoming.visibleDurationMs || 0),
    backgroundDurationMs: Math.max(
      existing.backgroundDurationMs || 0,
      incoming.backgroundDurationMs || 0
    ),
    submittedAtMs: pickMax(existing.submittedAtMs, incoming.submittedAtMs),
    submitSequence: Math.max(existing.submitSequence || 0, incoming.submitSequence || 0),
  };
}

export function shouldAcceptSubmitSequence(lastAccepted, incoming) {
  if (!isStrictNonNegativeInteger(incoming)) return false;
  if (!isStrictNonNegativeInteger(lastAccepted)) return incoming >= 1;
  return incoming > lastAccepted;
}

export function validateSubmitSequenceForCallable(value) {
  return isStrictPositiveInteger(value);
}

/**
 * Browser/Node async SHA-256 hex digest for assignment session tokens.
 * Never store or transmit the raw token in report payloads.
 * @param {string} token
 * @returns {Promise<string|null>}
 */
export async function hashAssignmentSessionTokenAsync(token) {
  if (typeof token !== "string" || token.length < 8 || token.length > 80) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(token)) return null;
  if (typeof globalThis.crypto?.subtle?.digest !== "function") return null;
  const data = new TextEncoder().encode(token);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
