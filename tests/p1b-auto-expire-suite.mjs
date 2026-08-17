/**
 * P1-B automatic offer expiry chain — laboratory suite (Firestore emulator).
 * Covers L3 expireRideOffer, expireDueOffersForRide piggyback on rematch, action guards.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROJECT = "demo-swiftgo-phase1";

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080";
}

const results = [];
function record(name, status, detail = "") {
  results.push({ name, status, detail });
  console.log(`${status} | ${name}${detail ? " — " + detail : ""}`);
}

const admin = require(
  require.resolve("firebase-admin", { paths: [path.join(ROOT, "functions"), ROOT] })
);
let app;
try {
  app = admin.app();
} catch {
  app = admin.initializeApp({ projectId: PROJECT });
}
const db = admin.firestore(app);
const { Timestamp, FieldValue } = admin.firestore;

const {
  createCustomerBooking,
  matchRideCandidates,
  submitRideOffer,
  finalizeAssignmentFromOffer,
  expireRideOffer,
  expireDueOffersForRide,
  acceptCustomerInitialFareAsDriver,
  readDispatchSettings,
  resolveOfferExpiryMs,
  isOfferPastTimeout,
} = require(path.join(ROOT, "functions", "bargaining.js"));

const pickup = { lat: 24.86, lng: 67.01 };
let seq = 0;
function uid(prefix) {
  seq += 1;
  return `${prefix}-${Date.now()}-${seq}`;
}

async function seedPartner(id) {
  await db.doc(`partners/${id}`).set({
    role: "driver",
    accountStatus: "active",
    walletBalance: 0,
    totalEarnings: 0,
  });
}

async function seedVehicle(driverId, vehicleId) {
  await db.doc(`vehicles/${vehicleId}`).set({
    driverId,
    ownerId: "test-owner",
    status: "online",
    activeRideId: null,
    location: { lat: pickup.lat, lng: pickup.lng },
    locationUpdatedAt: FieldValue.serverTimestamp(),
  });
}

async function createRide(customerUid) {
  await db.doc(`users/${customerUid}`).set({ role: "customer" }, { merge: true });
  await db.doc(`booking_slots/${customerUid}`).set({ count: 0 }, { merge: true });
  const booking = await createCustomerBooking(db, {
    customerUid,
    confirmedExtraBooking: true,
    ridePayload: {
      pickupLocation: { ...pickup, address: "P" },
      dropoffLocation: { lat: pickup.lat + 0.01, lng: pickup.lng + 0.01, address: "D" },
      vehicleType: "go",
      distanceKm: 2,
      timeMins: 8,
      farePkr: 250,
      estimatedFare: 250,
    },
  });
  return { id: booking.rideId || booking.id };
}

async function inviteAndOffer({ customerUid, driverId, vehicleId, fare = 350 }) {
  await seedPartner(driverId);
  await seedVehicle(driverId, vehicleId);
  const booking = await createRide(customerUid);
  const rideId = booking.id;
  await matchRideCandidates(db, {
    rideId,
    pickup,
    onlineDrivers: [
      {
        driverId,
        vehicleId,
        lat: pickup.lat,
        lng: pickup.lng,
        status: "online",
        locationUpdatedAtMs: Date.now(),
        accountStatus: "active",
      },
    ],
    candidateDriverLimit: 10,
  });
  const offer = await submitRideOffer(db, {
    rideId,
    driverUid: driverId,
    fare,
    vehicleId,
    ownerId: "test-owner",
    driverName: "Lab Driver",
    vehiclePlate: "LAB-1",
  });
  return { rideId, offerId: offer.offerId, offer };
}

async function main() {
  await db.doc("settings/dispatch").set({ offerTimeoutSeconds: 8 }, { merge: true });
  const settings = await readDispatchSettings(db);
  if (settings.offerTimeoutSeconds !== 8) {
    record("settings-offerTimeout", "FAIL", String(settings.offerTimeoutSeconds));
  } else {
    record("settings-offerTimeout", "PASS", "8s");
  }

  // T1: expireRideOffer after wall clock
  {
    const customerUid = uid("c");
    const driverId = uid("d");
    const { rideId, offerId } = await inviteAndOffer({
      customerUid,
      driverId,
      vehicleId: uid("v"),
    });
    await db.doc(`ride_offers/${offerId}`).set(
      { offerExpiresAt: Timestamp.fromMillis(Date.now() - 1000) },
      { merge: true }
    );
    const r = await expireRideOffer(db, { offerId, actorUid: driverId });
    const snap = await db.doc(`ride_offers/${offerId}`).get();
    const ride = await db.doc(`rides/${rideId}`).get();
    const ok =
      r.status === "expired" &&
      snap.data()?.status === "expired" &&
      snap.data()?.closedReason === "offer_timeout" &&
      ride.data()?.status === "searching_driver";
    record(
      "T1-expireRideOffer-marks-expired-keeps-search",
      ok ? "PASS" : "FAIL",
      `offer=${snap.data()?.status} ride=${ride.data()?.status}`
    );
  }

  // T2: finalize rejects after timeout
  {
    const customerUid = uid("c");
    const driverId = uid("d");
    const { offerId } = await inviteAndOffer({
      customerUid,
      driverId,
      vehicleId: uid("v"),
    });
    await db.doc(`ride_offers/${offerId}`).set(
      { offerExpiresAt: Timestamp.fromMillis(Date.now() - 500) },
      { merge: true }
    );
    let code = "";
    try {
      await finalizeAssignmentFromOffer(db, {
        offerId,
        actorUid: customerUid,
        actorRole: "customer",
      });
    } catch (e) {
      code = e?.message || String(e);
    }
    const snap = await db.doc(`ride_offers/${offerId}`).get();
    record(
      "T2-finalize-past-expiry-OFFER_EXPIRED",
      code.includes("OFFER_EXPIRED") && snap.data()?.status === "expired" ? "PASS" : "FAIL",
      code
    );
  }

  // T3: expireDueOffersForRide piggyback
  {
    const customerUid = uid("c");
    const driverId = uid("d");
    const { rideId, offerId } = await inviteAndOffer({
      customerUid,
      driverId,
      vehicleId: uid("v"),
    });
    await db.doc(`ride_offers/${offerId}`).set(
      { offerExpiresAt: Timestamp.fromMillis(Date.now() - 2000) },
      { merge: true }
    );
    const batch = await expireDueOffersForRide(db, rideId);
    const snap = await db.doc(`ride_offers/${offerId}`).get();
    record(
      "T3-expireDueOffersForRide",
      batch.expired >= 1 && snap.data()?.status === "expired" ? "PASS" : "FAIL",
      JSON.stringify(batch)
    );
  }

  // T4: matchRideCandidates piggyback expires overdue offer
  {
    const customerUid = uid("c");
    const driverId = uid("d");
    const vehicleId = uid("v");
    const { rideId, offerId } = await inviteAndOffer({
      customerUid,
      driverId,
      vehicleId,
      fare: 400,
    });
    await db.doc(`ride_offers/${offerId}`).set(
      { offerExpiresAt: Timestamp.fromMillis(Date.now() - 3000) },
      { merge: true }
    );
    await matchRideCandidates(db, {
      rideId,
      pickup,
      onlineDrivers: [
        {
          driverId,
          vehicleId,
          lat: pickup.lat,
          lng: pickup.lng,
          status: "online",
          locationUpdatedAtMs: Date.now(),
          accountStatus: "active",
        },
      ],
    });
    const snap = await db.doc(`ride_offers/${offerId}`).get();
    const ride = await db.doc(`rides/${rideId}`).get();
    record(
      "T4-rematch-piggyback-expires-offer",
      snap.data()?.status === "expired" && ride.data()?.status === "searching_driver"
        ? "PASS"
        : "FAIL",
      `offer=${snap.data()?.status}`
    );
  }

  // T5: expireRideOffer NOT_YET_EXPIRED
  {
    const customerUid = uid("c");
    const driverId = uid("d");
    const { offerId } = await inviteAndOffer({
      customerUid,
      driverId,
      vehicleId: uid("v"),
    });
    let code = "";
    try {
      await expireRideOffer(db, { offerId, actorUid: driverId });
    } catch (e) {
      code = e?.message || String(e);
    }
    record("T5-expireRideOffer-not-yet", code.includes("NOT_YET_EXPIRED") ? "PASS" : "FAIL", code);
  }

  // T6: local helper parity
  {
    const past = { offerExpiresAt: Timestamp.fromMillis(Date.now() - 1) };
    const future = { offerExpiresAt: Timestamp.fromMillis(Date.now() + 60_000) };
    const missing = {};
    record(
      "T6-local-expiry-helper",
      isOfferPastTimeout(past) && !isOfferPastTimeout(future) && !isOfferPastTimeout(missing)
        ? "PASS"
        : "FAIL"
    );
  }

  // T7: acceptCustomerInitialFare rejects past-due open offer
  {
    const customerUid = uid("c");
    const driverId = uid("d");
    const vehicleId = uid("v");
    const { rideId, offerId } = await inviteAndOffer({
      customerUid,
      driverId,
      vehicleId,
    });
    await db.doc(`ride_offers/${offerId}`).set(
      { offerExpiresAt: Timestamp.fromMillis(Date.now() - 1000), status: "open" },
      { merge: true }
    );
    let code = "";
    try {
      await acceptCustomerInitialFareAsDriver(db, {
        rideId,
        driverUid: driverId,
        vehicleId,
        ownerId: "test-owner",
        driverName: "Lab",
        vehiclePlate: "LAB",
      });
    } catch (e) {
      code = e?.message || String(e);
    }
    const snap = await db.doc(`ride_offers/${offerId}`).get();
    record(
      "T7-acceptCustomerInitialFare-OFFER_EXPIRED",
      code.includes("OFFER_EXPIRED") && snap.data()?.status === "expired" ? "PASS" : "FAIL",
      `code=${code} status=${snap.data()?.status}`
    );
  }

  // T8: resolveOfferExpiryMs fallback via offerTimeoutSeconds
  {
    const created = Timestamp.fromMillis(Date.now() - 20_000);
    const offer = { createdAt: created, offerTimeoutSeconds: 10 };
    const exp = resolveOfferExpiryMs(offer);
    const past = isOfferPastTimeout(offer, Date.now());
    record(
      "T8-resolveOfferExpiryMs-fallback",
      Number.isFinite(exp) && past ? "PASS" : "FAIL",
      `exp=${exp} past=${past}`
    );
  }

  // T9: acceptCustomerInitialFare rejects already-expired offer doc (no bypass)
  {
    const customerUid = uid("c");
    const driverId = uid("d");
    const vehicleId = uid("v");
    const { rideId, offerId } = await inviteAndOffer({
      customerUid,
      driverId,
      vehicleId,
    });
    await db.doc(`ride_offers/${offerId}`).set(
      {
        status: "expired",
        closedReason: "offer_timeout",
        offerExpiresAt: Timestamp.fromMillis(Date.now() - 1000),
      },
      { merge: true }
    );
    let code = "";
    try {
      await acceptCustomerInitialFareAsDriver(db, {
        rideId,
        driverUid: driverId,
        vehicleId,
        ownerId: "test-owner",
        driverName: "Lab",
        vehiclePlate: "LAB",
      });
    } catch (e) {
      code = e?.message || String(e);
    }
    const rideSnap = await db.doc(`rides/${rideId}`).get();
    record(
      "T9-acceptCustomerInitialFare-expired-doc-OFFER_EXPIRED",
      code.includes("OFFER_EXPIRED") && rideSnap.data()?.status === "searching_driver"
        ? "PASS"
        : "FAIL",
      `code=${code} ride=${rideSnap.data()?.status}`
    );
  }

  const pass = results.filter((r) => r.status === "PASS").length;
  const fail = results.filter((r) => r.status === "FAIL").length;
  const out = {
    generatedAt: new Date().toISOString(),
    package: "P1-B-auto-expire",
    pass,
    fail,
    results,
  };
  fs.writeFileSync(
    path.join(ROOT, "tests", "p1b-auto-expire-results.json"),
    JSON.stringify(out, null, 2)
  );
  console.log(`\nOVERALL ${fail ? "FAIL" : "PASS"} pass=${pass} fail=${fail}`);
  if (fail) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
