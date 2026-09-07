import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, updateDoc, deleteDoc, serverTimestamp } from 'firebase/firestore';
const require = createRequire(import.meta.url);
const requireServer = createRequire(new URL('../functions/package.json', import.meta.url));
const { initializeApp, deleteApp } = requireServer('firebase-admin/app');
const { getFirestore, Timestamp } = requireServer('firebase-admin/firestore');
const { getAuth } = requireServer('firebase-admin/auth');
const { normalizeBookingInput, quoteFare, quoteCustomerBooking } = require('../functions/booking-pricing');
const { createCustomerBooking, submitRideOffer, acceptCustomerInitialFareAsDriver } = require('../functions/bargaining');
const { approveRechargeRequest } = require('../functions/recharge');
const { registryAllows, readAdminRole, grantAdminClaim, grantSuperAdminClaim, revokeAdminClaim, initSuperAdminAccess } = require('../functions/admin-claims');
const { createFleetVehicle, rotateVehicleLinkCode, releaseFleetVehicle, linkVehicleByCode, validLinkCode } = require('../functions/fleet-security');
const { beginDriverVerification, submitDriverVerification, reviewDriverVerification } = require('../functions/driver-verification');
const { money, takeRateLimit, digest } = require('../functions/security-policy');
const { calculateVehicleFare } = require('../functions/pricing-fare');
const projectId = 'demo-remediation-phase1';
const host = process.env.FIRESTORE_EMULATOR_HOST;
if (!/^127\.0\.0\.1:\d+$/.test(host || '')) throw new Error('LOOPBACK_FIRESTORE_EMULATOR_REQUIRED; production is never a test target');
if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIREBASE_AUTH_EMULATOR_HOST || '')) throw new Error('LOOPBACK_AUTH_EMULATOR_REQUIRED');
let env, app, db;
const adminAuth = { uid: 'super', token: { admin: true, adminRole: 'super_admin', adminVersion: 1 } };
const ordinary = { uid: 'ordinary', token: { admin: true, adminRole: 'admin', adminVersion: 1 } };
const approved = { role: 'driver', accountStatus: 'active', driverApprovalStatus: 'approved', walletBalance: 0 };
const input = { pickupLocation: { lat: 24.86, lng: 67.01, address: 'A' }, dropoffLocation: { lat: 24.89, lng: 67.04, address: 'B' }, vehicleType: 'bike', paymentMethod: 'cash' };
const routeProvider = async () => ({ distanceKm: 4, timeMins: 12 });
const client = (uid, claims = {}) => env.authenticatedContext(uid, claims).firestore();
const superDb = () => client(adminAuth.uid, adminAuth.token);
const err = (code) => (error) => error.code === code;
before(async () => {
  const [hostname, port] = host.split(':');
  env = await initializeTestEnvironment({ projectId, firestore: { host: hostname, port: Number(port), rules: await readFile(new URL('../firestore.rules', import.meta.url), 'utf8') } });
  await env.clearFirestore();
  app = initializeApp({ projectId }); db = getFirestore(app);
  await db.doc('admin_registry/super').set({ admin: true, role: 'super_admin', version: 1 });
  await db.doc('admin_registry/ordinary').set({ admin: true, role: 'admin', version: 1 });
  await db.doc('partners/owner').set({ ...approved, role: 'owner' });
});
after(async () => { await env?.cleanup(); if (app) await deleteApp(app); });

test('financial input is allowlisted; price, role, owner and route supplied by client are discarded', () => {
  const value = normalizeBookingInput({ ...input, farePkr: 1, distanceKm: 0, ownerId: 'attacker', status: 'completed' });
  assert.equal(value.farePkr, undefined); assert.equal(value.distanceKm, undefined); assert.equal(value.ownerId, undefined);
  const quote = quoteFare(value, { baseFare: 100, perKmRate: 20 }, { distanceKm: 4, timeMins: 12 });
  assert.equal(quote.farePkr, 180);
});
test('coordinates and money reject coercion, negatives, NaN, fractions and huge values', () => {
  for (const value of ['1', -1, 0, NaN, Infinity, 0.5, 500001]) assert.throws(() => money(value));
  for (const lat of ['24', NaN, Infinity, 91]) assert.throws(() => normalizeBookingInput({ ...input, pickupLocation: { ...input.pickupLocation, lat } }));
});
test('an explicit zero tier rate is not replaced by the base rate', () => {
  assert.equal(calculateVehicleFare({ baseFare: 100, perKmRate: 20, distanceTiers: [{ upToKm: 5, baseFare: 50, perKmRate: 0 }] }, 4, 12), 50);
});
test('disabled, expired, exhausted and invalid promos fail closed', () => {
  const value = normalizeBookingInput({ ...input, promoCode: 'SAVE' });
  for (const promo of [null, { active: false }, { active: true, type: 'percent', value: 101 }, { active: true, type: 'fixed', value: 10, maxUses: 1, usedCount: 1 }, { active: true, type: 'fixed', value: 10, expiresAtMs: 1 }]) {
    assert.throws(() => quoteFare(value, {}, { distanceKm: 4, timeMins: 12 }, promo));
  }
});
test('claim alone, profile/email alone, stale version and ordinary admin never grant super privileges', async () => {
  assert.equal(registryAllows({ admin: true, role: 'super_admin', version: 1 }, adminAuth, 'super_admin'), true);
  assert.equal(registryAllows({ admin: true, role: 'super_admin', version: 2 }, adminAuth), false);
  assert.equal(registryAllows({ admin: true, role: 'admin', version: 1 }, ordinary, 'super_admin'), false);
  await db.doc('users/email-user').set({ role: 'super_admin' });
  assert.equal(await readAdminRole(db, { uid: 'email-user', token: { admin: true, email: 'fuzail1158@gmail.com', email_verified: true } }), null);
});
test('quote confirmation, owner binding, price changes, replay and server fare', async () => {
  const quote = await quoteCustomerBooking(db, 'customer-a', { ...input, farePkr: 1 }, { routeProvider });
  await assert.rejects(createCustomerBooking(db, { customerUid: 'customer-b', ridePayload: { quoteId: quote.quoteId, acceptedFare: quote.farePkr } }), err('permission-denied'));
  await assert.rejects(createCustomerBooking(db, { customerUid: 'customer-a', ridePayload: { quoteId: quote.quoteId, acceptedFare: 1 } }), err('failed-precondition'));
  const payload = { quoteId: quote.quoteId, acceptedFare: quote.farePkr, farePkr: 1, userId: 'forged' };
  const first = await createCustomerBooking(db, { customerUid: 'customer-a', ridePayload: payload });
  const replay = await createCustomerBooking(db, { customerUid: 'customer-a', ridePayload: payload });
  assert.equal(first.id, replay.id);
  const ride = (await db.doc(`rides/${first.id}`).get()).data();
  assert.equal(ride.farePkr, quote.farePkr); assert.equal(ride.userId, 'customer-a'); assert.equal(ride.distanceKm, 4);
  const old = await quoteCustomerBooking(db, 'price-change', input, { routeProvider });
  await db.doc('settings/pricing').set({ baseFare: 200, perKmRate: 30 });
  await assert.rejects(createCustomerBooking(db, { customerUid: 'price-change', ridePayload: { quoteId: old.quoteId, acceptedFare: old.farePkr } }), err('failed-precondition'));
});
test('last promo use is consumed once under concurrent bookings', async () => {
  await db.doc('promoCodes/LAST').set({ active: true, type: 'fixed', value: 10, usedCount: 0, maxUses: 1 });
  const quotes = await Promise.all(['promo-a', 'promo-b'].map((uid) => quoteCustomerBooking(db, uid, { ...input, promoCode: 'LAST' }, { routeProvider })));
  const outcomes = await Promise.allSettled(quotes.map((q, i) => createCustomerBooking(db, { customerUid: ['promo-a', 'promo-b'][i], ridePayload: { quoteId: q.quoteId, acceptedFare: q.farePkr } })));
  assert.equal(outcomes.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal((await db.doc('promoCodes/LAST').get()).data().usedCount, 1);
});
test('recharge is atomic, replay-safe, receipt-unique, and super-only', async () => {
  await db.doc('partners/paid-driver').set(approved);
  await db.doc('rechargeRequests/pay-one').set({ driverId: 'paid-driver', amount: 500, method: 'easypaisa', tid: 'REFERENCE1', status: 'pending' });
  await assert.rejects(approveRechargeRequest(db, ordinary, 'pay-one'), err('permission-denied'));
  await Promise.all([approveRechargeRequest(db, adminAuth, 'pay-one'), approveRechargeRequest(db, adminAuth, 'pay-one')]);
  assert.equal((await db.doc('partners/paid-driver').get()).data().walletBalance, 500);
  assert.equal((await db.doc('ledger_transactions/recharge_pay-one').get()).data().amount, 500);
  await db.doc('rechargeRequests/pay-two').set({ driverId: 'paid-driver', amount: 500, method: 'easypaisa', tid: 'reference1', status: 'pending' });
  await assert.rejects(approveRechargeRequest(db, adminAuth, 'pay-two'), err('already-exists'));
  assert.equal((await db.doc('partners/paid-driver').get()).data().walletBalance, 500);
});
test('concurrent abuse attempts consume a single bounded quota', async () => {
  const result = await Promise.allSettled(Array.from({ length: 8 }, () => takeRateLimit(db, 'test', 'identity', { limit: 3 })));
  assert.equal(result.filter((v) => v.status === 'fulfilled').length, 3);
  assert.equal((await db.doc(`security_rate_limits/test_${digest('identity')}`).get()).data().count, 3);
});
test('link codes are server-generated, private, expiring; unapproved drivers cannot link', async () => {
  const vehicle = await createFleetVehicle(db, 'owner', { model: 'Bike', plate: 'ABC-001', pin: '1234', driverId: 'attacker' });
  assert.equal(validLinkCode(vehicle.code), true);
  const data = (await db.doc(`vehicles/${vehicle.vehicleId}`).get()).data();
  assert.equal(data.pin, undefined); assert.equal(data.pinHash, undefined); assert.equal(data.driverId, null);
  await db.doc('partners/not-approved').set({ ...approved, driverApprovalStatus: 'pending' });
  await assert.rejects(linkVehicleByCode(db, { driverUid: 'not-approved', pin: vehicle.code }), err('permission-denied'));
  await assert.rejects(linkVehicleByCode(db, { driverUid: 'not-approved', pin: '1234' }), err('invalid-argument'));
});
test('only one approved driver wins concurrent linking; active vehicle cannot be transferred', async () => {
  await Promise.all(['driver-a', 'driver-b'].map((uid) => db.doc(`partners/${uid}`).set(approved)));
  const vehicle = await createFleetVehicle(db, 'owner', { model: 'Bike', plate: 'ABC-002' });
  const result = await Promise.allSettled(['driver-a', 'driver-b'].map((driverUid) => linkVehicleByCode(db, { driverUid, pin: vehicle.code })));
  assert.equal(result.filter((r) => r.status === 'fulfilled').length, 1);
  const linked = (await db.doc(`vehicles/${vehicle.vehicleId}`).get()).data();
  assert.equal(linked.status, 'offline'); assert.equal(linked.locationUpdatedAt, undefined);
  await db.doc(`vehicles/${vehicle.vehicleId}`).update({ activeRideId: 'active', status: 'in_ride' });
  await assert.rejects(releaseFleetVehicle(db, 'owner', vehicle.vehicleId), err('failed-precondition'));
  await assert.rejects(rotateVehicleLinkCode(db, 'owner', vehicle.vehicleId), err('failed-precondition'));
});
test('release clears both pointers atomically and rotation invalidates old code', async () => {
  await db.doc('partners/driver-release').set(approved);
  const vehicle = await createFleetVehicle(db, 'owner', { model: 'Bike', plate: 'ABC-003' });
  const next = await rotateVehicleLinkCode(db, 'owner', vehicle.vehicleId);
  await assert.rejects(linkVehicleByCode(db, { driverUid: 'driver-release', pin: vehicle.code }), err('not-found'));
  await linkVehicleByCode(db, { driverUid: 'driver-release', pin: next.code });
  await releaseFleetVehicle(db, 'driver-release', vehicle.vehicleId);
  assert.equal((await db.doc('partners/driver-release').get()).data().currentVehicleId, null);
  assert.equal((await db.doc(`vehicles/${vehicle.vehicleId}`).get()).data().driverId, null);
});
test('verification needs four stored proofs; only super may approve the exact application reviewed', async () => {
  await db.doc('partners/applicant').set({ ...approved, driverApprovalStatus: 'not_submitted' });
  const ticket = await beginDriverVerification(db, 'applicant');
  const data = { ticketId: ticket.ticketId, fullName: 'Test Driver', cnic: '1234512345671', licenseNumber: 'TEST-1' };
  await assert.rejects(submitDriverVerification(db, 'applicant', data, { proofInspector: async () => { throw new Error('missing'); } }));
  const proofInspector = async (path) => ({ path, generation: '1', size: 100, contentType: 'image/png' });
  await submitDriverVerification(db, 'applicant', data, { proofInspector });
  await assert.rejects(reviewDriverVerification(db, ordinary, { uid: 'applicant', ticketId: ticket.ticketId, decision: 'approved' }), err('permission-denied'));
  await assert.rejects(reviewDriverVerification(db, adminAuth, { uid: 'applicant', ticketId: 'old', decision: 'approved' }), err('failed-precondition'));
  await reviewDriverVerification(db, adminAuth, { uid: 'applicant', ticketId: ticket.ticketId, decision: 'approved' });
  assert.equal((await db.doc('partners/applicant').get()).data().driverApprovalStatus, 'approved');
});
test('rules permit safe profile creation but deny forged approval, role, wallet and link pointers', async () => {
  const own = client('profile'); const ref = doc(own, 'partners/profile');
  await assertSucceeds(setDoc(ref, { role: 'driver', accountStatus: 'active', name: 'Test', walletBalance: 0, currentVehicleId: null }));
  await assertSucceeds(updateDoc(ref, { name: 'Changed' }));
  for (const patch of [{ driverApprovalStatus: 'approved' }, { role: 'owner' }, { walletBalance: 1000 }, { currentVehicleId: 'stolen' }]) await assertFails(updateDoc(ref, patch));
  await assertFails(setDoc(doc(client('forged-create'), 'partners/forged-create'), { role: 'driver', accountStatus: 'active', driverApprovalStatus: 'approved', walletBalance: 0 }));
});
test('rules block ordinary/stale/email admins and direct financial writes, including super client', async () => {
  await assertSucceeds(getDoc(doc(superDb(), 'partners/paid-driver')));
  for (const context of [client('ordinary', ordinary.token), client('super', { ...adminAuth.token, adminVersion: 0 }), client('email-user', { admin: true, email: 'fuzail1158@gmail.com', email_verified: true })]) {
    await assertFails(getDoc(doc(context, 'partners/paid-driver')));
    await assertFails(updateDoc(doc(context, 'settings/dispatch'), { candidateDriverLimit: 5 }));
  }
  await assertFails(updateDoc(doc(superDb(), 'partners/paid-driver'), { walletBalance: 5000 }));
  await assertFails(updateDoc(doc(superDb(), 'rechargeRequests/pay-two'), { status: 'approved' }));
  await assertFails(setDoc(doc(superDb(), 'settings/security'), { adminBootstrapEnabled: true }));
  await assertSucceeds(setDoc(doc(superDb(), 'settings/dispatch'), { firebaseLocationFallbackEnabled: true, candidateDriverLimit: 5 }));
});
test('vehicle rules block owner GPS/assignment edits, hijacks, active clearing and deletion; approved location works', async () => {
  await db.doc('partners/location-driver').set(approved);
  await db.doc('vehicles/rules-car').set({ ownerId: 'owner', driverId: 'location-driver', status: 'offline', plate: 'RULES', activeRideId: null });
  await assertSucceeds(updateDoc(doc(client('owner'), 'vehicles/rules-car'), { plate: 'SAFE' }));
  for (const patch of [{ location: { lat: 0, lng: 0 } }, { driverId: 'other' }, { activeRideId: 'forged' }]) await assertFails(updateDoc(doc(client('owner'), 'vehicles/rules-car'), patch));
  await assertFails(updateDoc(doc(client('driver-b'), 'vehicles/rules-car'), { driverId: 'driver-b', status: 'online', driverName: 'Thief' }));
  await assertFails(deleteDoc(doc(client('owner'), 'vehicles/rules-car')));
  const location = { status: 'online', driverName: 'Test', location: { lat: 24.86, lng: 67.01, sessionId: 'session_1' }, locationUpdatedAt: serverTimestamp(), trackingSessionId: 'session_1', trackingSessionStartedAt: serverTimestamp(), geoCell: '24_67', locationGridCell: '24_67' };
  await assertSucceeds(updateDoc(doc(client('location-driver'), 'vehicles/rules-car'), location));
  await db.doc('vehicles/rules-car').update({ activeRideId: 'ongoing', status: 'in_ride' });
  await assertFails(updateDoc(doc(client('location-driver'), 'vehicles/rules-car'), { activeRideId: null, status: 'online' }));
  await db.doc('partners/location-driver').update({ driverApprovalStatus: 'rejected' });
  await assertFails(updateDoc(doc(client('location-driver'), 'vehicles/rules-car'), { location: { lat: 24.87, lng: 67.02, sessionId: 'session_1' }, locationUpdatedAt: serverTimestamp() }));
});
test('private code, KYC and promo counters are not client writable or readable cross-user', async () => {
  await assertFails(getDoc(doc(client('owner'), 'vehicle_link_codes/anything')));
  await assertFails(setDoc(doc(client('owner'), 'vehicle_pins/anything'), { ownerId: 'owner', pin: '1234' }));
  await assertFails(updateDoc(doc(client('customer-a'), 'promoCodes/LAST'), { usedCount: 2 }));
  await assertFails(updateDoc(doc(superDb(), 'promoCodes/LAST'), { usedCount: 0 }));
  await assertFails(updateDoc(doc(client('applicant'), 'driver_applications/applicant'), { fullName: 'Replaced' }));
  await assertFails(getDoc(doc(client('customer-a'), 'driver_applications/applicant')));
  await assertSucceeds(getDoc(doc(superDb(), 'driver_applications/applicant')));
});
test('registry revocation blocks existing token immediately in server and rules', async () => {
  await db.doc('admin_registry/super').update({ admin: false, role: 'none', version: 2 });
  assert.equal(await readAdminRole(db, adminAuth), null);
  await assertFails(getDoc(doc(superDb(), 'partners/paid-driver')));
  await assert.rejects(approveRechargeRequest(db, adminAuth, 'pay-one'), err('permission-denied'));
});

test('claim changes merge unrelated claims; revocation updates registry and profile; email alone cannot bootstrap', async () => {
  await db.doc('admin_registry/super').set({ admin: true, role: 'super_admin', version: 1 });
  const authApi = getAuth(app);
  await authApi.createUser({ uid: 'claim-target', email: 'claim-target@example.test', emailVerified: true });
  await authApi.setCustomUserClaims('claim-target', { unrelated: 'preserved', admin: false });
  await grantAdminClaim(db, adminAuth, 'claim-target');
  let user = await authApi.getUser('claim-target');
  assert.equal(user.customClaims.unrelated, 'preserved'); assert.equal(user.customClaims.adminRole, 'admin');
  const issued = { uid: 'claim-target', token: user.customClaims };
  assert.equal(await readAdminRole(db, issued), 'admin');
  await revokeAdminClaim(db, adminAuth, 'claim-target');
  user = await authApi.getUser('claim-target');
  assert.equal(user.customClaims.unrelated, 'preserved'); assert.equal(user.customClaims.admin, false);
  assert.equal((await db.doc('users/claim-target').get()).data().role, 'customer');
  assert.equal(await readAdminRole(db, issued), null);
  await assert.rejects(initSuperAdminAccess(db, { uid: 'email-user', token: { email: 'fuzail1158@gmail.com', email_verified: true } }), err('permission-denied'));
  await assert.rejects(grantSuperAdminClaim(db, ordinary, 'claim-target'), err('permission-denied'));
});
test('bootstrap requires explicitly configured UID and a valid one-time window', async () => {
  const saved = process.env.ADMIN_BOOTSTRAP_UID; process.env.ADMIN_BOOTSTRAP_UID = 'bootstrap-test';
  try {
    await getAuth(app).createUser({ uid: 'bootstrap-test', email: 'bootstrap-test@example.test', emailVerified: true });
    const auth = { uid: 'bootstrap-test', token: { email_verified: true } };
    await assert.rejects(initSuperAdminAccess(db, auth), err('permission-denied'));
    await db.doc('settings/security').set({ adminBootstrapEnabled: true, adminBootstrapExpiresAt: Timestamp.fromMillis(Date.now() + 60000) });
    await initSuperAdminAccess(db, auth);
    assert.equal((await db.doc('settings/security').get()).data().adminBootstrapEnabled, false);
    const user = await getAuth(app).getUser('bootstrap-test');
    assert.equal(await readAdminRole(db, { uid: auth.uid, token: user.customClaims }), 'super_admin');
    await assert.rejects(initSuperAdminAccess(db, auth), err('permission-denied'));
  } finally { if (saved === undefined) delete process.env.ADMIN_BOOTSTRAP_UID; else process.env.ADMIN_BOOTSTRAP_UID = saved; }
});
test('approved-driver assignment ignores forged owner and plate; unapproved bid is denied', async () => {
  const uid = 'assignment-driver';
  await db.doc(`partners/${uid}`).set(approved);
  await db.doc('vehicles/assignment-car').set({ ownerId: 'owner', driverId: uid, plate: 'REAL', status: 'online' });
  const q = await quoteCustomerBooking(db, 'assignment-customer', input, { routeProvider });
  const booking = await createCustomerBooking(db, { customerUid: 'assignment-customer', ridePayload: { quoteId: q.quoteId, acceptedFare: q.farePkr } });
  await db.doc(`ride_candidates/${booking.id}_${uid}`).set({ status: 'invited', rideId: booking.id, driverId: uid });
  await db.doc(`partners/${uid}`).update({ driverApprovalStatus: 'pending' });
  await assert.rejects(submitRideOffer(db, { rideId: booking.id, driverUid: uid, vehicleId: 'assignment-car', fare: 100 }), err('permission-denied'));
  await db.doc(`partners/${uid}`).update({ driverApprovalStatus: 'approved' });
  await acceptCustomerInitialFareAsDriver(db, { rideId: booking.id, driverUid: uid, vehicleId: 'assignment-car', ownerId: 'forged', vehiclePlate: 'FAKE' });
  const ride = (await db.doc(`rides/${booking.id}`).get()).data();
  assert.equal(ride.ownerId, 'owner'); assert.equal(ride.vehiclePlate, 'REAL'); assert.equal(ride.farePkr, q.farePkr);
});
test('quote expiry and malformed promo counters deny; full valid discount remains zero, not a hidden minimum', async () => {
  const expired = await quoteCustomerBooking(db, 'expired-quote', input, { routeProvider, now: Date.now() - 300000 });
  await assert.rejects(createCustomerBooking(db, { customerUid: 'expired-quote', ridePayload: { quoteId: expired.quoteId, acceptedFare: expired.farePkr } }), err('failed-precondition'));
  const base = normalizeBookingInput({ ...input, promoCode: 'FREE' });
  assert.equal(quoteFare(base, {}, { distanceKm: 4, timeMins: 12 }, { active: true, type: 'percent', value: 100 }).farePkr, 0);
  assert.throws(() => quoteFare(base, {}, { distanceKm: 4, timeMins: 12 }, { active: true, type: 'percent', value: 10, usedCount: -1 }));
});
test('expired link code and previous active vehicle never permit switching', async () => {
  await db.doc('partners/expiry-driver').set(approved);
  const v = await createFleetVehicle(db, 'owner', { model: 'Bike', plate: 'EXPIRY' }, { now: Date.now() - 700000 });
  await assert.rejects(linkVehicleByCode(db, { driverUid: 'expiry-driver', pin: v.code }), err('not-found'));
  const next = await rotateVehicleLinkCode(db, 'owner', v.vehicleId);
  await db.doc('vehicles/old-active').set({ ownerId: 'owner', driverId: 'expiry-driver', status: 'in_ride', activeRideId: 'ride-active' });
  await db.doc('partners/expiry-driver').update({ currentVehicleId: 'old-active' });
  await assert.rejects(linkVehicleByCode(db, { driverUid: 'expiry-driver', pin: next.code }), err('failed-precondition'));
  assert.equal((await db.doc('vehicles/old-active').get()).data().driverId, 'expiry-driver');
});
test('six simultaneous booking requests cannot overwrite the four-slot limit during reconciliation', async () => {
  const quotes = await Promise.all(Array.from({ length: 6 }, () => quoteCustomerBooking(db, 'slot-race', input, { routeProvider })));
  const results = await Promise.allSettled(quotes.map((q) => createCustomerBooking(db, { customerUid: 'slot-race', confirmedExtraBooking: true, ridePayload: { quoteId: q.quoteId, acceptedFare: q.farePkr } })));
  const live = await db.collection('rides').where('userId', '==', 'slot-race').where('status', '==', 'searching_driver').get();
  assert.equal(live.size, 4); assert.equal(results.filter((r) => r.status === 'fulfilled').length, 4);
  assert.equal((await db.doc('booking_slots/slot-race').get()).data().count, 4);
});
test('simultaneous replay of the same quote returns one booking without requiring another confirmation', async () => {
  const quote = await quoteCustomerBooking(db, 'quote-race', input, { routeProvider });
  const params = { customerUid: 'quote-race', ridePayload: { quoteId: quote.quoteId, acceptedFare: quote.farePkr } };
  const results = await Promise.all([createCustomerBooking(db, params), createCustomerBooking(db, params)]);
  assert.equal(results[0].id, results[1].id);
  assert.equal((await db.doc('booking_slots/quote-race').get()).data().count, 1);
});
test('settlement and cancellation cannot rely on a stale pre-transaction admin boolean', async () => {
  const { settleRide } = require('../functions/settlement');
  const { cancelRideByAdmin } = require('../functions/ride-cancellation');
  await assert.rejects(settleRide(db, { rideId: 'any', callerUid: 'ordinary', isAdmin: true, adminAuth: ordinary }), err('permission-denied'));
  await assert.rejects(cancelRideByAdmin(db, { rideId: 'any', adminUid: ordinary.uid, adminAuth: ordinary, reason: 'Test' }), err('permission-denied'));
});
test('native background location rechecks driver approval and vehicle binding after credential issuance', async () => {
  const { issueBackgroundLocationCredential, ingestBackgroundDriverLocation } = require('../functions/background-location-upload');
  const now = Date.now(); const secret = 'local-test-only-secret-not-a-production-credential';
  await db.doc('partners/bg-driver').set(approved);
  await db.doc('vehicles/bg-car').set({ ownerId: 'owner', driverId: 'bg-driver', activeRideId: 'bg-ride', status: 'in_ride', trackingSessionId: 'bg_session_1', trackingSessionStartedAt: Timestamp.fromMillis(now) });
  await db.doc('rides/bg-ride').set({ driverId: 'bg-driver', userId: 'bg-customer', vehicleId: 'bg-car', status: 'in_progress', assignmentSessionToken: 'as_test_background' });
  const input = { driverUid: 'bg-driver', rideId: 'bg-ride', vehicleId: 'bg-car', trackingSessionId: 'bg_session_1', secret, nowMs: now };
  const issued = await issueBackgroundLocationCredential(db, input);
  const fix = { lat: 24.86, lng: 67.01, observedAt: now, sessionId: 'bg_session_1', sequence: 1, accuracyM: 5 };
  const accepted = await ingestBackgroundDriverLocation(db, { token: issued.token, secret, nowMs: now, fix });
  assert.equal(accepted.accepted, true);
  await db.doc('partners/bg-driver').update({ driverApprovalStatus: 'rejected' });
  const denied = await ingestBackgroundDriverLocation(db, { token: issued.token, secret, nowMs: now + 5000, fix: { ...fix, observedAt: now + 5000, sequence: 2 } });
  assert.equal(denied.reason, 'DRIVER_NOT_AUTHORIZED');
  await assert.rejects(issueBackgroundLocationCredential(db, input), err('permission-denied'));
});
