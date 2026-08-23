/**
 * Customer map initialization recovery regression.
 * Exercises app.js ensureMap() with a fake Leaflet initializer.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appSource = fs.readFileSync(path.join(ROOT, "customer-app/js/app.js"), "utf8");
const start = appSource.indexOf("let mapReady = false;");
const end = appSource.indexOf("\nasync function goToMyLocation", start);
if (start < 0 || end < 0) throw new Error("ensureMap source bounds not found");

function harness(results) {
  let initCalls = 0;
  let resizeCalls = 0;
  let available = false;
  const sandbox = {
    initMap() {
      initCalls += 1;
      return available ? { id: "leaflet-map" } : null;
    },
    resizeMap() {
      resizeCalls += 1;
    },
    window: {
      requestAnimationFrame(fn) {
        fn();
      },
      setTimeout(fn) {
        fn();
      },
    },
  };
  vm.runInNewContext(
    `${appSource.slice(start, end)}
     this.ensure = ensureMap;
     this.ready = () => mapReady;`,
    sandbox
  );
  return {
    setAvailable(value) {
      available = value;
    },
    call() {
      sandbox.ensure();
    },
    state() {
      return { initCalls, resizeCalls, mapReady: sandbox.ready() };
    },
  };
}

const results = [];
function record(name, ok, detail) {
  results.push({ name, status: ok ? "PASS" : "FAIL", detail });
  console.log(`${ok ? "✓" : "✗"} ${name} — ${detail}`);
}

const h = harness(results);
h.call();
let s = h.state();
record(
  "first-attempt-without-leaflet-does-not-mark-ready",
  s.initCalls === 1 && s.resizeCalls === 0 && s.mapReady === false,
  JSON.stringify(s)
);

h.setAvailable(true);
h.call();
s = h.state();
record(
  "later-leaflet-availability-retries-and-marks-ready",
  s.initCalls === 2 && s.mapReady === true && s.resizeCalls === 2,
  JSON.stringify(s)
);

h.call();
s = h.state();
record(
  "repeated-success-does-not-create-duplicate-map",
  s.initCalls === 2 && s.resizeCalls === 3 && s.mapReady === true,
  JSON.stringify(s)
);

const failed = results.filter((r) => r.status === "FAIL").length;
fs.writeFileSync(
  path.join(ROOT, "tests", "map-init-recovery-results.json"),
  JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2)
);
if (failed) process.exitCode = 1;
