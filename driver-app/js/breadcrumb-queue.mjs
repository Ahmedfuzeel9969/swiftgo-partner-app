/**
 * Phase 6 hardening — bounded IndexedDB breadcrumb queue.
 * Per-partition mutation serializer; wait for transaction complete.
 * Does not claim application-level encryption.
 *
 * Privacy: queue stores raw lat/lng (sensitive location data) plus accuracy/
 * speed/heading/sequences only. No names, phones, emails, addresses, fare,
 * wallet, SDP, ICE, or auth tokens.
 */

import {
  BREADCRUMB_DIAG,
  BREADCRUMB_MAX_QUEUE_BYTES,
  BREADCRUMB_MAX_QUEUE_POINTS,
  BREADCRUMB_QUEUE_RETENTION_MS,
  BREADCRUMB_TARGET_BATCH_POINTS,
  buildBreadcrumbBatch,
  estimatePointBytes,
  validateBreadcrumbPoint,
} from "./breadcrumb-schema.mjs";

const DB_NAME = "swiftgo_breadcrumb_v1";
const STORE = "queues";
const DB_VERSION = 1;

function openDb(indexedDBImpl) {
  const idb = indexedDBImpl || (typeof indexedDB !== "undefined" ? indexedDB : null);
  if (!idb) return Promise.reject(new Error("INDEXEDDB_UNAVAILABLE"));
  return new Promise((resolve, reject) => {
    const req = idb.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "partitionKey" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("IDB_OPEN_FAILED"));
  });
}

function partitionKey({
  rideId,
  driverId,
  vehicleId,
  assignmentVersion,
  assignmentSessionToken,
  trackingSessionId,
}) {
  return [
    String(rideId || ""),
    String(driverId || ""),
    String(vehicleId || ""),
    String(assignmentSessionToken || assignmentVersion || ""),
    String(trackingSessionId || ""),
  ].join("|");
}

function emptyRecord(key, binding) {
  return {
    partitionKey: key,
    binding,
    points: [],
    pendingBatches: [],
    nextBatchSequence: 1,
    gapPending: false,
    incompleteCoverage: false,
    updatedAt: Date.now(),
    byteEstimate: 0,
  };
}

/**
 * @param {{
 *   indexedDB?: IDBFactory,
 *   nowMs?: () => number,
 *   onDiag?: (code: string) => void,
 *   allowMemoryFallback?: boolean,
 * }} [opts]
 */
export function createBreadcrumbQueue(opts = {}) {
  const nowMs = opts.nowMs || (() => Date.now());
  const diag = opts.onDiag || (() => {});
  const allowMemoryFallback = opts.allowMemoryFallback !== false;
  let memoryFallback = new Map();
  /** @type {'unknown'|'idb'|'memory'|'failed'} */
  let persistenceMode = "unknown";
  const partitionChains = new Map();

  const counters = {
    pointsAccepted: 0,
    pointsRejected: 0,
    batchesQueued: 0,
    overflows: 0,
    gapsRecorded: 0,
    purges: 0,
    idbFailures: 0,
  };

  function withPartitionLock(key, fn) {
    const prev = partitionChains.get(key) || Promise.resolve();
    const run = prev.catch(() => {}).then(fn);
    partitionChains.set(key, run);
    return run.finally(() => {
      if (partitionChains.get(key) === run) partitionChains.delete(key);
    });
  }

  async function withStore(mode, fn) {
    if (persistenceMode === "failed") {
      const err = new Error("INDEXEDDB_FAILED");
      err.code = "idb_failed";
      throw err;
    }
    if (persistenceMode === "memory") {
      return fn(null);
    }
    try {
      const db = await openDb(opts.indexedDB);
      persistenceMode = "idb";
      return await new Promise((resolve, reject) => {
        let settled = false;
        let result;
        let opError = null;
        const tx = db.transaction(STORE, mode);
        const store = tx.objectStore(STORE);
        Promise.resolve(fn(store))
          .then((r) => {
            result = r;
          })
          .catch((e) => {
            opError = e;
          });
        tx.oncomplete = () => {
          if (settled) return;
          settled = true;
          if (opError) reject(opError);
          else resolve(result);
        };
        tx.onerror = () => {
          if (settled) return;
          settled = true;
          reject(tx.error || opError || new Error("IDB_TX_ERROR"));
        };
        tx.onabort = () => {
          if (settled) return;
          settled = true;
          reject(tx.error || opError || new Error("IDB_TX_ABORT"));
        };
      });
    } catch (err) {
      counters.idbFailures += 1;
      diag(BREADCRUMB_DIAG.IDB_UNAVAILABLE);
      if (persistenceMode === "idb") {
        // Never abandon durable data for an empty memory queue.
        persistenceMode = "failed";
        const e = new Error("INDEXEDDB_FAILED");
        e.code = "idb_failed";
        e.cause = err;
        throw e;
      }
      if (!allowMemoryFallback) {
        persistenceMode = "failed";
        const e = new Error("INDEXEDDB_FAILED");
        e.code = "idb_failed";
        e.cause = err;
        throw e;
      }
      persistenceMode = "memory";
      return fn(null);
    }
  }

  async function loadInStore(store, key) {
    if (!store) return memoryFallback.get(key) || null;
    return new Promise((resolve, reject) => {
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  async function saveInStore(store, record) {
    record.updatedAt = nowMs();
    if (!store) {
      memoryFallback.set(record.partitionKey, record);
      return;
    }
    return new Promise((resolve, reject) => {
      const req = store.put(record);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  async function removeInStore(store, key) {
    if (!store) {
      memoryFallback.delete(key);
      return;
    }
    return new Promise((resolve, reject) => {
      const req = store.delete(key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  function enforceBounds(record) {
    while (
      record.points.length > BREADCRUMB_MAX_QUEUE_POINTS ||
      record.byteEstimate > BREADCRUMB_MAX_QUEUE_BYTES
    ) {
      const dropped = record.points.shift();
      if (!dropped) break;
      record.byteEstimate = Math.max(0, record.byteEstimate - estimatePointBytes(dropped));
      record.gapPending = true;
      record.incompleteCoverage = true;
      counters.overflows += 1;
      counters.gapsRecorded += 1;
      diag(BREADCRUMB_DIAG.QUEUE_OVERFLOW);
      diag(BREADCRUMB_DIAG.GAP_RECORDED);
    }
  }

  async function mutate(binding, mutator) {
    const key = partitionKey(binding);
    return withPartitionLock(key, async () =>
      withStore("readwrite", async (store) => {
        let record = await loadInStore(store, key);
        const out = await mutator(record, key, store);
        return out;
      })
    );
  }

  async function appendPoint(binding, rawPoint, { forceGapBefore = false } = {}) {
    try {
      return await mutate(binding, async (existing, key, store) => {
        let record = existing;
        if (!record) record = emptyRecord(key, binding);
        if (nowMs() - Number(record.updatedAt || 0) > BREADCRUMB_QUEUE_RETENTION_MS) {
          diag(BREADCRUMB_DIAG.STALE_QUEUE_PURGED);
          record = emptyRecord(key, binding);
          counters.purges += 1;
        }
        if (forceGapBefore) {
          record.gapPending = true;
          record.incompleteCoverage = true;
          counters.gapsRecorded += 1;
          diag(BREADCRUMB_DIAG.GAP_RECORDED);
        }
        const prev = record.points[record.points.length - 1] || null;
        const v = validateBreadcrumbPoint(rawPoint, { nowMs: nowMs(), previous: prev });
        if (!v.ok) {
          counters.pointsRejected += 1;
          diag(BREADCRUMB_DIAG.POINT_REJECTED);
          return { ok: false, reason: v.reason };
        }
        record.points.push(v.point);
        record.byteEstimate += estimatePointBytes(v.point);
        enforceBounds(record);
        await saveInStore(store, record);
        counters.pointsAccepted += 1;
        diag(BREADCRUMB_DIAG.POINT_ACCEPTED);
        return {
          ok: true,
          point: v.point,
          queuePoints: record.points.length,
          incompleteCoverage: Boolean(record.incompleteCoverage),
        };
      });
    } catch (err) {
      if (err?.code === "idb_failed") {
        return { ok: false, reason: "idb_failed", incompleteCoverage: true };
      }
      throw err;
    }
  }

  async function takeBatch(binding, { force = false, maxPoints = BREADCRUMB_TARGET_BATCH_POINTS } = {}) {
    try {
      return await mutate(binding, async (record, key, store) => {
        if (!record || !record.points.length) return { ok: false, reason: "empty" };
        const take = Math.min(maxPoints, record.points.length);
        if (!force && take < 1) return { ok: false, reason: "empty" };
        if (!force && take < maxPoints && take < BREADCRUMB_TARGET_BATCH_POINTS) {
          return { ok: false, reason: "below_target", count: take };
        }
        const points = record.points.splice(0, take);
        record.byteEstimate = record.points.reduce((n, p) => n + estimatePointBytes(p), 0);
        const gapBefore = Boolean(record.gapPending);
        record.gapPending = false;
        const batch = buildBreadcrumbBatch({
          rideBinding: {
            rideId: binding.rideId,
            vehicleId: binding.vehicleId,
            driverId: binding.driverId,
          },
          assignmentVersion: binding.assignmentVersion,
          assignmentSessionToken: binding.assignmentSessionToken,
          trackingSessionId: binding.trackingSessionId,
          batchSequence: record.nextBatchSequence,
          points,
          gapBefore,
          createdAtClient: nowMs(),
        });
        record.nextBatchSequence += 1;
        record.pendingBatches.push(batch);
        await saveInStore(store, record);
        counters.batchesQueued += 1;
        diag(BREADCRUMB_DIAG.BATCH_QUEUED);
        return { ok: true, batch, fromPending: false };
      });
    } catch (err) {
      if (err?.code === "idb_failed") {
        return { ok: false, reason: "idb_failed", incompleteCoverage: true };
      }
      throw err;
    }
  }

  async function peekOldestBatch(binding) {
    const key = partitionKey(binding);
    return withPartitionLock(key, async () => {
      try {
        return await withStore("readonly", async (store) => {
          const record = await loadInStore(store, key);
          if (!record?.pendingBatches?.length) return null;
          return record.pendingBatches[0];
        });
      } catch (err) {
        if (err?.code === "idb_failed") return null;
        throw err;
      }
    });
  }

  async function acknowledgeBatch(binding, batchSequence) {
    try {
      return await mutate(binding, async (record, _key, store) => {
        if (!record) return { ok: false };
        const before = record.pendingBatches.length;
        record.pendingBatches = record.pendingBatches.filter(
          (b) => Number(b.batchSequence) !== Number(batchSequence)
        );
        await saveInStore(store, record);
        if (record.pendingBatches.length < before) diag(BREADCRUMB_DIAG.BATCH_ACKNOWLEDGED);
        return { ok: true, removed: before - record.pendingBatches.length };
      });
    } catch (err) {
      if (err?.code === "idb_failed") {
        return { ok: false, reason: "idb_failed", incompleteCoverage: true };
      }
      throw err;
    }
  }

  async function purgePartition(binding) {
    const key = partitionKey(binding);
    return withPartitionLock(key, async () => {
      try {
        await withStore("readwrite", async (store) => {
          await removeInStore(store, key);
        });
        counters.purges += 1;
        diag(BREADCRUMB_DIAG.STALE_QUEUE_PURGED);
      } catch (err) {
        if (err?.code === "idb_failed") return { ok: false, reason: "idb_failed" };
        throw err;
      }
      return { ok: true };
    });
  }

  async function purgeIfMismatch(binding, expected) {
    const key = partitionKey(binding);
    return withPartitionLock(key, async () => {
      try {
        return await withStore("readwrite", async (store) => {
          const record = await loadInStore(store, key);
          if (!record) return { purged: false };
          const b = record.binding || {};
          const mismatch =
            String(b.rideId) !== String(expected.rideId) ||
            String(b.driverId) !== String(expected.driverId) ||
            String(b.vehicleId) !== String(expected.vehicleId) ||
            String(b.assignmentSessionToken || b.assignmentVersion) !==
              String(expected.assignmentSessionToken || expected.assignmentVersion) ||
            String(b.trackingSessionId) !== String(expected.trackingSessionId);
          if (
            mismatch ||
            nowMs() - Number(record.updatedAt || 0) > BREADCRUMB_QUEUE_RETENTION_MS
          ) {
            await removeInStore(store, key);
            counters.purges += 1;
            diag(BREADCRUMB_DIAG.STALE_QUEUE_PURGED);
            return { purged: true };
          }
          return { purged: false, record };
        });
      } catch (err) {
        if (err?.code === "idb_failed") {
          return { purged: false, reason: "idb_failed", incompleteCoverage: true };
        }
        throw err;
      }
    });
  }

  async function pointCount(binding) {
    const key = partitionKey(binding);
    return withPartitionLock(key, async () => {
      try {
        return await withStore("readonly", async (store) => {
          const record = await loadInStore(store, key);
          return record?.points?.length || 0;
        });
      } catch (err) {
        if (err?.code === "idb_failed") return 0;
        throw err;
      }
    });
  }

  async function _load(keyOrBinding) {
    const key = typeof keyOrBinding === "string" ? keyOrBinding : partitionKey(keyOrBinding);
    return withPartitionLock(key, async () =>
      withStore("readonly", async (store) => loadInStore(store, key))
    );
  }

  return {
    appendPoint,
    takeBatch,
    peekOldestBatch,
    acknowledgeBatch,
    purgePartition,
    purgeIfMismatch,
    pointCount,
    getCounters: () => ({
      ...counters,
      useMemory: persistenceMode === "memory",
      persistenceMode,
    }),
    partitionKey,
    _load,
  };
}

export { partitionKey, DB_NAME, STORE };
