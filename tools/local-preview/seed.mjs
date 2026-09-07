import { createRequire } from 'node:module';
import { PROJECT, HOST, PORTS, ACCOUNTS, assertEmulators } from './config.mjs';
import { fixturePng } from './fixture.mjs';
const requireServer = createRequire(new URL('../../functions/package.json', import.meta.url));

export async function seedPreview(password, { recoverMissingFixtures = false } = {}) {
  assertEmulators();
  const { initializeApp } = requireServer('firebase-admin/app');
  const { getAuth } = requireServer('firebase-admin/auth');
  const { getFirestore, FieldValue } = requireServer('firebase-admin/firestore');
  const { getStorage } = requireServer('firebase-admin/storage');
  const { DEFAULT_PRICING } = requireServer('./pricing-fare.js');
  const app = initializeApp({ projectId: PROJECT, storageBucket: `${PROJECT}.appspot.com` });
  const auth = getAuth(app), db = getFirestore(app), bucket = getStorage(app).bucket();
  // Never clear somebody else's emulator data or merge into an existing session.
  if (!recoverMissingFixtures && ((await auth.listUsers(1)).users.length || (await db.listCollections()).length)) throw new Error('FRESH_EMPTY_PREVIEW_EMULATORS_REQUIRED');
  const allAccounts = [...ACCOUNTS, { uid: 'preview-review', email: 'review@example.test', label: 'صرف فرضی شناختی درخواست' }];
  for (const account of allAccounts) {
    if (recoverMissingFixtures) {
      const existing = await auth.getUser(account.uid).catch((e) => { if (e.code === 'auth/user-not-found') return null; throw e; });
      if (existing) { if (existing.email !== account.email) throw new Error('PREVIEW_ACCOUNT_MISMATCH'); continue; }
    }
    await auth.createUser({ uid: account.uid, email: account.email, emailVerified: true, password, displayName: account.label });
  }
  if (!recoverMissingFixtures) await auth.setCustomUserClaims('preview-admin', { admin: true, adminRole: 'super_admin', adminVersion: 1 });
  const batch = recoverMissingFixtures ? createMissingOnlyBatch(db) : db.batch();
  batch.create(db.doc('admin_registry/preview-admin'), { admin: true, role: 'super_admin', version: 1 });
  for (const account of allAccounts) batch.create(db.doc(`users/${account.uid}`), { uid: account.uid, displayName: account.label, email: account.email, role: account.uid === 'preview-admin' ? 'super_admin' : 'customer', createdAt: FieldValue.serverTimestamp() });
  for (const uid of ['preview-driver', 'preview-applicant', 'preview-review', 'preview-owner']) {
    batch.create(db.doc(`partners/${uid}`), { uid, name: allAccounts.find((a) => a.uid === uid).label, email: allAccounts.find((a) => a.uid === uid).email,
      role: uid === 'preview-owner' ? 'owner' : 'driver', accountStatus: 'active', status: 'approved',
      driverApprovalStatus: uid === 'preview-driver' ? 'approved' : uid === 'preview-review' ? 'pending' : 'not_submitted',
      currentVehicleId: uid === 'preview-driver' ? 'preview-bike' : null, walletBalance: 0, totalEarnings: 0, totalRidesCompleted: 0,
      createdAt: FieldValue.serverTimestamp(), ...(uid === 'preview-review' ? { driverApplicationId: uid } : {}) });
  }
  batch.create(db.doc('vehicles/preview-bike'), { ownerId: 'preview-owner', driverId: 'preview-driver', driverName: 'آزمائشی ڈرائیور', model: 'Bike', plate: 'TEST-001', vehicleTypeKey: 'bike', vehicleType: 'bike', status: 'offline', activeRideId: null, createdAt: FieldValue.serverTimestamp() });
  batch.create(db.doc('vehicles/preview-free-bike'), { ownerId: 'preview-owner', driverId: null, model: 'Bike', plate: 'TEST-002', vehicleTypeKey: 'bike', vehicleType: 'bike', status: 'offline', createdAt: FieldValue.serverTimestamp() });
  batch.create(db.doc('settings/pricing'), DEFAULT_PRICING);
  batch.create(db.doc('settings/dispatch'), { maxCustomerActiveBookings: 4, maxDriverOpenBargains: 5, candidateDriverLimit: 10, searchRingsKm: [1, 2, 3], searchTimeoutSeconds: 180 });
  batch.create(db.doc('settings/security'), { adminBootstrapEnabled: false });
  batch.create(db.doc('promoCodes/TEST10'), { active: true, type: 'percent', value: 10, maxUses: 100, usedCount: 0 });
  batch.create(db.doc('rechargeRequests/preview-500'), { driverId: 'preview-driver', driverName: 'آزمائشی ڈرائیور', amount: 500, method: 'easypaisa', tid: 'PREVIEW-ONLY-500', status: 'pending', createdAt: FieldValue.serverTimestamp() });
  batch.create(db.doc('preview_metadata/session'), { project: PROJECT, synthetic: true, createdAt: FieldValue.serverTimestamp() });
  await batch.commit();
  const proofs = {}; const ticketId = 'preview-synthetic-documents';
  for (const key of ['cnicFront', 'cnicBack', 'license', 'selfie']) {
    const path = `driver_applications/preview-review/${ticketId}_${key}`;
    const file = bucket.file(path);
    if (!recoverMissingFixtures || !(await file.exists())[0]) await file.save(fixturePng(), { resumable: false, contentType: 'image/png' });
    const [metadata] = await file.getMetadata();
    proofs[key] = { path, generation: String(metadata.generation), size: Number(metadata.size), contentType: metadata.contentType };
  }
  const application = db.doc('driver_applications/preview-review');
  if (!recoverMissingFixtures || !(await application.get()).exists) await application.create({ userId: 'preview-review', ticketId, fullName: 'صرف فرضی درخواست — حقیقی شناخت نہیں', cnic: '0000000000000', licenseNumber: 'PREVIEW-NOT-VALID', proofs, status: 'pending', createdAt: FieldValue.serverTimestamp() });
  return { app, auth, db };
}

export function createMissingOnlyBatch(db) {
  const entries = [];
  return { create(ref, data) { entries.push([ref, data]); }, async commit() {
    const snapshots = await db.getAll(...entries.map(([ref]) => ref));
    const batch = db.batch(); let created = 0;
    for (let i = 0; i < entries.length; i++) if (!snapshots[i].exists) { batch.create(...entries[i]); created++; }
    if (created) await batch.commit(); return { created, kept: entries.length - created };
  } };
}

export async function signInAccount(email, password) {
  assertEmulators();
  const response = await fetch(`http://${HOST}:${PORTS.auth}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-api-key`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password, returnSecureToken: true }), signal: AbortSignal.timeout(15000),
  });
  const body = await response.json();
  if (!response.ok || !body.idToken) throw new Error(`PREVIEW_LOGIN_FAILED:${email}`);
  return body.idToken;
}

export async function callPreview(name, token, data = {}) {
  assertEmulators();
  if (!/^[a-zA-Z][a-zA-Z0-9]+$/.test(name)) throw new Error('INVALID_FUNCTION_NAME');
  const response = await fetch(`http://${HOST}:${PORTS.functions}/${PROJECT}/us-central1/${name}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ data }), signal: AbortSignal.timeout(60000),
  });
  let body;
  try { body = await response.json(); } catch { throw new Error(`PREVIEW_FUNCTION_NOT_READY:${name}:${response.status}`); }
  if (!response.ok || body.error) throw new Error(`PREVIEW_CALL_FAILED:${name}:${body.error?.status || response.status}:${body.error?.message || ''}`);
  return body.result;
}
