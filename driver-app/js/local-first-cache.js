/**
 * Local-First Cache — driver-scoped persistence (localStorage).
 * UI reads synchronously; network layers write after Firestore sync.
 */

const STORAGE_PREFIX = "swiftgo_lfc";
const SCHEMA_VERSION = 1;

function storageKey(namespace, driverUid, key) {
  return `${STORAGE_PREFIX}:v${SCHEMA_VERSION}:${namespace}:${driverUid}:${key}`;
}

function safeParse(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * @template T
 * @param {string} driverUid
 * @param {string} namespace
 * @param {string} key
 * @returns {{ payload: T, savedAt: string } | null}
 */
export function readLocalCache(driverUid, namespace, key) {
  if (!driverUid || !namespace || !key) return null;
  try {
    const envelope = safeParse(localStorage.getItem(storageKey(namespace, driverUid, key)));
    if (!envelope || envelope.schema !== SCHEMA_VERSION) return null;
    return {
      payload: envelope.payload,
      savedAt: envelope.savedAt || "",
    };
  } catch {
    return null;
  }
}

/**
 * @template T
 */
export function writeLocalCache(driverUid, namespace, key, payload) {
  if (!driverUid || !namespace || !key) return false;
  try {
    const envelope = {
      schema: SCHEMA_VERSION,
      savedAt: new Date().toISOString(),
      payload,
    };
    localStorage.setItem(storageKey(namespace, driverUid, key), JSON.stringify(envelope));
    return true;
  } catch (error) {
    console.warn("[SwiftGo LFC] write failed", error);
    return false;
  }
}

export function clearLocalCacheNamespace(driverUid, namespace) {
  if (!driverUid || !namespace) return;
  const prefix = `${STORAGE_PREFIX}:v${SCHEMA_VERSION}:${namespace}:${driverUid}:`;
  try {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(prefix)) keys.push(k);
    }
    keys.forEach((k) => localStorage.removeItem(k));
  } catch {
    /* ignore */
  }
}
