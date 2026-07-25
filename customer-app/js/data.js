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
  runTransaction,
  increment,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import {
  ref as storageRef,
  uploadBytes,
  getDownloadURL,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-storage.js";
import { getFirebase, isFirebaseConfigured } from "./firebase.js";

/**
 * users/{uid}: { displayName, email, walletBalance, createdAt, updatedAt }
 * bookings/{id}: { userId, status, service, pickup, destination, fare, createdAt }
 * settings/driverForm: Super Admin booleans for driver onboarding requirements
 * driver_applications/{id}: pending driver KYC applications
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

/** Phase 42 — customer rates a completed ride (1–5 stars). */
export async function submitRideRating(rideId, rating, driverId = null) {
  const stars = Math.round(Number(rating));
  if (!rideId || stars < 1 || stars > 5) {
    throw new Error("INVALID_RATING");
  }

  const { ready, db, auth } = getFirebase();
  const user = auth?.currentUser;
  if (!ready || !user) {
    throw new Error("NOT_SIGNED_IN");
  }

  await runTransaction(db, async (tx) => {
    const rideRef = doc(db, "rides", rideId);
    const rideSnap = await tx.get(rideRef);
    if (!rideSnap.exists()) throw new Error("RIDE_NOT_FOUND");

    const ride = rideSnap.data() || {};
    if (ride.userId !== user.uid || ride.status !== "completed") {
      throw new Error("NOT_ALLOWED");
    }
    if (ride.customerRating) throw new Error("ALREADY_RATED");

    tx.update(rideRef, {
      customerRating: stars,
      ratedAt: serverTimestamp(),
    });

    const partnerId = driverId || ride.driverId;
    if (!partnerId) return;

    const partnerRef = doc(db, "partners", partnerId);
    const partnerSnap = await tx.get(partnerRef);
    if (!partnerSnap.exists()) return;

    tx.update(partnerRef, {
      customerRatingSum: increment(stars),
      customerRatingCount: increment(1),
    });
  });
}

export async function createRideRequest({
  pickupLocation,
  dropoffLocation,
  vehicleType,
  vehicleTypeKey = "",
  distanceKm = 0,
  timeMins = 0,
  farePkr = 0,
  estimatedFare = null,
  promoCode = "",
  discountAmount = 0,
}) {
  const { ready, db, auth } = getFirebase();
  const user = auth?.currentUser;
  if (!ready || !user) {
    throw new Error("NOT_SIGNED_IN");
  }

  const clean = (n) => (Number.isFinite(n) && n >= 0 ? n : 0);
  const point = (loc) => ({
    lat: Number.isFinite(loc?.lat) ? loc.lat : null,
    lng: Number.isFinite(loc?.lng) ? loc.lng : null,
    address: String(loc?.address || "").slice(0, 500),
  });

  const baseFare = clean(estimatedFare == null ? farePkr : estimatedFare);
  const discount = clean(discountAmount);
  const finalFare = Math.max(0, baseFare - discount);
  const normalizedPromo = String(promoCode || "")
    .trim()
    .toUpperCase()
    .slice(0, 32);
  const stableKey = String(vehicleTypeKey || "").trim().slice(0, 40);

  const payload = {
    userId: user.uid,
    pickupLocation: point(pickupLocation),
    dropoffLocation: point(dropoffLocation),
    vehicleType: String(vehicleType || "").slice(0, 40),
    distanceKm: clean(distanceKm),
    timeMins: clean(timeMins),
    farePkr: finalFare,
    estimatedFare: finalFare,
    status: "searching_driver",
    createdAt: serverTimestamp(),
  };

  if (stableKey) payload.vehicleTypeKey = stableKey;

  if (normalizedPromo && discount > 0) {
    payload.promoCode = normalizedPromo;
    payload.discountAmount = discount;
    payload.originalFare = baseFare;
  }

  const ref = await addDoc(collection(db, "rides"), payload);

  if (normalizedPromo && discount > 0) {
    await recordPromoUse(normalizedPromo);
  }

  return { id: ref.id, ...payload };
}

/** Phase 16.2 — user aborts the search: rides/{id}.status → 'cancelled_by_user'. */
export async function cancelRideRequest(rideId) {
  const { ready, db, auth } = getFirebase();
  if (!ready || !auth?.currentUser || !rideId) {
    throw new Error("NOT_SIGNED_IN");
  }
  await updateDoc(doc(db, "rides", rideId), { status: "cancelled_by_user" });
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

/** Phase 17.3 — customer-side dev reset after an accepted ride. */
export async function completeRideRequest(rideId) {
  const { ready, db, auth } = getFirebase();
  if (!ready || !auth?.currentUser || !rideId) {
    throw new Error("NOT_SIGNED_IN");
  }
  await updateDoc(doc(db, "rides", rideId), { status: "completed" });
}

/** Local defaults when settings/driverForm is missing or Firestore is offline. */
export const FALLBACK_DRIVER_FORM_CONFIG = {
  requireFullName: true,
  requireCnic: true,
  requireLicense: true,
  requireVehicleType: true,
  requireCnicFront: true,
  requireCnicBack: true,
  requireLicenseImage: true,
  requireSelfie: true,
};

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

/**
 * Super Admin config: settings/driverForm
 * Booleans control which driver-onboarding fields are required.
 */
export async function getDriverFormConfig() {
  if (!isFirebaseConfigured()) {
    return { ...FALLBACK_DRIVER_FORM_CONFIG, source: "fallback" };
  }

  try {
    const { db } = getFirebase();
    const snap = await getDoc(doc(db, "settings", "driverForm"));
    if (!snap.exists()) {
      return { ...FALLBACK_DRIVER_FORM_CONFIG, source: "fallback" };
    }
    return {
      ...FALLBACK_DRIVER_FORM_CONFIG,
      ...snap.data(),
      source: "firestore",
    };
  } catch (err) {
    console.warn("[SwiftGo] driver form config", err);
    return { ...FALLBACK_DRIVER_FORM_CONFIG, source: "fallback" };
  }
}

async function uploadDriverImage(storage, userId, key, file) {
  if (!file) return "";
  const safeName = String(file.name || key).replace(/[^\w.\-]+/g, "_").slice(0, 80);
  const path = `driver_applications/${userId}/${key}-${Date.now()}-${safeName}`;
  const objectRef = storageRef(storage, path);
  await uploadBytes(objectRef, file, {
    contentType: file.type || "image/jpeg",
  });
  return getDownloadURL(objectRef);
}

/**
 * Upload identity images to Storage, then create driver_applications/{id}.
 */
export async function submitDriverApplication({
  fullName,
  cnic,
  licenseNumber,
  vehicleType,
  files = {},
}) {
  const { ready, db, auth, storage } = getFirebase();
  const user = auth?.currentUser;
  if (!ready || !user) {
    throw new Error("NOT_SIGNED_IN");
  }
  if (!storage) {
    throw new Error("STORAGE_UNAVAILABLE");
  }

  const [cnicFrontUrl, cnicBackUrl, licenseImageUrl, selfieUrl] = await Promise.all([
    uploadDriverImage(storage, user.uid, "cnic-front", files.cnicFront),
    uploadDriverImage(storage, user.uid, "cnic-back", files.cnicBack),
    uploadDriverImage(storage, user.uid, "license", files.license),
    uploadDriverImage(storage, user.uid, "selfie", files.selfie),
  ]);

  const payload = {
    userId: user.uid,
    email: user.email || "",
    fullName: (fullName || "").trim(),
    cnic: (cnic || "").trim(),
    licenseNumber: (licenseNumber || "").trim(),
    vehicleType: vehicleType || "",
    status: "pending",
    cnicFrontUrl,
    cnicBackUrl,
    licenseImageUrl,
    selfieUrl,
    createdAt: serverTimestamp(),
  };

  const refDoc = await addDoc(collection(db, "driver_applications"), payload);
  return { id: refDoc.id, ...payload };
}
