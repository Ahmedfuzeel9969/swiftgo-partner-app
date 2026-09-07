/** Read-only protocol checks of the running preview; never accepts a remote URL. */
import assert from 'node:assert/strict';
import { PROJECT, HOST, PORTS, APPS } from './config.mjs';
const base = `http://${HOST}:${APPS[0].port}`;
const health = await fetch(`${base}/__preview/health`).then((response) => response.json());
assert.equal(health.project, PROJECT); assert.equal(health.synthetic, true);
const info = await fetch(`${base}/__preview/info`).then((response) => response.json());
assert.equal(info.project, PROJECT);
async function login(email) {
  const response = await fetch(`http://${HOST}:${PORTS.auth}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-api-key`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: info.password, returnSecureToken: true }), signal: AbortSignal.timeout(15000),
  });
  assert.equal(response.status, 200);
  return (await response.json()).idToken;
}
const [customer, driver, admin] = await Promise.all(['customer@example.test', 'driver@example.test', 'admin@example.test'].map(login));
for (const app of APPS) {
  const response = await fetch(`http://${HOST}:${app.port}${app.path}?emulators=1`);
  assert.equal(response.status, 200); assert.equal(response.headers.get('x-swiftgo-preview'), PROJECT);
  const html = await response.text();
  assert.ok(html.includes('/__preview/bootstrap.js')); assert.ok(html.includes('/__preview/panel.mjs'));
  console.log(`PASS ${app.key}: HTTP 200 and preview bootstrap`);
}
const partnerUrl = `http://${HOST}:${PORTS.firestore}/v1/projects/${PROJECT}/databases/(default)/documents/partners/preview-driver`;
assert.equal((await fetch(partnerUrl, { headers: { Authorization: `Bearer ${driver}` } })).status, 200);
assert.equal((await fetch(partnerUrl, { headers: { Authorization: `Bearer ${customer}` } })).status, 403);
console.log('PASS Firestore: driver can read own profile; customer cannot read it');
const proof = encodeURIComponent('driver_applications/preview-review/preview-synthetic-documents_cnicFront');
const imageUrl = `http://${HOST}:${PORTS.storage}/v0/b/${PROJECT}.appspot.com/o/${proof}?alt=media`;
const allowed = await fetch(imageUrl, { headers: { Authorization: `Bearer ${admin}` } });
assert.equal(allowed.status, 200);
assert.equal(Buffer.from(await allowed.arrayBuffer()).subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
const denied = await fetch(imageUrl, { headers: { Authorization: `Bearer ${customer}` } });
assert.ok([401, 403].includes(denied.status));
console.log('PASS Storage: verified super admin can read synthetic proof; unrelated customer cannot');
console.log(JSON.stringify({ project: PROJECT, protocols: 'PASS', browserVisualQA: 'NOT_PERFORMED', startupChecks: health.checks }));
