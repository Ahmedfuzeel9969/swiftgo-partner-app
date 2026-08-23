/**
 * Booking-route OSRM timeout and supersession regression.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = fs.readFileSync(path.join(ROOT, "customer-app/js/routing.js"), "utf8");
const start = src.indexOf("async function fetchOsrmRoute");
const end = src.indexOf("\nasync function refreshRoute", start);
if (start < 0 || end < 0) throw new Error("OSRM helper source bounds not found");

function helper(fetchImpl, timerImpl = () => 1) {
  const sandbox = {
    AbortController,
    fetch: fetchImpl,
    window: {
      setTimeout: timerImpl,
      clearTimeout() {},
    },
  };
  const helperSource =
    `const OSRM_BASE = "https://router.project-osrm.org/route/v1/driving";\n` +
    `const BOOKING_ROUTE_TIMEOUT_MS = 12000;\n${src.slice(start, end)}`;
  vm.runInNewContext(`${helperSource}\nthis.fetchOsrmRoute = fetchOsrmRoute;`, sandbox);
  return sandbox.fetchOsrmRoute;
}

const results = [];
function record(name, ok, detail) {
  results.push({ name, status: ok ? "PASS" : "FAIL", detail });
  console.log(`${ok ? "✓" : "✗"} ${name} — ${detail}`);
}

const validPayload = {
  code: "Ok",
  routes: [{ distance: 1000, duration: 120, geometry: { coordinates: [[67, 24], [67.01, 24.01]] } }],
};

const route = await helper(async () => ({ ok: true, json: async () => validPayload }))(
  { lat: 24, lng: 67 },
  { lat: 24.01, lng: 67.01 }
);
record("normal-osrm-success-preserved", route === validPayload.routes[0], "route returned");

let timeoutAborted = false;
const stalled = helper(
  (_url, opts) => {
    if (opts.signal.aborted) {
      timeoutAborted = true;
      const err = new Error("aborted");
      err.name = "AbortError";
      return Promise.reject(err);
    }
    return new Promise((_, reject) => {
      opts.signal.addEventListener("abort", () => {
        timeoutAborted = true;
        const err = new Error("aborted");
        err.name = "AbortError";
        reject(err);
      });
    });
  },
  (fn) => {
    fn();
    return 1;
  }
);
await assert.rejects(() => stalled({ lat: 24, lng: 67 }, { lat: 24.01, lng: 67.01 }), /aborted/);
record("stalled-request-times-out-by-abort", timeoutAborted, "timeout abort reached fetch signal");

record(
  "newer-request-aborts-previous-request",
  /routeAbortController\?\.abort\(\);\s*const controller = new AbortController\(\)/.test(src),
  "refreshRoute aborts before replacing controller"
);
record(
  "old-response-cannot-overwrite-latest-route",
  /if \(seq !== fetchSeq\) return;/.test(src) && /routeAbortController === controller/.test(src),
  "sequence guard and controller ownership present"
);

if (results.some((r) => r.status === "FAIL")) process.exitCode = 1;
