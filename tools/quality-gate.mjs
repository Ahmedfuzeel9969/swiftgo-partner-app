/**
 * Zero-install first-party quality gate.
 *
 * This intentionally uses only Node built-ins so it can run before Hosting
 * deploys even when optional development packages are unavailable.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const checks = [];

function relative(filePath) {
  return path.relative(ROOT, filePath).replaceAll("\\", "/");
}

function pass(label) {
  checks.push(label);
}

function fail(label, detail) {
  failures.push(`${label}: ${detail}`);
}

function assert(label, condition, detail) {
  if (condition) pass(label);
  else fail(label, detail);
}

function read(projectPath) {
  return fs.readFileSync(path.join(ROOT, projectPath), "utf8");
}

function checkSourceSyntax() {
  const result = spawnSync(
    process.execPath,
    ["--experimental-vm-modules", path.join(ROOT, "tools", "source-syntax-check.mjs")],
    { cwd: ROOT, encoding: "utf8" }
  );
  assert(
    "source syntax",
    result.status === 0,
    String(result.stderr || result.stdout || "syntax check failed").trim()
  );
}

function checkJson() {
  const files = [
    "firebase.json",
    "firestore.indexes.json",
    "package.json",
    "functions/package.json",
    "mobile/package.json",
  ];
  for (const projectPath of files) {
    try {
      JSON.parse(read(projectPath));
      pass(`JSON ${projectPath}`);
    } catch (error) {
      fail(`JSON ${projectPath}`, error?.message || String(error));
    }
  }
}

function checkWrapperParity() {
  const result = spawnSync(
    process.execPath,
    [path.join(ROOT, "tools", "sync-shared-js-wrappers.mjs"), "--check"],
    { cwd: ROOT, encoding: "utf8" }
  );
  assert(
    "shared wrapper parity",
    result.status === 0,
    String(result.stderr || result.stdout || "wrapper check failed").trim()
  );
}

function checkArchitectureContracts() {
  const customerData = read("customer-app/js/data.js");
  const rules = read("firestore.rules");
  const driverApp = read("driver-app/js/driver-app.js");
  const radarList = read("driver-app/js/AvailableRidesList.js");
  const customerRideFlow = read("customer-app/js/ride-flow.js");
  const driverRideFlow = driverApp;
  const serverSources = fs.readdirSync(path.join(ROOT, "functions"), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
    .map((entry) => fs.readFileSync(path.join(ROOT, "functions", entry.name), "utf8"))
    .join("\n");

  assert(
    "legacy bookings client writes retired",
    !/collection\s*\(\s*db\s*,\s*["']bookings["']/.test(customerData),
    "customer data layer still writes the legacy bookings collection"
  );
  assert(
    "legacy bookings rules are read-only",
    /match \/bookings\/\{bookingId\}[\s\S]*?allow create, update, delete:\s*if false;/.test(rules),
    "Firestore rules do not explicitly deny legacy bookings mutations"
  );
  assert(
    "one available-rides remote feed",
    (driverApp.match(/\bsubscribePendingRadarRides\s*\(/g) || []).length === 1 &&
      !radarList.includes("subscribePendingRadarRides"),
    "ride badge and visible list may open separate remote listeners"
  );
  assert(
    "shared radar feed hub",
    driverApp.includes("createRideRadarFeedHub") && driverApp.includes("subscribeRadarState: radarFeedHub.subscribe"),
    "driver radar is not routed through the shared in-memory feed hub"
  );
  assert(
    "customer direct communication path",
    customerRideFlow.includes("createRideCommChat") && customerRideFlow.includes("createCommTransport"),
    "customer ride flow is missing the direct P2P communication bridge"
  );
  assert(
    "driver direct communication path",
    driverRideFlow.includes("createRideCommChat") && driverRideFlow.includes("createCommTransport"),
    "driver ride flow is missing the direct P2P communication bridge"
  );
  assert(
    "modular Firebase Admin SDK",
    !/\badmin\.(?:auth|firestore|storage)\s*\(/.test(serverSources) &&
      !/require\s*\(\s*["']firebase-admin["']\s*\)/.test(serverSources),
    "server source still uses a removed Firebase Admin namespace API"
  );
}

function checkHostingPolicy() {
  const config = JSON.parse(read("firebase.json"));
  const definitions = config?.hosting?.headers || [];
  const allHeaders = definitions.flatMap((item) => item.headers || []);
  const byKey = new Map(allHeaders.map((item) => [String(item.key).toLowerCase(), String(item.value)]));
  for (const key of [
    "content-security-policy",
    "x-content-type-options",
    "referrer-policy",
    "x-frame-options",
    "cross-origin-opener-policy",
    "permissions-policy",
  ]) {
    assert(`hosting header ${key}`, byKey.has(key), `missing ${key}`);
  }
  const csp = byKey.get("content-security-policy") || "";
  for (const directive of ["default-src", "connect-src", "frame-ancestors 'none'", "object-src 'none'"]) {
    assert(`CSP ${directive}`, csp.includes(directive), `missing directive: ${directive}`);
  }
  const scripts = definitions.find((item) => item.source === "**/*.@(js|mjs|css)");
  const staticAssets = definitions.find((item) => item.source === "**/*.@(png|jpg|jpeg|gif|webp|svg|ico|woff|woff2|ttf)");
  assert(
    "conditional code caching",
    scripts?.headers?.some((item) => item.key === "Cache-Control" && item.value === "public, max-age=0, must-revalidate"),
    "JS/CSS must revalidate with Hosting ETags"
  );
  assert(
    "bounded static asset caching",
    staticAssets?.headers?.some((item) => item.key === "Cache-Control" && item.value.includes("max-age=86400")),
    "images and fonts lack a bounded cache policy"
  );
}

function checkModuleBudgets() {
  const budgets = new Map([
    ["driver-app/js/driver-app.js", 176_256],
    ["super-admin-panel/js/admin-app.js", 122_000],
    ["customer-app/js/ride-flow.js", 66_000],
  ]);
  for (const [projectPath, maximumBytes] of budgets) {
    const actualBytes = fs.statSync(path.join(ROOT, projectPath)).size;
    assert(
      `module budget ${projectPath}`,
      actualBytes <= maximumBytes,
      `${actualBytes} bytes exceeds ${maximumBytes}; extract a focused module instead of growing this file`
    );
  }
}

function checkDependencyPolicy() {
  const rootPackage = JSON.parse(read("package.json"));
  const functionsPackage = JSON.parse(read("functions/package.json"));
  const mobilePackage = JSON.parse(read("mobile/package.json"));
  const expectedRoot = {
    "@firebase/rules-unit-testing": "5.0.2",
    "@playwright/test": "1.62.1",
    firebase: "12.18.0",
    "firebase-admin": "14.3.0",
    "firebase-tools": "15.28.2",
  };
  for (const [name, version] of Object.entries(expectedRoot))
    assert(`root dependency ${name}`, rootPackage.devDependencies?.[name] === version, `expected exact ${version}`);
  assert("root uuid security override", rootPackage.overrides?.uuid === "11.1.1", "uuid is not pinned to 11.1.1");
  assert("root pubsub security override", rootPackage.overrides?.["@google-cloud/pubsub"] === "6.0.1", "Pub/Sub is not pinned to 6.0.1");
  assert("server firebase-admin", functionsPackage.dependencies?.["firebase-admin"] === "14.3.0", "expected exact 14.3.0");
  assert("server firebase-functions", functionsPackage.dependencies?.["firebase-functions"] === "7.3.2", "expected exact 7.3.2");
  assert("server uuid security override", functionsPackage.overrides?.uuid === "11.1.1", "uuid is not pinned to 11.1.1");
  assert("mobile Capacitor CLI", mobilePackage.devDependencies?.["@capacitor/cli"] === "8.5.0", "expected exact 8.5.0");
  assert("mobile uuid security override", mobilePackage.overrides?.uuid === "11.1.1", "uuid is not pinned to 11.1.1");
  const expectedCapacitor = {
    "@capacitor/android": "8.5.0", "@capacitor/app": "8.1.1", "@capacitor/browser": "8.0.4",
    "@capacitor/core": "8.5.0", "@capacitor/geolocation": "8.2.2", "@capacitor/network": "8.0.1",
    "@capacitor/splash-screen": "8.0.2", "@capacitor/status-bar": "8.0.3",
  };
  for (const app of ["customer", "partner", "owner"]) {
    const appPackage = JSON.parse(read(`mobile/${app}/package.json`));
    for (const [name, version] of Object.entries(expectedCapacitor))
      assert(`mobile ${app} ${name}`, appPackage.dependencies?.[name] === version, `expected exact ${version}`);
    const manifest = read(`mobile/${app}/android/app/src/main/AndroidManifest.xml`);
    assert(`mobile ${app} Android 16 config`, manifest.includes("|navigation|density"), "missing Capacitor 8 configuration changes");
    assert(`mobile ${app} one Internet permission`, (manifest.match(/android\.permission\.INTERNET/g) || []).length === 1, "permission is missing or duplicated");
    const variables = read(`mobile/${app}/android/variables.gradle`);
    assert(`mobile ${app} SDK 36`, variables.includes("compileSdkVersion = 36") && variables.includes("targetSdkVersion = 36"), "compile/target SDK must be 36");
  }
}

checkSourceSyntax();
checkJson();
checkWrapperParity();
checkArchitectureContracts();
checkHostingPolicy();
checkModuleBudgets();
checkDependencyPolicy();

if (failures.length) {
  console.error(`[quality-gate] FAILED (${failures.length} issue${failures.length === 1 ? "" : "s"})`);
  for (const item of failures) console.error(`  - ${item}`);
  process.exitCode = 1;
} else {
  console.info(`[quality-gate] PASS (${checks.length} checks)`);
}
