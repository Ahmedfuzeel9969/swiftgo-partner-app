/**
 * Phase 4F — read-only vehicle PIN posture inventory.
 * Never logs or prints plaintext PIN values.
 *
 * Emulator (default safe):
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node tools/phase4f-pin-inventory.cjs
 *
 * Production read-only (REQUIRES separate approval):
 *   ALLOW_PRODUCTION_PIN_INVENTORY=1 GCLOUD_PROJECT=swiftgo-ride-app node tools/phase4f-pin-inventory.cjs
 */

"use strict";

const fs = require("fs");
const path = require("path");
const admin = require(require.resolve("firebase-admin", {
  paths: [path.join(__dirname, "..", "functions"), process.cwd(), __dirname],
}));

const OUT = path.join(__dirname, "..", "tests", "phase4f-pin-inventory-results.json");

function ensureApp(projectId) {
  try {
    return admin.app();
  } catch {
    return admin.initializeApp({
      projectId: projectId || process.env.GCLOUD_PROJECT || "demo-swiftgo-phase1",
    });
  }
}

async function inventoryPins(db) {
  const snap = await db.collection("vehicles").get();
  const summary = {
    scanned: snap.size,
    withPlaintextPinField: 0,
    withPinHash: 0,
    bothPlainAndHash: 0,
    neither: 0,
    // IDs only — never PIN values
    plaintextVehicleIds: [],
  };

  for (const doc of snap.docs) {
    const data = doc.data() || {};
    const hasPin =
      Object.prototype.hasOwnProperty.call(data, "pin") && data.pin != null && data.pin !== "";
    const hasHash =
      Object.prototype.hasOwnProperty.call(data, "pinHash") &&
      data.pinHash != null &&
      data.pinHash !== "";

    if (hasPin) {
      summary.withPlaintextPinField += 1;
      if (summary.plaintextVehicleIds.length < 50) {
        summary.plaintextVehicleIds.push(doc.id);
      }
    }
    if (hasHash) summary.withPinHash += 1;
    if (hasPin && hasHash) summary.bothPlainAndHash += 1;
    if (!hasPin && !hasHash) summary.neither += 1;
  }

  return summary;
}

async function main() {
  const onEmulator = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
  const allowProd = process.env.ALLOW_PRODUCTION_PIN_INVENTORY === "1";
  if (!onEmulator && !allowProd) {
    console.error(
      "Refusing Production inventory. Use FIRESTORE_EMULATOR_HOST or ALLOW_PRODUCTION_PIN_INVENTORY=1 after explicit approval."
    );
    process.exitCode = 2;
    return;
  }

  ensureApp(process.env.GCLOUD_PROJECT);
  const db = admin.firestore();
  const summary = await inventoryPins(db);
  const payload = {
    generatedAt: new Date().toISOString(),
    scope: onEmulator ? "emulator" : "production-readonly",
    projectId: process.env.GCLOUD_PROJECT || null,
    summary,
    note: "Plaintext PIN values were never logged. Migrate with tools/migrate-vehicle-pins.cjs only after approval.",
  };
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2));
  console.log(JSON.stringify({ ok: true, ...payload.summary, scope: payload.scope }, null, 2));
  console.log(`Wrote ${OUT}`);
}

main().catch((err) => {
  console.error(String(err?.message || err));
  process.exitCode = 1;
});
