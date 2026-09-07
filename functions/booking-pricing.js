"use strict";
const { FieldValue, Timestamp } = require("firebase-admin/firestore");
const { normalizeBookingVehicleFields } = require("./vehicle-catalog");
const { resolveVehicleRates, calculateVehicleFare } = require("./pricing-fare");
const { fail, documentId, money, digest, takeRateLimit } = require("./security-policy");
const QUOTE_TTL_MS = 2 * 60 * 1000;
function pricingDigest(value) {
  const canonical = (v) => Array.isArray(v) ? v.map(canonical) : v && typeof v === "object" ?
    Object.fromEntries(Object.keys(v).sort().map((key) => [key, canonical(v[key])])) : v;
  return digest(JSON.stringify(canonical(value)));
}

function location(value, label) {
  if (!value || typeof value.lat !== "number" || typeof value.lng !== "number" ||
      !Number.isFinite(value.lat) || !Number.isFinite(value.lng) || Math.abs(value.lat) > 90 || Math.abs(value.lng) > 180 ||
      typeof value.address !== "string" || value.address.length > 500 || /[\x00-\x1f]/.test(value.address)) {
    fail("invalid-argument", `INVALID_${label}`);
  }
  return { lat: value.lat, lng: value.lng, address: value.address.trim() };
}
function normalizeBookingInput(data = {}) {
  const vehicle = normalizeBookingVehicleFields(data);
  const paymentMethod = data.paymentMethod || "cash";
  if (!["cash", "easypaisa", "jazzcash", "business"].includes(paymentMethod)) fail("invalid-argument", "INVALID_PAYMENT_METHOD");
  const promoCode = String(data.promoCode || "").trim().toUpperCase();
  if (promoCode && !/^[A-Z0-9_-]{1,32}$/.test(promoCode)) fail("invalid-argument", "INVALID_PROMO_CODE");
  return { pickupLocation: location(data.pickupLocation, "PICKUP"), dropoffLocation: location(data.dropoffLocation, "DROPOFF"),
    vehicleType: vehicle.vehicleTypeKey, vehicleTypeKey: vehicle.vehicleTypeKey, paymentMethod, promoCode };
}

/** Only coordinates go to a server-selected routing endpoint; never a client URL. */
async function fetchTrustedRoute(input) {
  const base = new URL(process.env.BOOKING_ROUTE_BASE_URL || "https://router.project-osrm.org");
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) {
    fail("failed-precondition", "ROUTE_PROVIDER_NOT_CONFIGURED");
  }
  const a = input.pickupLocation; const b = input.dropoffLocation;
  const url = new URL(`/route/v1/driving/${a.lng},${a.lat};${b.lng},${b.lat}?overview=false&steps=false&alternatives=false`, base);
  let body;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10000), redirect: "error" });
    if (!response.ok) throw new Error("route unavailable");
    body = await response.json();
  } catch { fail("unavailable", "TRUSTED_ROUTE_UNAVAILABLE"); }
  const route = body?.routes?.[0];
  if (body?.code !== "Ok" || !route) fail("failed-precondition", "NO_DRIVABLE_ROUTE");
  return { distanceKm: Number(route.distance) / 1000, timeMins: Number(route.duration) / 60 };
}

function quoteFare(input, pricing, route, promo = null, now = Date.now()) {
  const { distanceKm, timeMins } = route || {};
  if (![distanceKm, timeMins].every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0) ||
      distanceKm > 2000 || timeMins > 2880) fail("failed-precondition", "INVALID_TRUSTED_ROUTE");
  const originalFare = money(calculateVehicleFare(resolveVehicleRates(pricing, input), distanceKm, timeMins), "FARE");
  let discountAmount = 0;
  if (input.promoCode) {
    const expires = promo?.expiresAt?.toMillis?.() ?? promo?.expiresAtMs ?? null;
    if (!promo || promo.active !== true || !["fixed", "percent"].includes(promo.type) ||
        !Number.isFinite(promo.value) || promo.value <= 0 || (promo.type === "percent" && promo.value > 100) ||
        !Number.isInteger(promo.usedCount ?? 0) || (promo.usedCount ?? 0) < 0 ||
        !Number.isInteger(promo.maxUses ?? 0) || (promo.maxUses ?? 0) < 0 ||
        (expires !== null && (!Number.isFinite(expires) || expires <= now)) ||
        (Number(promo.maxUses) > 0 && Number(promo.usedCount || 0) >= Number(promo.maxUses))) {
      fail("failed-precondition", "PROMO_UNAVAILABLE");
    }
    discountAmount = Math.min(originalFare, Math.round(promo.type === "fixed" ? promo.value : originalFare * promo.value / 100));
  }
  return { ...input, distanceKm, timeMins, originalFare, discountAmount,
    farePkr: originalFare - discountAmount, estimatedFare: originalFare - discountAmount };
}

async function quoteCustomerBooking(db, customerUid, data, { routeProvider = fetchTrustedRoute, now = Date.now() } = {}) {
  documentId(customerUid, "CUSTOMER");
  const input = normalizeBookingInput(data);
  await takeRateLimit(db, "booking_quote", customerUid, { limit: 10, now });
  const [pricingSnap, promoSnap, route] = await Promise.all([
    db.doc("settings/pricing").get(), input.promoCode ? db.doc(`promoCodes/${input.promoCode}`).get() : null, routeProvider(input),
  ]);
  const pricing = pricingSnap.exists ? pricingSnap.data() : {};
  const payload = quoteFare(input, pricing, route, promoSnap?.exists ? promoSnap.data() : null, now);
  const ref = db.collection("booking_quotes").doc();
  await ref.create({ userId: customerUid, payload, pricingDigest: pricingDigest(pricing),
    expiresAt: Timestamp.fromMillis(now + QUOTE_TTL_MS), createdAt: FieldValue.serverTimestamp(), consumedRideId: null });
  return { quoteId: ref.id, expiresAtMs: now + QUOTE_TTL_MS, ...payload };
}

/** Transaction reads only; the caller consumes the quote with the ride atomically. */
async function readBookingQuote(tx, db, customerUid, data, now = Date.now()) {
  const quoteRef = db.doc(`booking_quotes/${documentId(data.quoteId, "QUOTE")}`);
  const snap = await tx.get(quoteRef);
  if (!snap.exists || snap.data().userId !== customerUid) fail("permission-denied", "QUOTE_NOT_OWNED");
  const quote = snap.data();
  if (quote.consumedRideId) return { quoteRef, existingRideId: quote.consumedRideId, count: quote.consumedCount };
  if (quote.expiresAt.toMillis() <= now) fail("failed-precondition", "QUOTE_EXPIRED");
  if (data.acceptedFare !== quote.payload.farePkr) fail("failed-precondition", "FARE_CONFIRMATION_REQUIRED");
  const pricingSnap = await tx.get(db.doc("settings/pricing"));
  const pricing = pricingSnap.exists ? pricingSnap.data() : {};
  if (pricingDigest(pricing) !== quote.pricingDigest) fail("failed-precondition", "QUOTE_EXPIRED");
  const promoRef = quote.payload.promoCode ? db.doc(`promoCodes/${quote.payload.promoCode}`) : null;
  const promoSnap = promoRef ? await tx.get(promoRef) : null;
  const payload = quoteFare(quote.payload, pricing, quote.payload, promoSnap?.exists ? promoSnap.data() : null, now);
  if (payload.farePkr !== quote.payload.farePkr) fail("failed-precondition", "QUOTE_EXPIRED");
  return { quoteRef, payload, promoRef };
}
module.exports = { QUOTE_TTL_MS, normalizeBookingInput, quoteFare, fetchTrustedRoute, quoteCustomerBooking, readBookingQuote };
