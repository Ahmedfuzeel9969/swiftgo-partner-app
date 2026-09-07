import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { setDoc, doc, Timestamp } from 'firebase/firestore';
import { ref, uploadBytes, getBytes, updateMetadata, deleteObject, listAll } from 'firebase/storage';
const projectId = 'demo-remediation-phase1';
for (const key of ['FIRESTORE_EMULATOR_HOST', 'FIREBASE_STORAGE_EMULATOR_HOST']) {
  if (!/^127\.0\.0\.1:\d+$/.test(process.env[key] || '')) throw new Error(`LOOPBACK_${key}_REQUIRED`);
}
test('storage: ticketed upload; immutable proofs; private reads; revoked and ordinary admins denied', async () => {
  const [fhost, fport] = process.env.FIRESTORE_EMULATOR_HOST.split(':');
  const [shost, sport] = process.env.FIREBASE_STORAGE_EMULATOR_HOST.split(':');
  const env = await initializeTestEnvironment({ projectId,
    firestore: { host: fhost, port: Number(fport), rules: await readFile(new URL('../firestore.rules', import.meta.url), 'utf8') },
    storage: { host: shost, port: Number(sport), rules: await readFile(new URL('../storage.rules', import.meta.url), 'utf8') } });
  try {
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, 'driver_upload_tickets/proof-owner'), { ticketId: 'ticket1', used: false, expiresAt: Timestamp.fromMillis(Date.now() + 60000) });
      await setDoc(doc(db, 'admin_registry/proof-admin'), { admin: true, role: 'super_admin', version: 1 });
      await setDoc(doc(db, 'admin_registry/proof-ordinary'), { admin: true, role: 'admin', version: 1 });
    });
    const owner = env.authenticatedContext('proof-owner').storage();
    const other = env.authenticatedContext('proof-other').storage();
    const admin = env.authenticatedContext('proof-admin', { admin: true, adminRole: 'super_admin', adminVersion: 1 }).storage();
    const ordinary = env.authenticatedContext('proof-ordinary', { admin: true, adminRole: 'admin', adminVersion: 1 }).storage();
    const guest = env.unauthenticatedContext().storage();
    const path = 'driver_applications/proof-owner/ticket1_selfie';
    const bytes = new Uint8Array([255,216,255,217]);
    await assertSucceeds(uploadBytes(ref(owner, path), bytes, { contentType: 'image/jpeg' }));
    await assertSucceeds(getBytes(ref(owner, path)));
    await assertSucceeds(getBytes(ref(admin, path)));
    await assertFails(getBytes(ref(other, path)));
    await assertFails(getBytes(ref(ordinary, path)));
    await assertFails(getBytes(ref(guest, path)));
    await assertFails(uploadBytes(ref(owner, path), bytes, { contentType: 'image/jpeg' }));
    await assertFails(updateMetadata(ref(owner, path), { contentType: 'image/png' }));
    await assertFails(deleteObject(ref(owner, path)));
    await assertFails(listAll(ref(owner, 'driver_applications/proof-owner')));
    await assertFails(uploadBytes(ref(owner, 'driver_applications/proof-owner/not-ticketed'), bytes, { contentType: 'image/jpeg' }));
    await assertFails(uploadBytes(ref(other, 'driver_applications/proof-owner/ticket1_license'), bytes, { contentType: 'image/jpeg' }));
    await assertFails(uploadBytes(ref(owner, 'driver_applications/proof-owner/ticket1_license'), bytes, { contentType: 'application/pdf' }));
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, 'driver_upload_tickets/proof-owner'), { ticketId: 'ticket1', used: true, expiresAt: Timestamp.fromMillis(Date.now() + 60000) });
      await setDoc(doc(db, 'admin_registry/proof-admin'), { admin: false, role: 'none', version: 2 });
    });
    await assertFails(uploadBytes(ref(owner, 'driver_applications/proof-owner/ticket1_license'), bytes, { contentType: 'image/jpeg' }));
    await assertFails(getBytes(ref(admin, path)));
  } finally { await env.cleanup(); }
});
