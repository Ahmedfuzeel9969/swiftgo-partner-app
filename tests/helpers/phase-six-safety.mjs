export const PROJECT = "demo-remediation-phase6";
export function requirePhaseSixEmulators(env = process.env) {
  if (env.GCLOUD_PROJECT !== PROJECT || env.FIRESTORE_EMULATOR_HOST !== "127.0.0.1:8191" ||
      env.FIREBASE_AUTH_EMULATOR_HOST !== "127.0.0.1:9194" || env.FIREBASE_STORAGE_EMULATOR_HOST !== "127.0.0.1:9294" ||
      env.GOOGLE_APPLICATION_CREDENTIALS || env.ENABLE_RETENTION_SCHEDULE === "true" || env.ENABLE_ACCOUNT_ERASURE === "true") throw new Error("ISOLATED_PHASE_SIX_REQUIRED");
  env.GCE_METADATA_DISABLED = "true";
}
