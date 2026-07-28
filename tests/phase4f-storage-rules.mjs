/**
 * Phase 4F — Storage rules matrix (upload/read/list/update/delete) on emulator.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from "@firebase/rules-unit-testing";
import { ref as storageRef, uploadBytes, getBytes, deleteObject, listAll, updateMetadata } from "firebase/storage";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RESULTS = path.join(ROOT, "tests", "phase4f-storage-results.json");
const PROJECT = "demo-swiftgo-phase1-storage4f";

const results = [];
function record(name, status, detail = "") {
  results.push({ name, status, detail });
  console.log(`${status === "PASS" ? "✓" : "✗"} [${status}] ${name}${detail ? ` — ${detail}` : ""}`);
}

async function main() {
  const storageRules = fs.readFileSync(path.join(ROOT, "storage.rules"), "utf8");
  record(
    "rules-claim-admin-read",
    storageRules.includes("isClaimAdmin") && storageRules.includes("admin == true") ? "PASS" : "FAIL"
  );
  record(
    "rules-default-deny",
    storageRules.includes("match /{allPaths=**}") && storageRules.includes("allow read, write: if false")
      ? "PASS"
      : "FAIL"
  );

  const storageHost = process.env.FIREBASE_STORAGE_EMULATOR_HOST || "127.0.0.1:9199";
  const [shost, sport] = storageHost.split(":");
  const env = await initializeTestEnvironment({
    projectId: PROJECT,
    storage: { rules: storageRules, host: shost, port: Number(sport) || 9199 },
  });

  try {
    const owner = env.authenticatedContext("kyc-owner");
    const other = env.authenticatedContext("kyc-other");
    const adminCtx = env.authenticatedContext("kyc-admin", { admin: true });
    const unauth = env.unauthenticatedContext();

    const ownerStorage = owner.storage();
    const otherStorage = other.storage();
    const adminStorage = adminCtx.storage();
    const guestStorage = unauth.storage();

    const pathOk = "driver_applications/kyc-owner/selfie.jpg";
    const pathOther = "driver_applications/kyc-other/doc.jpg";
    const pathDenied = "private/secrets/x.bin";
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);

    await assertSucceeds(
      uploadBytes(storageRef(ownerStorage, pathOk), bytes, { contentType: "image/jpeg" })
    );
    record("owner-upload-image", "PASS");

    await assertFails(
      uploadBytes(storageRef(otherStorage, pathOk), bytes, { contentType: "image/jpeg" })
    );
    record("other-upload-denied", "PASS");

    await assertFails(
      uploadBytes(storageRef(guestStorage, pathOk), bytes, { contentType: "image/jpeg" })
    );
    record("unauth-upload-denied", "PASS");

    await assertSucceeds(getBytes(storageRef(ownerStorage, pathOk)));
    record("owner-read", "PASS");

    await assertFails(getBytes(storageRef(otherStorage, pathOk)));
    record("other-read-denied", "PASS");

    await assertSucceeds(getBytes(storageRef(adminStorage, pathOk)));
    record("admin-read-allowed", "PASS");

    await assertSucceeds(
      uploadBytes(storageRef(ownerStorage, pathOk), bytes, { contentType: "image/jpeg" })
    );
    record("owner-update-overwrite", "PASS");

    await assertFails(
      updateMetadata(storageRef(otherStorage, pathOk), { contentType: "image/png" })
    );
    record("other-update-denied", "PASS");

    await assertFails(listAll(storageRef(otherStorage, "driver_applications/kyc-owner")));
    record("other-list-denied", "PASS");

    await assertFails(
      uploadBytes(storageRef(ownerStorage, pathDenied), bytes, { contentType: "image/jpeg" })
    );
    record("non-kyc-path-denied", "PASS");

    await assertSucceeds(
      uploadBytes(storageRef(otherStorage, pathOther), bytes, { contentType: "image/jpeg" })
    );
    await assertSucceeds(deleteObject(storageRef(otherStorage, pathOther)));
    record("owner-delete-own", "PASS");

    await assertFails(deleteObject(storageRef(otherStorage, pathOk)));
    record("other-delete-denied", "PASS");

    await assertSucceeds(deleteObject(storageRef(ownerStorage, pathOk)));
    record("owner-delete-own-final", "PASS");
  } catch (err) {
    record("storage-matrix", "FAIL", String(err?.message || err));
  } finally {
    await env.cleanup();
  }

  const failed = results.filter((r) => r.status === "FAIL");
  fs.writeFileSync(
    RESULTS,
    JSON.stringify(
      {
        phase: "4F-storage",
        generatedAt: new Date().toISOString(),
        pass: results.filter((r) => r.status === "PASS").length,
        fail: failed.length,
        results,
      },
      null,
      2
    )
  );
  console.log(`\nPhase 4F storage: ${results.length - failed.length} PASS / ${failed.length} FAIL`);
  if (failed.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
