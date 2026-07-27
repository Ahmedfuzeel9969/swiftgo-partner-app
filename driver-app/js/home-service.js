/**
 * Home hub metrics — local-first via earnings cache + live sync.
 */

import { readCachedEarnings, subscribeDriverEarnings } from "./earnings-service.js";
import { readLocalCache, writeLocalCache } from "./local-first-cache.js";

const NAMESPACE = "home";
const CACHE_KEY = "snapshot";

function todayRideCountFromDaily(daily) {
  if (!Array.isArray(daily) || !daily.length) return 0;
  const last = daily[daily.length - 1];
  return Math.max(0, Math.round(Number(last?.rideCount) || 0));
}

function toHomeSnapshot(earnings, meta = {}) {
  return {
    todayEarnings: Number(earnings?.todayEarnings) || 0,
    todayRides: todayRideCountFromDaily(earnings?.daily),
    walletBalance: Number(earnings?.walletBalance) || 0,
    syncing: Boolean(meta.syncing),
    source: meta.source || "cache",
    syncedAt: meta.syncedAt || null,
  };
}

/**
 * @param {string} driverUid
 */
export function readCachedHome(driverUid) {
  if (!driverUid) return null;
  const cachedHome = readLocalCache(driverUid, NAMESPACE, CACHE_KEY);
  if (cachedHome?.payload) {
    return {
      ...cachedHome.payload,
      source: "cache",
      syncedAt: cachedHome.savedAt || null,
      syncing: false,
    };
  }
  const earnings = readCachedEarnings(driverUid);
  if (!earnings) return null;
  return toHomeSnapshot(earnings, { source: "cache", syncedAt: earnings.syncedAt });
}

function persistHome(driverUid, snap) {
  writeLocalCache(driverUid, NAMESPACE, CACHE_KEY, {
    todayEarnings: snap.todayEarnings,
    todayRides: snap.todayRides,
    walletBalance: snap.walletBalance,
  });
}

/**
 * @param {string} driverUid
 * @param {(snap: ReturnType<typeof toHomeSnapshot>) => void} onData
 */
export function subscribeHomeMetrics(driverUid, onData) {
  if (!driverUid || typeof onData !== "function") return () => {};

  const cached = readCachedHome(driverUid);
  if (cached) onData({ ...cached, syncing: true });

  return subscribeDriverEarnings(driverUid, (earnings) => {
    const snap = toHomeSnapshot(earnings, {
      syncing: Boolean(earnings.syncing),
      source: earnings.source || "remote",
      syncedAt: earnings.syncedAt,
    });
    persistHome(driverUid, snap);
    onData(snap);
  });
}
