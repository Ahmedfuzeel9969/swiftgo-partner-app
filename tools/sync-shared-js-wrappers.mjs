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

export const WRAPPER_APP_JS_DIRS = [
  "customer-app/js",
  "driver-app/js",
  "owner-app/js",
  "super-admin-panel/js",
];

// This is an app-specific Firebase adapter whose shared namesake is only a
// deprecated compatibility export. It must remain a real per-app module.
export const WRAPPER_EXCLUDED_MODULE_NAMES = Object.freeze([
  "p2p-ice-bootstrap.mjs",
]);

const SHARED_DIR = path.join(ROOT, "shared", "js");
const excluded = new Set(WRAPPER_EXCLUDED_MODULE_NAMES);

/** Every canonical module is known here; only existing app-local overlaps are wrapped. */
export const WRAPPER_MODULE_NAMES = Object.freeze(
  fs.readdirSync(SHARED_DIR)
    .filter((name) => name.endsWith(".mjs") && !excluded.has(name))
    .sort()
);

const body = (name) =>
  `/** Auto-wrapper: canonical implementation in shared/js. Do not edit algorithms here. */\n` +
  `export * from "../../shared/js/${name}";\n`;

function wrapperPath(appJsDir, name) {
  return path.join(ROOT, appJsDir, name);
}

function expectedWrapperContent(name) {
  return body(name);
}

export function listWrapperTargets() {
  return WRAPPER_APP_JS_DIRS.flatMap((app) =>
    WRAPPER_MODULE_NAMES
      .map((name) => ({ app, name, filePath: wrapperPath(app, name) }))
      .filter(({ filePath }) => fs.existsSync(filePath))
  );
}

function writeWrappers() {
  const targets = listWrapperTargets();
  for (const { filePath, name } of targets) {
    fs.writeFileSync(filePath, expectedWrapperContent(name));
  }
  console.info(
    `Wrote ${targets.length} canonical re-export wrappers; no unused app files were created`
  );
}

function checkWrappers() {
  const mismatches = [];
  const targets = listWrapperTargets();
  for (const { filePath, name } of targets) {
    const expected = expectedWrapperContent(name);
    const actual = fs.readFileSync(filePath, "utf8");
    if (actual !== expected) {
      mismatches.push(`${path.relative(ROOT, filePath)} (content drift)`);
    }
  }
  if (mismatches.length) {
    console.error("[sync-shared-js-wrappers] wrapper parity check FAILED:");
    for (const item of mismatches) console.error(`  - ${item}`);
    process.exit(1);
  }
  console.info(`[sync-shared-js-wrappers] wrapper parity check PASS (${targets.length} overlaps)`);
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
