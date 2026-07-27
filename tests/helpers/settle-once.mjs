/**
 * Child-process Admin SDK settlement runner (avoids Firestore settings clash with rules-unit-testing).
 * Usage: node tests/helpers/settle-once.mjs '{"rideId":"...","collectionName":"rides","callerUid":"...","isAdmin":false}'
 */
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const params = JSON.parse(process.argv[2] || "{}");
if (!process.env.FIRESTORE_EMULATOR_HOST) {
  process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080";
}

const admin = require(require.resolve("firebase-admin", { paths: [path.join(ROOT, "functions"), ROOT] }));
const app = admin.initializeApp({ projectId: params.projectId || "demo-swiftgo-phase1" });
const { settleRide } = require(path.join(ROOT, "functions", "settlement.js"));

settleRide(admin.firestore(app), {
  rideId: params.rideId,
  collectionName: params.collectionName,
  callerUid: params.callerUid,
  isAdmin: Boolean(params.isAdmin),
})
  .then((result) => {
    process.stdout.write(JSON.stringify({ ok: true, result }));
    process.exit(0);
  })
  .catch((err) => {
    process.stdout.write(
      JSON.stringify({ ok: false, error: err?.message || String(err), code: err?.code || null })
    );
    process.exit(0);
  });
