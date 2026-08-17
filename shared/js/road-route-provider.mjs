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
 * Attach structured routing failure diagnostics for console / two-leg fallback.
 * @param {Error} err
 * @param {object} fields
 */
export function attachRouteProviderDiag(err, fields = {}) {
  const snippet =
    fields.responseBodySnippet == null
      ? null
      : String(fields.responseBodySnippet).slice(0, 500);
  err.diag = {
    providerKind: fields.providerKind || ROUTE_PROVIDER_KIND.OSRM_PREVIEW,
    requestUrl: fields.requestUrl ?? null,
    httpStatus: fields.httpStatus ?? null,
    responseBodySnippet: snippet,
    timeoutMs: fields.timeoutMs ?? null,
    timeoutReason: fields.timeoutReason ?? null,
    networkError: fields.networkError === true,
    corsOrNetworkLikely: fields.corsOrNetworkLikely === true,
    errorCode: err.code || fields.errorCode || null,
    errorMessage: String(err.message || fields.errorMessage || "").slice(0, 200),
    fallbackTrigger: fields.fallbackTrigger || null,
  };
  return err;
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
        attachRouteProviderDiag(err, {
          fallbackTrigger: "fetch_unavailable",
          errorCode: "unavailable",
        });
        throw err;
      }
      if (req.signal?.aborted) {
        const err = new Error("ABORTED");
        err.code = "aborted";
        attachRouteProviderDiag(err, {
          timeoutReason: "external_abort",
          timeoutMs,
          fallbackTrigger: "external_abort_before_fetch",
        });
        throw err;
      }
      const o = req.origin;
      const d = req.destination;
      const coords = `${o.lng},${o.lat};${d.lng},${d.lat}`;
      const url = `${base}/${coords}?overview=full&geometries=geojson&alternatives=false&steps=false`;
      const ctrl = new AbortController();
      let timedOut = false;
      const onAbort = () => ctrl.abort();
      req.signal?.addEventListener?.("abort", onAbort);
      const timer = setTimeout(() => {
        timedOut = true;
        ctrl.abort();
      }, timeoutMs);
      try {
        const res = await fetchFn(url, {
          headers: { Accept: "application/json" },
          signal: ctrl.signal,
        });
        if (!res.ok) {
          let bodySnippet = null;
          try {
            bodySnippet = await res.text();
          } catch {
            bodySnippet = null;
          }
          const err = new Error(`OSRM_${res.status}`);
          err.code = "unavailable";
          attachRouteProviderDiag(err, {
            requestUrl: url,
            httpStatus: res.status,
            responseBodySnippet: bodySnippet,
            timeoutMs,
            fallbackTrigger: "http_error",
          });
          throw err;
        }
        const data = await res.json();
        const route = data?.routes?.[0];
        if (data?.code !== "Ok" || !route?.geometry?.coordinates?.length) {
          const err = new Error("OSRM_NO_ROUTE");
          err.code = "invalid_response";
          let bodySnippet = null;
          try {
            bodySnippet = JSON.stringify(data);
          } catch {
            bodySnippet = String(data?.code || "");
          }
          attachRouteProviderDiag(err, {
            requestUrl: url,
            httpStatus: res.status,
            responseBodySnippet: bodySnippet,
            timeoutMs,
            fallbackTrigger: "osrm_no_route",
          });
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
          attachRouteProviderDiag(err, {
            requestUrl: url,
            httpStatus: res.status,
            timeoutMs,
            fallbackTrigger: "geometry_validation_failed",
            errorMessage: validated.reason,
          });
          throw err;
        }
        return validated.route;
      } catch (err) {
        if (err?.diag) throw err;
        if (err?.name === "AbortError" || err?.code === "aborted") {
          const e = new Error(timedOut ? "TIMEOUT" : "ABORTED");
          e.code = timedOut ? "timeout" : "aborted";
          attachRouteProviderDiag(e, {
            requestUrl: url,
            timeoutMs,
            timeoutReason: timedOut ? "request_timeout" : "external_abort",
            fallbackTrigger: timedOut ? "request_timeout" : "external_abort",
          });
          throw e;
        }
        const e = err instanceof Error ? err : new Error(String(err?.message || err || "OSRM_FETCH_FAILED"));
        if (!e.code) e.code = "unavailable";
        const msg = String(e.message || "").toLowerCase();
        const corsOrNetworkLikely =
          e.name === "TypeError" ||
          msg.includes("failed to fetch") ||
          msg.includes("networkerror") ||
          msg.includes("cors");
        attachRouteProviderDiag(e, {
          requestUrl: url,
          timeoutMs,
          networkError: true,
          corsOrNetworkLikely,
          fallbackTrigger: corsOrNetworkLikely ? "cors_or_network" : "fetch_threw",
        });
        throw e;
      } finally {
        clearTimeout(timer);
        req.signal?.removeEventListener?.("abort", onAbort);
      }
    },
  };
}

/**
 * Resolve runtime provider. Default: disabled unless configured.
 * window.__SWIFTGO_ROUTE_PROVIDER__ = { kind: "osrm_preview"|"mock"|"disabled", enabled?: true, ... }
 *
 * Hosted apps should call installDefaultOsrmPreviewRouteProvider() at startup
 * (same public OSRM already used for booking). Unset global stays disabled for tests.
 */
export function resolveRouteProvider(globalObj = typeof globalThis !== "undefined" ? globalThis : {}) {
  const cfg = globalObj?.__SWIFTGO_ROUTE_PROVIDER__ || {};
  const kind = String(cfg.kind || ROUTE_PROVIDER_KIND.DISABLED);
  if (kind === ROUTE_PROVIDER_KIND.MOCK) return createMockRouteProvider(cfg);
  if (kind === ROUTE_PROVIDER_KIND.FIXTURE) return createFixtureRouteProvider(cfg.fixtures || {});
  if (kind === ROUTE_PROVIDER_KIND.OSRM_PREVIEW) {
    // Explicit opt-in only — never silently enable public OSRM from an empty global.
    if (cfg.enabled === true) return createOsrmPreviewProvider(cfg);
  }
  return {
    id: ROUTE_PROVIDER_KIND.DISABLED,
    previewOnly: true,
    async route() {
      const err = new Error("PROVIDER_DISABLED");
      err.code = "unavailable";
      attachRouteProviderDiag(err, {
        providerKind: ROUTE_PROVIDER_KIND.DISABLED,
        fallbackTrigger: "provider_disabled_config",
        errorCode: "unavailable",
      });
      throw err;
    },
  };
}

export { buildDirectFallback };
