/**
 * Canonical vehicle catalog — single source of truth for vehicleType IDs,
 * legacy aliases, and default advisory rates.
 */

import catalog from "../vehicle-catalog.json" with { type: "json" };

export const CATALOG_SCHEMA_VERSION = catalog.schemaVersion;
export const CATALOG_VERSION = catalog.catalogVersion;

export const CANONICAL_VEHICLE_IDS = Object.freeze([...catalog.canonicalVehicleIds]);

export const LEGACY_VEHICLE_ALIASES = Object.freeze({ ...catalog.legacyAliases });

export const VEHICLE_DISPLAY_LABEL_KEYS = Object.freeze({ ...catalog.displayLabelKeys });

export const VALID_COMMISSION_RANGE = Object.freeze({ ...catalog.validCommissionRange });

const DEFAULT_RATES_RAW = catalog.defaultRates;

/** @type {Readonly<Record<string, Readonly<{ baseFare: number, perKmRate: number, commissionPercent: number, distanceTiers: readonly [], paceTiers: readonly [] }>>>} */
export const DEFAULT_VEHICLE_RATES = Object.freeze(
  Object.fromEntries(
    CANONICAL_VEHICLE_IDS.map((id) => [
      id,
      Object.freeze({
        baseFare: DEFAULT_RATES_RAW[id].baseFare,
        perKmRate: DEFAULT_RATES_RAW[id].perKmRate,
        commissionPercent: DEFAULT_RATES_RAW[id].commissionPercent,
        distanceTiers: Object.freeze([]),
        paceTiers: Object.freeze([]),
      }),
    ])
  )
);

export const DEFAULT_PRICING = Object.freeze({
  baseFare: DEFAULT_VEHICLE_RATES.go.baseFare,
  perKmRate: DEFAULT_VEHICLE_RATES.go.perKmRate,
  commissionPercent: DEFAULT_VEHICLE_RATES.go.commissionPercent,
  vehicles: DEFAULT_VEHICLE_RATES,
});

const CANONICAL_SET = new Set(CANONICAL_VEHICLE_IDS);
const LEGACY_MAP = new Map(
  Object.entries(LEGACY_VEHICLE_ALIASES).map(([legacy, canonical]) => [legacy.toLowerCase(), canonical])
);

/** @type {Map<string, string>} */
const LABEL_TO_CANONICAL = new Map();
for (const [canonicalId, labels] of Object.entries(catalog.nameAliases || {})) {
  for (const label of labels) {
    LABEL_TO_CANONICAL.set(String(label).trim().toLowerCase(), canonicalId);
  }
  LABEL_TO_CANONICAL.set(canonicalId.toLowerCase(), canonicalId);
}

/**
 * @param {unknown} raw
 * @returns {string}
 */
export function normalizeVehicleTypeInput(raw) {
  return String(raw ?? "")
    .trim()
    .toLowerCase();
}

/**
 * @param {string} canonicalId
 * @returns {boolean}
 */
export function isCanonicalVehicleTypeKey(canonicalId) {
  return CANONICAL_SET.has(canonicalId);
}

/**
 * Resolve a stored or inbound vehicle key for READ paths (rides, pricing maps).
 * Legacy aliases map to canonical IDs. Unknown inputs fail explicitly.
 *
 * @param {unknown} raw
 * @returns {{ ok: true, canonicalId: string, source: 'canonical'|'legacy_alias'|'label_alias', input: string, legacyAlias?: string } | { ok: false, code: 'EMPTY_VEHICLE_TYPE'|'UNKNOWN_VEHICLE_TYPE', input: string }}
 */
export function resolveVehicleTypeKeyForRead(raw) {
  const input = normalizeVehicleTypeInput(raw);
  if (!input) {
    return { ok: false, code: "EMPTY_VEHICLE_TYPE", input: "" };
  }
  if (CANONICAL_SET.has(input)) {
    return { ok: true, canonicalId: input, source: "canonical", input };
  }
  const labelCanonical = LABEL_TO_CANONICAL.get(input);
  if (labelCanonical) {
    return {
      ok: true,
      canonicalId: labelCanonical,
      source: "label_alias",
      input,
      legacyAlias: input !== labelCanonical ? input : undefined,
    };
  }
  const legacyCanonical = LEGACY_MAP.get(input);
  if (legacyCanonical) {
    return {
      ok: true,
      canonicalId: legacyCanonical,
      source: "legacy_alias",
      input,
      legacyAlias: input,
    };
  }
  return { ok: false, code: "UNKNOWN_VEHICLE_TYPE", input };
}

/**
 * Resolve display labels (English/Urdu) to canonical IDs.
 * @param {unknown} label
 * @returns {string} canonical ID or empty string when unknown
 */
export function resolveVehicleTypeKeyFromLabel(label) {
  const resolution = resolveVehicleTypeKeyForRead(label);
  return resolution.ok ? resolution.canonicalId : "";
}

/**
 * Assert canonical ID for NEW writes (booking, admin save payloads).
 * @param {unknown} raw
 * @returns {string} canonicalId
 */
export function assertCanonicalVehicleTypeKeyForWrite(raw) {
  const input = normalizeVehicleTypeInput(raw);
  if (!input) {
    const err = new Error("EMPTY_VEHICLE_TYPE");
    err.code = "EMPTY_VEHICLE_TYPE";
    throw err;
  }
  if (!CANONICAL_SET.has(input)) {
    const err = new Error(`NON_CANONICAL_VEHICLE_TYPE:${input}`);
    err.code = "NON_CANONICAL_VEHICLE_TYPE";
    err.input = input;
    throw err;
  }
  return input;
}

/**
 * @param {string} canonicalId
 */
export function getDefaultVehicleRate(canonicalId) {
  if (!isCanonicalVehicleTypeKey(canonicalId)) {
    const err = new Error(`UNKNOWN_VEHICLE_TYPE:${canonicalId}`);
    err.code = "UNKNOWN_VEHICLE_TYPE";
    throw err;
  }
  return DEFAULT_VEHICLE_RATES[canonicalId];
}

/**
 * Lookup a vehicle rate entry from settings/pricing vehicles map.
 * Accepts canonical keys and legacy stored keys; never maps unknown to go.
 *
 * @param {Record<string, unknown>|null|undefined} vehiclesMap
 * @param {{ ok: true, canonicalId: string, input: string, legacyAlias?: string }} resolution
 */
export function lookupPricingVehicleEntry(vehiclesMap, resolution) {
  const vehicles = vehiclesMap && typeof vehiclesMap === "object" ? vehiclesMap : {};
  const { canonicalId, input, legacyAlias } = resolution;
  if (vehicles[canonicalId]) return vehicles[canonicalId];
  if (input && vehicles[input]) return vehicles[input];
  if (legacyAlias && legacyAlias !== canonicalId && vehicles[legacyAlias]) {
    return vehicles[legacyAlias];
  }
  return null;
}

/**
 * @param {Record<string, unknown>|null|undefined} vehiclesMap
 * @param {unknown} rawKey
 */
export function resolveKnownVehicleRateFromMap(vehiclesMap, rawKey) {
  const resolution = resolveVehicleTypeKeyForRead(rawKey);
  if (!resolution.ok) {
    const err = new Error(`${resolution.code}:${resolution.input}`);
    err.code = resolution.code;
    err.diagnostic = resolution;
    throw err;
  }
  const entry = lookupPricingVehicleEntry(vehiclesMap, resolution);
  return {
    resolution,
    entry,
    defaults: getDefaultVehicleRate(resolution.canonicalId),
  };
}

/** Stable JSON payload for parity checks (browser vs Functions data copy). */
export function exportCatalogDataForParity() {
  return {
    schemaVersion: catalog.schemaVersion,
    catalogVersion: catalog.catalogVersion,
    canonicalVehicleIds: [...catalog.canonicalVehicleIds],
    legacyAliases: { ...catalog.legacyAliases },
    defaultRates: JSON.parse(JSON.stringify(catalog.defaultRates)),
    displayLabelKeys: { ...catalog.displayLabelKeys },
    nameAliases: JSON.parse(JSON.stringify(catalog.nameAliases || {})),
    validCommissionRange: { ...catalog.validCommissionRange },
  };
}
