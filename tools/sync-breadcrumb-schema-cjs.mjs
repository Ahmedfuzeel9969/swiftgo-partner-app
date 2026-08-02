/**
 * Generate functions/breadcrumb-schema.js (CJS) from shared/js/breadcrumb-schema.mjs.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = fs.readFileSync(path.join(ROOT, "shared/js/breadcrumb-schema.mjs"), "utf8");
const body = src
  .replace(/^export const /gm, "const ")
  .replace(/^export function /gm, "function ");
const out =
  `"use strict";\n\n` +
  `/** Auto-generated from shared/js/breadcrumb-schema.mjs — do not edit by hand. */\n` +
  body +
  `\nmodule.exports = {\n` +
  `  BREADCRUMB_PROTOCOL_VERSION,\n` +
  `  BREADCRUMB_SAMPLE_INTERVAL_MS,\n` +
  `  BREADCRUMB_TARGET_UPLOAD_INTERVAL_MS,\n` +
  `  BREADCRUMB_TARGET_BATCH_POINTS,\n` +
  `  BREADCRUMB_MAX_BATCH_POINTS,\n` +
  `  BREADCRUMB_MAX_BATCH_BYTES,\n` +
  `  BREADCRUMB_MAX_QUEUE_POINTS,\n` +
  `  BREADCRUMB_MAX_QUEUE_BYTES,\n` +
  `  BREADCRUMB_QUEUE_RETENTION_MS,\n` +
  `  BREADCRUMB_MAX_BATCH_SPAN_MS,\n` +
  `  BREADCRUMB_MAX_POINT_AGE_MS,\n` +
  `  BREADCRUMB_MAX_FUTURE_SKEW_MS,\n` +
  `  BREADCRUMB_MAX_ACCURACY_M,\n` +
  `  BREADCRUMB_MIN_SEGMENT_M,\n` +
  `  BREADCRUMB_MAX_SPEED_MPS,\n` +
  `  BREADCRUMB_RETRY_BASE_MS,\n` +
  `  BREADCRUMB_RETRY_MAX_MS,\n` +
  `  BREADCRUMB_FINAL_FLUSH_TIMEOUT_MS,\n` +
  `  BREADCRUMB_MAX_UPLOADS_PER_WAKE,\n` +
  `  BREADCRUMB_MAX_UPLOADS_PER_SCHEDULED_TICK,\n` +
  `  BREADCRUMB_COORD_DECIMALS,\n` +
  `  BREADCRUMB_DIAG,\n` +
  `  isValidAssignmentSessionToken,\n` +
  `  isValidLatLng,\n` +
  `  roundCoord,\n` +
  `  haversineMeters,\n` +
  `  assignmentVersionFromRide,\n` +
  `  assignmentVersionFromToken,\n` +
  `  validateBreadcrumbPoint,\n` +
  `  validateBreadcrumbBatch,\n` +
  `  accumulateDenseChordMeters,\n` +
  `  buildBreadcrumbBatch,\n` +
  `  estimatePointBytes,\n` +
  `};\n`;
fs.writeFileSync(path.join(ROOT, "functions/breadcrumb-schema.js"), out);
console.info("Wrote functions/breadcrumb-schema.js");
