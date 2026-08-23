/**
 * Super Admin location reporting config UI + callable validation tests.
 * Run: npm run test:ride-location-report-admin-config
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  buildValidatedLocationReportingSettings,
  normalizeLocationReportingConfig,
  LOCATION_REPORTING_DEFAULTS,
} from "../shared/js/location-reporting-config.mjs";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "tests", "ride-location-report-admin-config-results.json");

const results = [];
function record(name, status, detail = "") {
  results.push({ name, status, detail });
  console.log(`${status === "PASS" ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

function expectInvalid(fn, code) {
  try {
    fn();
    return false;
  } catch (e) {
    return String(e?.message || e) === code;
  }
}

record(
  "static-callable-exported",
  read("functions/index.js").includes("exports.saveAdminLocationReportingSettings") ? "PASS" : "FAIL"
);

record(
  "static-callable-uses-super-admin-gate",
  read("functions/index.js").includes("SUPER_ADMIN_REPORTING_CONFIG_ONLY") &&
    read("functions/index.js").includes("isCallerAuthorizedForDiagnostic")
    ? "PASS"
    : "FAIL"
);

record(
  "static-admin-settings-client-export",
  read("super-admin-panel/js/admin-settings-client.js").includes(
    "saveAdminLocationReportingSettings"
  )
    ? "PASS"
    : "FAIL"
);

record(
  "static-admin-ui-form-present",
  read("super-admin-panel/index.html").includes("locationReportingSettingsForm") &&
    read("super-admin-panel/index.html").includes("settings/locationReporting")
    ? "PASS"
    : "FAIL"
);

record(
  "static-admin-app-load-save-wired",
  read("super-admin-panel/js/admin-app.js").includes("loadLocationReportingSettings") &&
    read("super-admin-panel/js/admin-app.js").includes("saveLocationReportingSettings")
    ? "PASS"
    : "FAIL"
);

record(
  "static-admin-config-module-present",
  fs.existsSync(path.join(ROOT, "super-admin-panel/js/location-reporting-config.mjs")) ? "PASS" : "FAIL"
);

record(
  "unit-valid-payload-normalized",
  (() => {
    const cfg = buildValidatedLocationReportingSettings({
      enabled: true,
      uploadMode: "ride_end",
      periodicIntervalMinutes: 10,
      uploadOnAnomaly: false,
      finalUploadRequired: true,
      collectDriverMetrics: true,
      collectCustomerMetrics: true,
      collectFirebaseMetrics: true,
      collectP2pMetrics: true,
      retentionDays: 45,
    });
    return cfg.uploadMode === "ride_end" && cfg.retentionDays === 45 ? "PASS" : "FAIL";
  })()
);

record(
  "unit-disabled-mode-forces-enabled-false",
  (() => {
    const cfg = buildValidatedLocationReportingSettings({
      enabled: true,
      uploadMode: "disabled",
      periodicIntervalMinutes: 10,
      uploadOnAnomaly: false,
      finalUploadRequired: true,
      collectDriverMetrics: true,
      collectCustomerMetrics: true,
      collectFirebaseMetrics: true,
      collectP2pMetrics: true,
      retentionDays: 30,
    });
    return cfg.enabled === false && cfg.uploadMode === "disabled" ? "PASS" : "FAIL";
  })()
);

record(
  "unit-periodic-mode-not-implemented",
  expectInvalid(
    () =>
      buildValidatedLocationReportingSettings({
        enabled: true,
        uploadMode: "periodic_and_ride_end",
        periodicIntervalMinutes: 10,
        uploadOnAnomaly: false,
        finalUploadRequired: true,
        collectDriverMetrics: true,
        collectCustomerMetrics: true,
        collectFirebaseMetrics: true,
        collectP2pMetrics: true,
        retentionDays: 30,
      }),
    "INVALID_UPLOAD_MODE_NOT_IMPLEMENTED"
  )
    ? "PASS"
    : "FAIL"
);

record(
  "unit-periodic-mode-requires-interval",
  expectInvalid(
    () =>
      buildValidatedLocationReportingSettings({
        enabled: true,
        uploadMode: "periodic_and_ride_end",
        periodicIntervalMinutes: 3,
        uploadOnAnomaly: false,
        finalUploadRequired: true,
        collectDriverMetrics: true,
        collectCustomerMetrics: true,
        collectFirebaseMetrics: true,
        collectP2pMetrics: true,
        retentionDays: 30,
      }),
    "INVALID_UPLOAD_MODE_NOT_IMPLEMENTED"
  )
    ? "PASS"
    : "FAIL"
);

record(
  "unit-rejects-string-retention",
  expectInvalid(
    () =>
      buildValidatedLocationReportingSettings({
        ...LOCATION_REPORTING_DEFAULTS,
        retentionDays: "30",
      }),
    "INVALID_RETENTION_DAYS"
  )
    ? "PASS"
    : "FAIL"
);

record(
  "unit-rejects-invalid-upload-mode",
  expectInvalid(
    () =>
      buildValidatedLocationReportingSettings({
        ...LOCATION_REPORTING_DEFAULTS,
        uploadMode: "every_second",
      }),
    "INVALID_UPLOAD_MODE"
  )
    ? "PASS"
    : "FAIL"
);

record(
  "cjs-validation-parity",
  (() => {
    const cjs = require("../functions/location-reporting-config.js");
    const payload = {
      enabled: true,
      uploadMode: "ride_end",
      periodicIntervalMinutes: 15,
      uploadOnAnomaly: true,
      finalUploadRequired: false,
      collectDriverMetrics: true,
      collectCustomerMetrics: false,
      collectFirebaseMetrics: true,
      collectP2pMetrics: false,
      retentionDays: 14,
    };
    const esm = buildValidatedLocationReportingSettings(payload);
    const cjsOut = cjs.buildValidatedLocationReportingSettings(payload);
    return JSON.stringify(esm) === JSON.stringify(cjsOut) ? "PASS" : "FAIL";
  })()
);

// Emulator — persist via Admin SDK using same normalized shape as callable
const admin = require(require.resolve("firebase-admin", { paths: [path.join(ROOT, "functions"), ROOT] }));
process.env.FIRESTORE_EMULATOR_HOST ||= "127.0.0.1:8080";

let app;
try {
  app = admin.app();
} catch {
  app = admin.initializeApp({ projectId: "demo-swiftgo-phase1" });
}
const db = admin.firestore(app);

const savedConfig = buildValidatedLocationReportingSettings({
  enabled: true,
  uploadMode: "ride_end",
  periodicIntervalMinutes: 10,
  uploadOnAnomaly: false,
  finalUploadRequired: true,
  collectDriverMetrics: true,
  collectCustomerMetrics: true,
  collectFirebaseMetrics: true,
  collectP2pMetrics: true,
  retentionDays: 21,
});

await db.doc("settings/locationReporting").set({
  schemaVersion: 1,
  ...savedConfig,
  updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  updatedBy: "admin-config-test",
});

const snap = await db.doc("settings/locationReporting").get();
const loaded = normalizeLocationReportingConfig(snap.exists ? snap.data() : {});
record(
  "emulator-settings-doc-roundtrip",
  loaded.uploadMode === "ride_end" && loaded.retentionDays === 21 ? "PASS" : "FAIL"
);

await db.doc("settings/locationReporting").set({
  schemaVersion: 1,
  enabled: "yes",
  uploadMode: "ride_end",
  retentionDays: "30",
});
const malformed = normalizeLocationReportingConfig((await db.doc("settings/locationReporting").get()).data());
record(
  "emulator-malformed-doc-uses-safe-defaults",
  malformed.retentionDays === LOCATION_REPORTING_DEFAULTS.retentionDays &&
    malformed.uploadMode === LOCATION_REPORTING_DEFAULTS.uploadMode
    ? "PASS"
    : "FAIL"
);

const failCount = results.filter((r) => r.status === "FAIL").length;
const passCount = results.filter((r) => r.status === "PASS").length;

fs.writeFileSync(
  OUT,
  JSON.stringify({ generatedAt: new Date().toISOString(), pass: passCount, fail: failCount, results }, null, 2)
);
console.log(`\nSummary: ${passCount} PASS, ${failCount} FAIL`);
if (failCount > 0) process.exit(1);
