import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { PROJECT, APPS, ACCOUNTS, assertEmulators, safeChild, previewConfigModule, contentSecurityPolicy } from '../tools/local-preview/config.mjs';
import { previewEnvironment, copyFunctionSources } from '../tools/local-preview.mjs';
import { makeHandler, portal } from '../tools/local-preview/server.mjs';
import { fixturePng } from '../tools/local-preview/fixture.mjs';
const env = { GCLOUD_PROJECT: PROJECT, GOOGLE_CLOUD_PROJECT: PROJECT, FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080', FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099', FIREBASE_STORAGE_EMULATOR_HOST: '127.0.0.1:9199' };

test('production/missing/wrong project, credentials and emulator hosts fail closed', () => {
  assert.doesNotThrow(() => assertEmulators(env));
  for (const key of Object.keys(env)) {
    assert.throws(() => assertEmulators({ ...env, [key]: 'swiftgo-ride-app' }));
    assert.throws(() => assertEmulators({ ...env, [key]: undefined }));
  }
  assert.throws(() => assertEmulators({ ...env, GOOGLE_APPLICATION_CREDENTIALS: 'anything.json' }));
});
test('runtime inherits no Firebase, cloud, TURN, bootstrap or application secrets', () => {
  const clean = previewEnvironment({ PATH: 'path', SystemRoot: 'windows', FIREBASE_TOKEN: 'secret', GOOGLE_APPLICATION_CREDENTIALS: 'key', ADMIN_BOOTSTRAP_UID: 'real', P2P_TURN_SECRET: 'secret', BACKGROUND_LOCATION_UPLOAD_SECRET: 'secret', BOOKING_ROUTE_BASE_URL: 'https://private.example', NODE_OPTIONS: '--require bad.js' });
  assert.deepEqual(Object.keys(clean).sort(), ['PATH', 'SystemRoot', 'CI', 'GCLOUD_PROJECT', 'GOOGLE_CLOUD_PROJECT', 'FIREBASE_CLI_DISABLE_UPDATE_CHECK', 'FIREBASE_CLI_DISABLE_TELEMETRY'].sort());
  assert.equal(clean.GCLOUD_PROJECT, PROJECT);
});
test('separate origins and reserved test emails avoid session collision and real identities', () => {
  assert.equal(new Set(APPS.map((a) => a.port)).size, 4);
  assert.ok(ACCOUNTS.every((a) => a.email.endsWith('@example.test')));
});
test('staging keeps credential-handling source modules, excludes credential data and environment files', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'swiftgo-preview-test-'));
  const source = path.join(dir, 'source'), destination = path.join(dir, 'staged');
  await fs.mkdir(source);
  try {
    for (const name of ['index.js', 'p2p-turn-credentials.js', 'credentials.json', 'serviceAccount.json', '.env', '.secret.local']) await fs.writeFile(path.join(source, name), 'fixture');
    copyFunctionSources(source, destination);
    assert.deepEqual((await fs.readdir(destination)).sort(), ['index.js', 'p2p-turn-credentials.js']);
  } finally {
    if (path.dirname(path.resolve(dir)) !== path.resolve(os.tmpdir()) || !path.basename(dir).startsWith('swiftgo-preview-test-')) throw new Error('UNSAFE_TEMP_CLEANUP');
    await fs.rm(dir, { recursive: true });
  }
});
test('browser policy permits only listed local Firebase endpoints, not production services', () => {
  const policy = contentSecurityPolicy();
  const connect = policy.split('; ').find((part) => part.startsWith('connect-src'));
  assert.ok(connect.includes('http://127.0.0.1:8080'));
  assert.ok(!connect.includes('googleapis.com'));
  assert.ok(!connect.includes('cloudfunctions.net'));
  assert.ok(!connect.includes('firebaseapp.com'));
  assert.ok(!connect.includes(' https:') || !connect.includes(' https: '));
  const config = previewConfigModule();
  assert.ok(config.includes(PROJECT)); assert.ok(!config.includes('swiftgo-ride-app'));
});
test('path traversal, hidden files, Windows separators and absolute escape denied', () => {
  const root = path.resolve('hosting-dist');
  for (const rel of ['../functions/index.js', '.env', '.git/config', 'a/../../secret', '..\\secret', '/outside']) assert.throws(() => safeChild(root, rel, path));
  assert.equal(safeChild(root, 'customer/index.html', path), path.join(root, 'customer', 'index.html'));
});
test('visible synthetic proof is a valid PNG-shaped fixture; portal clearly disclaims live/motion testing', () => {
  const png = fixturePng(); assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(png.readUInt32BE(16), 480); assert.equal(png.readUInt32BE(20), 240);
  const page = portal('<unsafe>', []); assert.ok(!page.includes('<unsafe>')); assert.ok(page.includes('&lt;unsafe&gt;'));
  assert.ok(page.includes('چلتی گاڑی')); assert.ok(page.includes('حقیقی ادائیگی'));
});
test('HTTP preview bootstraps before app scripts; serves no source/secrets; locks origin and writes', async () => {
  const dist = await fs.mkdtemp(path.join(os.tmpdir(), 'swiftgo-preview-test-'));
  await fs.mkdir(path.join(dist, 'customer'));
  await fs.writeFile(path.join(dist, 'customer', 'index.html'), '<html><head><script src="app.js"></script></head><body>test</body></html>');
  const server = http.createServer(makeHandler({ dist, app: APPS[0], password: 'test-only' }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const html = await fetch(`${base}/customer/`).then((r) => r.text());
    assert.ok(html.indexOf('/__preview/bootstrap.js') < html.indexOf('app.js'));
    assert.ok(html.includes('/__preview/panel.mjs'));
    const config = await fetch(`${base}/admin/js/firebase-config.js`).then((r) => r.text());
    assert.ok(config.includes(PROJECT));
    for (const resource of ['/functions/index.js', '/.env', '/%2e%2e%5csecret']) assert.notEqual((await fetch(`${base}${resource}`)).status, 200);
    assert.equal((await fetch(`${base}/__preview/info`, { headers: { Origin: 'https://evil.example' } })).status, 403);
    const wrongHost = await new Promise((resolve, reject) => {
      http.get(`${base}/__preview/info`, { headers: { Host: 'evil.example' } }, (response) => { response.resume(); resolve(response.statusCode); }).once('error', reject);
    });
    assert.equal(wrongHost, 403);
    assert.equal((await fetch(`${base}/__preview/info`, { method: 'POST' })).status, 405);
    const info = await fetch(`${base}/__preview/info`); assert.equal(info.headers.get('cache-control'), 'no-store, max-age=0');
    assert.ok((await info.json()).accounts.every((a) => a.app === 'customer'));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (path.dirname(path.resolve(dist)) !== path.resolve(os.tmpdir()) || !path.basename(dist).startsWith('swiftgo-preview-test-')) throw new Error('UNSAFE_TEMP_CLEANUP');
    await fs.rm(dist, { recursive: true });
  }
});
