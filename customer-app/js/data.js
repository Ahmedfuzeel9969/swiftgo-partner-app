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
 * { userId, pickupLocation, dropoffLocation, vehicleType, distanceKm, timeMins,
 *   farePkr, status: 'searching_driver', createdAt }
 */
export async function createRideRequest({
  pickupLocation,
  dropoffLocation,
  vehicleType,
  distanceKm = 0,
  timeMins = 0,
  farePkr = 0,
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

  const payload = {
    userId: user.uid,
    pickupLocation: point(pickupLocation),
    dropoffLocation: point(dropoffLocation),
    vehicleType: String(vehicleType || "").slice(0, 40),
    distanceKm: clean(distanceKm),
    timeMins: clean(timeMins),
    farePkr: clean(farePkr),
    status: "searching_driver",
    createdAt: serverTimestamp(),
  };

  const ref = await addDoc(collection(db, "rides"), payload);
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
