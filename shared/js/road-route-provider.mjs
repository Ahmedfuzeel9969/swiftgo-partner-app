/**
 * Phase 4 — provider-neutral road route providers.
 *
 * Public OSRM (router.project-osrm.org) is development/preview only:
 * - no availability / SLA / traffic guarantee
 * - must not be treated as production
 * - do not increase uncontrolled request volume
 *
 * No paid provider. No API keys in source.
 */

import {
  buildDirectFallback,
  validateRouteResult,
} from "./route-geometry.mjs";

export const ROUTE_PROVIDER_KIND = Object.freeze({
  MOCK: "mock",
  FIXTURE: "fixture",
  OSRM_PREVIEW: "osrm_preview",
  DISABLED: "disabled",
});

export const ROUTE_REQUEST_TIMEOUT_MS = 12_000;

/**
 * @typedef {{
 *   origin: {lat:number,lng:number},
 *   destination: {lat:number,lng:number},
 *   mode?: string,
 *   alternatives?: boolean,
 *   signal?: AbortSignal,
 *   context?: object,
 * }} RouteRequest
 */

/**
 * @typedef {{
 *   provider: string,
 *   geometry: Array<{lat:number,lng:number}|[number,number]>,
 *   distanceMeters: number,
 *   durationSeconds: number,
 *   generatedAt: number,
 *   attribution: string,
 *   quality: string,
 *   version?: number,
 * }} RouteResult
 */

function assertCoords(req) {
  const o = req?.origin;
  const d = req?.destination;
  if (
    typeof o?.lat !== "number" ||
    typeof o?.lng !== "number" ||
    typeof d?.lat !== "number" ||
    typeof d?.lng !== "number"
  ) {
    const err = new Error("INVALID_COORDS");
    err.code = "invalid_argument";
    throw err;
  }
}

/** Deterministic mock: straight polyline with midpoints for tests. */
export function createMockRouteProvider(opts = {}) {
  const delayMs = Number(opts.delayMs) || 0;
  const fail = Boolean(opts.fail);
  return {
    id: ROUTE_PROVIDER_KIND.MOCK,
    previewOnly: true,
    async route(req) {
      assertCoords(req);
      if (req.signal?.aborted) {
        const err = new Error("ABORTED");
        err.code = "aborted";
        throw err;
      }
      if (fail) {
        const err = new Error("MOCK_UNAVAILABLE");
        err.code = "unavailable";
        throw err;
      }
      if (delayMs > 0) {
        await new Promise((resolve, reject) => {
          const t = setTimeout(resolve, delayMs);
          req.signal?.addEventListener?.("abort", () => {
            clearTimeout(t);
            const err = new Error("ABORTED");
            err.code = "aborted";
            reject(err);
          });
        });
      }
      const o = req.origin;
      const d = req.destination;
      const mid = { lat: (o.lat + d.lat) / 2, lng: (o.lng + d.lng) / 2 };
      const geometry = [o, mid, d];
      const distanceMeters =
        Math.hypot((d.lat - o.lat) * 111_320, (d.lng - o.lng) * 111_320 * Math.cos((o.lat * Math.PI) / 180)) *
        1.15;
      const raw = {
        provider: ROUTE_PROVIDER_KIND.MOCK,
        geometry,
        distanceMeters,
        durationSeconds: Math.max(60, distanceMeters / 8),
        generatedAt: Date.now(),
        attribution: "Mock provider (test)",
        quality: "fixture",
        version: 1,
      };
      const validated = validateRouteResult(raw, { origin: o, destination: d });
      if (!validated.ok) {
        const err = new Error(validated.reason);
        err.code = "invalid_response";
        throw err;
      }
      return validated.route;
    },
  };
}

/** Fixture map keyed by "olat,olng|dlat,dlng" rounded. */
export function createFixtureRouteProvider(fixtures = {}) {
  return {
    id: ROUTE_PROVIDER_KIND.FIXTURE,
    previewOnly: true,
    async route(req) {
      assertCoords(req);
      if (req.signal?.aborted) {
        const err = new Error("ABORTED");
        err.code = "aborted";
        throw err;
      }
      const key = `${req.origin.lat.toFixed(4)},${req.origin.lng.toFixed(4)}|${req.destination.lat.toFixed(4)},${req.destination.lng.toFixed(4)}`;
      const hit = fixtures[key] || fixtures["*"];
      if (!hit) {
        const err = new Error("FIXTURE_MISS");
        err.code = "unavailable";
        throw err;
      }
      const validated = validateRouteResult(
        { ...hit, provider: ROUTE_PROVIDER_KIND.FIXTURE, version: 1, generatedAt: Date.now() },
        { origin: req.origin, destination: req.destination }
      );
      if (!validated.ok) {
        const err = new Error(validated.reason);
        err.code = "invalid_response";
        throw err;
      }
      return validated.route;
    },
  };
}

/**
 * Public OSRM adapter — preview/dev only. Feature-gated.
 * Endpoint: https://router.project-osrm.org/route/v1/driving
 */
export function createOsrmPreviewProvider(opts = {}) {
  const base =
    String(opts.baseUrl || "https://router.project-osrm.org/route/v1/driving").replace(/\/$/, "");
  const timeoutMs = opts.timeoutMs ?? ROUTE_REQUEST_TIMEOUT_MS;
  const fetchFn = opts.fetchFn || (typeof fetch !== "undefined" ? fetch.bind(globalThis) : null);

  return {
    id: ROUTE_PROVIDER_KIND.OSRM_PREVIEW,
    previewOnly: true,
    label:
      "OSRM public demo (development/preview only — no SLA, no traffic, not for production)",
    async route(req) {
      assertCoords(req);
      if (!fetchFn) {
        const err = new Error("FETCH_UNAVAILABLE");
        err.code = "unavailable";
        throw err;
      }
      if (req.signal?.aborted) {
        const err = new Error("ABORTED");
        err.code = "aborted";
        throw err;
      }
      const o = req.origin;
      const d = req.destination;
      const coords = `${o.lng},${o.lat};${d.lng},${d.lat}`;
      const url = `${base}/${coords}?overview=full&geometries=geojson&alternatives=false&steps=false`;
      const ctrl = new AbortController();
      const onAbort = () => ctrl.abort();
      req.signal?.addEventListener?.("abort", onAbort);
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetchFn(url, {
          headers: { Accept: "application/json" },
          signal: ctrl.signal,
        });
        if (!res.ok) {
          const err = new Error(`OSRM_${res.status}`);
          err.code = "unavailable";
          throw err;
        }
        const data = await res.json();
        const route = data?.routes?.[0];
        if (data?.code !== "Ok" || !route?.geometry?.coordinates?.length) {
          const err = new Error("OSRM_NO_ROUTE");
          err.code = "invalid_response";
          throw err;
        }
        const raw = {
          provider: ROUTE_PROVIDER_KIND.OSRM_PREVIEW,
          geometry: route.geometry.coordinates,
          distanceMeters: Number(route.distance),
          durationSeconds: Number(route.duration),
          generatedAt: Date.now(),
          attribution: "OSRM (preview)",
          quality: "preview",
          version: 1,
        };
        const validated = validateRouteResult(raw, { origin: o, destination: d });
        if (!validated.ok) {
          const err = new Error(validated.reason);
          err.code = "invalid_response";
          throw err;
        }
        return validated.route;
      } catch (err) {
        if (err?.name === "AbortError" || err?.code === "aborted") {
          const e = new Error("ABORTED");
          e.code = "aborted";
          throw e;
        }
        throw err;
      } finally {
        clearTimeout(timer);
        req.signal?.removeEventListener?.("abort", onAbort);
      }
    },
  };
}

/**
 * Resolve runtime provider. Default: mock in tests, disabled unless configured.
 * window.__SWIFTGO_ROUTE_PROVIDER__ = { kind: "osrm_preview"|"mock"|"disabled", ... }
 */
export function resolveRouteProvider(globalObj = typeof globalThis !== "undefined" ? globalThis : {}) {
  const cfg = globalObj?.__SWIFTGO_ROUTE_PROVIDER__ || {};
  const kind = String(cfg.kind || ROUTE_PROVIDER_KIND.DISABLED);
  if (kind === ROUTE_PROVIDER_KIND.MOCK) return createMockRouteProvider(cfg);
  if (kind === ROUTE_PROVIDER_KIND.FIXTURE) return createFixtureRouteProvider(cfg.fixtures || {});
  if (kind === ROUTE_PROVIDER_KIND.OSRM_PREVIEW) {
    // Explicit opt-in only — never silently enable public OSRM in production builds.
    if (cfg.enabled === true) return createOsrmPreviewProvider(cfg);
  }
  return {
    id: ROUTE_PROVIDER_KIND.DISABLED,
    previewOnly: true,
    async route() {
      const err = new Error("PROVIDER_DISABLED");
      err.code = "unavailable";
      throw err;
    },
  };
}

export { buildDirectFallback };
