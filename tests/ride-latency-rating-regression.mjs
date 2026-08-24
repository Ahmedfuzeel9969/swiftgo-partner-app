import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const results = [];
function check(name, ok) {
  results.push({ name, ok });
  console.log(`${ok ? "✓" : "✗"} ${name}`);
}

const functionsIndex = read("functions/index.js");
const driverApp = read("driver-app/js/driver-app.js");
const rideFlow = read("customer-app/js/ride-flow.js");
const ratingServer = read("functions/ride-rating.js");
const completionStart = driverApp.indexOf('if (nextStatus === "completed")');
const completionSettlement = driverApp.indexOf("const settlementResult = await completeRideWithEarnings(ride)", completionStart);
const completionPrefix = driverApp.slice(completionStart, completionSettlement);

check(
  "warm-booking-callable-matches-before-return",
  /created = await createCustomerBooking[\s\S]*?await withDispatchTimeout\([\s\S]*?matchRideCandidates/.test(
    functionsIndex
  )
);
check(
  "document-trigger-skips-already-matched-ride",
  functionsIndex.includes('includes(String(current.matchingStatus || ""))') &&
    functionsIndex.includes("current.matchedAt")
);
check(
  "completion-has-no-extra-firestore-preflight",
  completionStart >= 0 && completionSettlement > completionStart && !completionPrefix.includes("await getDoc(")
);
check(
  "star-click-submits-immediately",
  /function setSelectedRating[\s\S]*?void submitSelectedRatingNow\(\)/.test(rideFlow)
);
check(
  "rating-transaction-reads-before-writes",
  ratingServer.indexOf("partnerSnap = await tx.get(partnerRef)") <
    ratingServer.indexOf("tx.update(rideRef")
);
check(
  "admin-live-table-renders-server-rating",
  read("super-admin-panel/js/admin-app.js").includes("ride.customerRating")
);

if (process.env.FIRESTORE_EMULATOR_HOST) {
  const functionRequire = createRequire(path.join(root, "functions", "package.json"));
  const admin = functionRequire("firebase-admin");
  const app = admin.apps.length
    ? admin.app()
    : admin.initializeApp({ projectId: "demo-swiftgo-phase1" });
  const db = admin.firestore(app);
  const rideId = "latency-rating-regression";
  const customerUid = "customer-latency-rating";
  const driverUid = "driver-latency-rating";
  await db.doc(`partners/${driverUid}`).set({
    customerRatingSum: 0,
    customerRatingCount: 0,
  });
  await db.doc(`rides/${rideId}`).set({
    userId: customerUid,
    driverId: driverUid,
    status: "completed",
  });
  const { submitCompletedRideRating } = functionRequire("./ride-rating.js");
  const saved = await submitCompletedRideRating(db, {
    customerUid,
    rideId,
    rating: 5,
  });
  const [rideSnap, partnerSnap] = await Promise.all([
    db.doc(`rides/${rideId}`).get(),
    db.doc(`partners/${driverUid}`).get(),
  ]);
  check(
    "emulator-rating-reaches-ride-and-partner",
    saved.ok === true &&
      rideSnap.data()?.customerRating === 5 &&
      partnerSnap.data()?.customerRatingSum === 5 &&
      partnerSnap.data()?.customerRatingCount === 1
  );
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\nride-latency-rating-regression: ${results.length - failed} PASS / ${failed} FAIL`);
if (failed) process.exit(1);
