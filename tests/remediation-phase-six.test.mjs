import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import { requirePhaseSixEmulators, PROJECT } from "./helpers/phase-six-safety.mjs";
const require = createRequire(import.meta.url);
const { GROUPS, normalizeRetentionPolicy, saveRetentionPolicy, expirationDecision, retentionTarget, runRetentionMaintenance,
  purgeExpiredTransientData, retireTerminalLiveFields } = require("../functions/data-retention.js");
const { reportRetentionDeadline, reportRetentionWindowClosed } = require("../functions/retention-timestamps.js");
const { assertAccountAccessAllowed } = require("../functions/account-deletion-workflow.js");
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const now = 1_800_000_000_000;

test("maintenance defaults are disabled, malformed flags never become permission", () => {
  assert.deepEqual(normalizeRetentionPolicy(), { expiryEnabled: false, purgeEnabled: false, policyVersion: "", batchLimit: 25 });
  const p = normalizeRetentionPolicy({ expiryEnabled: "true", purgeEnabled: 1, policyVersion: "../x", batchLimit: 100 });
  assert.equal(p.expiryEnabled, false); assert.equal(p.purgeEnabled, false); assert.equal(p.policyVersion, ""); assert.equal(p.batchLimit, 25);
});
for (const path of ["rides/x", "users/x", "partners/x", "ledger_transactions/x", "driver_applications/x", "audit_logs/x",
  "other/x/customerLocations/y", "rides/x/customerLocations/y/nested/z", "customerLocations/x"]) {
  test(`cleanup refuses protected/unexpected path ${path}`, () => {
    assert.equal(retentionTarget(path, {}), null);
    assert.equal(expirationDecision(path, { expiresAt: new Date(now - 1) }, { status: "completed" }, now).eligible, false);
  });
}
test("expired receipt may retire; active or unknown accounting parent may not", () => {
  const d = { expiresAt: new Date(now - 1) };
  assert.equal(expirationDecision("rides/r/peerCredentialIssues/a", d, { status: "in_progress" }, now).eligible, true);
  assert.equal(expirationDecision("rideBreadcrumbTelemetry/r", d, { status: "in_progress" }, now).eligible, false);
  assert.equal(expirationDecision("rideLocationReports/r", d, null, now).eligible, false);
  assert.equal(expirationDecision("rideLocationReports/r", d, { status: "completed" }, now).eligible, true);
});
test("legal holds, future deadlines and malformed dates fail closed", () => {
  for (const patch of [{ expiresAt: new Date(now + 1) }, { expiresAt: "yesterday" }, { expiresAt: new Date(0) }, { expiresAt: new Date(now - 1), legalHold: true }])
    assert.equal(expirationDecision("ridePeerSessions/r", patch, {}, now).eligible, false);
  assert.equal(expirationDecision("ridePeerSessions/r", { expiresAt: new Date(now - 1) }, { legalHold: true }, now).eligible, false);
});
test("report retries do not extend retention; shortening admin window applies", () => {
  const report = { createdAt: new Date(now - 10 * 86400000), expiresAt: new Date(now + 20 * 86400000) };
  assert.equal(reportRetentionDeadline({}, report, 30, now).getTime(), report.expiresAt.getTime());
  assert.equal(reportRetentionDeadline({}, report, 7, now).getTime(), now - 3 * 86400000);
});
test("long-finished ride cannot resurrect a purged location report", () => {
  const ride = { status: "completed", closedAt: new Date(now - 31 * 86400000) };
  assert.equal(reportRetentionWindowClosed(ride, 30, now), true);
  assert.equal(reportRetentionWindowClosed({ ...ride, status: "in_progress" }, 30, now), false);
  assert.equal(reportRetentionWindowClosed({ status: "completed" }, 30, now), false);
});
for (const status of ["pending", "pending_review", "reviewed", "erasure_in_progress", "completed"]) {
  test(`old credentials are blocked while deletion status is ${status}`, async () => {
    const db = { doc: () => ({ get: async () => ({ data: () => ({ status }) }) }) };
    await assert.rejects(assertAccountAccessAllowed(db, "u"), /ACCOUNT_DELETION_PENDING/);
  });
}
test("normal accounts are not blocked and an explicit access tombstone wins", async () => {
  await assertAccountAccessAllowed({ doc: () => ({ get: async () => ({ data: () => undefined }) }) }, "u");
  await assert.rejects(assertAccountAccessAllowed({ doc: () => ({ get: async () => ({ data: () => ({ accessBlocked: true, status: "unknown" }) }) }) }, "u"));
});
test("disabled maintenance does not even touch the database", async () => {
  const db = { doc() { throw new Error("unexpected DB access"); } };
  for (const allowMutation of [undefined, false, "true", 1])
    assert.equal((await runRetentionMaintenance(db, { allowMutation })).reason, "MAINTENANCE_NOT_ENABLED");
});
test("maintenance input rejects malformed clocks and truthy mutation flags", async () => {
  const db = { doc: () => ({ get: async () => ({ data: () => ({ purgeEnabled: true, policyVersion: "test-policy" }) }) }) };
  for (const worker of [purgeExpiredTransientData, retireTerminalLiveFields]) {
    await assert.rejects(worker(db, { dryRun: "false" }), /INVALID_RETENTION_RUN/);
    await assert.rejects(worker(db, { nowMs: NaN }), /INVALID_RETENTION_RUN/);
    await assert.rejects(worker(db, { dryRun: false, allowMutation: "true" }), /PURGE_NOT_APPROVED/);
  }
  await assert.rejects(runRetentionMaintenance(db, { allowMutation: true, nowMs: -1 }), /INVALID_RETENTION_RUN/);
});
test("policy writes require explicit bounded values and approval reference", async () => {
  for (const input of [{}, { expiryEnabled: true, purgeEnabled: false, batchLimit: 25, policyVersion: "" },
    { expiryEnabled: false, purgeEnabled: false, batchLimit: 1.2, policyVersion: "" },
    { expiryEnabled: false, purgeEnabled: false, batchLimit: 25, policyVersion: "", arbitrary: true }])
    await assert.rejects(saveRetentionPolicy({}, {}, input));
});
test("test environment refuses preview, production, credentials and scheduler opt-in", () => {
  const good = { GCLOUD_PROJECT: PROJECT, FIRESTORE_EMULATOR_HOST: "127.0.0.1:8191", FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9194", FIREBASE_STORAGE_EMULATOR_HOST: "127.0.0.1:9294" };
  requirePhaseSixEmulators({ ...good });
  for (const patch of [{ GCLOUD_PROJECT: "demo-swiftgo-phase1" }, { FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080" },
    { GOOGLE_APPLICATION_CREDENTIALS: "secret.json" }, { ENABLE_RETENTION_SCHEDULE: "true" }]) assert.throws(() => requirePhaseSixEmulators({ ...good, ...patch }));
  assert.throws(() => requirePhaseSixEmulators({}));
});
test("pasted map expansion cannot call a public proxy or any fetch", async () => {
  const source = read("customer-app/js/location.js");
  assert.doesNotMatch(source, /allorigins|corsproxy/);
  const body = source.match(/async function expandMapsUrlForCoords\(url\) \{[\s\S]*?\n\}/)[0];
  const fn = vm.runInNewContext(`(${body})`, { parseGoogleMapsCoords: () => null, fetch: () => { throw new Error("LOCATION_LEAK"); } });
  assert.equal(await fn("https://maps.app.goo.gl/private"), null);
  assert.match(source, /isMapsUrl\(text.trim\(\)\)/);
});
test("privacy panel attaches to real settings markup and never calls direct storage/Auth erasure", () => {
  const html = read("super-admin-panel/index.html"), panel = read("super-admin-panel/js/privacy-maintenance.js");
  assert.match(html, /id="locationReportingSettingsForm"/); assert.match(panel, /getElementById\("locationReportingSettingsForm"\)/);
  assert.match(panel, /previewExpiredPrivateData/); assert.doesNotMatch(panel, /deleteUser|purgeExpiredTransientData|dryRun:\s*false/);
});
test("index changes do not silently enable native TTL deletion", () => {
  const indexes = JSON.parse(read("firestore.indexes.json"));
  assert.ok(indexes.fieldOverrides.every((f) => f.ttl !== true));
  assert.ok(!GROUPS.includes("rides") && !GROUPS.includes("audit_logs"));
});
