import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const { POLICY, DAY, millis, clock, afterYear, closureRetention, identityDueAt, financialRetention, isApprovedPolicy } = require("../functions/retention-policy.js");
const { profileTombstone, executeAccountDispositionPage, SCOPES } = require("../functions/account-disposition.js");
const { proofTargets, disposeIdentityRecord } = require("../functions/identity-disposition.js");
const { requirePhaseSixEmulators, PROJECT } = await import("./helpers/phase-six-safety.mjs");
const at = Date.parse("2026-08-28T12:00:00Z");
test("approved policy is immutable and does not invent incorporation", () => {
  assert.equal(Object.isFrozen(POLICY), true); assert.equal(POLICY.registrationStatus, "not_recorded");
  assert.equal(POLICY.financialYears, 10); assert.equal(POLICY.rejectedIdentityDays, 90); assert.equal(POLICY.personalDataDays, 30);
});
test("financial retention uses end of financial year in Karachi, not transaction anniversary", () => {
  const before = financialRetention(Date.parse("2026-06-30T18:59:59.999Z"));
  const after = financialRetention(Date.parse("2026-06-30T19:00:00.000Z"));
  assert.equal(before.financialYearEnd, "2026-06-30"); assert.equal(before.retainFinancialUntil.toISOString(), "2036-06-30T19:00:00.000Z");
  assert.equal(after.financialYearEnd, "2027-06-30"); assert.equal(after.retainFinancialUntil.toISOString(), "2037-06-30T19:00:00.000Z");
});
test("calendar year after leap-day closure clamps to February 28", () => {
  assert.equal(afterYear(Date.parse("2024-02-29T12:30:00Z")).toISOString(), "2025-02-28T12:30:00.000Z");
  assert.equal(afterYear(at).toISOString(), "2027-08-28T12:00:00.000Z");
});
test("calendar-year anniversary uses local leap day at Karachi midnight", () => {
  assert.equal(afterYear(Date.parse("2024-02-28T19:30:00Z")).toISOString(), "2025-02-27T19:30:00.000Z");
  assert.equal(afterYear(Date.parse("2024-02-29T19:30:00Z")).toISOString(), "2025-02-28T19:30:00.000Z");
});
test("personal and identity deadlines have separate anchors", () => {
  const c = closureRetention(at); assert.equal(c.personalDataDueAt.getTime(), at + 30 * DAY);
  assert.equal(c.approvedIdentityDueAt.getTime(), afterYear(at).getTime());
  assert.equal(identityDueAt({ status: "approved" }, { ...c, accessBlocked: true }).getTime(), c.approvedIdentityDueAt.getTime());
  assert.equal(identityDueAt({ status: "approved" }, {}), null);
  assert.equal(identityDueAt({ status: "pending" }, { ...c, accessBlocked: true }).getTime(), at + 90 * DAY);
});
test("rejected and withdrawn identity use decision, never last update or forged due date", () => {
  assert.equal(identityDueAt({ status: "rejected", reviewedAt: new Date(at), identityDueAt: new Date(at - DAY) }).getTime(), at + 90 * DAY);
  assert.equal(identityDueAt({ status: "withdrawn", withdrawnAt: new Date(at) }).getTime(), at + 90 * DAY);
  assert.equal(identityDueAt({ status: "rejected", updatedAt: new Date(at) }), null);
});
test("invalid clocks are never deletion authority", () => {
  for (const value of [0, -1, NaN, Infinity, "2026-08-28", {}, new Date("invalid")]) { assert.equal(millis(value), null); assert.throws(() => clock(value)); }
});
test("only exact approved policy plus literal permission can authorize", () => {
  for (const raw of [{}, { purgeEnabled: "true", policyVersion: POLICY.version }, { purgeEnabled: true, policyVersion: "older-policy" }]) assert.equal(isApprovedPolicy(raw), false);
  assert.equal(isApprovedPolicy({ purgeEnabled: true, policyVersion: POLICY.version }), true);
});
test("profile tombstone removes contact, location, tokens and unknown personal fields but not financial totals", () => {
  const result = profileTombstone({ walletBalance: 0, totalEarnings: 500, totalRidesCompleted: 3, role: "driver", name: "private", email: "private", cnic: "private", fcmToken: "private", location: {}, unknownPersonalField: "private" });
  assert.equal(result.walletBalance, 0); assert.equal(result.totalEarnings, 500); assert.equal(result.totalRidesCompleted, 3);
  for (const k of ["name", "email", "cnic", "fcmToken", "location", "unknownPersonalField"]) assert.equal(result[k], undefined);
  assert.equal(result.accountStatus, "closed"); assert.ok(!SCOPES.some((s) => ["ledger_transactions", "audit_logs", "rechargeRequests"].includes(s.collection)));
});
test("strict runtime gate rejects truthy flags without database or Auth access", async () => {
  const db = { runTransaction() { throw new Error("UNEXPECTED_DATABASE_ACCESS"); } };
  for (const allowMutation of [undefined, false, "true", 1]) {
    await assert.rejects(executeAccountDispositionPage(db, {}, { uid: "u", confirm: POLICY.version }, { allowMutation }), /ACCOUNT_ERASURE_NOT_ENABLED/);
    await assert.rejects(disposeIdentityRecord(db, {}, { confirm: POLICY.version }, { dryRun: false, allowMutation }), /ACCOUNT_ERASURE_NOT_ENABLED/);
  }
  await assert.rejects(disposeIdentityRecord(db, {}, {}, { dryRun: "false" }), /INVALID_DISPOSITION_MODE/);
});
test("proof deletion cannot target another account, arbitrary file or invalid generation", () => {
  const proofs = Object.fromEntries(["cnicFront", "cnicBack", "license", "selfie"].map((key) => [key, { path: `driver_applications/u/t_${key}`, generation: "123" }]));
  assert.equal(proofTargets("driver_applications", { ticketId: "t", proofs }, "u").length, 4);
  assert.throws(() => proofTargets("driver_applications", { ticketId: "t", proofs }, "other"));
  assert.throws(() => proofTargets("driver_applications", { ticketId: "../t", proofs }, "u"));
  assert.deepEqual(proofTargets("owner_applications", {}, "u"), []);
});
test("test safety refuses account erasure runtime flag", () => {
  assert.throws(() => requirePhaseSixEmulators({ GCLOUD_PROJECT: PROJECT, FIRESTORE_EMULATOR_HOST: "127.0.0.1:8191",
    FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9194", FIREBASE_STORAGE_EMULATOR_HOST: "127.0.0.1:9294", ENABLE_ACCOUNT_ERASURE: "true" }));
});
test("UI execution is hidden by default and server-gated, not automatic on load", () => {
  const source = readFileSync(new URL("../super-admin-panel/js/privacy-maintenance.js", import.meta.url), "utf8");
  assert.match(source, /id="privacyAccountExecute" hidden/); assert.match(source, /id="privacyIdentityExecute" hidden/);
  assert.match(source, /executorAvailable = result.erasureExecutorAvailable === true/);
  assert.match(source, /confirm: approvedPolicy/); assert.doesNotMatch(source, /deleteUser|\.delete\(/);
});
