/**
 * Safe, idempotent vehicle PIN migration (Admin SDK).
 * - Documents with plaintext `pin` get `pinHash` (if missing) then `pin` deleted.
 * - Documents already hashed are left unchanged.
 * - Never logs or returns plaintext PIN values.
 *
 * Usage (emulator only in Phase 2C):
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node tools/migrate-vehicle-pins.cjs --dry-run
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node tools/migrate-vehicle-pins.cjs --apply
 *
 * Do NOT run against production without separate approval.
 */

"use strict";

const path = require("path");
const admin = require(require.resolve("firebase-admin", {
  paths: [path.join(__dirname, "..", "functions"), process.cwd(), __dirname],
}));
const { FieldValue } = require(require.resolve("firebase-admin/firestore", {
  paths: [path.join(__dirname, "..", "functions"), process.cwd(), __dirname],
}));
const { hashVehiclePin, isValidPinFormat } = require(path.join(
  __dirname,
  "..",
  "functions",
  "pin-security.js"
));

const APPLY = process.argv.includes("--apply");
const DRY = !APPLY || process.argv.includes("--dry-run");

function ensureApp(projectId) {
  try {
    return admin.app();
  } catch {
    return admin.initializeApp({ projectId: projectId || process.env.GCLOUD_PROJECT || "demo-swiftgo-phase1" });
  }
}

/**
 * @param {FirebaseFirestore.Firestore} db
 * @param {{ apply?: boolean }} opts
 */
async function migrateVehiclePins(db, opts = {}) {
  const apply = Boolean(opts.apply);
  const snap = await db.collection("vehicles").get();
  const summary = {
    scanned: snap.size,
    withPlaintextPin: 0,
    withPinHash: 0,
    migrated: 0,
    alreadyHashedOnly: 0,
    skippedInvalidPin: 0,
    errors: 0,
  };

  for (const doc of snap.docs) {
    const data = doc.data() || {};
    const hasPin = Object.prototype.hasOwnProperty.call(data, "pin") && data.pin != null && data.pin !== "";
    const hasHash = Boolean(data.pinHash);
    if (hasHash) summary.withPinHash += 1;
    if (!hasPin) {
      if (hasHash) summary.alreadyHashedOnly += 1;
      continue;
    }
    summary.withPlaintextPin += 1;
    const pin = String(data.pin).trim();
    if (!isValidPinFormat(pin) && !hasHash) {
      summary.skippedInvalidPin += 1;
      continue;
    }
    try {
      const update = {
        pin: FieldValue.delete(),
        pinMigratedAt: FieldValue.serverTimestamp(),
      };
      if (!hasHash && isValidPinFormat(pin)) {
        update.pinHash = hashVehiclePin(pin);
      }
      if (apply) {
        await doc.ref.update(update);
      }
      summary.migrated += 1;
    } catch {
      summary.errors += 1;
    }
  }

  return summary;
}

async function main() {
  if (process.env.ALLOW_PRODUCTION_PIN_MIGRATE !== "1" && !process.env.FIRESTORE_EMULATOR_HOST) {
    console.error(
      "[migrate-vehicle-pins] Refusing to run without FIRESTORE_EMULATOR_HOST (or ALLOW_PRODUCTION_PIN_MIGRATE=1)."
    );
    process.exit(2);
  }
  ensureApp();
  const db = admin.firestore();
  const summary = await migrateVehiclePins(db, { apply: APPLY && !DRY });
  console.log(
    JSON.stringify(
      {
        mode: APPLY && !DRY ? "apply" : "dry-run",
        emulator: Boolean(process.env.FIRESTORE_EMULATOR_HOST),
        ...summary,
      },
      null,
      2
    )
  );
  process.exit(summary.errors > 0 ? 1 : 0);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { migrateVehiclePins };
