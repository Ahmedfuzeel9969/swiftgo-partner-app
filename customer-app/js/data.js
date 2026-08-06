import {
  doc,
  getDoc,
  setDoc,
  updateDoc,
  collection,
  query,
  where,
  orderBy,
  onSnapshot,
  addDoc,
  increment,
  serverTimestamp,
  deleteField,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { getFirebase, isFirebaseConfigured } from "./firebase.js";

/**
 * users/{uid}: { displayName, email, walletBalance, createdAt, updatedAt }
 * bookings/{id}: { userId, status, service, pickup, destination, fare, createdAt }
 */

export async function ensureUserProfile(user, extra = {}) {
  if (!isFirebaseConfigured() || !user) return null;
  const { db } = getFirebase();
  const ref = doc(db, "users", user.uid);
  const snap = await getDoc(ref);

  if (!snap.exists()) {
    const profile = {
      displayName: extra.displayName || user.displayName || user.email?.split("@")[0] || "User",
      email: user.email || "",
      walletBalance: 0,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };
    await setDoc(ref, profile);
    return profile;
  }

  if (extra.displayName) {
    await updateDoc(ref, {
      displayName: extra.displayName,
      updatedAt: serverTimestamp(),
    });
  }

  return snap.data();
}

export function watchUserProfile(uid, onData) {
  if (!isFirebaseConfigured() || !uid) {
    onData(null);
    return () => {};
  }
  const { db } = getFirebase();
  const ref = doc(db, "users", uid);
  return onSnapshot(
    ref,
    (snap) => onData(snap.exists() ? { id: snap.id, ...snap.data() } : null),
    (err) => {
      console.warn("[SwiftGo] profile watch", err);
      onData(null);
    }
  );
}

export function watchBookings(uid, onData) {
  if (!isFirebaseConfigured() || !uid) {
    onData([]);
    return () => {};
  }

  const { db } = getFirebase();
  let unsub = () => {};

  const emit = (snap) => {
    const rows = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
    onData(rows);
  };

  const qOrdered = query(
    collection(db, "bookings"),
    where("userId", "==", uid),
    orderBy("createdAt", "desc")
  );

  unsub = onSnapshot(
    qOrdered,
    (snap) => onData(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    () => {
      unsub();
      const qSimple = query(collection(db, "bookings"), where("userId", "==", uid));
      unsub = onSnapshot(
        qSimple,
        emit,
        (err) => {
          console.warn("[SwiftGo] bookings watch", err);
          onData([]);
        }
      );
    }
  );

  return () => unsub();
}

export async function createBooking({
  service,
  pickup,
  destination,
  status = "scheduled",
  fare = 0,
  paymentMethod = "cash",
  promoCode = "",
}) {
  const { ready, db, auth } = getFirebase();
  const user = auth?.currentUser;
  if (!ready || !user) {
    throw new Error("NOT_SIGNED_IN");
  }

  const payload = {
    userId: user.uid,
    service: service || "ride",
    pickup: pickup || "",
    destination: destination || "",
    status,
    fare: Number.isFinite(fare) && fare >= 0 ? fare : 0,
    paymentMethod,
    promoCode,
    createdAt: serverTimestamp(),
  };

  const ref = await addDoc(collection(db, "bookings"), payload);
  return { id: ref.id, ...payload };
}

/**
 * Phase 16.1 — rides/{id}: live ride request written when "Book Ride" is tapped.
 */

/** Offline fallback when Firestore promo lookup is unavailable. */
const FALLBACK_PROMOS = Object.freeze({
  SWIFT10: { type: "percent", value: 10, active: true },
  SAVE50: { type: "fixed", value: 50, active: true },
});

/**
 * Phase 42 — validate promo code from Firestore (or offline fallback).
 * @returns {Promise<{ code: string, type: 'percent'|'fixed', value: number } | null>}
 */
export async function validatePromoCode(rawCode) {
  const code = String(rawCode || "")
    .trim()
    .toUpperCase();
  if (!code) return null;

  if (!isFirebaseConfigured()) {
    const fallback = FALLBACK_PROMOS[code];
    return fallback?.active ? { code, type: fallback.type, value: fallback.value } : null;
  }

  try {
    const { db, auth } = getFirebase();
    if (!auth?.currentUser) return null;

    const snap = await getDoc(doc(db, "promoCodes", code));
    if (!snap.exists()) return null;

    const data = snap.data() || {};
    if (data.active !== true) return null;

    const type = data.type === "fixed" ? "fixed" : "percent";
    const value = Number(data.value);
    if (!Number.isFinite(value) || value <= 0) return null;

    const maxUses = Number(data.maxUses);
    const usedCount = Number(data.usedCount) || 0;
    if (Number.isFinite(maxUses) && maxUses > 0 && usedCount >= maxUses) return null;

    const expiresAt = data.expiresAt?.toDate?.() || null;
    if (expiresAt && expiresAt.getTime() < Date.now()) return null;

    return { code, type, value };
  } catch (err) {
    console.warn("[SwiftGo] promo validate", err);
    return null;
  }
}

/** Phase 42 — increment promo usage after a ride is booked with a code. */
export async function recordPromoUse(code) {
  const normalized = String(code || "")
    .trim()
    .toUpperCase();
  if (!normalized || !isFirebaseConfigured()) return;

  try {
    const { db, auth } = getFirebase();
    if (!auth?.currentUser) return;
    await updateDoc(doc(db, "promoCodes", normalized), {
      usedCount: increment(1),
    });
  } catch (err) {
    console.warn("[SwiftGo] promo use count", err);
  }
}

/** Phase 42 / Phase 2A — customer rates a completed ride via trusted CF (aggregates server-only). */
export async function submitRideRating(rideId, rating, _driverId = null) {
  const stars = Math.round(Number(rating));
  if (!rideId || stars < 1 || stars > 5) {
    throw new Error("INVALID_RATING");
  }

  const { ready, functions, auth } = getFirebase();
  const user = auth?.currentUser;
  if (!ready || !user) {
    throw new Error("NOT_SIGNED_IN");
  }
  if (!functions) throw new Error("FUNCTIONS_UNAVAILABLE");

  const { httpsCallable } = await import(
    "https://www.gstatic.com/firebasejs/10.14.1/firebase-functions.js"
  );
  return httpsCallable(functions, "submitCompletedRideRating")({
    rideId,
    rating: stars,
  }).then((r) => r?.data || r);
}

/** @deprecated Client ride create denied — use createCustomerBookingClient. */
export async function createRideRequest(_payload) {
  throw new Error("USE_CREATE_CUSTOMER_BOOKING_CF");
}

const DRIVER_OFFER_CLEAR = {
  driverOfferDriverId: deleteField(),
  driverOfferFare: deleteField(),
  driverOfferVehicleId: deleteField(),
  driverOfferOwnerId: deleteField(),
  driverOfferDriverName: deleteField(),
  driverOfferVehiclePlate: deleteField(),
  driverOfferAt: deleteField(),
  customerCounterFare: deleteField(),
};

/** Customer accepts the driver's pending fare offer — Phase 2A: use finalizeAssignmentFromOffer. */
export async function acceptDriverOffer(_rideId) {
  throw new Error("USE_FINALIZE_OFFER_CF");
}

/** Customer declines the current driver offer — Phase 2A: use rejectRideOffer CF. */
export async function rejectDriverOffer(_rideId) {
  throw new Error("USE_REJECT_OFFER_CF");
}

/** Customer proposes a different fare (PKR) — Phase 2A: use counterRideOffer CF. */
export async function counterDriverOffer(_rideId, _farePkr) {
  throw new Error("USE_COUNTER_OFFER_CF");
}

/** Fetch one canonical ride document (customer resume / recovery). */
export async function fetchRideById(rideId) {
  const { ready, db, auth } = getFirebase();
  if (!ready || !auth?.currentUser || !rideId) return null;
  const snap = await getDoc(doc(db, "rides", rideId));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

/** Live assigned vehicle GPS — allowed when vehicle is on customer's active ride. */
export function watchAssignedVehicle(vehicleId, onData, onError = () => {}) {
  const { ready, db, auth } = getFirebase();
  if (!ready || !auth?.currentUser || !vehicleId) {
    onError(new Error("NOT_SIGNED_IN"));
    return () => {};
  }
  return onSnapshot(
    doc(db, "vehicles", vehicleId),
    (snap) => onData(snap.exists() ? { id: snap.id, ...snap.data() } : null),
    onError
  );
}

/** Phase 17.1 — subscribe to one ride document and stream status changes. */
export function watchRideRequest(rideId, onData, onError = () => {}) {
  const { ready, db, auth } = getFirebase();
  if (!ready || !auth?.currentUser || !rideId) {
    onError(new Error("NOT_SIGNED_IN"));
    return () => {};
  }

  return onSnapshot(
    doc(db, "rides", rideId),
    (snap) => onData(snap.exists() ? { id: snap.id, ...snap.data() } : null),
    onError
  );
}

/**
 * Phase 2A — customer must not complete rides.
 * Settlement is trusted server-side (`completeRideSettlement`) after in_progress.
 */
export async function completeRideRequest(_rideId) {
  throw new Error("SETTLEMENT_SERVER_ONLY");
}

/**
 * Super Admin config: settings/pricing (Phase 30–47)
 * Per-vehicle baseFare + perKmRate + optional distanceTiers / paceTiers.
 */
export const FALLBACK_VEHICLE_RATES = Object.freeze({
  bike: Object.freeze({
    baseFare: 40,
    perKmRate: 15,
    commissionPercent: 10,
    distanceTiers: Object.freeze([]),
    paceTiers: Object.freeze([]),
  }),
  go: Object.freeze({
    baseFare: 100,
    perKmRate: 35,
    commissionPercent: 10,
    distanceTiers: Object.freeze([]),
    paceTiers: Object.freeze([]),
  }),
  "go-plus": Object.freeze({
    baseFare: 130,
    perKmRate: 40,
    commissionPercent: 10,
    distanceTiers: Object.freeze([]),
    paceTiers: Object.freeze([]),
  }),
  business: Object.freeze({
    baseFare: 200,
    perKmRate: 60,
    commissionPercent: 10,
    distanceTiers: Object.freeze([]),
    paceTiers: Object.freeze([]),
  }),
  "bike-cargo": Object.freeze({
    baseFare: 60,
    perKmRate: 20,
    commissionPercent: 10,
    distanceTiers: Object.freeze([]),
    paceTiers: Object.freeze([]),
  }),
  suzuki: Object.freeze({
    baseFare: 250,
    perKmRate: 50,
    commissionPercent: 10,
    distanceTiers: Object.freeze([]),
    paceTiers: Object.freeze([]),
  }),
  truck: Object.freeze({
    baseFare: 500,
    perKmRate: 80,
    commissionPercent: 10,
    distanceTiers: Object.freeze([]),
    paceTiers: Object.freeze([]),
  }),
});

export const FALLBACK_PRICING = Object.freeze({
  baseFare: FALLBACK_VEHICLE_RATES.go.baseFare,
  perKmRate: FALLBACK_VEHICLE_RATES.go.perKmRate,
  commissionPercent: FALLBACK_VEHICLE_RATES.go.commissionPercent,
  vehicles: FALLBACK_VEHICLE_RATES,
});

function normalizeDistanceTiers(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((row) => {
      const upToRaw = row?.upToKm;
      const upToKm =
        upToRaw === null || upToRaw === undefined || upToRaw === ""
          ? null
          : Number(upToRaw);
      const baseFare = Number(row?.baseFare);
      const perKmRate = Number(row?.perKmRate);
      if (!Number.isFinite(baseFare) || baseFare < 0) return null;
      if (!Number.isFinite(perKmRate) || perKmRate < 0) return null;
      if (upToKm !== null && (!Number.isFinite(upToKm) || upToKm <= 0)) return null;
      return { upToKm, baseFare, perKmRate };
    })
    .filter(Boolean)
    .sort((a, b) => {
      const av = a.upToKm == null ? Number.POSITIVE_INFINITY : a.upToKm;
      const bv = b.upToKm == null ? Number.POSITIVE_INFINITY : b.upToKm;
      return av - bv;
    });
}

function normalizePaceTiers(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((row) => {
      const maxRaw = row?.maxMinPerKm;
      const maxMinPerKm =
        maxRaw === null || maxRaw === undefined || maxRaw === ""
          ? null
          : Number(maxRaw);
      const baseFare = Number(row?.baseFare);
      const perKmRate = Number(row?.perKmRate);
      if (!Number.isFinite(baseFare) || baseFare < 0) return null;
      if (!Number.isFinite(perKmRate) || perKmRate < 0) return null;
      if (maxMinPerKm !== null && (!Number.isFinite(maxMinPerKm) || maxMinPerKm <= 0)) {
        return null;
      }
      return { maxMinPerKm, baseFare, perKmRate };
    })
    .filter(Boolean)
    .sort((a, b) => {
      const av = a.maxMinPerKm == null ? Number.POSITIVE_INFINITY : a.maxMinPerKm;
      const bv = b.maxMinPerKm == null ? Number.POSITIVE_INFINITY : b.maxMinPerKm;
      return av - bv;
    });
}

function normalizeRate(raw, fallback) {
  const base = fallback || FALLBACK_VEHICLE_RATES.go;
  const baseFare = Number(raw?.baseFare ?? raw?.base);
  const perKmRate = Number(raw?.perKmRate ?? raw?.perKm);
  const commissionPercent = Number(raw?.commissionPercent);
  return {
    baseFare: Number.isFinite(baseFare) && baseFare >= 0 ? baseFare : base.baseFare,
    perKmRate: Number.isFinite(perKmRate) && perKmRate >= 0 ? perKmRate : base.perKmRate,
    commissionPercent:
      Number.isFinite(commissionPercent) && commissionPercent >= 0 && commissionPercent <= 100
        ? commissionPercent
        : base.commissionPercent,
    distanceTiers: normalizeDistanceTiers(raw?.distanceTiers ?? base.distanceTiers),
    paceTiers: normalizePaceTiers(raw?.paceTiers ?? base.paceTiers),
  };
}

/**
 * Pick effective base/perKm from distance range, then optional pace (min/km) override.
 * Fare = Math.round(baseFare + distanceKm * perKmRate)
 */
export function resolveEffectiveRates(rates, distanceKm, timeMins) {
  const distance = Number(distanceKm);
  const time = Number(timeMins);
  let baseFare = Number(rates?.baseFare) || 0;
  let perKmRate = Number(rates?.perKmRate) || 0;

  const distanceTiers = Array.isArray(rates?.distanceTiers) ? rates.distanceTiers : [];
  if (distanceTiers.length && Number.isFinite(distance) && distance >= 0) {
    const match = distanceTiers.find(
      (tier) => tier.upToKm == null || distance <= tier.upToKm
    );
    if (match) {
      baseFare = match.baseFare;
      perKmRate = match.perKmRate;
    }
  }

  const paceTiers = Array.isArray(rates?.paceTiers) ? rates.paceTiers : [];
  if (
    paceTiers.length &&
    Number.isFinite(distance) &&
    distance > 0 &&
    Number.isFinite(time) &&
    time >= 0
  ) {
    const minPerKm = time / distance;
    const match = paceTiers.find(
      (tier) => tier.maxMinPerKm == null || minPerKm <= tier.maxMinPerKm
    );
    if (match) {
      baseFare = match.baseFare;
      perKmRate = match.perKmRate;
    }
  }

  return { baseFare, perKmRate };
}

export function calculateVehicleFare(rates, distanceKm, timeMins) {
  const { baseFare, perKmRate } = resolveEffectiveRates(rates, distanceKm, timeMins);
  const distance = Number(distanceKm);
  if (![baseFare, perKmRate, distance].every((n) => Number.isFinite(n) && n >= 0)) {
    return 0;
  }
  return Math.round(baseFare + distance * perKmRate);
}

export function normalizePricingSettings(data = {}) {
  const legacy = {
    baseFare: Number(data.baseFare),
    perKmRate: Number(data.perKmRate),
    commissionPercent: Number(data.commissionPercent),
  };
  const hasLegacy =
    Number.isFinite(legacy.baseFare) ||
    Number.isFinite(legacy.perKmRate) ||
    Number.isFinite(legacy.commissionPercent);
  const legacyRate = hasLegacy
    ? normalizeRate(
        {
          baseFare: Number.isFinite(legacy.baseFare)
            ? legacy.baseFare
            : FALLBACK_VEHICLE_RATES.go.baseFare,
          perKmRate: Number.isFinite(legacy.perKmRate)
            ? legacy.perKmRate
            : FALLBACK_VEHICLE_RATES.go.perKmRate,
          commissionPercent: Number.isFinite(legacy.commissionPercent)
            ? legacy.commissionPercent
            : FALLBACK_VEHICLE_RATES.go.commissionPercent,
        },
        FALLBACK_VEHICLE_RATES.go
      )
    : null;

  /** @type {Record<string, { baseFare: number, perKmRate: number, commissionPercent: number }>} */
  const vehicles = {};
  Object.keys(FALLBACK_VEHICLE_RATES).forEach((key) => {
    vehicles[key] = normalizeRate(
      data.vehicles?.[key] || legacyRate || FALLBACK_VEHICLE_RATES[key],
      FALLBACK_VEHICLE_RATES[key]
    );
  });

  const go = vehicles.go;
  return {
    baseFare: go.baseFare,
    perKmRate: go.perKmRate,
    commissionPercent: go.commissionPercent,
    vehicles,
  };
}

export function getVehicleRates(pricing, vehicleKey) {
  const key = vehicleKey || "go";
  const fromMap = pricing?.vehicles?.[key];
  if (fromMap) return fromMap;
  const fallback = FALLBACK_VEHICLE_RATES[key];
  if (fallback) return fallback;
  return {
    baseFare: pricing?.baseFare ?? FALLBACK_PRICING.baseFare,
    perKmRate: pricing?.perKmRate ?? FALLBACK_PRICING.perKmRate,
    commissionPercent: pricing?.commissionPercent ?? FALLBACK_PRICING.commissionPercent,
    distanceTiers: [],
    paceTiers: [],
  };
}

export async function getPricingSettings() {
  if (!isFirebaseConfigured()) {
    return { ...normalizePricingSettings(FALLBACK_PRICING), source: "fallback" };
  }

  try {
    const { db, auth } = getFirebase();
    if (!auth?.currentUser) {
      return { ...normalizePricingSettings(FALLBACK_PRICING), source: "fallback" };
    }

    const snap = await getDoc(doc(db, "settings", "pricing"));
    if (!snap.exists()) {
      return { ...normalizePricingSettings(FALLBACK_PRICING), source: "fallback" };
    }

    return {
      ...normalizePricingSettings(snap.data() || {}),
      source: "firestore",
    };
  } catch (err) {
    console.warn("[SwiftGo] pricing settings", err);
    return { ...normalizePricingSettings(FALLBACK_PRICING), source: "fallback" };
  }
}
