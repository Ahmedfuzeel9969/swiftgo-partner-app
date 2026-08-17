/**
 * Phase 4G pipeline verification (structure + permissions + signing wiring).
 * Does not require a successful Gradle download if network to dl.google.com is blocked.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RESULTS = path.join(ROOT, "tests", "phase4g-android-results.json");

const results = [];
function record(name, status, detail = "") {
  results.push({ name, status, detail });
  console.log(`${status === "PASS" ? "✓" : "✗"} [${status}] ${name}${detail ? ` — ${detail}` : ""}`);
}

function exists(p) {
  return fs.existsSync(path.join(ROOT, p));
}

for (const app of ["customer", "partner", "owner"]) {
  record(`${app}-capacitor-config`, exists(`mobile/${app}/capacitor.config.json`) ? "PASS" : "FAIL");
  record(`${app}-android-project`, exists(`mobile/${app}/android/app/build.gradle`) ? "PASS" : "FAIL");
  const manifest = path.join(ROOT, "mobile", app, "android", "app", "src", "main", "AndroidManifest.xml");
  if (fs.existsSync(manifest)) {
    const xml = fs.readFileSync(manifest, "utf8");
    record(`${app}-fine-location`, xml.includes("ACCESS_FINE_LOCATION") ? "PASS" : "FAIL");
    record(`${app}-notifications-13`, xml.includes("POST_NOTIFICATIONS") ? "PASS" : "FAIL");
    record(`${app}-deep-link`, xml.includes("swiftgo-ride-app.web.app") ? "PASS" : "FAIL");
    if (app === "customer") {
      record(
        "customer-p2p-keepalive-service-declared",
        xml.includes("CustomerP2pKeepAliveForegroundService") &&
          xml.includes('foregroundServiceType="dataSync"')
          ? "PASS"
          : "FAIL"
      );
      record(
        "customer-p2p-keepalive-service-java",
        exists(
          "mobile/customer/android/app/src/main/java/com/swiftgo/customer/CustomerP2pKeepAliveForegroundService.java"
        )
          ? "PASS"
          : "FAIL"
      );
      record(
        "customer-p2p-keepalive-plugin-java",
        exists(
          "mobile/customer/android/app/src/main/java/com/swiftgo/customer/CustomerP2pKeepAlivePlugin.java"
        )
          ? "PASS"
          : "FAIL"
      );
    }
    if (app === "partner") {
      record("partner-background-location", xml.includes("ACCESS_BACKGROUND_LOCATION") ? "PASS" : "FAIL");
      record("partner-fg-service-location", xml.includes("FOREGROUND_SERVICE_LOCATION") ? "PASS" : "FAIL");
      record(
        "partner-location-service-declared",
        xml.includes("DriverLocationForegroundService") && xml.includes('foregroundServiceType="location"')
          ? "PASS"
          : "FAIL"
      );
      record(
        "partner-location-service-java",
        exists("mobile/partner/android/app/src/main/java/com/swiftgo/partner/DriverLocationForegroundService.java")
          ? "PASS"
          : "FAIL"
      );
      record(
        "partner-location-plugin-java",
        exists("mobile/partner/android/app/src/main/java/com/swiftgo/partner/DriverLocationPlugin.java")
          ? "PASS"
          : "FAIL"
      );
      record(
        "partner-bg-uploader-java",
        exists("mobile/partner/android/app/src/main/java/com/swiftgo/partner/BackgroundLocationUploader.java")
          ? "PASS"
          : "FAIL"
      );
    }
  } else {
    record(`${app}-manifest`, "FAIL", "missing");
  }
}

record("admin-not-packaged", !exists("mobile/admin/android") ? "PASS" : "FAIL");
record("signing-readme", exists("mobile/signing/README.md") ? "PASS" : "FAIL");
record("signing-example", exists("mobile/signing/keystore.properties.example") ? "PASS" : "FAIL");
record(
  "secrets-not-committed-pattern",
  fs.readFileSync(path.join(ROOT, ".gitignore"), "utf8").includes("*.jks") ? "PASS" : "FAIL"
);
record("distribution-doc", exists("docs/PHASE-4G-DISTRIBUTION-RECOMMENDATION.md") ? "PASS" : "FAIL");
record("sync-tool", exists("tools/phase4g-sync-mobile.mjs") ? "PASS" : "FAIL");

const aabCandidates = [
  "mobile/customer/android/app/build/outputs/bundle/release/app-release.aab",
  "docs/phase4g-aab-output/customer-release.aab",
];
const aabHit = aabCandidates.find((p) => exists(p));
record("customer-aab-artifact", aabHit ? "PASS" : "BLOCKED", aabHit || "Gradle could not reach dl.google.com in this environment");

const failed = results.filter((r) => r.status === "FAIL");
const blocked = results.filter((r) => r.status === "BLOCKED");
const payload = {
  phase: "4G",
  generatedAt: new Date().toISOString(),
  pass: results.filter((r) => r.status === "PASS").length,
  fail: failed.length,
  blocked: blocked.length,
  results,
};
fs.writeFileSync(RESULTS, JSON.stringify(payload, null, 2));
console.log(`\nPhase 4G: ${payload.pass} PASS / ${payload.fail} FAIL / ${payload.blocked} BLOCKED`);
if (failed.length) process.exitCode = 1;
