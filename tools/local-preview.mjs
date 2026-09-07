/** Loopback-only manual QA. No deploy/export/import command exists in this tool. */
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PROJECT, HOST, PORTS, APPS, ACCOUNTS, assertEmulators } from './local-preview/config.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SELF = fileURLToPath(import.meta.url);

export function previewEnvironment(source = process.env) {
  const allowed = /^(path|systemroot|windir|comspec|userprofile|homedrive|homepath|appdata|localappdata|temp|tmp|java_home|programfiles(?:\(x86\))?|programdata|lang|lc_all|http_proxy|https_proxy|no_proxy|npm_config_cache|firebase_emulators_path)$/i;
  const env = Object.fromEntries(Object.entries(source).filter(([key]) => allowed.test(key)));
  return { ...env, CI: 'true', GCLOUD_PROJECT: PROJECT, GOOGLE_CLOUD_PROJECT: PROJECT, FIREBASE_CLI_DISABLE_UPDATE_CHECK: 'true', FIREBASE_CLI_DISABLE_TELEMETRY: 'true' };
}

function runNode(script, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: ROOT, stdio: 'inherit', windowsHide: true, ...options });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`LOCAL_PROCESS_EXIT:${code ?? signal}`)));
  });
}

async function requireFreePorts() {
  for (const port of [...Object.values(PORTS), ...APPS.map((a) => a.port)]) {
    await new Promise((resolve, reject) => {
      const server = net.createServer();
      server.once('error', () => reject(new Error(`PORT_IN_USE_NO_PROCESS_WAS_STOPPED:${port}`)));
      server.listen(port, HOST, () => server.close(resolve));
    });
  }
}

function firebaseCli() {
  for (const directory of String(process.env.PATH || process.env.Path || '').split(path.delimiter)) {
    const candidate = path.resolve(directory, '..', 'firebase-tools', 'lib', 'bin', 'firebase.js');
    const packageFile = path.resolve(directory, '..', 'firebase-tools', 'package.json');
    if (fs.existsSync(candidate) && fs.existsSync(packageFile) && JSON.parse(fs.readFileSync(packageFile, 'utf8')).version === '15.28.2') return candidate;
  }
  throw new Error('RUN_WITH: npm run preview:local');
}

export function copyFunctionSources(source, destination) {
  fs.mkdirSync(destination);
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.') || /^(?:credentials|serviceaccount.*|.*service-account.*)\.json$/i.test(entry.name)) continue;
    const from = path.join(source, entry.name), to = path.join(destination, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`FUNCTION_SOURCE_LINK_NOT_ALLOWED:${entry.name}`);
    if (entry.isDirectory()) copyFunctionSources(from, to);
    else if (/\.(js|mjs|cjs|json)$/.test(entry.name)) fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
  }
}

export function stagePreview() {
  const base = path.join(ROOT, 'emulator-data', 'local-preview');
  fs.mkdirSync(base, { recursive: true });
  if (fs.realpathSync(base) !== base) throw new Error('PREVIEW_DIRECTORY_MUST_NOT_BE_LINKED');
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}`;
  const dir = path.join(base, runId); fs.mkdirSync(dir);
  const source = path.join(ROOT, 'functions'), target = path.join(dir, 'functions');
  copyFunctionSources(source, target);
  const dependencies = path.join(source, 'node_modules');
  if (!fs.statSync(dependencies).isDirectory()) throw new Error('FUNCTION_DEPENDENCIES_REQUIRED');
  fs.symlinkSync(dependencies, path.join(target, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  // Only freshly generated local values; never copy production .env or secrets.
  fs.writeFileSync(path.join(target, '.secret.local'), `BACKGROUND_LOCATION_UPLOAD_SECRET=preview-${randomBytes(32).toString('hex')}\n`, { flag: 'wx' });
  fs.writeFileSync(path.join(target, '.env.local'), 'ENFORCE_APP_CHECK=false\n', { flag: 'wx' });
  for (const file of ['firestore.rules', 'firestore.indexes.json', 'storage.rules']) fs.copyFileSync(path.join(ROOT, file), path.join(dir, file), fs.constants.COPYFILE_EXCL);
  const config = { firestore: { rules: 'firestore.rules', indexes: 'firestore.indexes.json' }, storage: { rules: 'storage.rules' }, functions: [{ source: 'functions', codebase: 'default', runtime: 'nodejs22' }],
    emulators: { ...Object.fromEntries(Object.entries(PORTS).map(([name, port]) => [name, { host: HOST, port }])), ui: { enabled: false }, singleProjectMode: true } };
  fs.writeFileSync(path.join(dir, 'firebase.json'), `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx' });
  const manifest = { project: PROJECT, runId, runDir: dir, password: `Preview-${randomBytes(8).toString('hex')}!`, createdAt: new Date().toISOString(), apps: APPS, synthetic: true };
  fs.writeFileSync(path.join(dir, 'preview.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  return manifest;
}

async function start() {
  if (Number(process.versions.node.split('.')[0]) !== 22) throw new Error('NODE_22_REQUIRED: npm run preview:local');
  const cli = firebaseCli();
  await requireFreePorts();
  await runNode(path.join(ROOT, 'tools', 'build-hosting.mjs'), []);
  await runNode(path.join(ROOT, 'tools', 'hosting-startup-health.mjs'), ['--no-write']);
  const manifest = stagePreview();
  console.log(`[local-preview] Fresh isolated demo session: ${manifest.runId}`);
  const quote = (value) => `"${value.replaceAll('"', '')}"`;
  const command = `${quote(process.execPath)} ${quote(SELF)} serve ${quote(manifest.runDir)}`;
  await runNode(cli, ['emulators:exec', '--only', 'auth,firestore,storage,functions', '--project', PROJECT, '--config', path.join(manifest.runDir, 'firebase.json'), command], { cwd: manifest.runDir, env: previewEnvironment() });
}

async function serve(dir) {
  assertEmulators();
  const base = path.join(ROOT, 'emulator-data', 'local-preview');
  if (path.dirname(path.resolve(dir || '')) !== base || fs.realpathSync(dir) !== path.resolve(dir)) throw new Error('INVALID_PREVIEW_SESSION');
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'preview.json'), 'utf8'));
  if (manifest.project !== PROJECT || manifest.runDir !== dir || manifest.synthetic !== true) throw new Error('INVALID_PREVIEW_MANIFEST');
  const hub = await fetch(`http://${HOST}:${PORTS.hub}/emulators`, { signal: AbortSignal.timeout(10000) }).then((r) => r.json());
  for (const name of ['auth', 'firestore', 'storage', 'functions']) {
    if (hub[name]?.host !== HOST || hub[name]?.port !== PORTS[name]) throw new Error(`WRONG_PREVIEW_SERVICE:${name}`);
  }
  const { seedPreview, signInAccount, callPreview } = await import('./local-preview/seed.mjs');
  const { auth, db } = await seedPreview(manifest.password);
  const checks = [];
  for (const account of ACCOUNTS) {
    const token = await signInAccount(account.email, manifest.password);
    if (account.app === 'admin' || account.app === 'customer') {
      const access = await callPreview('getAdminAccess', token);
      if (access.authorized !== (account.app === 'admin')) throw new Error('PREVIEW_ADMIN_GATE_FAILED');
    }
  }
  checks.push('پانچ آزمائشی داخلے اور سپر منتظم کی اجازت درست');
  try {
    const token = await signInAccount('customer@example.test', manifest.password);
    const result = await callPreview('quoteCustomerBooking', token, { pickupLocation: { lat: 24.8607, lng: 67.0011, address: 'آزمائشی آغاز' }, dropoffLocation: { lat: 24.87, lng: 67.025, address: 'آزمائشی اختتام' }, vehicleType: 'bike', paymentMethod: 'cash' });
    if (!result.quoteId || !Number.isFinite(result.farePkr)) throw new Error('INVALID_QUOTE');
    checks.push('سرور سے آزمائشی قیمت موصول ہوئی');
  } catch (error) { checks.push('راستے/قیمت کی جانچ ناکام؛ بکنگ کی تصدیق باقی'); console.warn(`[local-preview] Quote check: ${error.message}`); }
  const { startServers } = await import('./local-preview/server.mjs');
  const servers = await startServers({ dist: path.join(ROOT, 'hosting-dist'), password: manifest.password, checks });
  fs.mkdirSync(path.join(ROOT, '.firebase'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, '.firebase', 'local-preview-current.json'), JSON.stringify({ ...manifest, checks, readyAt: new Date().toISOString(), pid: process.pid }, null, 2));
  console.log(`[local-preview] READY http://${HOST}:${APPS[0].port}/__preview/`);
  for (const app of APPS) console.log(`[local-preview] ${app.key}: http://${HOST}:${app.port}${app.path}?emulators=1`);
  console.log('[local-preview] Original Firebase was not deployed or used. Fixed synthetic GPS; this is NOT a moving-vehicle proof.');
  const stop = () => { for (const server of servers) server.close(); process.exit(0); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  // Keep emulator handles alive for manual QA; they are all on the checked demo project.
  void auth; void db;
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  const action = process.argv[2];
  try {
    if (action === 'start') await start();
    else if (action === 'serve') await serve(process.argv[3]);
    else throw new Error('Use start; deployment is not supported.');
  } catch (error) { console.error(`[local-preview] STOPPED: ${error.message}`); process.exit(1); }
}
