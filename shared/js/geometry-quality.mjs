/**
 * Phase 5 hardening — immutable route geometry classification.
 * snapEligible is derived only by this module; never trust UI/provider self-declaration.
 */

export const GEOMETRY_KIND = Object.freeze({
  VERIFIED_ROAD_ROUTE: "VERIFIED_ROAD_ROUTE",
  FIXTURE_ROAD_ROUTE: "FIXTURE_ROAD_ROUTE",
  DIRECT_ESTIMATE_FALLBACK: "DIRECT_ESTIMATE_FALLBACK",
  INVALID_GEOMETRY: "INVALID_GEOMETRY",
});

/** Approved adapters that may emit fixture road geometry. */
const APPROVED_FIXTURE_PROVIDERS = new Set(["mock", "fixture"]);
/** Approved adapters that may emit verified/preview road geometry. */
const APPROVED_VERIFIED_PROVIDERS = new Set(["osrm_preview"]);

const SNAP_OK = new Set([
  GEOMETRY_KIND.VERIFIED_ROAD_ROUTE,
  GEOMETRY_KIND.FIXTURE_ROAD_ROUTE,
]);

/**
 * Classify geometry from canonical provider identity only.
 * Ignores inbound snapEligible / geometryKind / arbitrary quality self-claims.
 *
 * @param {{
 *   provider?: string,
 *   providerKind?: string,
 *   quality?: string,
 *   fallback?: boolean,
 * }} input
 */
export function classifyRouteGeometry(input = {}) {
  const provider = String(input.providerKind || input.provider || "")
    .trim()
    .toLowerCase();
  const quality = String(input.quality || "").trim().toLowerCase();
  const fallback = input.fallback === true;

  if (
    fallback ||
    provider === "direct_fallback" ||
    provider === "disabled" ||
    quality === "estimate"
  ) {
    return {
      geometryKind: GEOMETRY_KIND.DIRECT_ESTIMATE_FALLBACK,
      snapEligible: false,
      providerKind: provider || "direct_fallback",
    };
  }

  if (APPROVED_FIXTURE_PROVIDERS.has(provider)) {
    return {
      geometryKind: GEOMETRY_KIND.FIXTURE_ROAD_ROUTE,
      snapEligible: true,
      providerKind: provider,
    };
  }

  if (APPROVED_VERIFIED_PROVIDERS.has(provider)) {
    return {
      geometryKind: GEOMETRY_KIND.VERIFIED_ROAD_ROUTE,
      snapEligible: true,
      providerKind: provider,
    };
  }

  return {
    geometryKind: GEOMETRY_KIND.INVALID_GEOMETRY,
    snapEligible: false,
    providerKind: provider || "unknown",
  };
}

/**
 * Fail closed: missing/malformed/unknown → not snappable.
 * @param {{ geometryKind?: string, snapEligible?: boolean }|null|undefined} meta
 */
export function isSnapEligibleMeta(meta) {
  if (!meta || typeof meta !== "object") return false;
  if (meta.snapEligible !== true) return false;
  const kind = meta.geometryKind;
  if (typeof kind !== "string" || !SNAP_OK.has(kind)) return false;
  return true;
}

/**
 * Strip untrusted eligibility fields before classification.
 */
export function attachGeometryQuality(routeLike = {}) {
  const classified = classifyRouteGeometry({
    provider: routeLike.provider,
    providerKind: routeLike.providerKind,
    quality: routeLike.quality,
    fallback: routeLike.fallback === true,
  });
  return {
    ...routeLike,
    geometryKind: classified.geometryKind,
    snapEligible: classified.snapEligible,
    providerKind: classified.providerKind,
  };
}
