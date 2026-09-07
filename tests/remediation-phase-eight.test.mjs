import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRideRadarFeedHub } from "../driver-app/js/ride-radar-feed-hub.mjs";
import {
  listWrapperTargets,
  WRAPPER_EXCLUDED_MODULE_NAMES,
} from "../tools/sync-shared-js-wrappers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (projectPath) => fs.readFileSync(path.join(ROOT, projectPath), "utf8");

test("every existing shared overlap is a thin canonical wrapper", () => {
  const targets = listWrapperTargets();
  assert.ok(targets.length >= 90);
  for (const { filePath, name } of targets) {
    assert.equal(
      fs.readFileSync(filePath, "utf8"),
      `/** Auto-wrapper: canonical implementation in shared/js. Do not edit algorithms here. */\n` +
        `export * from "../../shared/js/${name}";\n`
    );
  }
  assert.deepEqual(WRAPPER_EXCLUDED_MODULE_NAMES, ["p2p-ice-bootstrap.mjs"]);
});

test("previously stale admin and auth implementations now use canonical sources", () => {
  for (const app of ["customer-app", "driver-app", "owner-app", "super-admin-panel"]) {
    assert.match(read(`${app}/js/auth-surface-routing.mjs`), /export \* from "\.\.\/\.\.\/shared\/js\/auth-surface-routing\.mjs"/);
  }
  for (const name of ["idle-publish-config.mjs", "location-reporting-config.mjs", "ride-location-report-schema.mjs"]) {
    assert.match(read(`super-admin-panel/js/${name}`), new RegExp(`export \\* from "\\.\\.\\/\\.\\.\\/shared\\/js\\/${name.replace(".", "\\.")}"`));
  }
});

test("legacy bookings are readable archives but cannot be written by clients", () => {
  const rules = read("firestore.rules");
  const customerData = read("customer-app/js/data.js");
  assert.match(rules, /match \/bookings\/\{bookingId\}[\s\S]*?allow create, update, delete:\s*if false;/);
  assert.doesNotMatch(customerData, /collection\s*\(\s*db\s*,\s*["']bookings["']/);
  assert.doesNotMatch(customerData, /function\s+(?:watchBookings|createBooking)\b/);
});

test("one remote radar feed fans out to badge and visible list", () => {
  const app = read("driver-app/js/driver-app.js");
  const list = read("driver-app/js/AvailableRidesList.js");
  assert.equal((app.match(/\bsubscribePendingRadarRides\s*\(/g) || []).length, 1);
  assert.doesNotMatch(list, /subscribePendingRadarRides/);
  assert.match(app, /subscribeRadarState:\s*radarFeedHub\.subscribe/);

  const hub = createRideRadarFeedHub();
  const receivedA = [];
  const receivedB = [];
  const unsubscribeA = hub.subscribe((state) => receivedA.push(state));
  hub.publish({ rides: [{ id: "ride-1" }], source: "remote" });
  const unsubscribeB = hub.subscribe((state) => receivedB.push(state));
  assert.equal(receivedA.length, 1);
  assert.equal(receivedB.length, 1);
  assert.equal(receivedB[0].rides[0].id, "ride-1");
  unsubscribeA();
  hub.publish({ rides: [], source: "cache" });
  assert.equal(receivedA.length, 1);
  assert.equal(receivedB.length, 2);
  unsubscribeB();
  assert.equal(hub.listenerCount(), 0);
  hub.clear();
  assert.equal(hub.getState(), null);
});

test("customer and driver both attach communication to the direct P2P transport", () => {
  for (const file of ["customer-app/js/ride-flow.js", "driver-app/js/driver-app.js"]) {
    const source = read(file);
    assert.match(source, /createRideCommChat/);
    assert.match(source, /createCommTransport/);
  }
});

test("Hosting policy protects pages and conditionally caches code and assets", () => {
  const config = JSON.parse(read("firebase.json"));
  const definitions = config.hosting.headers;
  const headers = definitions.flatMap((entry) => entry.headers);
  const byKey = new Map(headers.map((entry) => [entry.key, entry.value]));
  for (const key of [
    "Content-Security-Policy",
    "X-Content-Type-Options",
    "Referrer-Policy",
    "X-Frame-Options",
    "Cross-Origin-Opener-Policy",
    "Permissions-Policy",
  ]) assert.ok(byKey.has(key), key);
  assert.match(byKey.get("Content-Security-Policy"), /frame-ancestors 'none'/);
  assert.match(byKey.get("Content-Security-Policy"), /http:\/\/127\.0\.0\.1:\*/);
  const code = definitions.find((entry) => entry.source === "**/*.@(js|mjs|css)");
  const assets = definitions.find((entry) => entry.source.includes("png|jpg"));
  assert.equal(code.headers[0].value, "public, max-age=0, must-revalidate");
  assert.match(assets.headers[0].value, /max-age=86400/);
});

test("quality gate is mandatory before Hosting build and passes locally", () => {
  const config = JSON.parse(read("firebase.json"));
  const qualityIndex = config.hosting.predeploy.indexOf("node tools/quality-gate.mjs");
  const buildIndex = config.hosting.predeploy.indexOf("node tools/build-hosting.mjs");
  assert.ok(qualityIndex >= 0 && qualityIndex < buildIndex);
  const pkg = JSON.parse(read("package.json"));
  assert.equal(pkg.scripts["check:quality"], "node tools/quality-gate.mjs");
  const result = spawnSync(process.execPath, [path.join(ROOT, "tools/quality-gate.mjs")], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /PASS/);
});

test("large legacy entry points have enforced no-growth budgets", () => {
  const budgets = new Map([
    ["driver-app/js/driver-app.js", 176_256],
    ["super-admin-panel/js/admin-app.js", 122_000],
    ["customer-app/js/ride-flow.js", 66_000],
  ]);
  for (const [file, maximum] of budgets) {
    assert.ok(fs.statSync(path.join(ROOT, file)).size <= maximum, file);
  }
  assert.ok(fs.statSync(path.join(ROOT, "driver-app/js/ride-radar-feed-hub.mjs")).size > 0);
});
