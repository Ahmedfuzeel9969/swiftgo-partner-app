/**
 * Durable pending final location report index (localStorage).
 * Retries survive timeout, sign-out, and app restart until server ack.
 */

export const RIDE_LOCATION_REPORT_PENDING_QUEUE_VERSION = 1;
const INDEX_KEY = `swiftgo_rlr_pending:v${RIDE_LOCATION_REPORT_PENDING_QUEUE_VERSION}`;
export const RIDE_LOCATION_REPORT_PENDING_MAX_ENTRIES = 32;

function safeParse(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function entryKey(entry) {
  return `${entry.role}:${entry.rideId}:${entry.assignmentSessionTokenHash}`;
}

export function readPendingQueue(storage) {
  const parsed = safeParse(storage?.getItem?.(INDEX_KEY));
  if (!parsed || parsed.version !== RIDE_LOCATION_REPORT_PENDING_QUEUE_VERSION) {
    return [];
  }
  return Array.isArray(parsed.entries) ? parsed.entries : [];
}

function writePendingQueue(storage, entries) {
  storage?.setItem?.(
    INDEX_KEY,
    JSON.stringify({
      version: RIDE_LOCATION_REPORT_PENDING_QUEUE_VERSION,
      entries,
      updatedAtMs: Date.now(),
    })
  );
}

/**
 * @param {object} storage
 * @param {{
 *   rideId: string,
 *   role: "driver" | "customer",
 *   assignmentSessionTokenHash: string,
 *   section: object,
 *   finalSubmit?: boolean,
 * }} entry
 */
export function enqueuePendingReport(storage, entry) {
  if (!entry?.rideId || !entry?.assignmentSessionTokenHash || !entry?.section) {
    return { ok: false, reason: "invalid_entry" };
  }
  const list = readPendingQueue(storage);
  const key = entryKey(entry);
  const filtered = list.filter((row) => entryKey(row) !== key);
  filtered.unshift({
    rideId: entry.rideId,
    role: entry.role,
    assignmentSessionTokenHash: entry.assignmentSessionTokenHash,
    section: entry.section,
    finalSubmit: entry.finalSubmit === true,
    enqueuedAtMs: Date.now(),
    attempts: 0,
  });
  writePendingQueue(storage, filtered.slice(0, RIDE_LOCATION_REPORT_PENDING_MAX_ENTRIES));
  return { ok: true };
}

export function removePendingReport(storage, { rideId, role, assignmentSessionTokenHash }) {
  const list = readPendingQueue(storage);
  const key = entryKey({ rideId, role, assignmentSessionTokenHash });
  const next = list.filter((row) => entryKey(row) !== key);
  writePendingQueue(storage, next);
  return { ok: true, removed: list.length - next.length };
}

export function bumpPendingAttempt(storage, { rideId, role, assignmentSessionTokenHash }) {
  const list = readPendingQueue(storage);
  const key = entryKey({ rideId, role, assignmentSessionTokenHash });
  for (const row of list) {
    if (entryKey(row) === key) {
      row.attempts = (row.attempts || 0) + 1;
      row.lastAttemptAtMs = Date.now();
    }
  }
  writePendingQueue(storage, list);
}
