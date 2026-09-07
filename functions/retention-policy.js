"use strict";
// Owner-approved business policy, not a claim that incorporation/legal review is complete.
const POLICY = Object.freeze({ version: "company-retention-2026-08-28-v1", financialYears: 10,
  financialYearEndMonth: 6, financialYearEndDay: 30, timeZone: "Asia/Karachi",
  approvedIdentityYearsAfterClosure: 1, rejectedIdentityDays: 90, personalDataDays: 30,
  registrationStatus: "not_recorded", financialDisposition: "review_after_minimum_not_automatic_deletion" });
const DAY = 86400000;
function millis(value) {
  const n = value instanceof Date ? value.getTime() : typeof value?.toMillis === "function" ? value.toMillis() : value;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}
function clock(value) { const n = millis(value); if (!n) throw new Error("INVALID_RETENTION_CLOCK"); return n; }
function afterDays(value, days) { return new Date(clock(value) + days * DAY); }
function afterYear(value) {
  // Calendar anniversary uses the policy's Karachi date, including midnight
  // where the UTC day/month may still be the previous one.
  const offset = 300 * 60000;
  const date = new Date(clock(value) + offset), day = date.getUTCDate();
  date.setUTCDate(1); date.setUTCFullYear(date.getUTCFullYear() + 1);
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, lastDay)); return new Date(date.getTime() - offset);
}
function financialRetention(at) {
  const local = new Date(clock(at) + 300 * 60000);
  const endYear = local.getUTCFullYear() + (local.getUTCMonth() >= 6 ? 1 : 0);
  return { retentionPolicyVersion: POLICY.version, financialYearEnd: `${endYear}-06-30`,
    retainFinancialUntil: new Date(Date.UTC(endYear + POLICY.financialYears, 6, 1) - 300 * 60000),
    financialDisposition: "review_after_minimum_not_automatic_deletion" };
}
function closureRetention(at) {
  return { retentionPolicyVersion: POLICY.version, accountClosedAt: new Date(clock(at)),
    personalDataDueAt: afterDays(at, POLICY.personalDataDays), approvedIdentityDueAt: afterYear(at) };
}
function identityDueAt(application, request = {}) {
  if (["rejected", "withdrawn"].includes(application?.status)) {
    const at = millis(application.reviewedAt) || millis(application.rejectedAt) || millis(application.withdrawnAt);
    return at ? afterDays(at, POLICY.rejectedIdentityDays) : null;
  }
  const closed = request.accessBlocked === true && millis(request.accountClosedAt);
  if (application?.status === "approved") return closed ? afterYear(closed) : null;
  // An unfinished application becomes withdrawn when its account closes.
  if (application?.status === "pending") return closed ? afterDays(closed, POLICY.rejectedIdentityDays) : null;
  return null;
}
function isApprovedPolicy(raw) { return raw?.purgeEnabled === true && raw?.policyVersion === POLICY.version; }
module.exports = { POLICY, DAY, millis, clock, afterDays, afterYear, financialRetention, closureRetention, identityDueAt, isApprovedPolicy };
