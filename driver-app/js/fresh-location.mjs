/**
 * Canonical fresh GPS read for driver ONLINE_READY — testable, single in-flight, finite timeouts.
 * Never accepts cached vehicle docs, defaults, or stale coordinates for online readiness.
 */

export const FRESH_LOCATION_APP_TIMEOUT_MS = 18_000;
export const FRESH_LOCATION_BROWSER_TIMEOUT_MS = 15_000;

export const LOCATION_FAILURE = Object.freeze({
  UNSUPPORTED: "unsupported",
  PERMISSION_DENIED: "permission_denied",
  UNAVAILABLE: "unavailable",
  TIMEOUT: "timeout",
  INVALID: "invalid",
  CANCELLED: "cancelled",
});

export const LOCATION_FAILURE_URDU = Object.freeze({
  [LOCATION_FAILURE.PERMISSION_DENIED]:
    "مقام کی اجازت نہیں ملی — براؤزر اور کمپیوٹر کی مقام والی اجازت کھولیں",
  [LOCATION_FAILURE.UNAVAILABLE]:
    "موجودہ مقام دستیاب نہیں — انٹرنیٹ اور کمپیوٹر کی مقام والی سہولت جانچیں",
  [LOCATION_FAILURE.TIMEOUT]: "مقام حاصل کرنے میں زیادہ وقت لگ رہا ہے — دوبارہ کوشش کریں",
  [LOCATION_FAILURE.UNSUPPORTED]: "یہ براؤزر مقام حاصل کرنے کی سہولت فراہم نہیں کرتا",
  [LOCATION_FAILURE.INVALID]: "درست مقام حاصل نہیں ہو سکا — دوبارہ کوشش کریں",
  [LOCATION_FAILURE.CANCELLED]: "",
  geo_write_failed: "مقام سرور پر محفوظ نہیں ہو سکا — دوبارہ کوشش کریں",
});

export function isValidGpsCoord(lat, lng) {
  const a = Number(lat);
  const b = Number(lng);
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a) <= 90 && Math.abs(b) <= 180 && !(a === 0 && b === 0);
}

function locationError(category, message = category) {
  const err = new Error(message);
  err.category = category;
  return err;
}

function mapBrowserGeoError(err) {
  const code = Number(err?.code);
  if (code === 1) return LOCATION_FAILURE.PERMISSION_DENIED;
  if (code === 2) return LOCATION_FAILURE.UNAVAILABLE;
  if (code === 3) return LOCATION_FAILURE.TIMEOUT;
  return LOCATION_FAILURE.UNAVAILABLE;
}

/**
 * @param {{
 *   geolocation?: Geolocation | null,
 *   appTimeoutMs?: number,
 *   browserTimeoutMs?: number,
 * }} [deps]
 */
export function createFreshLocationService(deps = {}) {
  const geo = deps.geolocation ?? null;
  const appTimeoutMs = deps.appTimeoutMs ?? FRESH_LOCATION_APP_TIMEOUT_MS;
  const browserTimeoutMs = deps.browserTimeoutMs ?? FRESH_LOCATION_BROWSER_TIMEOUT_MS;

  let generation = 0;
  let inFlight = false;
  /** @type {null | (() => void)} */
  let activeCleanup = null;
  /** @type {Promise<{ lat: number, lng: number }>> | null} */
  let inFlightPromise = null;

  function invalidate(reason = LOCATION_FAILURE.CANCELLED) {
    generation += 1;
    if (activeCleanup) {
      activeCleanup();
      activeCleanup = null;
    }
    inFlight = false;
    inFlightPromise = null;
    return reason;
  }

  /**
   * @param {{ signal?: AbortSignal, onEvent?: (name: string, meta?: object) => void }} [options]
   */
  function requestFreshLocation(options = {}) {
    if (inFlightPromise) return inFlightPromise;

    const gen = ++generation;
    const startedAt = Date.now();
    const onEvent = typeof options.onEvent === "function" ? options.onEvent : () => {};
    const signal = options.signal;

    const abortIfStale = () => gen !== generation || Boolean(signal?.aborted);

    inFlight = true;
    onEvent("locating_started", { state: "locating" });

    inFlightPromise = new Promise((resolve, reject) => {
      if (!geo?.getCurrentPosition) {
        onEvent("locating_unavailable", { category: LOCATION_FAILURE.UNSUPPORTED });
        reject(locationError(LOCATION_FAILURE.UNSUPPORTED));
        return;
      }

      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        if (activeCleanup) {
          activeCleanup = null;
        }
        if (gen === generation) {
          inFlight = false;
          inFlightPromise = null;
        }
        fn(value);
      };

      const appTimer = setTimeout(() => {
        if (abortIfStale()) {
          onEvent("late_location_callback_ignored", { category: LOCATION_FAILURE.TIMEOUT });
          finish(reject, locationError(LOCATION_FAILURE.TIMEOUT));
          return;
        }
        onEvent("locating_timeout", {
          durationMs: Date.now() - startedAt,
          category: LOCATION_FAILURE.TIMEOUT,
        });
        finish(reject, locationError(LOCATION_FAILURE.TIMEOUT));
      }, appTimeoutMs);

      activeCleanup = () => {
        clearTimeout(appTimer);
        if (!settled) {
          onEvent("locating_cancelled", { state: "offline" });
          finish(reject, locationError(LOCATION_FAILURE.CANCELLED));
        }
      };

      if (signal) {
        if (signal.aborted) {
          activeCleanup();
          return;
        }
        signal.addEventListener(
          "abort",
          () => {
            onEvent("offline_during_locating", { state: "offline" });
            invalidate(LOCATION_FAILURE.CANCELLED);
            if (activeCleanup) activeCleanup();
          },
          { once: true }
        );
      }

      geo.getCurrentPosition(
        (pos) => {
          if (abortIfStale()) {
            onEvent("late_location_callback_ignored", { category: "success" });
            return;
          }
          clearTimeout(appTimer);
          const lat = Number(pos?.coords?.latitude);
          const lng = Number(pos?.coords?.longitude);
          if (!isValidGpsCoord(lat, lng)) {
            onEvent("locating_invalid", { category: LOCATION_FAILURE.INVALID });
            finish(reject, locationError(LOCATION_FAILURE.INVALID));
            return;
          }
          onEvent("locating_success", { durationMs: Date.now() - startedAt, state: "locating" });
          finish(resolve, { lat, lng });
        },
        (err) => {
          if (abortIfStale()) {
            onEvent("late_location_callback_ignored", { category: "error" });
            return;
          }
          clearTimeout(appTimer);
          const category = mapBrowserGeoError(err);
          onEvent(`locating_${category}`, {
            durationMs: Date.now() - startedAt,
            category,
          });
          finish(reject, locationError(category));
        },
        {
          enableHighAccuracy: true,
          maximumAge: 0,
          timeout: browserTimeoutMs,
        }
      );
    });

    return inFlightPromise;
  }

  return {
    requestFreshLocation,
    invalidate,
    isInFlight: () => inFlight,
    _testGeneration: () => generation,
  };
}

/** Browser singleton — replaced in tests via createFreshLocationService. */
export const freshLocationService = createFreshLocationService({
  geolocation: typeof navigator !== "undefined" ? navigator.geolocation : null,
});
