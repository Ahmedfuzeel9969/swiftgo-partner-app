/**
 * Driver fresh-location + ONLINE_READY state machine regression tests.
 * Run: npm run test:driver-fresh-location-online
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createFreshLocationService,
  FRESH_LOCATION_APP_TIMEOUT_MS,
  FRESH_LOCATION_BROWSER_TIMEOUT_MS,
  isValidGpsCoord,
  LOCATION_FAILURE,
  LOCATION_FAILURE_URDU,
} from "../driver-app/js/fresh-location.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "tests", "driver-fresh-location-online-results.json");
const results = [];

function record(name, status, detail = "") {
  results.push({ name, status, detail, suite: "driver-fresh-location-online" });
  const mark = status === "PASS" ? "✓" : status === "FAIL" ? "✗" : "·";
  console.log(`${mark} ${name} — ${status}${detail ? `: ${detail}` : ""}`);
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class MockClassList {
  constructor() {
    this._ = new Set();
  }
  add(...names) {
    names.forEach((n) => this._.add(n));
  }
  remove(...names) {
    names.forEach((n) => this._.delete(n));
  }
  toggle(name, on) {
    if (on) this.add(name);
    else this.remove(name);
  }
  has(name) {
    return this._.has(name);
  }
}

function createMockGeolocation() {
  /** @type {Array<(pos: GeolocationPosition) => void>} */
  const successQueue = [];
  /** @type {Array<(err: GeolocationPositionError) => void>} */
  const errorQueue = [];
  let lastOptions = null;

  return {
    getCurrentPosition(success, error, options) {
      lastOptions = options;
      successQueue.length = 0;
      errorQueue.length = 0;
      successQueue.push(success);
      errorQueue.push(error);
    },
    emitSuccess(lat, lng) {
      const cb = successQueue.shift();
      if (!cb) return false;
      cb({
        coords: { latitude: lat, longitude: lng, accuracy: 12 },
        timestamp: Date.now(),
      });
      return true;
    },
    emitError(code) {
      const cb = errorQueue.shift();
      if (!cb) return false;
      cb({ code, message: `geo-${code}` });
      return true;
    },
    get lastOptions() {
      return lastOptions;
    },
    pendingCount() {
      return successQueue.length;
    },
  };
}

const ONLINE_READINESS = Object.freeze({
  OFFLINE: "offline",
  LOCATING: "locating",
  WRITING_GEO: "writing_geo",
  ONLINE_READY: "online_ready",
});

/** Minimal UI harness mirroring syncOnlineToggleUi + overlay behaviour. */
function createUiHarness() {
  const btn = {
    classList: new MockClassList(),
    disabled: false,
    ariaChecked: "false",
  };
  const overlay = { hidden: true, text: "" };
  let online = false;
  let onlineReadiness = ONLINE_READINESS.OFFLINE;
  let radarStarted = false;
  let inboxStarted = false;

  function syncOnlineToggleUi(value, connectingPhase = "") {
    const connecting = Boolean(connectingPhase);
    btn.classList.remove("is-online", "is-connecting");
    btn.classList.toggle("is-online", value && !connecting);
    btn.classList.toggle("is-connecting", connecting);
    btn.disabled = connecting;
    btn.ariaChecked = String(value && !connecting);
  }

  function showConnectingOverlay(phase = ONLINE_READINESS.LOCATING) {
    overlay.hidden = false;
    overlay.text =
      phase === ONLINE_READINESS.WRITING_GEO
        ? "مقام سرور پر محفوظ ہو رہا ہے…"
        : "لوکیشن حاصل ہو رہی ہے…";
  }

  function hideConnectingOverlay() {
    overlay.hidden = true;
  }

  function setConnectingUi(phase) {
    online = false;
    onlineReadiness = phase;
    syncOnlineToggleUi(false, phase);
    showConnectingOverlay(phase);
  }

  function setOnlineUi(value) {
    online = value;
    onlineReadiness = value ? ONLINE_READINESS.ONLINE_READY : ONLINE_READINESS.OFFLINE;
    syncOnlineToggleUi(value);
    if (value) {
      radarStarted = true;
      inboxStarted = true;
    }
  }

  function failToOffline() {
    online = false;
    onlineReadiness = ONLINE_READINESS.OFFLINE;
    hideConnectingOverlay();
    syncOnlineToggleUi(false);
    radarStarted = false;
    inboxStarted = false;
  }

  function isOnlineReady() {
    return online && onlineReadiness === ONLINE_READINESS.ONLINE_READY;
  }

  return {
    btn,
    overlay,
    get online() {
      return online;
    },
    get onlineReadiness() {
      return onlineReadiness;
    },
    get radarStarted() {
      return radarStarted;
    },
    get inboxStarted() {
      return inboxStarted;
    },
    setConnectingUi,
    setOnlineUi,
    failToOffline,
    hideConnectingOverlay,
    isOnlineReady,
    syncOnlineToggleUi,
  };
}

/** Activation harness using canonical fresh-location service. */
function createActivationHarness(options = {}) {
  const ui = createUiHarness();
  const geo = options.geo ?? createMockGeolocation();
  const locService = createFreshLocationService({
    geolocation: geo,
    appTimeoutMs: options.appTimeoutMs ?? 80,
    browserTimeoutMs: options.browserTimeoutMs ?? 60,
  });
  let writeCalls = 0;
  let writeShouldFail = options.writeShouldFail ?? false;
  let activationAbort = null;
  /** @type {Promise<boolean> | null} */
  let activationPromise = null;
  let lastGpsFixAtMs = 0;
  /** @type {{ lat: number, lng: number } | null} */
  let lastDriverPosition = null;
  const FRESH_GPS_MS = 120_000;

  function resolveInSessionFreshGpsFix() {
    if (
      lastDriverPosition &&
      lastGpsFixAtMs > 0 &&
      Date.now() - lastGpsFixAtMs <= FRESH_GPS_MS &&
      isValidGpsCoord(lastDriverPosition.lat, lastDriverPosition.lng)
    ) {
      return { ...lastDriverPosition };
    }
    return null;
  }

  async function writeOnlineReadyVehicle(lat, lng) {
    writeCalls += 1;
    if (writeShouldFail) throw new Error("GEO_WRITE_FAILED");
    if (!isValidGpsCoord(lat, lng)) throw new Error("INVALID_COORD");
    await delay(options.writeDelayMs ?? 0);
    if (activationAbort?.signal.aborted) throw new Error("CANCELLED");
  }

  async function activateDriverOnlineMode() {
    if (activationPromise) return activationPromise;
    if (ui.isOnlineReady()) return true;

    activationAbort = new AbortController();
    activationPromise = (async () => {
      try {
        ui.setConnectingUi(ONLINE_READINESS.LOCATING);
        let lat;
        let lng;
        const inSession = resolveInSessionFreshGpsFix();
        if (inSession) {
          lat = inSession.lat;
          lng = inSession.lng;
        } else {
          const fix = await locService.requestFreshLocation({
            signal: activationAbort.signal,
          });
          lat = fix.lat;
          lng = fix.lng;
          lastDriverPosition = { lat, lng };
          lastGpsFixAtMs = Date.now();
        }

        if (activationAbort.signal.aborted) {
          ui.failToOffline();
          return false;
        }

        ui.setConnectingUi(ONLINE_READINESS.WRITING_GEO);
        try {
          await writeOnlineReadyVehicle(lat, lng);
        } catch {
          ui.failToOffline();
          return false;
        }

        if (activationAbort.signal.aborted) {
          ui.failToOffline();
          return false;
        }

        ui.hideConnectingOverlay();
        ui.setOnlineUi(true);
        return true;
      } catch {
        ui.failToOffline();
        return false;
      } finally {
        ui.hideConnectingOverlay();
        activationPromise = null;
        activationAbort = null;
        if (!ui.isOnlineReady()) ui.syncOnlineToggleUi(false);
      }
    })();

    return activationPromise;
  }

  function cancelActivation() {
    activationAbort?.abort();
    locService.invalidate();
    ui.failToOffline();
  }

  return {
    ui,
    geo,
    locService,
    activateDriverOnlineMode,
    cancelActivation,
    get writeCalls() {
      return writeCalls;
    },
    set writeShouldFail(v) {
      writeShouldFail = v;
    },
    seedInSessionFix(lat, lng, ageMs = 1000) {
      lastDriverPosition = { lat, lng };
      lastGpsFixAtMs = Date.now() - ageMs;
    },
  };
}

async function freshLocationTests() {
  record("01-fresh-valid-location-succeeds", "PENDING");
  {
    const geo = createMockGeolocation();
    const svc = createFreshLocationService({
      geolocation: geo,
      appTimeoutMs: 200,
      browserTimeoutMs: 150,
    });
    const p = svc.requestFreshLocation();
    geo.emitSuccess(24.87, 67.05);
    const fix = await p;
    record(
      "01-fresh-valid-location-succeeds",
      fix.lat === 24.87 && fix.lng === 67.05 ? "PASS" : "FAIL"
    );
  }

  record("02-permission-denied", "PENDING");
  {
    const geo = createMockGeolocation();
    const svc = createFreshLocationService({ geolocation: geo, appTimeoutMs: 200 });
    const p = svc.requestFreshLocation();
    geo.emitError(1);
    try {
      await p;
      record("02-permission-denied", "FAIL", "expected reject");
    } catch (e) {
      record(
        "02-permission-denied",
        e.category === LOCATION_FAILURE.PERMISSION_DENIED ? "PASS" : "FAIL",
        e.category
      );
    }
  }

  record("03-position-unavailable", "PENDING");
  {
    const geo = createMockGeolocation();
    const svc = createFreshLocationService({ geolocation: geo, appTimeoutMs: 200 });
    const p = svc.requestFreshLocation();
    geo.emitError(2);
    try {
      await p;
      record("03-position-unavailable", "FAIL");
    } catch (e) {
      record(
        "03-position-unavailable",
        e.category === LOCATION_FAILURE.UNAVAILABLE ? "PASS" : "FAIL"
      );
    }
  }

  record("04-browser-callback-never-fires", "PENDING");
  {
    const geo = createMockGeolocation();
    const svc = createFreshLocationService({
      geolocation: geo,
      appTimeoutMs: 60,
      browserTimeoutMs: 5000,
    });
    const started = Date.now();
    try {
      await svc.requestFreshLocation();
      record("04-browser-callback-never-fires", "FAIL", "expected timeout");
    } catch (e) {
      const elapsed = Date.now() - started;
      record(
        "04-browser-callback-never-fires",
        e.category === LOCATION_FAILURE.TIMEOUT && elapsed >= 55 && elapsed < 250 ? "PASS" : "FAIL",
        `${e.category} ${elapsed}ms`
      );
    }
  }

  record("05-app-timeout-returns-offline", "PENDING");
  {
    const harness = createActivationHarness({ appTimeoutMs: 50, browserTimeoutMs: 5000 });
    const p = harness.activateDriverOnlineMode();
    const ok = await p;
    record(
      "05-app-timeout-returns-offline",
      !ok &&
        harness.ui.onlineReadiness === ONLINE_READINESS.OFFLINE &&
        harness.ui.overlay.hidden &&
        !harness.ui.btn.disabled
        ? "PASS"
        : "FAIL"
    );
  }

  record("06-unsupported-browser", "PENDING");
  {
    const svc = createFreshLocationService({ geolocation: null });
    try {
      await svc.requestFreshLocation();
      record("06-unsupported-browser", "FAIL");
    } catch (e) {
      record(
        "06-unsupported-browser",
        e.category === LOCATION_FAILURE.UNSUPPORTED ? "PASS" : "FAIL"
      );
    }
  }

  record("07-invalid-coordinates-rejected", "PENDING");
  {
    const geo = createMockGeolocation();
    const svc = createFreshLocationService({ geolocation: geo, appTimeoutMs: 200 });
    const p = svc.requestFreshLocation();
    geo.emitSuccess(0, 0);
    try {
      await p;
      record("07-invalid-coordinates-rejected", "FAIL");
    } catch (e) {
      record(
        "07-invalid-coordinates-rejected",
        e.category === LOCATION_FAILURE.INVALID ? "PASS" : "FAIL"
      );
    }
  }

  record("08-duplicate-clicks-one-request", "PENDING");
  {
    const geo = createMockGeolocation();
    const harness = createActivationHarness({ geo, appTimeoutMs: 500 });
    const a = harness.activateDriverOnlineMode();
    const b = harness.activateDriverOnlineMode();
    const deduped =
      geo.pendingCount() === 1 &&
      harness.locService.isInFlight() &&
      typeof a?.then === "function" &&
      typeof b?.then === "function";
    record("08-duplicate-clicks-one-request", deduped ? "PASS" : "FAIL", `pending=${geo.pendingCount()}`);
    geo.emitSuccess(24.9, 67.1);
    await a;
  }

  record("17-late-success-after-cancel-ignored", "PENDING");
  {
    const geo = createMockGeolocation();
    const svc = createFreshLocationService({ geolocation: geo, appTimeoutMs: 500 });
    const ac = new AbortController();
    const p = svc.requestFreshLocation({ signal: ac.signal });
    ac.abort();
    try {
      await p;
    } catch (e) {
      /* cancelled */
    }
    const late = geo.emitSuccess(24.8, 67.0);
    record(
      "17-late-success-after-cancel-ignored",
      late && !svc.isInFlight() ? "PASS" : "FAIL"
    );
  }

  record("18-late-error-after-cancel-ignored", "PENDING");
  {
    const geo = createMockGeolocation();
    const svc = createFreshLocationService({ geolocation: geo, appTimeoutMs: 500 });
    const ac = new AbortController();
    const p = svc.requestFreshLocation({ signal: ac.signal });
    ac.abort();
    try {
      await p;
    } catch {
      /* cancelled */
    }
    const late = geo.emitError(3);
    record(
      "18-late-error-after-cancel-ignored",
      late && !svc.isInFlight() ? "PASS" : "FAIL"
    );
  }

  record("21-retry-after-timeout", "PENDING");
  {
    const geo = createMockGeolocation();
    const harness = createActivationHarness({ geo, appTimeoutMs: 40, browserTimeoutMs: 5000 });
    const first = await harness.activateDriverOnlineMode();
    await delay(15);
    const secondP = harness.activateDriverOnlineMode();
    geo.emitSuccess(24.86, 67.01);
    const second = await secondP;
    record(
      "21-retry-after-timeout",
      !first && second && harness.ui.isOnlineReady() ? "PASS" : "FAIL"
    );
  }
}

async function activationFlowTests() {
  record("09-pin-link-then-online-activation", "PENDING");
  {
    const harness = createActivationHarness();
    const linked = { status: "offline" };
    const p = harness.activateDriverOnlineMode();
    harness.geo.emitSuccess(24.88, 67.04);
    const ok = await p;
    record(
      "09-pin-link-then-online-activation",
      linked.status === "offline" && ok && harness.ui.isOnlineReady() ? "PASS" : "FAIL"
    );
  }

  record("10-no-green-during-locating", "PENDING");
  {
    const harness = createActivationHarness();
    void harness.activateDriverOnlineMode();
    const ok =
      harness.ui.onlineReadiness === ONLINE_READINESS.LOCATING &&
      !harness.ui.btn.classList.has("is-online") &&
      harness.ui.btn.classList.has("is-connecting");
    record("10-no-green-during-locating", ok ? "PASS" : "FAIL");
    harness.geo.emitSuccess(24.87, 67.05);
    await delay(5);
  }

  record("11-no-green-during-writing-geo", "PENDING");
  {
    const harness = createActivationHarness({ writeDelayMs: 40 });
    const p = harness.activateDriverOnlineMode();
    harness.geo.emitSuccess(24.87, 67.05);
    await delay(5);
    const ok =
      harness.ui.onlineReadiness === ONLINE_READINESS.WRITING_GEO &&
      !harness.ui.btn.classList.has("is-online") &&
      harness.ui.btn.classList.has("is-connecting");
    record("11-no-green-during-writing-geo", ok ? "PASS" : "FAIL");
    await p;
  }

  record("12-overlay-removed-after-success", "PENDING");
  {
    const harness = createActivationHarness();
    const p = harness.activateDriverOnlineMode();
    harness.geo.emitSuccess(24.87, 67.05);
    await p;
    record("12-overlay-removed-after-success", harness.ui.overlay.hidden ? "PASS" : "FAIL");
  }

  record("13-overlay-removed-after-failures", "PENDING");
  {
    const cases = [
      async (h) => {
        const p = h.activateDriverOnlineMode();
        h.geo.emitError(1);
        await p;
      },
      async (h) => {
        const p = h.activateDriverOnlineMode();
        h.geo.emitError(2);
        await p;
      },
      async (h) => {
        await h.activateDriverOnlineMode();
      },
      async (h) => {
        const p = h.activateDriverOnlineMode();
        h.geo.emitSuccess(0, 0);
        await p;
      },
      async (h) => {
        h.writeShouldFail = true;
        const p = h.activateDriverOnlineMode();
        h.geo.emitSuccess(24.87, 67.05);
        await p;
      },
    ];
    let allHidden = true;
    for (const run of cases) {
      const h = createActivationHarness({ appTimeoutMs: 50 });
      await run(h);
      if (!h.ui.overlay.hidden) allHidden = false;
    }
    record("13-overlay-removed-after-failures", allHidden ? "PASS" : "FAIL");
  }

  record("14-toggle-restored-after-failure", "PENDING");
  {
    const harness = createActivationHarness({ appTimeoutMs: 40 });
    await harness.activateDriverOnlineMode();
    record(
      "14-toggle-restored-after-failure",
      !harness.ui.btn.disabled && !harness.ui.btn.classList.has("is-online") ? "PASS" : "FAIL"
    );
  }

  record("15-offline-during-locating-cancels", "PENDING");
  {
    const harness = createActivationHarness();
    void harness.activateDriverOnlineMode();
    harness.cancelActivation();
    await delay(10);
    record(
      "15-offline-during-locating-cancels",
      harness.ui.onlineReadiness === ONLINE_READINESS.OFFLINE &&
        harness.ui.overlay.hidden &&
        !harness.ui.btn.classList.has("is-online")
        ? "PASS"
        : "FAIL"
    );
  }

  record("16-offline-during-writing-geo-cancels", "PENDING");
  {
    const harness = createActivationHarness({ writeDelayMs: 80 });
    void harness.activateDriverOnlineMode();
    harness.geo.emitSuccess(24.87, 67.05);
    await delay(10);
    harness.cancelActivation();
    await delay(20);
    record(
      "16-offline-during-writing-geo-cancels",
      !harness.ui.isOnlineReady() && harness.ui.overlay.hidden ? "PASS" : "FAIL"
    );
  }

  record("19-geo-write-failure-keeps-offline", "PENDING");
  {
    const harness = createActivationHarness();
    harness.writeShouldFail = true;
    const p = harness.activateDriverOnlineMode();
    harness.geo.emitSuccess(24.87, 67.05);
    const ok = await p;
    record(
      "19-geo-write-failure-keeps-offline",
      !ok && !harness.ui.isOnlineReady() ? "PASS" : "FAIL"
    );
  }

  record("20-radar-inbox-not-before-online-ready", "PENDING");
  {
    const harness = createActivationHarness({ writeDelayMs: 50 });
    void harness.activateDriverOnlineMode();
    harness.geo.emitSuccess(24.87, 67.05);
    await delay(5);
    const blockedDuringWrite =
      !harness.ui.isOnlineReady() && !harness.ui.radarStarted && !harness.ui.inboxStarted;
    await delay(60);
    const allowedAfter =
      harness.ui.isOnlineReady() && harness.ui.radarStarted && harness.ui.inboxStarted;
    record(
      "20-radar-inbox-not-before-online-ready",
      blockedDuringWrite && allowedAfter ? "PASS" : "FAIL"
    );
  }

  record("22-post-ride-reactivation-same-helper", "PENDING");
  {
    const driverApp = read("driver-app/js/driver-app.js");
    record(
      "22-post-ride-reactivation-same-helper",
      driverApp.includes("async function reactivateOnlineAfterRideEnd()") &&
        driverApp.includes("return activateDriverOnlineMode()") &&
        driverApp.includes("freshLocationService.requestFreshLocation")
        ? "PASS"
        : "FAIL"
    );
  }

  record("23-pin-linked-offline-when-location-fails", "PENDING");
  {
    const harness = createActivationHarness();
    const p = harness.activateDriverOnlineMode();
    harness.geo.emitError(1);
    const ok = await p;
    record(
      "23-pin-linked-offline-when-location-fails",
      !ok && harness.ui.onlineReadiness === ONLINE_READINESS.OFFLINE ? "PASS" : "FAIL"
    );
  }

  record("24-no-fake-coords-online-ready", "PENDING");
  {
    const driverApp = read("driver-app/js/driver-app.js");
    const fresh = read("driver-app/js/fresh-location.mjs");
    const usesStaleVehicleLocationForOnline =
      /resolveFreshVehicleLocation/.test(driverApp) ||
      /STALE_LOCATION_MS/.test(driverApp) ||
      /awaitQuickGpsFix/.test(driverApp);
    record(
      "24-no-fake-coords-online-ready",
      !usesStaleVehicleLocationForOnline &&
        fresh.includes("maximumAge: 0") &&
        driverApp.includes("resolveInSessionFreshGpsFix") &&
        driverApp.includes("never vehicle doc")
        ? "PASS"
        : "FAIL"
    );
  }
}

function staticContractTests() {
  const driverApp = read("driver-app/js/driver-app.js");
  const html = read("driver-app/index.html");
  const css = read("driver-app/css/driver-style.css");

  record(
    "S01-canonical-fresh-location-import",
    driverApp.includes('from "./fresh-location.mjs"') &&
      driverApp.includes("freshLocationService.requestFreshLocation")
      ? "PASS"
      : "FAIL"
  );

  record(
    "S02-finite-timeouts-configured",
    read("driver-app/js/fresh-location.mjs").includes("FRESH_LOCATION_APP_TIMEOUT_MS = 18_000") &&
      read("driver-app/js/fresh-location.mjs").includes("FRESH_LOCATION_BROWSER_TIMEOUT_MS = 15_000")
      ? "PASS"
      : "FAIL"
  );

  record(
    "S03-connecting-overlay-dom",
    html.includes('id="driverConnectingOverlay"') &&
      html.includes('id="driverConnectingOverlayText"')
      ? "PASS"
      : "FAIL"
  );

  record(
    "S04-ui-state-urdu-messages",
    driverApp.includes("لوکیشن حاصل ہو رہی ہے…") &&
      driverApp.includes("مقام سرور پر محفوظ ہو رہا ہے…") &&
      LOCATION_FAILURE_URDU[LOCATION_FAILURE.PERMISSION_DENIED].includes("اجازت")
      ? "PASS"
      : "FAIL"
  );

  record(
    "S05-setOnlineUi-only-after-geo-write",
    (() => {
      const start = driverApp.indexOf("async function activateDriverOnlineMode()");
      const end = driverApp.indexOf("async function reactivateOnlineAfterRideEnd()", start);
      const block = driverApp.slice(start, end);
      const writeIdx = block.indexOf("await writeOnlineReadyVehicle(lat, lng)");
      const onlineIdx = block.indexOf("setOnlineUi(true)");
      return writeIdx >= 0 && onlineIdx > writeIdx;
    })()
      ? "PASS"
      : "FAIL"
  );

  record(
    "S06-radar-gated-on-isOnlineReady",
    driverApp.includes("isOnlineReady()") &&
      driverApp.match(/function startRadarBackgroundFeed[\s\S]{0,120}isOnlineReady/)
      ? "PASS"
      : "FAIL"
  );

  record(
    "S07-diagnostics-module",
    read("driver-app/js/online-readiness-diag.mjs").includes("logOnlineReadinessEvent") &&
      driverApp.includes("readinessOnEvent")
      ? "PASS"
      : "FAIL"
  );

  record(
    "S08-connecting-overlay-css",
    css.includes(".driver-connecting-overlay") && css.includes(".is-connecting")
      ? "PASS"
      : "FAIL"
  );

  record(
    "S09-no-stale-location-reference",
    !driverApp.includes("STALE_LOCATION_MS") && !driverApp.includes("resolveFreshVehicleLocation")
      ? "PASS"
      : "FAIL"
  );
}

async function main() {
  console.log("\n=== Driver fresh-location / ONLINE_READY suite ===\n");
  await freshLocationTests();
  await activationFlowTests();
  staticContractTests();

  const fail = results.filter((r) => r.status === "FAIL").length;
  const pass = results.filter((r) => r.status === "PASS").length;
  const summary = { suite: "driver-fresh-location-online", pass, fail, total: results.length, results };
  fs.writeFileSync(OUT, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`\n${pass} PASS / ${fail} FAIL (${results.length} total)\n`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
