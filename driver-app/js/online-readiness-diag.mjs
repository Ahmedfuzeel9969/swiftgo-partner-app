/**
 * Privacy-safe online-readiness diagnostics — no coordinates or PII.
 */

const PREFIX = "[SwiftGo Partner readiness]";

/**
 * @param {string} event
 * @param {{ durationMs?: number, state?: string, category?: string }} [meta]
 */
export function logOnlineReadinessEvent(event, meta = {}) {
  const payload = { event, ts: Date.now() };
  if (Number.isFinite(meta.durationMs)) payload.durationMs = Math.round(meta.durationMs);
  if (meta.state) payload.state = meta.state;
  if (meta.category) payload.category = meta.category;
  console.info(PREFIX, payload);
}
