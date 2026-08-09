/**
 * Per-ride location delivery report — trusted client submit + server mirror aggregation.
 * Diagnostic only — never touches fare, settlement, wallet, dispatch, or ride status.
 */
"use strict";

const crypto = require("crypto");
const { FieldValue, Timestamp } = require("firebase-admin/firestore");
const { LOCATION_DIAG } = require("./live-location-envelope");
const { CUSTOMER_RIDE_OWNER_FIELD } = require("./matching");
const {
  LOCATION_REPORTING_CONFIG_DOC_PATH,
  normalizeLocationReportingConfig,
  buildLocationReportingConfigSnapshot,
  isReportingActive,
} = require("./location-reporting-config.js");
const {
  getCachedLocationReportingConfig,
  shouldAggregateServerMirror,
} = require("./location-reporting-config-cache.js");
const {
  buildAcceptedMirrorAggregatePatch,
  serverSectionFromRideAggregate,
  hasRideServerMirrorAggregate,
} = require("./server-mirror-aggregate.js");
const {
  RIDE_LOCATION_REPORT_SCHEMA_VERSION,
  REPORT_RETENTION_POLICY,
  validateDriverSubmitSection,
  validateCustomerSubmitSection,
  validateSubmitSequenceForCallable,
  isValidAssignmentSessionTokenHash,
  isValidRideIdForReport,
  shouldAcceptSubmitSequence,
  mergeSubmitSections,
  computeDerivedMetrics,
  classifyReportHealth,
  computeLifecycleDurations,
  computeReportCompleteness,
  createEmptyDriverSection,
  createEmptyServerSection,
  createEmptyCustomerSection,
  DRIVER_COUNTER_KEYS,
  CUSTOMER_COUNTER_KEYS,
} = require("./ride-location-report-schema.js");

const REPORT_COLLECTION = "rideLocationReports";

const REPORT_SUBMIT_ALLOWED_STATUSES = Object.freeze([
  "accepted",
  "arrived",
  "in_progress",
  "completed",
  "cancelled_by_customer",
  "cancelled_by_admin",
  "cancelled_by_user",
  "expired",
  "no_driver_found",
]);

const TERMINAL_RIDE_STATUSES = Object.freeze([
  "completed",
  "cancelled_by_customer",
  "cancelled_by_admin",
  "cancelled_by_user",
  "expired",
  "no_driver_found",
]);

function err(code, message) {
  const e = new Error(message || code);
  e.code = code;
  return e;
}

function hashAssignmentSessionTokenSync(token) {
  if (typeof token !== "string" || token.length < 8) return null;
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

function timestampToMs(value) {
  if (value == null) return null;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.getTime();
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "object" && Number.isInteger(value.seconds)) {
    return value.seconds * 1000 + Math.floor((value.nanoseconds || 0) / 1_000_000);
  }
  return null;
}

function lifecycleFromRide(ride = {}) {
  const settledAtMs = timestampToMs(ride.settledAt);
  const cancelledAtMs = timestampToMs(ride.cancelledAt) || timestampToMs(ride.cancelledAtMs);
  const terminalAtMs = settledAtMs ?? cancelledAtMs;
  return computeLifecycleDurations({
    bookingCreatedAtMs: timestampToMs(ride.createdAt),
    matchedAtMs: timestampToMs(ride.matchedAt),
    assignedAtMs: timestampToMs(ride.assignedAt),
    driverArrivedAtMs: timestampToMs(ride.driverArrivedAt),
    tripStartedAtMs: timestampToMs(ride.tripStartedAt),
    settledAtMs,
    terminalAtMs,
  });
}

function hasClientSection(report, role) {
  const seq =
    role === "driver"
      ? report?.driver?.lastAcceptedSequence || report?.driver?.submitSequence || 0
      : report?.customer?.lastAcceptedSequence || report?.customer?.submitSequence || 0;
  return seq >= 1;
}

function hasServerSection(report) {
  return (report?.server?.counters?.mirrorAttempts || 0) > 0;
}

function mergeServerSectionFromRide(report, ride, config) {
  if (!shouldAggregateServerMirror(config)) return false;
  const serverSection = serverSectionFromRideAggregate(ride);
  if (!serverSection) return false;
  report.server = serverSection;
  return true;
}

function recomputeReportDerived(report, ride, config) {
  report.lifecycle = lifecycleFromRide(ride);
  report.derived = computeDerivedMetrics(report);
  report.health = classifyReportHealth({ ...report, derived: report.derived });
  report.completeness = computeCompleteness(report);
  report.status = computeDocStatus(report, ride.status, config);
}

function computeCompleteness(report = {}) {
  return computeReportCompleteness(report);
}

function requiredSectionsAcknowledged(report = {}, config = {}) {
  const normalized = normalizeLocationReportingConfig(config);
  if (normalized.collectDriverMetrics !== false && !hasClientSection(report, "driver")) return false;
  if (normalized.collectCustomerMetrics !== false && !hasClientSection(report, "customer")) {
    return false;
  }
  if (normalized.collectFirebaseMetrics !== false && !hasServerSection(report)) return false;
  return true;
}

function computeDocStatus(report = {}, rideStatus = "", config = {}) {
  const terminal = TERMINAL_RIDE_STATUSES.includes(String(rideStatus || ""));
  const requiredAck = requiredSectionsAcknowledged(report, config);
  if (terminal && requiredAck) return "final";
  if (hasClientSection(report, "driver") || hasClientSection(report, "customer") || hasServerSection(report)) {
    return "partial";
  }
  return "open";
}

function createEmptyLifecyclePlain() {
  return {
    bookingCreatedAtMs: null,
    matchedAtMs: null,
    assignedAtMs: null,
    driverArrivedAtMs: null,
    tripStartedAtMs: null,
    settledAtMs: null,
    terminalAtMs: null,
    bookingToAssignmentMs: null,
    assignedToArrivedMs: null,
    arrivedToTripStartMs: null,
    tripStartToTerminalMs: null,
    assignedToTerminalMs: null,
    driverApproachMs: null,
    inProgressMs: null,
    totalLifecycleMs: null,
  };
}

function emptyReportDoc(rideId, tokenHash, configSnapshot) {
  return {
    schemaVersion: RIDE_LOCATION_REPORT_SCHEMA_VERSION,
    rideId,
    assignmentSessionTokenHash: tokenHash,
    status: "open",
    completeness: "missing",
    lifecycle: createEmptyLifecyclePlain(),
    driver: stripSectionForStorage(createEmptyDriverSection(), "driver"),
    server: createEmptyServerSection(),
    customer: stripSectionForStorage(createEmptyCustomerSection(), "customer"),
    derived: computeDerivedMetrics({}),
    health: classifyReportHealth({}),
    configSnapshot,
    retentionPolicy: REPORT_RETENTION_POLICY,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
    finalizedAt: null,
    expiresAt: null,
  };
}

function stripSectionForStorage(section, role) {
  const base = { ...section, counters: { ...(section.counters || {}) }, lastAcceptedSequence: 0 };
  if (role === "driver") {
    delete base.firstRenderedAtMs;
    delete base.lastRenderedAtMs;
    delete base.visibleDurationMs;
    delete base.backgroundDurationMs;
  } else {
    delete base.firstFixAtMs;
    delete base.lastFixAtMs;
  }
  return base;
}

function mergeClientSection(existing = {}, incoming = {}, role) {
  const merged = mergeSubmitSections(existing, incoming);
  const out = stripSectionForStorage(merged, role);
  out.submittedAt = FieldValue.serverTimestamp();
  out.lastAcceptedSequence = incoming.submitSequence;
  return out;
}

async function readReportingConfig(db) {
  return getCachedLocationReportingConfig(db);
}

function assertRoleMetricsEnabled(config, role) {
  if (!isReportingActive(config)) return;
  if (role === "driver" && config.collectDriverMetrics === false) {
    throw err("failed-precondition", "DRIVER_METRICS_DISABLED");
  }
  if (role === "customer" && config.collectCustomerMetrics === false) {
    throw err("failed-precondition", "CUSTOMER_METRICS_DISABLED");
  }
}

function filterSectionCountersForConfig(section, role, config) {
  const normalized = normalizeLocationReportingConfig(config);
  const counters = { ...(section?.counters || {}) };
  if (role === "driver" && normalized.collectP2pMetrics === false) {
    for (const key of DRIVER_COUNTER_KEYS) {
      if (key.startsWith("p2p")) counters[key] = 0;
    }
  }
  if (role === "customer") {
    if (normalized.collectFirebaseMetrics === false) {
      counters.firebaseSnapshotsReceived = 0;
      counters.firebaseValidRendered = 0;
      counters.sourceSwitchP2pToFirebase = 0;
      counters.sourceSwitchFirebaseToP2p = 0;
    }
    if (normalized.collectP2pMetrics === false) {
      for (const key of CUSTOMER_COUNTER_KEYS) {
        if (key.startsWith("p2p") || key.startsWith("sourceSwitch")) counters[key] = 0;
      }
    }
  }
  return { ...section, counters };
}

function mapMirrorReasonToCounter(reason, mirrored) {
  if (mirrored) return "mirrorAccepted";
  const r = String(reason || "");
  if (r === LOCATION_DIAG.MIRRORED) return "mirrorAccepted";
  if (r === LOCATION_DIAG.NOOP_UNCHANGED) return "mirrorSkippedNoop";
  if (r === LOCATION_DIAG.DUPLICATE) return "mirrorSkippedDuplicate";
  if (r === LOCATION_DIAG.OUT_OF_ORDER) return "mirrorSkippedOutOfOrder";
  if (r === LOCATION_DIAG.SESSION_MISMATCH || r === LOCATION_DIAG.RETIRED_SESSION) {
    return "mirrorSkippedSessionMismatch";
  }
  if (
    r === "terminal_or_inactive" ||
    r === "no_active_ride" ||
    r === "ride_missing" ||
    r === "vehicle_mismatch"
  ) {
    return "mirrorSkippedInactive";
  }
  if (
    r === LOCATION_DIAG.INVALID ||
    r === LOCATION_DIAG.POOR_ACCURACY ||
    r === LOCATION_DIAG.IMPOSSIBLE_JUMP
  ) {
    return "mirrorSkippedInvalid";
  }
  if (r === "ride_location_mirror_txn_failed" || r.includes("txn")) return "mirrorFailed";
  return "mirrorSkippedInvalid";
}

/**
 * Pure helper — apply one mirror outcome to an in-memory report document.
 * @returns {object|null} patched report fields or null when skipped (disabled/stale token)
 */
function applyServerMirrorOutcomeToReport(report, outcome, ride, config) {
  if (!shouldAggregateServerMirror(config)) return null;

  const token = String(ride?.assignmentSessionToken || "").trim();
  const tokenHash = hashAssignmentSessionTokenSync(token);
  if (!tokenHash) return null;

  const rideId = String(ride?.id || ride?.rideId || "").trim();
  const base =
    report && Object.keys(report).length > 0
      ? { ...report }
      : emptyReportDoc(rideId, tokenHash, buildLocationReportingConfigSnapshot(config));

  if (base.assignmentSessionTokenHash && base.assignmentSessionTokenHash !== tokenHash) {
    return null;
  }

  const counterKey = mapMirrorReasonToCounter(outcome.reason, outcome.mirrored === true);
  const server = base.server || createEmptyServerSection();
  const counters = { ...(server.counters || {}) };
  counters.mirrorAttempts = (counters.mirrorAttempts || 0) + 1;
  counters[counterKey] = (counters[counterKey] || 0) + 1;

  const nowMs = Date.now();
  if (counterKey === "mirrorAccepted") {
    if (server.firstMirrorAtMs == null) server.firstMirrorAtMs = nowMs;
    server.lastMirrorAtMs = nowMs;
    if (server.lastEventAtMs != null && nowMs > server.lastEventAtMs) {
      const gap = nowMs - server.lastEventAtMs;
      server.longestGapMs = server.longestGapMs == null ? gap : Math.max(server.longestGapMs, gap);
    }
    server.lastEventAtMs = nowMs;
  }

  server.counters = counters;
  base.server = server;
  base.assignmentSessionTokenHash = tokenHash;
  base.lifecycle = lifecycleFromRide(ride);
  base.derived = computeDerivedMetrics(base);
  base.health = classifyReportHealth({ ...base, derived: base.derived });
  base.completeness = computeCompleteness(base);
  base.status = computeDocStatus(base, ride.status, config);
  base.configSnapshot = buildLocationReportingConfigSnapshot(config);
  base.retentionPolicy = REPORT_RETENTION_POLICY;
  base.updatedAt = FieldValue.serverTimestamp();

  const retentionDays = config.retentionDays || 30;
  if (!base.expiresAt) {
    base.expiresAt = Timestamp.fromMillis(Date.now() + retentionDays * 24 * 60 * 60 * 1000);
  }

  if (base.status === "final" && !base.finalizedAt) {
    base.finalizedAt = FieldValue.serverTimestamp();
  }

  return base;
}

/**
 * Trusted callable — driver or customer submits location report section.
 */
async function submitRideLocationReportSection(db, input) {
  const callerUid = String(input?.callerUid || "").trim();
  if (!callerUid) throw err("unauthenticated", "AUTH_REQUIRED");

  const rideId = String(input?.rideId || "").trim();
  if (!isValidRideIdForReport(rideId)) throw err("invalid-argument", "INVALID_RIDE_ID");

  const role = input?.role;
  if (role !== "driver" && role !== "customer") throw err("invalid-argument", "INVALID_ROLE");

  const tokenHash = String(input?.assignmentSessionTokenHash || "").trim();
  if (!isValidAssignmentSessionTokenHash(tokenHash)) {
    throw err("invalid-argument", "INVALID_ASSIGNMENT_TOKEN_HASH");
  }

  if (!validateSubmitSequenceForCallable(input?.submitSequence)) {
    throw err("invalid-argument", "INVALID_SUBMIT_SEQUENCE");
  }
  const submitSequence = input.submitSequence;

  const config = await readReportingConfig(db);
  if (!isReportingActive(config)) {
    return { ok: true, skipped: true, reason: "REPORTING_DISABLED" };
  }
  assertRoleMetricsEnabled(config, role);

  const filteredSection = filterSectionCountersForConfig(input?.section || {}, role, config);
  const validated =
    role === "driver"
      ? validateDriverSubmitSection({ ...filteredSection, submitSequence })
      : validateCustomerSubmitSection({ ...filteredSection, submitSequence });
  if (!validated.ok) throw err("invalid-argument", String(validated.reason || "INVALID_SECTION").toUpperCase());

  const rideRef = db.collection("rides").doc(rideId);
  const reportRef = db.collection(REPORT_COLLECTION).doc(rideId);

  const result = await db.runTransaction(async (tx) => {
    const [rideSnap, reportSnap] = await Promise.all([tx.get(rideRef), tx.get(reportRef)]);
    if (!rideSnap.exists) throw err("not-found", "RIDE_NOT_FOUND");
    const ride = rideSnap.data() || {};

    if (!REPORT_SUBMIT_ALLOWED_STATUSES.includes(String(ride.status || ""))) {
      throw err("failed-precondition", `SUBMIT_NOT_ALLOWED:${ride.status || "unknown"}`);
    }

    const serverTokenHash = hashAssignmentSessionTokenSync(String(ride.assignmentSessionToken || "").trim());
    if (!serverTokenHash) throw err("failed-precondition", "ASSIGNMENT_TOKEN_MISSING");
    if (serverTokenHash !== tokenHash) throw err("failed-precondition", "STALE_ASSIGNMENT");

    if (role === "driver") {
      if (String(ride.driverId || "") !== callerUid) throw err("permission-denied", "NOT_RIDE_DRIVER");
    } else if (String(ride[CUSTOMER_RIDE_OWNER_FIELD] || "") !== callerUid) {
      throw err("permission-denied", "NOT_RIDE_CUSTOMER");
    }

    const configSnapshot = buildLocationReportingConfigSnapshot(config);
    const existing = reportSnap.exists ? reportSnap.data() || {} : null;
    const report =
      existing && existing.assignmentSessionTokenHash === tokenHash
        ? { ...existing }
        : emptyReportDoc(rideId, tokenHash, configSnapshot);

    const roleKey = role === "driver" ? "driver" : "customer";
    const roleSection = report[roleKey] || stripSectionForStorage(
      role === "driver" ? createEmptyDriverSection() : createEmptyCustomerSection(),
      role
    );
    const lastAccepted = roleSection.lastAcceptedSequence || 0;

    mergeServerSectionFromRide(report, ride, config);

    if (submitSequence < lastAccepted) {
      throw err("failed-precondition", "STALE_SUBMIT_SEQUENCE");
    }
    if (submitSequence === lastAccepted) {
      recomputeReportDerived(report, ride, config);
      report.configSnapshot = configSnapshot;
      report.retentionPolicy = REPORT_RETENTION_POLICY;
      report.updatedAt = FieldValue.serverTimestamp();
      if (reportSnap.exists) tx.update(reportRef, report);
      else if (hasClientSection(report, "driver") || hasClientSection(report, "customer") || hasServerSection(report)) {
        tx.set(reportRef, report);
      }
      return {
        ok: true,
        already: true,
        rideId,
        role,
        submitSequence,
        status: report.status || "open",
        completeness: report.completeness || "missing",
      };
    }
    if (!shouldAcceptSubmitSequence(lastAccepted, submitSequence)) {
      throw err("failed-precondition", "STALE_SUBMIT_SEQUENCE");
    }

    report[roleKey] = mergeClientSection(roleSection, validated.section, role);
    recomputeReportDerived(report, ride, config);
    report.configSnapshot = configSnapshot;
    report.retentionPolicy = REPORT_RETENTION_POLICY;
    report.updatedAt = FieldValue.serverTimestamp();

    const retentionDays = config.retentionDays || 30;
    if (!report.expiresAt) {
      report.expiresAt = Timestamp.fromMillis(Date.now() + retentionDays * 24 * 60 * 60 * 1000);
    }

    const terminal = TERMINAL_RIDE_STATUSES.includes(String(ride.status || ""));
    const shouldFinalize = terminal && requiredSectionsAcknowledged(report, config);
    if (shouldFinalize) {
      report.status = "final";
      if (!report.finalizedAt) report.finalizedAt = FieldValue.serverTimestamp();
    }

    if (reportSnap.exists) tx.update(reportRef, report);
    else tx.set(reportRef, report);

    return {
      ok: true,
      already: false,
      rideId,
      role,
      submitSequence,
      status: report.status,
      completeness: report.completeness,
      healthStatus: report.health?.status || "insufficient_data",
    };
  });

  return result;
}

module.exports = {
  REPORT_COLLECTION,
  REPORT_SUBMIT_ALLOWED_STATUSES,
  TERMINAL_RIDE_STATUSES,
  hashAssignmentSessionTokenSync,
  lifecycleFromRide,
  computeCompleteness,
  computeDocStatus,
  requiredSectionsAcknowledged,
  mapMirrorReasonToCounter,
  applyServerMirrorOutcomeToReport,
  mergeServerSectionFromRide,
  submitRideLocationReportSection,
  filterSectionCountersForConfig,
  hasRideServerMirrorAggregate,
};
