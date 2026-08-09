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
} = require("./location-reporting-config.js");
const {
  RIDE_LOCATION_REPORT_SCHEMA_VERSION,
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
  createEmptyDriverSection,
  createEmptyServerSection,
  createEmptyCustomerSection,
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
  return computeLifecycleDurations({
    bookingCreatedAtMs: timestampToMs(ride.createdAt),
    matchedAtMs: timestampToMs(ride.matchedAt),
    assignedAtMs: timestampToMs(ride.assignedAt),
    driverArrivedAtMs: timestampToMs(ride.driverArrivedAt),
    tripStartedAtMs: timestampToMs(ride.tripStartedAt),
    settledAtMs: timestampToMs(ride.settledAt),
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
  const attempts = report?.server?.counters?.mirrorAttempts || 0;
  return attempts > 0;
}

function computeCompleteness(report = {}) {
  const driver = hasClientSection(report, "driver");
  const customer = hasClientSection(report, "customer");
  const server = hasServerSection(report);
  if (driver && customer && server) return "complete";
  if (driver && customer) return "partial_driver_only";
  if (driver) return "partial_driver_only";
  if (customer) return "partial_customer_only";
  if (server) return "server_only";
  return "missing";
}

function computeDocStatus(report = {}, rideStatus = "") {
  const completeness = computeCompleteness(report);
  const driverDone = hasClientSection(report, "driver");
  const customerDone = hasClientSection(report, "customer");
  const terminal = ["completed", "cancelled_by_customer", "cancelled_by_admin", "cancelled_by_user", "expired", "no_driver_found"].includes(
    String(rideStatus || "")
  );
  if (driverDone && customerDone && terminal) return "final";
  if (driverDone || customerDone || hasServerSection(report)) return "partial";
  return "open";
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
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
    finalizedAt: null,
    expiresAt: null,
  };
}

function createEmptyLifecyclePlain() {
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
  const snap = await db.doc(LOCATION_REPORTING_CONFIG_DOC_PATH).get();
  return normalizeLocationReportingConfig(snap.exists ? snap.data() : {});
}

function assertRoleMetricsEnabled(config, role) {
  if (role === "driver" && config.collectDriverMetrics === false) {
    throw err("failed-precondition", "DRIVER_METRICS_DISABLED");
  }
  if (role === "customer" && config.collectCustomerMetrics === false) {
    throw err("failed-precondition", "CUSTOMER_METRICS_DISABLED");
  }
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
 * Record server mirror outcome into rideLocationReports (non-blocking for mirror path).
 * @param {import("firebase-admin/firestore").Firestore} db
 * @param {string} rideId
 * @param {{ mirrored?: boolean, reason?: string }} outcome
 */
async function recordServerMirrorOutcome(db, rideId, outcome = {}) {
  if (!rideId) return { ok: false, reason: "missing_ride_id" };
  const rideRef = db.collection("rides").doc(rideId);
  const reportRef = db.collection(REPORT_COLLECTION).doc(rideId);

  try {
    await db.runTransaction(async (tx) => {
      const rideSnap = await tx.get(rideRef);
      if (!rideSnap.exists) return;
      const ride = rideSnap.data() || {};
      const token = String(ride.assignmentSessionToken || "").trim();
      const tokenHash = hashAssignmentSessionTokenSync(token);
      if (!tokenHash) return;

      const reportSnap = await tx.get(reportRef);
      const configSnapshot = buildLocationReportingConfigSnapshot({});
      const report = reportSnap.exists
        ? { ...reportSnap.data() }
        : emptyReportDoc(rideId, tokenHash, configSnapshot);

      if (report.assignmentSessionTokenHash && report.assignmentSessionTokenHash !== tokenHash) {
        return;
      }

      const counterKey = mapMirrorReasonToCounter(outcome.reason, outcome.mirrored === true);
      const server = report.server || createEmptyServerSection();
      const counters = { ...(server.counters || {}) };
      counters.mirrorAttempts = (counters.mirrorAttempts || 0) + 1;
      counters[counterKey] = (counters[counterKey] || 0) + 1;

      const nowMs = Date.now();
      if (counterKey === "mirrorAccepted") {
        if (server.firstMirrorAtMs == null) server.firstMirrorAtMs = nowMs;
        server.lastMirrorAtMs = nowMs;
        if (server.lastEventAtMs != null && nowMs > server.lastEventAtMs) {
          const gap = nowMs - server.lastEventAtMs;
          server.longestGapMs =
            server.longestGapMs == null ? gap : Math.max(server.longestGapMs, gap);
        }
        server.lastEventAtMs = nowMs;
      }

      server.counters = counters;
      report.server = server;
      report.assignmentSessionTokenHash = tokenHash;
      report.lifecycle = lifecycleFromRide(ride);
      report.derived = computeDerivedMetrics(report);
      report.health = classifyReportHealth({ ...report, derived: report.derived });
      report.completeness = computeCompleteness(report);
      report.status = computeDocStatus(report, ride.status);
      report.updatedAt = FieldValue.serverTimestamp();

      if (report.status === "final" && !report.finalizedAt) {
        report.finalizedAt = FieldValue.serverTimestamp();
      }

      if (reportSnap.exists) tx.update(reportRef, report);
      else tx.set(reportRef, report);
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: String(e?.message || e).slice(0, 120) };
  }
}

/**
 * Trusted callable — driver or customer submits location report section.
 * @param {import("firebase-admin/firestore").Firestore} db
 * @param {{
 *   callerUid: string,
 *   rideId: string,
 *   role: "driver" | "customer",
 *   assignmentSessionTokenHash: string,
 *   section: object,
 *   submitSequence: number,
 *   finalSubmit?: boolean,
 * }} input
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

  const validated =
    role === "driver"
      ? validateDriverSubmitSection({ ...(input?.section || {}), submitSequence })
      : validateCustomerSubmitSection({ ...(input?.section || {}), submitSequence });
  if (!validated.ok) throw err("invalid-argument", String(validated.reason || "INVALID_SECTION").toUpperCase());

  const config = await readReportingConfig(db);
  if (config.enabled === false || config.uploadMode === "disabled") {
    return { ok: true, skipped: true, reason: "REPORTING_DISABLED" };
  }
  assertRoleMetricsEnabled(config, role);

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

    if (submitSequence < lastAccepted) {
      throw err("failed-precondition", "STALE_SUBMIT_SEQUENCE");
    }
    if (submitSequence === lastAccepted) {
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
    report.lifecycle = lifecycleFromRide(ride);
    report.derived = computeDerivedMetrics(report);
    report.health = classifyReportHealth({ ...report, derived: report.derived });
    report.completeness = computeCompleteness(report);
    report.status = computeDocStatus(report, ride.status);
    report.configSnapshot = configSnapshot;
    report.updatedAt = FieldValue.serverTimestamp();

    const retentionDays = config.retentionDays || 30;
    if (!report.expiresAt) {
      report.expiresAt = Timestamp.fromMillis(Date.now() + retentionDays * 24 * 60 * 60 * 1000);
    }

    const shouldFinalize =
      report.status === "final" ||
      (input.finalSubmit === true &&
        hasClientSection(report, "driver") &&
        hasClientSection(report, "customer"));
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
  hashAssignmentSessionTokenSync,
  lifecycleFromRide,
  computeCompleteness,
  computeDocStatus,
  mapMirrorReasonToCounter,
  recordServerMirrorOutcome,
  submitRideLocationReportSection,
};
