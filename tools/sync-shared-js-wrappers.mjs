/**
 * Thin re-export wrappers from shared/js into app js folders.
 * Canonical algorithms live only in shared/js.
 *
 * Usage:
 *   node tools/sync-shared-js-wrappers.mjs          # write wrappers (dev/CI maintenance)
 *   node tools/sync-shared-js-wrappers.mjs --check  # verify committed parity, no writes
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHECK_ONLY = process.argv.includes("--check");

export const WRAPPER_MODULE_NAMES = [
  "geometry-quality.mjs",
  "marker-heading.mjs",
  "route-geometry.mjs",
  "road-route-provider.mjs",
  "two-leg-route-controller.mjs",
  "two-leg-route-layers.mjs",
  "route-projection.mjs",
  "route-progress.mjs",
  "route-motion-controller.mjs",
  "off-route-detector.mjs",
  "display-location-pipeline.mjs",
  "breadcrumb-schema.mjs",
  "vehicle-catalog.mjs",
];

export const WRAPPER_APP_JS_DIRS = [
  "customer-app/js",
  "driver-app/js",
  "owner-app/js",
  "super-admin-panel/js",
];

const body = (name) =>
  `/** Auto-wrapper: canonical implementation in shared/js. Do not edit algorithms here. */\n` +
  `export * from "../../shared/js/${name}";\n`;

function wrapperPath(appJsDir, name) {
  return path.join(ROOT, appJsDir, name);
}

function expectedWrapperContent(name) {
  return body(name);
}

function writeWrappers() {
  for (const app of WRAPPER_APP_JS_DIRS) {
    const dir = path.join(ROOT, app);
    fs.mkdirSync(dir, { recursive: true });
    for (const name of WRAPPER_MODULE_NAMES) {
      fs.writeFileSync(path.join(dir, name), expectedWrapperContent(name));
    }
  }
  console.info(
    `Wrote ${WRAPPER_MODULE_NAMES.length} re-export wrappers into customer-app, driver-app, owner-app, super-admin-panel`
  );
}

function checkWrappers() {
  const mismatches = [];
  for (const app of WRAPPER_APP_JS_DIRS) {
    for (const name of WRAPPER_MODULE_NAMES) {
      const filePath = wrapperPath(app, name);
      const expected = expectedWrapperContent(name);
      if (!fs.existsSync(filePath)) {
        mismatches.push(`${path.relative(ROOT, filePath)} (missing)`);
        continue;
      }
      const actual = fs.readFileSync(filePath, "utf8");
      if (actual !== expected) {
        mismatches.push(`${path.relative(ROOT, filePath)} (content drift)`);
      }
    }
  }
  if (mismatches.length) {
    console.error("[sync-shared-js-wrappers] wrapper parity check FAILED:");
    for (const item of mismatches) console.error(`  - ${item}`);
    process.exit(1);
  }
  console.info("[sync-shared-js-wrappers] wrapper parity check PASS");
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  if (CHECK_ONLY) {
    checkWrappers();
  } else {
    writeWrappers();
  }
}