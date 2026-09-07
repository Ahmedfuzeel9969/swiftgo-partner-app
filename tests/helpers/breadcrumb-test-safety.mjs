import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
export const BREADCRUMB_TEST_PROJECT = "demo-remediation-phase5";
export function requireBreadcrumbEmulators(env = process.env) {
  if (env.FIRESTORE_EMULATOR_HOST !== "127.0.0.1:8190" || env.FIREBASE_AUTH_EMULATOR_HOST !== "127.0.0.1:9195" ||
      env.GCLOUD_PROJECT !== BREADCRUMB_TEST_PROJECT || env.GOOGLE_APPLICATION_CREDENTIALS) throw new Error("ISOLATED_BREADCRUMB_EMULATORS_REQUIRED; open preview and production are forbidden");
  env.GCE_METADATA_DISABLED = "true";
}
export function breadcrumbResultPath(name) {
  if (path.basename(name) !== name || !name.endsWith("-results.json")) throw new Error("INVALID_RESULT_NAME");
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../emulator-data/phase-five-legacy-results");
  fs.mkdirSync(dir, { recursive: true }); return path.join(dir, name);
}
