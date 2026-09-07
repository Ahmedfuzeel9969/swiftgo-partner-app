// Development-only. These files are never copied into the Hosting package.
export const PROJECT = 'demo-swiftgo-phase1';
export const HOST = '127.0.0.1';
export const PORTS = Object.freeze({ auth: 9099, firestore: 8080, storage: 9199, functions: 5001, hub: 4400, logging: 4500 });
export const APPS = Object.freeze([
  { key: 'customer', label: 'کسٹمر', port: 8786, path: '/customer/' },
  { key: 'partner', label: 'ڈرائیور', port: 8787, path: '/partner/' },
  { key: 'owner', label: 'مالک', port: 8788, path: '/owner/' },
  { key: 'admin', label: 'سپر منتظم', port: 8789, path: '/admin/' },
]);
export const ACCOUNTS = Object.freeze([
  { uid: 'preview-customer', email: 'customer@example.test', label: 'آزمائشی کسٹمر', app: 'customer' },
  { uid: 'preview-driver', email: 'driver@example.test', label: 'منظور شدہ آزمائشی ڈرائیور', app: 'partner' },
  { uid: 'preview-applicant', email: 'applicant@example.test', label: 'نیا ڈرائیور — شناخت جمع کرانے کے لیے', app: 'partner' },
  { uid: 'preview-owner', email: 'owner@example.test', label: 'آزمائشی مالک', app: 'owner' },
  { uid: 'preview-admin', email: 'admin@example.test', label: 'آزمائشی سپر منتظم', app: 'admin' },
]);
export const TEST_POSITION = Object.freeze({ latitude: 24.8607, longitude: 67.0011, accuracy: 10 });

export function assertEmulators(env = process.env) {
  for (const key of ['GCLOUD_PROJECT', 'GOOGLE_CLOUD_PROJECT']) {
    if (env[key] !== PROJECT) throw new Error(`REFUSING_NON_DEMO_PROJECT:${key}`);
  }
  for (const [key, service] of Object.entries({ FIRESTORE_EMULATOR_HOST: 'firestore', FIREBASE_AUTH_EMULATOR_HOST: 'auth', FIREBASE_STORAGE_EMULATOR_HOST: 'storage' })) {
    if (env[key] !== `${HOST}:${PORTS[service]}`) throw new Error(`REFUSING_NON_LOOPBACK_EMULATOR:${key}`);
  }
  if (env.GOOGLE_APPLICATION_CREDENTIALS) throw new Error('PRODUCTION_CREDENTIALS_NOT_ALLOWED');
}

export function safeChild(root, relative, path) {
  if (relative.includes('\\') || relative.split('/').some((part) => part === '..' || part.startsWith('.'))) throw new Error('UNSAFE_PATH');
  const target = path.resolve(root, relative);
  const rel = path.relative(root, target);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error('UNSAFE_PATH');
  return target;
}

export function previewConfigModule() {
  return `export const firebaseConfig = ${JSON.stringify({ apiKey: 'demo-api-key', authDomain: `${PROJECT}.firebaseapp.com`, projectId: PROJECT, storageBucket: `${PROJECT}.appspot.com`, appId: '1:123456789012:web:local-preview' })};\nexport const isFirebaseConfigured = () => true;\n`;
}

export function contentSecurityPolicy() {
  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://www.gstatic.com https://unpkg.com https://cdn.jsdelivr.net",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://unpkg.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    "img-src 'self' data: blob: https://*.tile.openstreetmap.org https://tile.openstreetmap.org https://server.arcgisonline.com",
    `connect-src 'self' ${['auth', 'firestore', 'storage', 'functions'].map((name) => `http://${HOST}:${PORTS[name]}`).join(' ')} ws://${HOST}:${PORTS.firestore} https://www.gstatic.com https://unpkg.com https://cdn.jsdelivr.net https://router.project-osrm.org https://nominatim.openstreetmap.org`,
    `frame-src http://${HOST}:${PORTS.auth}`,
    "worker-src 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'", "media-src 'self' data: blob:",
  ].join('; ');
}
