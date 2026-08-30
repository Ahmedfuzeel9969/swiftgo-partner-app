/** Single dispatch-policy contract. Units in storage are seconds, in runtime milliseconds.
 * Omitted fields preserve the established defaults. Malformed saved flags fail closed.
 * Rendering cadence is NOT a Firestore billing/read throttle: the ride lifecycle
 * subscription stays attached; only the separate customer-location watch is gated.
 */
export const LOCATION_DELIVERY_FIELDS = Object.freeze({
  p2pFallbackAfterSeconds: Object.freeze({ default: 12, min: 5, max: 60 }),
  firebaseFallbackWriteSeconds: Object.freeze({ default: 4, min: 2, max: 60 }),
  firebaseLocationRenderSeconds: Object.freeze({ default: 4, min: 1, max: 30 }),
  firebaseHealthyApproachSeconds: Object.freeze({ default: 60, min: 10, max: 300, zero: true }),
  firebaseHealthyTripSeconds: Object.freeze({ default: 30, min: 10, max: 300, zero: true }),
  customerLocationFallbackSeconds: Object.freeze({ default: 60, min: 30, max: 300, zero: true }),
});
export const LOCATION_DELIVERY_KEYS = Object.freeze([
  ...Object.keys(LOCATION_DELIVERY_FIELDS), "firebaseLocationFallbackEnabled",
]);

export function validDeliveryValue(key, value) {
  if (key === "firebaseLocationFallbackEnabled") return typeof value === "boolean";
  const field = LOCATION_DELIVERY_FIELDS[key];
  return Boolean(field && Number.isInteger(value) &&
    ((field.zero && value === 0) || (value >= field.min && value <= field.max)));
}

export function normalizeLocationDeliverySettings(raw = {}) {
  const result = {};
  for (const [key, field] of Object.entries(LOCATION_DELIVERY_FIELDS)) {
    result[key] = validDeliveryValue(key, raw[key]) ? raw[key] : field.default;
  }
  result.firebaseLocationFallbackEnabled = raw.firebaseLocationFallbackEnabled === undefined ||
    raw.firebaseLocationFallbackEnabled === true;
  return result;
}

/** Strict callable validation: never round/coerce or silently ignore malformed edits. */
export function locationDeliverySettingsPatch(raw = {}) {
  const patch = {};
  for (const key of LOCATION_DELIVERY_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) continue;
    if (!validDeliveryValue(key, raw[key])) {
      throw Object.assign(new Error(`INVALID_LOCATION_POLICY:${key}`), { code: "invalid-argument" });
    }
    patch[key] = raw[key];
  }
  return patch;
}

export function resolveLocationDeliveryPolicy(raw = {}) {
  const s = normalizeLocationDeliverySettings(raw);
  return {
    p2pFirstGraceMs: s.p2pFallbackAfterSeconds * 1000,
    p2pFallbackAfterMs: s.p2pFallbackAfterSeconds * 1000,
    firebaseFallbackEnabled: s.firebaseLocationFallbackEnabled,
    firebaseWriteIntervalMs: s.firebaseFallbackWriteSeconds * 1000,
    firebaseBackupReadIntervalMs: s.firebaseLocationRenderSeconds * 1000,
    firebaseHealthyApproachMs: s.firebaseHealthyApproachSeconds * 1000,
    firebaseHealthyTripMs: s.firebaseHealthyTripSeconds * 1000,
    customerBackgroundReadIntervalMs: s.customerLocationFallbackSeconds * 1000,
  };
}

/** Runtime callers may apply a partial policy without resetting other admin fields. */
export function normalizeRuntimeDeliveryPolicy(raw = {}, previous = resolveLocationDeliveryPolicy()) {
  const mapping = {
    p2pFirstGraceMs: "p2pFallbackAfterSeconds", p2pFallbackAfterMs: "p2pFallbackAfterSeconds",
    firebaseWriteIntervalMs: "firebaseFallbackWriteSeconds",
    firebaseBackupReadIntervalMs: "firebaseLocationRenderSeconds",
    firebaseHealthyApproachMs: "firebaseHealthyApproachSeconds",
    firebaseHealthyTripMs: "firebaseHealthyTripSeconds",
    customerBackgroundReadIntervalMs: "customerLocationFallbackSeconds",
  };
  const result = { ...previous };
  for (const [key, storageKey] of Object.entries(mapping)) {
    if (Object.prototype.hasOwnProperty.call(raw, key)) {
      result[key] = validDeliveryValue(storageKey, raw[key] / 1000) && typeof raw[key] === "number"
        ? raw[key] : resolveLocationDeliveryPolicy()[key];
    }
  }
  if (Object.prototype.hasOwnProperty.call(raw, "firebaseFallbackEnabled")) {
    result.firebaseFallbackEnabled = raw.firebaseFallbackEnabled === true;
  }
  return result;
}
