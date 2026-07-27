/**
 * Phase 1 — Firestore rules contract tests (embedded emulator via rules-unit-testing).
 * Run: npm exec --package=@firebase/rules-unit-testing --package=firebase -- node tests/phase1-emulator-contract.mjs
 * Does not touch production Firebase.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from "@firebase/rules-unit-testing";
import { doc, setDoc, getDoc, updateDoc, deleteField, writeBatch, increment } from "firebase/firestore";
import { ref as storageRef, uploadBytes, getDownloadURL } from "firebase/storage";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const rules = fs.readFileSync(path.join(ROOT, "firestore.rules"), "utf8");

const PROJECT = "demo-swiftgo-phase1";

/** @type {{ name: string, status: 'PASS'|'FAIL'|'BLOCKED', detail: string, rules?: string }[]} */
const results = [];

function record(name, status, detail, rulesSection = "") {
  results.push({ name, status, detail, rules: rulesSection });
}

async function main() {
  let testEnv;
  const emuHost = process.env.FIRESTORE_EMULATOR_HOST || "";
  const [host, portStr] = emuHost.includes(":") ? emuHost.split(":") : ["127.0.0.1", "8080"];
  const port = Number(portStr) || 8080;
  try {
    testEnv = await initializeTestEnvironment({
      projectId: PROJECT,
      firestore: { rules, host, port },
    });
  } catch (err) {
    record("emulator-bootstrap", "BLOCKED", `Could not start test environment: ${err.message}`);
    writeReport();
    process.exit(2);
  }

  const adminDb = testEnv.authenticatedContext("admin-uid", {
    email: "fuzail1158@gmail.com",
    email_verified: true,
  }).firestore();

  const customerDb = testEnv.authenticatedContext("customer-a").firestore();
  const driver1Db = testEnv.authenticatedContext("driver-1", { name: "Driver One" }).firestore();
  const driver2Db = testEnv.authenticatedContext("driver-2", { name: "Driver Two" }).firestore();
  const ownerDb = testEnv.authenticatedContext("owner-1").firestore();

  // Seed vehicle for driver-1
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, "vehicles", "veh-1"), {
      ownerId: "owner-1",
      driverId: "driver-1",
      plate: "KHI-1001",
      status: "online",
      pin: "1234",
    });
    await setDoc(doc(db, "partners", "driver-1"), {
      role: "driver",
      accountStatus: "active",
      walletBalance: 0,
      totalEarnings: 0,
      totalRidesCompleted: 0,
    });
    await setDoc(doc(db, "partners", "driver-2"), {
      role: "driver",
      accountStatus: "active",
      walletBalance: 0,
    });
    await setDoc(doc(db, "partners", "owner-1"), { role: "owner", accountStatus: "active" });
  });

  // 1 — Customer creates valid ride; invited candidate can read open ride
  try {
    const rideRef = doc(customerDb, "rides", "ride-1");
    await assertSucceeds(
      setDoc(rideRef, {
        userId: "customer-a",
        pickupLocation: { lat: 24.86, lng: 67.0, address: "A" },
        dropoffLocation: { lat: 24.9, lng: 67.05, address: "B" },
        vehicleType: "go",
        distanceKm: 5,
        timeMins: 15,
        farePkr: 350,
        status: "searching_driver",
        createdAt: new Date(),
      })
    );
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "ride_candidates", "ride-1_driver-1"), {
        rideId: "ride-1",
        driverId: "driver-1",
        status: "invited",
        distanceKm: 0.4,
        ringKm: 1,
      });
    });
    await assertSucceeds(getDoc(doc(driver1Db, "rides", "ride-1")));
    record(
      "T01-customer-create-driver-read-open",
      "PASS",
      "Customer created searching_driver ride; candidate driver get succeeded",
      "rides/{rideId} create + get"
    );
  } catch (e) {
    record("T01-customer-create-driver-read-open", "FAIL", String(e.message), "rides");
  }

  // 2 — Client direct accept denied; trusted assign still visible to customer
  try {
    await assertFails(
      updateDoc(doc(driver1Db, "rides", "ride-1"), {
        status: "accepted",
        driverId: "driver-1",
        vehicleId: "veh-1",
        ownerId: "owner-1",
        driverName: "Driver One",
        vehiclePlate: "KHI-1001",
        farePkr: 350,
        estimatedFare: 350,
        driverBidFare: 350,
      })
    );
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "rides", "ride-1"), {
        userId: "customer-a",
        pickupLocation: { lat: 24.86, lng: 67.0, address: "A" },
        dropoffLocation: { lat: 24.9, lng: 67.05, address: "B" },
        vehicleType: "go",
        distanceKm: 5,
        timeMins: 15,
        farePkr: 350,
        status: "accepted",
        driverId: "driver-1",
        vehicleId: "veh-1",
        ownerId: "owner-1",
        driverName: "Driver One",
        vehiclePlate: "KHI-1001",
        createdAt: new Date(),
      });
    });
    const snap = await getDoc(doc(customerDb, "rides", "ride-1"));
    const ok = snap.data()?.driverId === "driver-1" && snap.data()?.status === "accepted";
    record(
      "T02-driver-accept-customer-sees-driver",
      ok ? "PASS" : "FAIL",
      ok ? "client accept denied; trusted assign visible" : "snapshot mismatch",
      "rides accept branch"
    );
  } catch (e) {
    record("T02-driver-accept-customer-sees-driver", "FAIL", String(e.message), "rides");
  }

  // 3 — Second driver cannot accept already accepted ride
  try {
    await assertFails(
      updateDoc(doc(driver2Db, "rides", "ride-1"), {
        status: "accepted",
        driverId: "driver-2",
        vehicleId: "veh-1",
        ownerId: "owner-1",
        driverName: "Driver Two",
        vehiclePlate: "KHI-1001",
        farePkr: 350,
        estimatedFare: 350,
        driverBidFare: 350,
      })
    );
    record("T03-dual-accept-second-denied", "PASS", "Second accept update denied", "rides");
  } catch (e) {
    record("T03-dual-accept-second-denied", "FAIL", String(e.message), "rides");
  }

  // 4 — Different driver cannot update accepted ride status
  try {
    await assertFails(
      updateDoc(doc(driver2Db, "rides", "ride-1"), { status: "arrived" })
    );
    record("T04-non-assigned-driver-update-denied", "PASS", "driver-2 arrived update denied", "rides");
  } catch (e) {
    record("T04-non-assigned-driver-update-denied", "FAIL", String(e.message), "rides");
  }

  // 5 — Customer cannot complete without in_progress path (only status)
  try {
    await assertFails(
      updateDoc(doc(customerDb, "rides", "ride-1"), { status: "completed" })
    );
    record(
      "T05-customer-skip-to-completed-denied",
      "PASS",
      "Customer accepted→completed denied (needs in_progress driver path for commission)",
      "rides"
    );
  } catch (e) {
    record("T05-customer-skip-to-completed-denied", "FAIL", String(e.message), "rides");
  }

  // Seed ride-2 for stage tests
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, "rides", "ride-2"), {
      userId: "customer-a",
      pickupLocation: { lat: 24.86, lng: 67.0, address: "A" },
      dropoffLocation: { lat: 24.9, lng: 67.05, address: "B" },
      vehicleType: "go",
      distanceKm: 5,
      timeMins: 15,
      farePkr: 350,
      status: "accepted",
      driverId: "driver-1",
      vehicleId: "veh-1",
      ownerId: "owner-1",
      driverName: "Driver One",
      vehiclePlate: "KHI-1001",
      createdAt: new Date(),
    });
  });

  // 6 — Driver cannot skip arrived → completed
  try {
    await assertFails(
      updateDoc(doc(driver1Db, "rides", "ride-2"), { status: "completed", commissionAmount: 35, driverEarnings: 315 })
    );
    record("T06-driver-skip-stages-denied", "PASS", "accepted→completed denied", "rides");
  } catch (e) {
    record("T06-driver-skip-stages-denied", "FAIL", String(e.message), "rides");
  }

  // 7 — Blocked driver wallet self-credit denied
  try {
    await assertFails(
      updateDoc(doc(driver1Db, "partners", "driver-1"), { walletBalance: 99999 })
    );
    record("T09-driver-wallet-increase-denied", "PASS", "Partner self walletBalance denied", "partners");
  } catch (e) {
    record("T09-driver-wallet-increase-denied", "FAIL", String(e.message), "partners");
  }

  // 8 — Owner cannot update another owner's vehicle
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), "vehicles", "veh-other"), {
      ownerId: "owner-2",
      driverId: null,
      plate: "KHI-9999",
      status: "offline",
    });
  });
  try {
    await assertFails(
      updateDoc(doc(ownerDb, "vehicles", "veh-other"), { plate: "HACK" })
    );
    record("T10-owner-other-vehicle-denied", "PASS", "Cross-owner vehicle update denied", "vehicles");
  } catch (e) {
    record("T10-owner-other-vehicle-denied", "FAIL", String(e.message), "vehicles");
  }

  // 9 — Owner cannot become super admin via partners role escalation
  try {
    await assertFails(
      updateDoc(doc(ownerDb, "partners", "owner-1"), { role: "admin_driver" })
    );
    record("T11-owner-not-super-admin", "PASS", "role admin_driver denied on self-update", "partners");
  } catch (e) {
    record("T11-owner-not-super-admin", "FAIL", String(e.message), "partners");
  }

  // 10 — Super admin can block driver
  try {
    await assertSucceeds(
      updateDoc(doc(adminDb, "partners", "driver-2"), { accountStatus: "blocked" })
    );
    record("T12-super-admin-block-driver", "PASS", "accountStatus blocked set by super admin", "partners");
  } catch (e) {
    record("T12-super-admin-block-driver", "FAIL", String(e.message), "partners");
  }

  // 11 — Invalid ride create missing fields
  try {
    await assertFails(
      setDoc(doc(customerDb, "rides", "ride-bad"), {
        userId: "customer-a",
        status: "searching_driver",
      })
    );
    record("T13-invalid-ride-create-denied", "PASS", "Missing required ride fields denied", "rides isValidRide");
  } catch (e) {
    record("T13-invalid-ride-create-denied", "FAIL", String(e.message), "rides");
  }

  // 12 — Driver completion with commission fields (in_progress)
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), "rides", "ride-3"), {
      userId: "customer-a",
      pickupLocation: { lat: 24.86, lng: 67.0, address: "A" },
      dropoffLocation: { lat: 24.9, lng: 67.05, address: "B" },
      vehicleType: "go",
      distanceKm: 5,
      timeMins: 15,
      farePkr: 350,
      status: "in_progress",
      driverId: "driver-1",
      vehicleId: "veh-1",
      ownerId: "owner-1",
      createdAt: new Date(),
    });
  });
  // Phase 2A: client must NOT complete with commission — trusted Function only.
  try {
    await assertFails(
      updateDoc(doc(driver1Db, "rides", "ride-3"), {
        status: "completed",
        commissionAmount: 35,
        driverEarnings: 315,
      })
    );
    record(
      "T14-client-driver-completion-denied",
      "PASS",
      "Client in_progress→completed with commission denied (trusted settlement required)",
      "rides"
    );
  } catch (e) {
    record("T14-client-driver-completion-denied", "FAIL", String(e.message), "rides");
  }

  // 13 — Client completion remains denied on retry
  try {
    await assertFails(
      updateDoc(doc(driver1Db, "rides", "ride-3"), {
        status: "completed",
        commissionAmount: 35,
        driverEarnings: 315,
      })
    );
    record("T15-duplicate-completion-denied", "PASS", "Repeat client complete denied", "rides");
  } catch (e) {
    record("T15-duplicate-completion-denied", "FAIL", String(e.message), "rides");
  }

  // 14 — Customer cancel searching ride
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), "rides", "ride-4"), {
      userId: "customer-a",
      pickupLocation: { lat: 24.86, lng: 67.0, address: "A" },
      dropoffLocation: { lat: 24.9, lng: 67.05, address: "B" },
      vehicleType: "go",
      distanceKm: 5,
      timeMins: 15,
      farePkr: 350,
      status: "searching_driver",
      createdAt: new Date(),
    });
  });
  try {
    await assertSucceeds(
      updateDoc(doc(customerDb, "rides", "ride-4"), { status: "cancelled_by_user" })
    );
    record("T16-customer-cancel-searching", "PASS", "cancelled_by_user allowed", "rides");
  } catch (e) {
    record("T16-customer-cancel-searching", "FAIL", String(e.message), "rides");
  }

  // 15 — Unauthenticated read denied
  try {
    const unauth = testEnv.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(unauth, "rides", "ride-1")));
    record("T17-unauth-read-denied", "PASS", "Unauthenticated get denied", "rides");
  } catch (e) {
    record("T17-unauth-read-denied", "FAIL", String(e.message), "rides");
  }

  // 16 — ride_requests create denied (server-only collection)
  try {
    await assertFails(
      setDoc(doc(customerDb, "ride_requests", "req-1"), {
        userId: "customer-a",
        status: "pending",
      })
    );
    record("T18-ride-requests-create-denied", "PASS", "Client create on ride_requests denied", "ride_requests");
  } catch (e) {
    record("T18-ride-requests-create-denied", "FAIL", String(e.message), "ride_requests");
  }

  // 17 — Driver batch wallet on partners (simulates completeRideWithEarnings) — expect DENY
  try {
    const { writeBatch, increment: inc } = await import("firebase/firestore");
    const batch = writeBatch(driver1Db);
    batch.update(doc(driver1Db, "partners", "driver-1"), {
      walletBalance: inc(-35),
      totalEarnings: inc(315),
      totalRidesCompleted: inc(1),
    });
    await assertFails(batch.commit());
    record(
      "T19-driver-partner-wallet-batch-denied",
      "PASS",
      "Driver cannot debit wallet via partners batch (matches app completeRideWithEarnings risk)",
      "partners"
    );
  } catch (e) {
    record("T19-driver-partner-wallet-batch-denied", "FAIL", String(e.message), "partners");
  }

  // T07 — blocked/suspended driver cannot go online (Phase 2B)
  try {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, "partners", "driver-blocked"), {
        role: "driver",
        accountStatus: "blocked",
        walletBalance: 0,
      });
      await setDoc(doc(db, "vehicles", "veh-blocked"), {
        ownerId: "owner-1",
        plate: "BLK-1",
        status: "offline",
        pinHash: "abc",
      });
    });
    const blockedDb = testEnv.authenticatedContext("driver-blocked").firestore();
    await assertFails(
      updateDoc(doc(blockedDb, "vehicles", "veh-blocked"), {
        driverId: "driver-blocked",
        status: "online",
      })
    );
    record(
      "T07-suspended-driver-online",
      "PASS",
      "Blocked partner cannot set vehicle online",
      "vehicles + partners"
    );
  } catch (e) {
    record("T07-suspended-driver-online", "FAIL", String(e.message), "vehicles");
  }

  // T08 — customer cannot tamper fare after assignment
  try {
    await assertFails(
      updateDoc(doc(customerDb, "rides", "ride-1"), {
        farePkr: 1,
        estimatedFare: 1,
        driverBidFare: 1,
      })
    );
    record(
      "T08-customer-fare-tamper",
      "PASS",
      "Customer fare/estimatedFare/driverBidFare update on accepted ride denied",
      "rides"
    );
  } catch (e) {
    record("T08-customer-fare-tamper", "FAIL", String(e.message), "rides");
  }

  // T20 — KYC storage privacy (Storage emulator)
  try {
    const storageRules = fs.readFileSync(path.join(ROOT, "storage.rules"), "utf8");
    const storageEnv = await initializeTestEnvironment({
      projectId: `${PROJECT}-storage`,
      storage: {
        rules: storageRules,
        host: "127.0.0.1",
        port: Number(process.env.FIREBASE_STORAGE_EMULATOR_HOST?.split(":")[1] || 9199),
      },
    });
    const ownerStorage = storageEnv.authenticatedContext("kyc-owner").storage();
    const otherStorage = storageEnv.authenticatedContext("kyc-other").storage();
    const pathOwner = "driver_applications/kyc-owner/cnic-front.jpg";
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    await assertSucceeds(
      uploadBytes(storageRef(ownerStorage, pathOwner), bytes, { contentType: "image/jpeg" })
    );
    await assertFails(getDownloadURL(storageRef(otherStorage, pathOwner)));
    await assertSucceeds(getDownloadURL(storageRef(ownerStorage, pathOwner)));
    await storageEnv.cleanup();
    record(
      "T20-storage-kyc-privacy",
      "PASS",
      "Owner can write/read KYC; other user cannot read",
      "storage"
    );
  } catch (e) {
    record("T20-storage-kyc-privacy", "FAIL", String(e.message), "storage");
  }

  try {
    await testEnv.cleanup();
  } catch {
    /* Windows emulator teardown can abort on open gRPC handles */
  }
  writeReport();
  const failed = results.filter((r) => r.status === "FAIL").length;
  // Delayed exit avoids UV_HANDLE_CLOSING abort on Windows after Storage cleanup.
  setTimeout(() => process.exit(failed > 0 ? 1 : 0), 300);
}

function writeReport() {
  const out = {
    generatedAt: new Date().toISOString(),
    command:
      "npm exec --package=@firebase/rules-unit-testing --package=firebase -- node tests/phase1-emulator-contract.mjs",
    results,
    passed: results.filter((r) => r.status === "PASS").length,
    failed: results.filter((r) => r.status === "FAIL").length,
    blocked: results.filter((r) => r.status === "BLOCKED").length,
  };
  fs.writeFileSync(path.join(ROOT, "tests", "phase1-emulator-results.json"), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
