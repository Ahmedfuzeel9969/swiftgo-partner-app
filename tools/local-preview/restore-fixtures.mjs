/** Recover only known missing SYNTHETIC fixtures after an accidental local reset.
 * Not recovery of manual ride history. No overwrite, deletion or production mode. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initializeTestEnvironment } from "@firebase/rules-unit-testing";
import { PROJECT, HOST, PORTS, assertEmulators } from "./config.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
if (process.argv[2] !== "--recover-known-synthetic-fixtures") throw new Error("EXPLICIT_FIXTURE_RECOVERY_REQUIRED");
const current = JSON.parse(fs.readFileSync(path.join(root, ".firebase/local-preview-current.json"), "utf8"));
if (current.project !== PROJECT || !current.synthetic ||
    path.dirname(current.runDir) !== path.join(root, "emulator-data/local-preview") ||
    fs.realpathSync(current.runDir) !== current.runDir) throw new Error("INVALID_LOCAL_PREVIEW_MANIFEST");
const health = await fetch(`http://${HOST}:8786/__preview/health`).then((r) => r.json());
if (health.project !== PROJECT || !health.synthetic) throw new Error("NOT_THE_SYNTHETIC_PREVIEW");
if (process.env.GOOGLE_APPLICATION_CREDENTIALS) throw new Error("PRODUCTION_CREDENTIALS_NOT_ALLOWED");
Object.assign(process.env, { GCLOUD_PROJECT: PROJECT, GOOGLE_CLOUD_PROJECT: PROJECT, GCE_METADATA_DISABLED: "true",
  FIRESTORE_EMULATOR_HOST: `${HOST}:${PORTS.firestore}`, FIREBASE_AUTH_EMULATOR_HOST: `${HOST}:${PORTS.auth}`, FIREBASE_STORAGE_EMULATOR_HOST: `${HOST}:${PORTS.storage}` });
assertEmulators();
// Restore the exact rules bundled with the still-running preview, not new source rules.
const env = await initializeTestEnvironment({ projectId: PROJECT, firestore: { host: HOST, port: PORTS.firestore,
  rules: fs.readFileSync(path.join(current.runDir, "firestore.rules"), "utf8") } });
const { seedPreview } = await import("./seed.mjs");
const { app } = await seedPreview(current.password, { recoverMissingFixtures: true });
await env.cleanup(); await app.delete();
console.log("Known missing synthetic fixtures recovered; existing records, Auth, Storage and old Hosting artifact retained. Manual ride history is NOT recovered.");
