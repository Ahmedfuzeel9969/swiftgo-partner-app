/**
 * Earnings data layer — local-first read, Firestore background sync.
 */

import {
  collection,
  doc,
  limit,
  onSnapshot,
  orderBy,
  query,
  where,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { getFirebase } from "./firebase.js";
import { readLocalCache, writeLocalCache } from "./local-first-cache.js";

const CACHE_NAMESPACE = "earnings";
const CACHE_KEY = "snapshot";
const COMPLETED_RIDES_LIMIT = 80;

/** @typedef {{ dateKey: string, label: string, amount: number, rideCount: number }} DailyBucket */
/** @typedef {{
 *   id: string,
 *   completedAtMs: number,
 *   driverEarnings: number,
 *   commissionAmount: number,
 *   fare: number,
 *   pickup: string,
 *   dropoff: string,
 * }} PayoutRow */
/** @typedef {{
 *   walletBalance: number,
 *   totalEarnings: number,
 *   totalRidesCompleted: number,
 *   todayEarnings: number,
 *   weekEarnings: number,
 *   daily: DailyBucket[],
 *   recentPayouts: PayoutRow[],
 *   source: "cache" | "remote",
 *   syncedAt: string | null,
 *   syncing: boolean,
 * }} EarningsSnapshot */

function finiteMoney(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function timestampToMs(value) {
  if (!value) return 0;
  if (typeof value.toDate === "function") return value.toDate().getTime();
  if (typeof value.seconds === "number") return value.seconds * 1000;
  return 0;
}

function formatDayKey(ms) {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function formatDayLabel(dateKey) {
  const [y, m, d] = dateKey.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  return new Intl.DateTimeFormat("ur-PK", {
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(date);
}

function startOfLocalDayMs(ms = Date.now()) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function normalizePartner(partner = {}) {
  return {
    walletBalance: finiteMoney(partner.walletBalance),
    totalEarnings: finiteMoney(partner.totalEarnings),
    totalRidesCompleted: Math.max(0, Math.round(finiteMoney(partner.totalRidesCompleted))),
  };
}

function normalizeCompletedRide(docSnap) {
  const data = docSnap.data();
  const fare = finiteMoney(data.estimatedFare ?? data.farePkr);
  const driverEarnings = finiteMoney(
    data.driverEarnings ?? Math.max(0, fare - finiteMoney(data.commissionAmount))
  );
  const completedAtMs = timestampToMs(data.updatedAt || data.createdAt);
  return {
    id: docSnap.id,
    completedAtMs,
    driverEarnings,
    commissionAmount: finiteMoney(data.commissionAmount),
    fare,
    pickup: String(data.pickupLocation?.address || "—").slice(0, 120),
    dropoff: String(data.dropoffLocation?.address || "—").slice(0, 120),
  };
}

/**
 * @param {ReturnType<typeof normalizePartner>} partner
 * @param {ReturnType<typeof normalizeCompletedRide>[]} completedRides
 * @returns {Omit<EarningsSnapshot, "source" | "syncedAt" | "syncing">}
 */
export function buildEarningsModel(partner, completedRides) {
  const todayStart = startOfLocalDayMs();
  const weekStart = todayStart - 6 * 24 * 60 * 60 * 1000;

  const dailyMap = new Map();
  let todayEarnings = 0;
  let weekEarnings = 0;

  for (const ride of completedRides) {
    const amount = Math.max(0, ride.driverEarnings);
    const ms = ride.completedAtMs || 0;
    if (!ms) continue;

    const dateKey = formatDayKey(ms);
    const bucket = dailyMap.get(dateKey) || { dateKey, label: formatDayLabel(dateKey), amount: 0, rideCount: 0 };
    bucket.amount += amount;
    bucket.rideCount += 1;
    dailyMap.set(dateKey, bucket);

    if (ms >= todayStart) todayEarnings += amount;
    if (ms >= weekStart) weekEarnings += amount;
  }

  const daily = [];
  for (let i = 6; i >= 0; i--) {
    const ms = todayStart - i * 24 * 60 * 60 * 1000;
    const dateKey = formatDayKey(ms);
    daily.push(
      dailyMap.get(dateKey) || {
        dateKey,
        label: formatDayLabel(dateKey),
        amount: 0,
        rideCount: 0,
      }
    );
  }

  const recentPayouts = [...completedRides]
    .filter((r) => r.completedAtMs > 0)
    .sort((a, b) => b.completedAtMs - a.completedAtMs)
    .slice(0, 25);

  return {
    walletBalance: partner.walletBalance,
    totalEarnings: partner.totalEarnings,
    totalRidesCompleted: partner.totalRidesCompleted,
    todayEarnings,
    weekEarnings,
    daily,
    recentPayouts,
  };
}

function mergeSnapshot(partial, meta) {
  return {
    walletBalance: 0,
    totalEarnings: 0,
    totalRidesCompleted: 0,
    todayEarnings: 0,
    weekEarnings: 0,
    daily: [],
    recentPayouts: [],
    ...partial,
    ...meta,
  };
}

/**
 * Synchronous cache read for instant paint.
 * @param {string} driverUid
 * @returns {EarningsSnapshot | null}
 */
export function readCachedEarnings(driverUid) {
  const cached = readLocalCache(driverUid, CACHE_NAMESPACE, CACHE_KEY);
  if (!cached?.payload) return null;
  return mergeSnapshot(cached.payload, {
    source: "cache",
    syncedAt: cached.savedAt || null,
    syncing: false,
  });
}

function persistEarnings(driverUid, model) {
  writeLocalCache(driverUid, CACHE_NAMESPACE, CACHE_KEY, model);
}

/**
 * Subscribe to partner + completed rides; emit cache first, then live updates.
 * @param {string} driverUid
 * @param {(snapshot: EarningsSnapshot) => void} onData
 * @returns {() => void}
 */
export function subscribeDriverEarnings(driverUid, onData) {
  if (!driverUid || typeof onData !== "function") {
    return () => {};
  }

  const cached = readCachedEarnings(driverUid);
  if (cached) onData({ ...cached, syncing: true });

  const { ready, db } = getFirebase();
  if (!ready || !db) {
    onData(
      mergeSnapshot(cached || {}, {
        source: cached ? "cache" : "remote",
        syncedAt: cached?.syncedAt ?? null,
        syncing: false,
      })
    );
    return () => {};
  }

  let partnerRaw = {};
  let ridesRaw = [];
  let partnerReady = false;
  let ridesReady = false;
  let stopped = false;

  const emit = (syncing) => {
    if (stopped) return;
    const partner = normalizePartner(partnerRaw);
    const completed = ridesRaw
      .filter((r) => r.status === "completed")
      .map((r) => normalizeCompletedRide({ id: r.id, data: () => r }));
    const model = buildEarningsModel(partner, completed);
    persistEarnings(driverUid, model);
    onData(
      mergeSnapshot(model, {
        source: "remote",
        syncedAt: new Date().toISOString(),
        syncing: Boolean(syncing),
      })
    );
  };

  const partnerUnsub = onSnapshot(
    doc(db, "partners", driverUid),
    (snap) => {
      partnerRaw = snap.exists() ? snap.data() : {};
      partnerReady = true;
      emit(!(partnerReady && ridesReady));
    },
    (error) => {
      console.warn("[SwiftGo Earnings] partner listener", error);
      partnerReady = true;
      emit(false);
    }
  );

  const ridesQuery = query(
    collection(db, "rides"),
    where("driverId", "==", driverUid),
    orderBy("createdAt", "desc"),
    limit(COMPLETED_RIDES_LIMIT)
  );

  const ridesUnsub = onSnapshot(
    ridesQuery,
    (snapshot) => {
      ridesRaw = snapshot.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }));
      ridesReady = true;
      emit(false);
    },
    (error) => {
      console.warn("[SwiftGo Earnings] rides listener", error);
      ridesReady = true;
      emit(false);
    }
  );

  return () => {
    stopped = true;
    partnerUnsub();
    ridesUnsub();
  };
}
