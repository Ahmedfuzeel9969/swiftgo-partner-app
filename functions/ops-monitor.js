/**
 * Phase 4F — structured ops logging + lightweight metric counters (Admin SDK).
 * Does not phone home to third-party SaaS; uses Cloud Logging + Firestore ops_metrics.
 */

"use strict";

const { FieldValue } = require("firebase-admin/firestore");

function logStructured(severity, event, fields = {}) {
  const payload = {
    severity: String(severity || "INFO").toUpperCase(),
    event,
    ts: new Date().toISOString(),
    ...fields,
  };
  const line = JSON.stringify(payload);
  if (payload.severity === "ERROR" || payload.severity === "CRITICAL") {
    console.error(line);
  } else if (payload.severity === "WARNING") {
    console.warn(line);
  } else {
    console.info(line);
  }
  return payload;
}

function dayKey(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

/**
 * Increment a daily counter. Never stores secrets/PINs.
 * @param {FirebaseFirestore.Firestore} db
 * @param {string} metric
 * @param {number} [by]
 */
async function bumpOpsMetric(db, metric, by = 1) {
  const key = String(metric || "").trim().slice(0, 80);
  if (!key) return;
  const ref = db.collection("ops_metrics").doc(`${dayKey()}_${key}`);
  await ref.set(
    {
      metric: key,
      day: dayKey(),
      count: FieldValue.increment(Number(by) || 1),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}

async function recordFunctionError(db, name, err) {
  logStructured("ERROR", "function_error", {
    function: name,
    code: err?.code || null,
    message: String(err?.message || err).slice(0, 300),
  });
  try {
    await bumpOpsMetric(db, `fn_error_${String(name).slice(0, 40)}`);
  } catch {
    /* metrics best-effort */
  }
}

async function recordSettlementFailure(db, rideId, reason) {
  logStructured("ERROR", "settlement_failure", {
    rideId: rideId ? String(rideId).slice(0, 80) : null,
    reason: String(reason || "").slice(0, 200),
  });
  try {
    await bumpOpsMetric(db, "settlement_failure");
  } catch {
    /* ignore */
  }
}

async function recordMatchingFailure(db, reason) {
  logStructured("WARNING", "matching_failure", {
    reason: String(reason || "").slice(0, 200),
  });
  try {
    await bumpOpsMetric(db, "matching_failure");
  } catch {
    /* ignore */
  }
}

async function recordAuthDenial(db, reason) {
  logStructured("WARNING", "auth_denial", {
    reason: String(reason || "").slice(0, 200),
  });
  try {
    await bumpOpsMetric(db, "auth_denial");
  } catch {
    /* ignore */
  }
}

/**
 * Detect duplicate settlement ledger id collisions (count only).
 */
async function countDuplicateLedgerIds(db, sampleLimit = 500) {
  const snap = await db.collection("ledger_transactions").limit(sampleLimit).get();
  const seen = new Map();
  let duplicates = 0;
  for (const doc of snap.docs) {
    const data = doc.data() || {};
    const logical = data.ledgerKey || data.rideId || doc.id;
    const n = (seen.get(logical) || 0) + 1;
    seen.set(logical, n);
    if (n === 2) duplicates += 1;
  }
  return { sampled: snap.size, duplicateKeys: duplicates };
}

/**
 * @param {FirebaseFirestore.Firestore} db
 */
async function getOpsHealthSummary(db) {
  const day = dayKey();
  const metricsSnap = await db
    .collection("ops_metrics")
    .where("day", "==", day)
    .limit(50)
    .get();
  const today = {};
  for (const doc of metricsSnap.docs) {
    const d = doc.data() || {};
    if (d.metric) today[d.metric] = d.count || 0;
  }
  const dup = await countDuplicateLedgerIds(db);
  return {
    ok: true,
    day,
    metricsToday: today,
    ledgerSample: dup,
    budgetNote:
      "DRAFT — Set Firebase/Blaze budget alerts in Google Cloud Billing. Not automated in-app.",
    runtimeNote: "See functions/package.json engines; Production runtime change needs deploy approval.",
  };
}

module.exports = {
  logStructured,
  bumpOpsMetric,
  recordFunctionError,
  recordSettlementFailure,
  recordMatchingFailure,
  recordAuthDenial,
  countDuplicateLedgerIds,
  getOpsHealthSummary,
};
