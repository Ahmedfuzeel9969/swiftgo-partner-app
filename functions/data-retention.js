/** Bounded, opt-in maintenance. Never deletes rides, profiles, money or audit history. */
"use strict";
const { createHash, randomUUID } = require("node:crypto");
const { FieldValue, FieldPath, Timestamp } = require("firebase-admin/firestore");
const { assertAdminInTransaction } = require("./admin-claims");
const { fail } = require("./security-policy");

const TERMINAL = new Set(["completed", "cancelled", "cancelled_by_customer", "cancelled_by_driver", "cancelled_by_admin", "expired", "no_driver_found"]);
const GROUPS = Object.freeze([
  "ridePeerSessions", "rideViewerPresence", "customerLocations", "peerCredentialIssues",
  "rideLocationReports", "rideBreadcrumbTelemetry", "booking_quotes", "driver_upload_tickets", "security_rate_limits",
]);
const DEFAULTS = Object.freeze({ expiryEnabled: false, purgeEnabled: false, policyVersion: "", batchLimit: 25 });
const ms = (v) => v instanceof Date ? v.getTime() : v?.toMillis?.() ?? null;
function normalizeRetentionPolicy(raw = {}) {
  return { expiryEnabled: raw.expiryEnabled === true, purgeEnabled: raw.purgeEnabled === true,
    policyVersion: typeof raw.policyVersion === "string" && /^[A-Za-z0-9_-]{3,64}$/.test(raw.policyVersion) ? raw.policyVersion : "",
    batchLimit: Number.isInteger(raw.batchLimit) && raw.batchLimit >= 1 && raw.batchLimit <= 50 ? raw.batchLimit : 25 };
}
async function saveRetentionPolicy(db, auth, input) {
  if (!input || Object.keys(input).some((k) => !Object.hasOwn(DEFAULTS, k)) ||
      typeof input.expiryEnabled !== "boolean" || typeof input.purgeEnabled !== "boolean" ||
      !Number.isInteger(input.batchLimit) || input.batchLimit < 1 || input.batchLimit > 50 ||
      typeof input.policyVersion !== "string" || (input.policyVersion !== "" && !/^[A-Za-z0-9_-]{3,64}$/.test(input.policyVersion)))
    fail("invalid-argument", "INVALID_RETENTION_POLICY");
  if ((input.expiryEnabled || input.purgeEnabled) && !input.policyVersion) fail("failed-precondition", "POLICY_APPROVAL_REQUIRED");
  await db.runTransaction(async (tx) => {
    await assertAdminInTransaction(tx, db, auth);
    tx.set(db.doc("settings/dataRetention"), { ...input, updatedAt: FieldValue.serverTimestamp(), updatedBy: auth.uid });
    tx.create(db.collection("audit_logs").doc(), { action: "retention_policy_saved", actorUid: auth.uid,
      policyVersion: input.policyVersion, expiryEnabled: input.expiryEnabled, purgeEnabled: input.purgeEnabled, at: FieldValue.serverTimestamp() });
  });
  return { ok: true, policy: input, schedulerRequiresSeparateDeployment: true };
}
function retentionTarget(path, data) {
  const parts = path.split("/");
  if (parts.length === 4 && parts[0] === "rides" && ["customerLocations", "peerCredentialIssues"].includes(parts[2]))
    return { group: parts[2], rideId: parts[1], requiresTerminal: false };
  if (parts.length !== 2 || !GROUPS.includes(parts[0]) || ["customerLocations", "peerCredentialIssues"].includes(parts[0])) return null;
  const group = parts[0];
  const rideId = ["rideLocationReports", "rideBreadcrumbTelemetry", "ridePeerSessions"].includes(group) ? parts[1] :
    group === "rideViewerPresence" ? data.rideId : null;
  return { group, rideId, requiresTerminal: ["rideLocationReports", "rideBreadcrumbTelemetry"].includes(group) };
}
function expirationDecision(path, data, ride, now) {
  const target = retentionTarget(path, data);
  if (!target) return { eligible: false, reason: "unapproved_path" };
  const deadline = ms(data.expiresAt);
  if (!Number.isFinite(deadline) || deadline <= 0 || deadline > now) return { eligible: false, reason: "not_due" };
  if (data.legalHold === true || ride?.legalHold === true) return { eligible: false, reason: "legal_hold" };
  // Unknown parent/state is NOT permission to delete accounting-adjacent telemetry.
  if (target.requiresTerminal && (!ride || !TERMINAL.has(ride.status))) return { eligible: false, reason: "ride_not_terminal" };
  return { eligible: true, target, deadline };
}
async function purgeExpiredTransientData(db, { dryRun = true, allowMutation = false, nowMs = Date.now(), limit, groups = GROUPS } = {}) {
  if (!Array.isArray(groups) || !groups.length || groups.some((g) => !GROUPS.includes(g)) || new Set(groups).size !== groups.length)
    fail("invalid-argument", "INVALID_RETENTION_GROUP");
  if (typeof dryRun !== "boolean" || !Number.isSafeInteger(nowMs) || nowMs <= 0) fail("invalid-argument", "INVALID_RETENTION_RUN");
  const config = normalizeRetentionPolicy((await db.doc("settings/dataRetention").get()).data());
  if (!dryRun && (allowMutation !== true || !config.purgeEnabled || !config.policyVersion)) fail("failed-precondition", "PURGE_NOT_APPROVED");
  const budget = limit ?? config.batchLimit;
  if (!Number.isInteger(budget) || budget < 1 || budget > 50) fail("invalid-argument", "INVALID_RETENTION_LIMIT");
  const result = { dryRun, scanned: 0, eligible: 0, deleted: 0, skipped: 0, failed: 0, truncated: false, groups: {} };
  for (const group of groups) {
    // No broad fallback on index/permission errors. Missing indexes must be repaired explicitly.
    let query = ["customerLocations", "peerCredentialIssues"].includes(group) ? db.collectionGroup(group) : db.collection(group);
    const cursorRef = db.doc(`maintenance_cursors/${group}`);
    const cursor = dryRun ? null : (await cursorRef.get()).data();
    query = query.where("expiresAt", "<=", Timestamp.fromMillis(nowMs)).orderBy("expiresAt").orderBy(FieldPath.documentId());
    if (cursor?.path && Number.isFinite(ms(cursor.expiresAt)) && retentionTarget(cursor.path, {})?.group === group)
      query = query.startAfter(cursor.expiresAt, db.doc(cursor.path));
    // Per-category cap prevents busy signaling from starving reports/other categories.
    const snap = await query.limit(budget).get();
    if (snap.size === budget) result.truncated = true;
    result.groups[group] = { scanned: snap.size, deleted: 0 };
    for (const candidate of snap.docs) {
      result.scanned++;
      try {
        const outcome = await db.runTransaction(async (tx) => {
          const current = await tx.get(candidate.ref);
          if (!current.exists) return "skipped";
          const data = current.data(), target = retentionTarget(candidate.ref.path, data);
          const ride = target?.rideId && /^[A-Za-z0-9_-]{1,128}$/.test(target.rideId) ?
            (await tx.get(db.doc(`rides/${target.rideId}`))).data() : null;
          const decision = expirationDecision(candidate.ref.path, data, ride, nowMs);
          if (!decision.eligible) return "skipped";
          if (dryRun) return "eligible";
          const live = normalizeRetentionPolicy((await tx.get(db.doc("settings/dataRetention"))).data());
          if (!live.purgeEnabled || live.policyVersion !== config.policyVersion) return "skipped";
          const hash = createHash("sha256").update(`${candidate.ref.path}|${decision.deadline}`).digest("hex");
          tx.delete(candidate.ref);
          // Atomic proof: no deleted coordinates, SDP, tokens, email or raw path in audit.
          tx.set(db.doc(`retention_events/${hash}`), { category: target.group, subjectHash: hash,
            expiredAt: data.expiresAt, deletedAt: FieldValue.serverTimestamp(), policyVersion: live.policyVersion });
          return "deleted";
        });
        if (outcome === "eligible" || outcome === "deleted") result.eligible++;
        if (outcome === "deleted") { result.deleted++; result.groups[group].deleted++; }
        if (outcome === "skipped") result.skipped++;
      } catch { result.failed++; }
    }
    if (!dryRun) {
      const last = snap.size === budget ? snap.docs.at(-1) : null;
      // Held/active records cannot permanently starve later eligible records.
      // Wrap on the final page; crash/retry remains safe because deletion is idempotent.
      await cursorRef.set({ path: last?.ref.path || null, expiresAt: last?.data().expiresAt || null, updatedAt: FieldValue.serverTimestamp() });
    }
  }
  if (!dryRun) await db.doc(`retention_runs/${randomUUID()}`).set({ ...result, at: FieldValue.serverTimestamp(), policyVersion: config.policyVersion });
  return result;
}
async function runRetentionMaintenance(db, { allowMutation = false, nowMs = Date.now() } = {}) {
  if (allowMutation !== true) return { skipped: true, reason: "MAINTENANCE_NOT_ENABLED" };
  if (!Number.isSafeInteger(nowMs) || nowMs <= 0) fail("invalid-argument", "INVALID_RETENTION_RUN");
  const policy = normalizeRetentionPolicy((await db.doc("settings/dataRetention").get()).data());
  if (!policy.policyVersion || (!policy.expiryEnabled && !policy.purgeEnabled)) return { skipped: true, reason: "POLICY_NOT_ENABLED" };
  const leaseRef = db.doc("maintenance_leases/retention"), runId = randomUUID();
  const acquired = await db.runTransaction(async (tx) => {
    const lease = (await tx.get(leaseRef)).data();
    if ((ms(lease?.expiresAt) || 0) > nowMs) return false;
    tx.set(leaseRef, { runId, expiresAt: new Date(nowMs + 9 * 60000) }); return true;
  });
  if (!acquired) return { skipped: true, reason: "RUN_IN_PROGRESS" };
  const result = {};
  try {
    if (policy.expiryEnabled) {
      const { expireDueSearchingBookings, expireDueRideOffers } = require("./bargaining");
      result.searches = await expireDueSearchingBookings(db, { nowMs, limit: policy.batchLimit, strictIndex: true });
      result.offers = await expireDueRideOffers(db, { nowMs, limit: policy.batchLimit, strictIndex: true });
    }
    if (policy.purgeEnabled) {
      result.purge = await purgeExpiredTransientData(db, { nowMs, dryRun: false, allowMutation: true });
      result.liveFields = await retireTerminalLiveFields(db, { nowMs, dryRun: false, allowMutation: true });
    }
    return result;
  } finally {
    await db.runTransaction(async (tx) => {
      if ((await tx.get(leaseRef)).data()?.runId === runId) tx.update(leaseRef, { expiresAt: new Date(0) });
    });
  }
}
async function retireTerminalLiveFields(db, { nowMs = Date.now(), dryRun = true, allowMutation = false } = {}) {
  if (typeof dryRun !== "boolean" || !Number.isSafeInteger(nowMs) || nowMs <= 0) fail("invalid-argument", "INVALID_RETENTION_RUN");
  const policy = normalizeRetentionPolicy((await db.doc("settings/dataRetention").get()).data());
  if (!dryRun && (allowMutation !== true || !policy.purgeEnabled || !policy.policyVersion)) fail("failed-precondition", "PURGE_NOT_APPROVED");
  const cursorRef = db.doc("maintenance_cursors/terminal_live_fields");
  const cursor = dryRun ? null : (await cursorRef.get()).data();
  let query = db.collection("rides").where("liveLocationRetireAt", "<=", new Date(nowMs))
    .orderBy("liveLocationRetireAt").orderBy(FieldPath.documentId());
  if (/^rides\/[A-Za-z0-9_-]{1,128}$/.test(cursor?.path || "") && Number.isFinite(ms(cursor.liveLocationRetireAt)))
    query = query.startAfter(cursor.liveLocationRetireAt, db.doc(cursor.path));
  const candidates = await query.limit(policy.batchLimit).get();
  let retired = 0, eligible = 0, failed = 0;
  for (const candidate of candidates.docs) {
    try {
      const outcome = await db.runTransaction(async (tx) => {
        const [snap, currentPolicy, telemetry] = await Promise.all([tx.get(candidate.ref), tx.get(db.doc("settings/dataRetention")),
          tx.get(db.doc(`rideBreadcrumbTelemetry/${candidate.id}`))]);
        const ride = snap.data(), live = normalizeRetentionPolicy(currentPolicy.data());
        if (!ride || !TERMINAL.has(ride.status) || ride.legalHold === true || !ms(ride.liveLocationRetireAt) || ms(ride.liveLocationRetireAt) > nowMs) return false;
        if (dryRun) return true;
        if (!live.purgeEnabled || !live.policyVersion || live.policyVersion !== policy.policyVersion) return false;
        tx.update(candidate.ref, { driverLocation: FieldValue.delete(), driverLocationUpdatedAt: FieldValue.delete(),
          driverTrackingSessionId: FieldValue.delete(), driverTrackingSessionStartedAt: FieldValue.delete(), lastTrackedLocation: FieldValue.delete(),
          liveLocationRetireAt: FieldValue.delete(), liveLocationRetiredAt: FieldValue.serverTimestamp() });
        if (telemetry.exists && telemetry.data().legalHold !== true) tx.update(telemetry.ref, { lastAcceptedRawPoint: FieldValue.delete(),
          lastDistanceAnchor: FieldValue.delete(), assignmentSessionToken: FieldValue.delete(), trackingSessionId: FieldValue.delete() });
        const hash = createHash("sha256").update(`live-fields|${candidate.id}`).digest("hex");
        tx.set(db.doc(`retention_events/${hash}`), { category: "terminal_live_fields", subjectHash: hash,
          policyVersion: live.policyVersion, deletedAt: FieldValue.serverTimestamp() });
        return true;
      });
      if (outcome) { eligible++; if (!dryRun) retired++; }
    } catch { failed++; }
  }
  if (!dryRun) {
    const last = candidates.size === policy.batchLimit ? candidates.docs.at(-1) : null;
    // Legal holds and failed transactions must not pin every run to page one.
    await cursorRef.set({ path: last?.ref.path || null, liveLocationRetireAt: last?.data().liveLocationRetireAt || null,
      updatedAt: FieldValue.serverTimestamp() });
  }
  return { dryRun, scanned: candidates.size, eligible, retired, failed, truncated: candidates.size === policy.batchLimit };
}
module.exports = { GROUPS, DEFAULTS, TERMINAL, normalizeRetentionPolicy, saveRetentionPolicy, retentionTarget, expirationDecision,
  purgeExpiredTransientData, retireTerminalLiveFields, runRetentionMaintenance };
