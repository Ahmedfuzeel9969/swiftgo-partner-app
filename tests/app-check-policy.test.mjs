import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
const requireServer = createRequire(new URL('../functions/package.json', import.meta.url));
const { readAppCheckEnforcement } = requireServer('./app-check-policy.js');
const { onCall } = requireServer('firebase-functions/v2/https');
const express = requireServer('express');

test('App Check configuration produces literal booleans; malformed values fail closed', () => {
  assert.equal(readAppCheckEnforcement({}), false);
  assert.equal(readAppCheckEnforcement({ ENFORCE_APP_CHECK: 'false' }), false);
  assert.equal(readAppCheckEnforcement({ ENFORCE_APP_CHECK: 'true' }), true);
  for (const value of ['', 'FALSE', 'yes', '0', {}, false]) assert.throws(() => readAppCheckEnforcement({ ENFORCE_APP_CHECK: value }));
});

test('actual callable HTTP middleware allows disabled App Check and denies missing proof when enabled', async () => {
  const app = express(); app.use(express.json());
  app.post('/disabled', onCall({ enforceAppCheck: readAppCheckEnforcement({ ENFORCE_APP_CHECK: 'false' }) }, () => ({ reached: true })));
  app.post('/enabled', onCall({ enforceAppCheck: readAppCheckEnforcement({ ENFORCE_APP_CHECK: 'true' }) }, () => ({ reached: true })));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const options = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: {} }) };
    const allowed = await fetch(`${base}/disabled`, options);
    assert.equal(allowed.status, 200); assert.equal((await allowed.json()).result.reached, true);
    const denied = await fetch(`${base}/enabled`, options);
    assert.equal(denied.status, 401); assert.equal((await denied.json()).error.status, 'UNAUTHENTICATED');
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
