"use strict";
const TERMINAL = new Set(["completed", "cancelled", "cancelled_by_customer", "cancelled_by_driver", "cancelled_by_admin", "expired", "no_driver_found"]);
const timestampMs = (v) => v instanceof Date ? v.getTime() : v?.toMillis?.() ?? null;
function terminalAtMs(ride) {
  const values = [ride.closedAt, ride.settledAt, ride.cancelledAt, ride.expiredAt].map(timestampMs).filter((n) => Number.isFinite(n) && n > 0);
  return values.length ? Math.max(...values) : null;
}
function reportRetentionDeadline(ride, report, days, nowMs) {
  if (!Number.isInteger(days) || days < 7 || days > 90) days = 30;
  const anchor = (TERMINAL.has(ride.status) ? terminalAtMs(ride) : null) || timestampMs(report.createdAt) || nowMs;
  const deadline = anchor + days * 86400000, existing = timestampMs(report.expiresAt);
  return new Date(Number.isFinite(existing) && existing > 0 ? Math.min(existing, deadline) : deadline);
}
function reportRetentionWindowClosed(ride, days, nowMs) {
  const endedAt = terminalAtMs(ride);
  return TERMINAL.has(ride.status) && endedAt !== null && nowMs >= endedAt + days * 86400000;
}
module.exports = { TERMINAL, timestampMs, terminalAtMs, reportRetentionDeadline, reportRetentionWindowClosed };
