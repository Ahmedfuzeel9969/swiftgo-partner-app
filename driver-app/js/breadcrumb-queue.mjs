/**
 * Phase 6 — bounded IndexedDB breadcrumb queue.
 * Partitioned by ride / assignment / vehicle / tracking session.
 * Does not claim application-level encryption; relies on browser storage isolation.
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

function partitionKey({ rideId, driverId, vehicleId, assignmentVersion, trackingSessionId }) {
  return [
    String(rideId || ""),
    String(driverId || ""),
    String(vehicleId || ""),
    String(assignmentVersion || ""),
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
 * }} [opts]
 */
export function createBreadcrumbQueue(opts = {}) {
  const nowMs = opts.nowMs || (() => Date.now());
  const diag = opts.onDiag || (() => {});
  let memoryFallback = new Map();
  let useMemory = false;

  const counters = {
    pointsAccepted: 0,
    pointsRejected: 0,
    batchesQueued: 0,
    overflows: 0,
    gapsRecorded: 0,
    purges: 0,
  };

  async function withStore(mode, fn) {
    if (useMemory) {
      return fn(null);
    }
    try {
      const db = await openDb(opts.indexedDB);
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const store = tx.objectStore(STORE);
        Promise.resolve(fn(store))
          .then(resolve)
          .catch(reject);
        tx.onerror = () => reject(tx.error);
      });
    } catch {
      useMemory = true;
      return fn(null);
    }
  }

  async function load(key) {
    return withStore("readonly", async (store) => {
      if (!store) return memoryFallback.get(key) || null;
      return new Promise((resolve, reject) => {
        const req = store.get(key);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      });
    });
  }

  async function save(record) {
    record.updatedAt = nowMs();
    return withStore("readwrite", async (store) => {
      if (!store) {
        memoryFallback.set(record.partitionKey, record);
        return;
      }
      return new Promise((resolve, reject) => {
        const req = store.put(record);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
    });
  }

  async function remove(key) {
    counters.purges += 1;
    return withStore("readwrite", async (store) => {
      if (!store) {
        memoryFallback.delete(key);
        return;
      }
      return new Promise((resolve, reject) => {
        const req = store.delete(key);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
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

  async function appendPoint(binding, rawPoint) {
    const key = partitionKey(binding);
    let record = await load(key);
    if (!record) record = emptyRecord(key, binding);
    // Stale retention
    if (nowMs() - Number(record.updatedAt || 0) > BREADCRUMB_QUEUE_RETENTION_MS) {
      diag(BREADCRUMB_DIAG.STALE_QUEUE_PURGED);
      record = emptyRecord(key, binding);
      counters.purges += 1;
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
    await save(record);
    counters.pointsAccepted += 1;
    diag(BREADCRUMB_DIAG.POINT_ACCEPTED);
    return { ok: true, point: v.point, queuePoints: record.points.length };
  }

  async function takeBatch(binding, { force = false, maxPoints = BREADCRUMB_TARGET_BATCH_POINTS } = {}) {
    const key = partitionKey(binding);
    const record = await load(key);
    if (!record || !record.points.length) return { ok: false, reason: "empty" };
    // Form a new batch from points only. Pending uploads are drained via peekOldestBatch.
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
      trackingSessionId: binding.trackingSessionId,
      batchSequence: record.nextBatchSequence,
      points,
      gapBefore,
      createdAtClient: nowMs(),
    });
    record.nextBatchSequence += 1;
    record.pendingBatches.push(batch);
    await save(record);
    counters.batchesQueued += 1;
    diag(BREADCRUMB_DIAG.BATCH_QUEUED);
    return { ok: true, batch, fromPending: false };
  }

  async function peekOldestBatch(binding) {
    const key = partitionKey(binding);
    const record = await load(key);
    if (!record?.pendingBatches?.length) return null;
    return record.pendingBatches[0];
  }

  async function acknowledgeBatch(binding, batchSequence) {
    const key = partitionKey(binding);
    const record = await load(key);
    if (!record) return { ok: false };
    const before = record.pendingBatches.length;
    record.pendingBatches = record.pendingBatches.filter(
      (b) => Number(b.batchSequence) !== Number(batchSequence)
    );
    await save(record);
    if (record.pendingBatches.length < before) diag(BREADCRUMB_DIAG.BATCH_ACKNOWLEDGED);
    return { ok: true, removed: before - record.pendingBatches.length };
  }

  async function purgePartition(binding) {
    await remove(partitionKey(binding));
    diag(BREADCRUMB_DIAG.STALE_QUEUE_PURGED);
  }

  async function purgeIfMismatch(binding, expected) {
    const key = partitionKey(binding);
    const record = await load(key);
    if (!record) return { purged: false };
    const b = record.binding || {};
    const mismatch =
      String(b.rideId) !== String(expected.rideId) ||
      String(b.driverId) !== String(expected.driverId) ||
      String(b.vehicleId) !== String(expected.vehicleId) ||
      String(b.assignmentVersion) !== String(expected.assignmentVersion) ||
      String(b.trackingSessionId) !== String(expected.trackingSessionId);
    if (mismatch) {
      await remove(key);
      diag(BREADCRUMB_DIAG.STALE_QUEUE_PURGED);
      return { purged: true };
    }
    if (nowMs() - Number(record.updatedAt || 0) > BREADCRUMB_QUEUE_RETENTION_MS) {
      await remove(key);
      diag(BREADCRUMB_DIAG.STALE_QUEUE_PURGED);
      return { purged: true };
    }
    return { purged: false, record };
  }

  async function pointCount(binding) {
    const record = await load(partitionKey(binding));
    return record?.points?.length || 0;
  }

  return {
    appendPoint,
    takeBatch,
    peekOldestBatch,
    acknowledgeBatch,
    purgePartition,
    purgeIfMismatch,
    pointCount,
    getCounters: () => ({ ...counters, useMemory }),
    partitionKey,
    /** Test helper */
    _load: load,
  };
}

export { partitionKey, DB_NAME, STORE };
