"use strict";
const { createHash } = require("node:crypto");
const { FieldValue, Timestamp } = require("firebase-admin/firestore");

function fail(code, message) { const error = new Error(message); error.code = code; throw error; }
function documentId(value, label = "ID") {
  if (typeof value !== "string" || !value || value.length > 128 || value.includes("/") || /[\x00-\x1f]/.test(value)) {
    fail("invalid-argument", `INVALID_${label}`);
  }
  return value;
}
function driverApproved(partner) {
  return Boolean(partner && ["driver", "owner"].includes(partner.role) &&
    partner.accountStatus === "active" && partner.driverApprovalStatus === "approved");
}
function requireApprovedDriver(partner) {
  if (!driverApproved(partner)) fail("permission-denied", "DRIVER_APPROVAL_REQUIRED");
}
function money(value, label = "AMOUNT", maximum = 500000, minimum = 1) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum || !Number.isInteger(value)) {
    fail("invalid-argument", `INVALID_${label}`);
  }
  return value;
}
const digest = (value) => createHash("sha256").update(String(value)).digest("hex");

/** Atomic fixed window: concurrent attempts consume quota before sensitive work. */
async function takeRateLimit(db, scope, identity, { limit = 10, windowMs = 60000, now = Date.now() } = {}) {
  const ref = db.collection("security_rate_limits").doc(`${scope}_${digest(identity)}`);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const prior = snap.exists ? snap.data() : {};
    const active = Number(prior.resetAtMs) > now;
    const count = active ? Number(prior.count || 0) : 0;
    if (count >= limit) fail("resource-exhausted", "TOO_MANY_REQUESTS");
    const resetAtMs = active ? prior.resetAtMs : now + windowMs;
    tx.set(ref, { count: count + 1, resetAtMs, expiresAt: Timestamp.fromMillis(resetAtMs + windowMs), updatedAt: FieldValue.serverTimestamp() });
  });
}
module.exports = { fail, documentId, driverApproved, requireApprovedDriver, money, digest, takeRateLimit };
