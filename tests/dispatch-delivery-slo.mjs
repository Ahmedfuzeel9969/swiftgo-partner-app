import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  dispatchDeliveryBucket,
  summarizeDispatchDeliveryMetric,
} = require("../functions/ops-monitor.js");

assert.equal(dispatchDeliveryBucket(0), "under2s");
assert.equal(dispatchDeliveryBucket(2_001), "under5s");
assert.equal(dispatchDeliveryBucket(5_001), "under10s");
assert.equal(dispatchDeliveryBucket(10_001), "over10s");
assert.equal(dispatchDeliveryBucket(null), "missing");
assert.equal(dispatchDeliveryBucket(Number.NaN), "missing");

const summary = summarizeDispatchDeliveryMetric({
  receiptCount: 10,
  deliveryTotalMs: 38_000,
  bookingToCandidateTotalMs: 15_000,
  bookingToCandidateCount: 5,
  delivery_under2s: 2,
  delivery_under5s: 5,
  delivery_under10s: 2,
  delivery_over10s: 1,
});
assert.equal(summary.averageDriverDeliveryMs, 3_800);
assert.equal(summary.averageBookingToCandidateMs, 3_000);
assert.equal(summary.within5SecondsCount, 7);
assert.equal(summary.within5SecondsRate, 70);

console.log("dispatch-delivery-slo: PASS");
