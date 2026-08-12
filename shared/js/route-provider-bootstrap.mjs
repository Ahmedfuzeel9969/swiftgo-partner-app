/**
 * Hosted-app bootstrap for active-ride road routing.
 *
 * Booking already calls public OSRM directly (customer-app/js/routing.js).
 * Active-ride two-leg routing uses resolveRouteProvider(), which stays disabled
 * until explicitly configured — that mismatch caused route_provider_unavailable
 * and straight-line fallbacks on the live map.
 *
 * This helper opts the app into the same preview OSRM endpoint without changing
 * the safe default for tests (unset global → disabled).
 *
 * Does not override an existing __SWIFTGO_ROUTE_PROVIDER__ object.
 */

/**
 * @param {object} [globalObj]
 * @returns {{ kind: string, enabled: boolean }|object|null}
 */
export function installDefaultOsrmPreviewRouteProvider(
  globalObj = typeof globalThis !== "undefined" ? globalThis : {}
) {
  if (!globalObj || typeof globalObj !== "object") return null;
  const existing = globalObj.__SWIFTGO_ROUTE_PROVIDER__;
  if (existing && typeof existing === "object") return existing;
  const cfg = {
    kind: "osrm_preview",
    enabled: true,
  };
  globalObj.__SWIFTGO_ROUTE_PROVIDER__ = cfg;
  return cfg;
}
