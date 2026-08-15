/**
 * Super Admin — per-ride location report detail panel (read-only, no coordinates).
 */
import {
  computeDerivedMetrics,
  classifyReportHealth,
  computeLifecycleDurations,
  DRIVER_COUNTER_KEYS,
  SERVER_COUNTER_KEYS,
  CUSTOMER_COUNTER_KEYS,
  FORBIDDEN_REPORT_PAYLOAD_KEYS,
} from "./ride-location-report-schema.mjs";

export const RIDE_LOCATION_REPORT_COLLECTION = "rideLocationReports";

const COMPLETENESS_LABELS = Object.freeze({
  complete: "مکمل / Complete",
  partial_both_clients: "جزوی · دونوں کلائنٹ (سرور نہیں)",
  partial_driver_only: "جزوی · صرف ڈرائیور",
  partial_customer_only: "جزوی · صرف کسٹمر",
  server_only: "صرف سرور",
  missing: "رپورٹ نہیں / Missing",
});

const HEALTH_LABELS = Object.freeze({
  healthy: "صحت مند / Healthy",
  warning: "انتباہ / Warning",
  critical: "تشویشناک / Critical",
  insufficient_data: "ڈیٹا ناکافی / Insufficient",
});

const COUNTER_LABELS = Object.freeze({
  gpsFixesReceived: "GPS fixes received",
  validFixesAccepted: "Valid fixes accepted",
  duplicateOrOutOfOrderRejected: "Duplicate/out-of-order rejected",
  vehicleWritesAttempted: "Vehicle writes attempted",
  vehicleWritesAcknowledged: "Vehicle writes acknowledged",
  vehicleWritesFailed: "Vehicle writes failed",
  p2pSessionsStarted: "P2P sessions started",
  p2pChannelsOpened: "P2P channels opened",
  p2pFramesAttempted: "P2P frames attempted",
  p2pFramesSent: "P2P frames sent",
  p2pFramesAcknowledged: "P2P acknowledgements received",
  p2pFramesRejected: "P2P frames rejected",
  p2pSendFailures: "P2P send failures",
  p2pHealthySessionCount: "P2P verified healthy sessions",
  p2pDegradedOrFallbackTransitions: "P2P degraded/fallback transitions",
  mirrorAttempts: "Mirror attempts",
  mirrorAccepted: "Mirror accepted",
  mirrorSkippedInvalid: "Mirror skipped (invalid)",
  mirrorSkippedInactive: "Mirror skipped (inactive)",
  mirrorSkippedSessionMismatch: "Mirror skipped (session mismatch)",
  mirrorSkippedDuplicate: "Mirror skipped (duplicate)",
  mirrorSkippedOutOfOrder: "Mirror skipped (out-of-order)",
  mirrorSkippedNoop: "Mirror skipped (noop)",
  mirrorFailed: "Mirror failed",
  firebaseSnapshotsReceived: "Firebase snapshots received",
  firebaseValidRendered: "Firebase valid rendered",
  p2pSessionsStarted: "P2P sessions started",
  p2pChannelsOpened: "P2P channels opened",
  p2pHealthySessionCount: "P2P verified healthy sessions",
  p2pFramesReceived: "P2P frames received",
  p2pValidRendered: "P2P valid rendered",
  staleRejected: "Stale rejected",
  duplicateRejected: "Duplicate rejected",
  rollbackRejected: "Rollback rejected",
  sourceSwitchP2pToFirebase: "Source switch P2P → Firebase",
  sourceSwitchFirebaseToP2p: "Source switch Firebase → P2P",
});

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function hasClientSection(report, role) {
  const section = role === "driver" ? report?.driver : report?.customer;
  const seq = section?.lastAcceptedSequence || section?.submitSequence || 0;
  return seq >= 1;
}

function hasServerSection(report) {
  return (report?.server?.counters?.mirrorAttempts || 0) > 0;
}

export function computeReportCompleteness(report = {}) {
  const driver = hasClientSection(report, "driver");
  const customer = hasClientSection(report, "customer");
  const server = hasServerSection(report);
  if (driver && customer && server) return "complete";
  if (driver && customer) return "partial_both_clients";
  if (driver) return "partial_driver_only";
  if (customer) return "partial_customer_only";
  if (server) return "server_only";
  return "missing";
}

function timestampToMs(value) {
  if (value == null) return null;
  if (typeof value?.toMillis === "function") return value.toMillis();
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

export function formatReportDurationMs(ms) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${ms} ms`;
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec} s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return sec ? `${min}m ${sec}s` : `${min}m`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return remMin ? `${hr}h ${remMin}m` : `${hr}h`;
}

export function formatReportTimestampMs(ms) {
  if (ms == null || !Number.isFinite(ms)) return "—";
  try {
    return new Intl.DateTimeFormat("ur-PK", {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(new Date(ms));
  } catch {
    return "—";
  }
}

function formatRatio(value) {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${Math.round(value * 1000) / 10}%`;
}

function counterRows(keys, counters = {}, legacyHints = {}) {
  return keys.map((key) => ({
    key,
    label: legacyHints[key] || COUNTER_LABELS[key] || key,
    value: Number.isInteger(counters[key]) ? counters[key] : 0,
  }));
}

function assertNoForbiddenKeys(value, path = "report") {
  if (value == null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoForbiddenKeys(item, `${path}[${index}]`));
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_REPORT_PAYLOAD_KEYS.includes(key)) {
      throw new Error(`forbidden_key:${key}`);
    }
    assertNoForbiddenKeys(nested, `${path}.${key}`);
  }
}

/**
 * @param {object|null} report Firestore rideLocationReports doc
 * @param {{ rideId?: string, ride?: object, rideStatus?: string }} meta
 */
export function buildRideLocationReportViewModel(report, meta = {}) {
  const rideId = String(meta.rideId || report?.rideId || "").trim();
  const ride = meta.ride || {};
  const rideStatus = String(meta.rideStatus || ride.status || "").trim();

  if (!report) {
    return {
      rideId,
      rideStatus,
      found: false,
      completeness: "missing",
      completenessLabel: COMPLETENESS_LABELS.missing,
      health: { status: "insufficient_data", reasons: ["report_not_found"] },
      healthLabel: HEALTH_LABELS.insufficient_data,
      lifecycle: lifecycleFromRide(ride),
      driver: [],
      server: [],
      customer: [],
      derived: null,
      configSnapshot: null,
      docStatus: "open",
    };
  }

  assertNoForbiddenKeys(report);

  const sections = {
    driver: report.driver || {},
    server: report.server || {},
    customer: report.customer || {},
  };
  const driverCounters = sections.driver.counters || {};
  const customerCounters = sections.customer.counters || {};
  const driverLegacy = {};
  const customerLegacy = {};
  if (driverCounters.p2pSessionsStarted == null && Number(driverCounters.p2pHealthySessionCount) > 0) {
    driverLegacy.p2pHealthySessionCount =
      "P2P sessions started (legacy field — unverified health)";
  }
  if (customerCounters.p2pSessionsStarted == null && Number(customerCounters.p2pHealthySessionCount) > 0) {
    customerLegacy.p2pHealthySessionCount =
      "P2P sessions started (legacy field — unverified health)";
  }
  const derived = report.derived || computeDerivedMetrics(sections);
  const health = report.health || classifyReportHealth({ ...sections, derived });
  const completeness = report.completeness || computeReportCompleteness(report);
  const lifecycle =
    report.lifecycle && typeof report.lifecycle === "object"
      ? { ...report.lifecycle }
      : lifecycleFromRide(ride);

  return {
    rideId,
    rideStatus,
    found: true,
    completeness,
    completenessLabel: COMPLETENESS_LABELS[completeness] || completeness,
    health,
    healthLabel: HEALTH_LABELS[health.status] || health.status,
    lifecycle,
    driver: counterRows(DRIVER_COUNTER_KEYS, driverCounters, driverLegacy),
    server: counterRows(SERVER_COUNTER_KEYS, sections.server.counters),
    customer: counterRows(CUSTOMER_COUNTER_KEYS, customerCounters, customerLegacy),
    derived,
    configSnapshot: report.configSnapshot || null,
    docStatus: report.status || "open",
    tokenHashPrefix: String(report.assignmentSessionTokenHash || "").slice(0, 12),
  };
}

function renderCounterTable(rows) {
  if (!rows.length) {
    return `<p class="location-report-empty">کوئی counter نہیں</p>`;
  }
  const body = rows
    .map(
      (row) => `
      <tr>
        <th scope="row">${escapeHtml(row.label)}</th>
        <td><strong>${escapeHtml(String(row.value))}</strong></td>
      </tr>`
    )
    .join("");
  return `
    <table class="location-report-table">
      <tbody>${body}</tbody>
    </table>`;
}

function renderLifecycleSection(lifecycle) {
  const items = [
    ["بکنگ بنی", formatReportTimestampMs(lifecycle.bookingCreatedAtMs)],
    ["میچ مکمل", formatReportTimestampMs(lifecycle.matchedAtMs)],
    ["ڈرائیور assigned", formatReportTimestampMs(lifecycle.assignedAtMs)],
    ["ڈرائیور پہنچا", formatReportTimestampMs(lifecycle.driverArrivedAtMs)],
    ["سفر شروع", formatReportTimestampMs(lifecycle.tripStartedAtMs)],
    ["سیٹلمنٹ", formatReportTimestampMs(lifecycle.settledAtMs)],
    ["بکنگ → assignment", formatReportDurationMs(lifecycle.bookingToAssignmentMs)],
    ["ڈرائیور approach", formatReportDurationMs(lifecycle.driverApproachMs)],
    ["in_progress مدت", formatReportDurationMs(lifecycle.inProgressMs)],
    ["کل lifecycle", formatReportDurationMs(lifecycle.totalLifecycleMs)],
  ];
  const rows = items
    .map(
      ([label, value]) => `
      <tr>
        <th scope="row">${escapeHtml(label)}</th>
        <td>${escapeHtml(value)}</td>
      </tr>`
    )
    .join("");
  return `
    <section class="location-report-section">
      <h3>سواری lifecycle</h3>
      <table class="location-report-table">
        <tbody>${rows}</tbody>
      </table>
    </section>`;
}

function renderDerivedSection(derived) {
  if (!derived) return "";
  const ratios = derived.deliveryRatios || {};
  const rows = [
    ["اوسط GPS وقفہ", formatReportDurationMs(derived.avgDriverGpsIntervalMs)],
    ["اوسط Firebase write", formatReportDurationMs(derived.avgFirebaseWriteIntervalMs)],
    ["اوسط mirror وقفہ", formatReportDurationMs(derived.avgMirrorIntervalMs)],
    ["اوسط customer Firebase receive", formatReportDurationMs(derived.avgCustomerFirebaseReceiveIntervalMs)],
    ["اوسط P2P receive", formatReportDurationMs(derived.avgP2pReceiveIntervalMs)],
    ["اوسط map refresh", formatReportDurationMs(derived.avgMapRefreshIntervalMs)],
    ["Mirror/GPS ratio", formatRatio(ratios.mirrorToGps)],
    ["Customer Firebase/Mirror", formatRatio(ratios.customerFirebaseToMirror)],
    ["Customer P2P/Sent", formatRatio(ratios.customerP2pToSent)],
    ["Rendered/Received", formatRatio(ratios.renderedToReceived)],
  ]
    .map(
      ([label, value]) => `
      <tr>
        <th scope="row">${escapeHtml(label)}</th>
        <td>${escapeHtml(value)}</td>
      </tr>`
    )
    .join("");
  return `
    <section class="location-report-section">
      <h3>Derived metrics</h3>
      <table class="location-report-table">
        <tbody>${rows}</tbody>
      </table>
    </section>`;
}

export function renderRideLocationReportPanelHtml(viewModel) {
  if (!viewModel?.found) {
    return `
      <div class="location-report-empty-state" role="status">
        <p><strong>اس سواری کے لیے location report دستیاب نہیں۔</strong></p>
        <p class="location-report-empty-state__hint">
          رپورٹ سواری مکمل/terminal ہونے پر ride_end flush سے بنتی ہے، یا server mirror counters سے جزوی ہو سکتی ہے۔
        </p>
      </div>`;
  }

  const healthClass = `location-report-pill location-report-pill--${escapeHtml(viewModel.health?.status || "insufficient_data")}`;
  const reasons =
    Array.isArray(viewModel.health?.reasons) && viewModel.health.reasons.length
      ? `<p class="location-report-reasons">${escapeHtml(viewModel.health.reasons.join(" · "))}</p>`
      : "";

  const configLine = viewModel.configSnapshot
    ? `<p class="location-report-meta">Config snapshot: ${escapeHtml(viewModel.configSnapshot.uploadMode || "—")} · retention ${escapeHtml(String(viewModel.configSnapshot.retentionDays ?? "—"))}d</p>`
    : "";

  return `
    <div class="location-report-summary">
      <div class="location-report-badges">
        <span class="location-report-pill location-report-pill--completeness">${escapeHtml(viewModel.completenessLabel)}</span>
        <span class="${healthClass}">${escapeHtml(viewModel.healthLabel)}</span>
        <span class="location-report-pill location-report-pill--neutral">${escapeHtml(viewModel.docStatus)}</span>
      </div>
      ${reasons}
      <p class="location-report-meta">
        Ride <code>${escapeHtml(viewModel.rideId)}</code>
        · token hash <code>${escapeHtml(viewModel.tokenHashPrefix || "—")}…</code>
        · ride status ${escapeHtml(viewModel.rideStatus || "—")}
      </p>
      ${configLine}
    </div>
    ${renderLifecycleSection(viewModel.lifecycle)}
    <section class="location-report-section">
      <h3>Driver counters</h3>
      ${renderCounterTable(viewModel.driver)}
    </section>
    <section class="location-report-section">
      <h3>Server / Firebase counters</h3>
      ${renderCounterTable(viewModel.server)}
    </section>
    <section class="location-report-section">
      <h3>Customer counters</h3>
      ${renderCounterTable(viewModel.customer)}
    </section>
    ${renderDerivedSection(viewModel.derived)}
    <p class="location-report-footnote" role="note">
      تشخیصی counters only — coordinates، tokens، یا PII یہاں نہیں دکھائے جاتے۔
    </p>`;
}
