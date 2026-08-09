/**
 * Package the four independent apps into hosting-dist/ for Firebase Hosting.
 * Usage: node tools/build-hosting.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DIST = path.join(ROOT, "hosting-dist");

function rmrf(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

function ensureDir(target) {
  fs.mkdirSync(target, { recursive: true });
}

function copyDir(src, dest) {
  ensureDir(dest);
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else fs.copyFileSync(from, to);
  }
}

function copyApp(srcRel, destRel) {
  const src = path.join(ROOT, srcRel);
  const dest = path.join(DIST, destRel);
  if (!fs.existsSync(src)) {
    throw new Error(`Missing app source: ${srcRel}`);
  }
  copyDir(src, dest);
}

/** Canonical Phase 4/5 modules — fan out into each app package (no dual editable copies). */
const SHARED_JS_MODULES = [
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
  "idle-publish-config.mjs",
  "location-reporting-config.mjs",
  "ride-location-report-schema.mjs",
  "ride-location-local-counter-store.mjs",
];

function syncSharedJsInto(destJsDir) {
  const sharedDir = path.join(ROOT, "shared", "js");
  ensureDir(destJsDir);
  for (const name of SHARED_JS_MODULES) {
    const from = path.join(sharedDir, name);
    if (!fs.existsSync(from)) {
      throw new Error(`Missing canonical shared module: shared/js/${name}`);
    }
    fs.copyFileSync(from, path.join(destJsDir, name));
  }
  const catalogJsonFrom = path.join(ROOT, "shared", "vehicle-catalog.json");
  const catalogJsonTo = path.join(destJsDir, "..", "vehicle-catalog.json");
  fs.copyFileSync(catalogJsonFrom, catalogJsonTo);
}

const syncCatalog = spawnSync(process.execPath, [path.join(ROOT, "tools", "sync-vehicle-catalog.mjs")], {
  cwd: ROOT,
  stdio: "inherit",
});
if (syncCatalog.status !== 0) {
  throw new Error("sync-vehicle-catalog failed");
}

spawnSync(process.execPath, [path.join(ROOT, "tools", "sync-shared-js-wrappers.mjs")], {
  cwd: ROOT,
  stdio: "inherit",
});

rmrf(DIST);
ensureDir(DIST);

// Customer app at site root and mirrored under /customer/
copyApp("customer-app", ".");
copyApp("customer-app", "customer");

// Driver app stays at /partner/ (God Mode + legacy bookmarks)
copyApp("driver-app", "partner");

// Replace thin re-export wrappers with self-contained canonical copies for Hosting.
syncSharedJsInto(path.join(DIST, "js"));
syncSharedJsInto(path.join(DIST, "customer", "js"));
syncSharedJsInto(path.join(DIST, "partner", "js"));
syncSharedJsInto(path.join(DIST, "owner", "js"));
syncSharedJsInto(path.join(DIST, "admin", "js"));
// Optional inspection path
syncSharedJsInto(path.join(DIST, "shared", "js"));

// Fleet owner app at /owner/
copyApp("owner-app", "owner");

// Super Admin under /admin/
copyApp("super-admin-panel", "admin");

// Phase 4E — draft legal pages (static; served before SPA rewrites when file exists)
copyDir(path.join(ROOT, "legal"), path.join(DIST, "legal"));

// Phase free-tier — Digital Asset Links draft (fingerprints must be replaced before verify)
const wellKnownSrc = path.join(ROOT, "hosting-static", ".well-known");
if (fs.existsSync(wellKnownSrc)) {
  copyDir(wellKnownSrc, path.join(DIST, ".well-known"));
}

console.info("[build-hosting] packaged apps into hosting-dist/");
console.info("  /              <- customer-app");
console.info("  /customer/     <- customer-app");
console.info("  /partner/      <- driver-app");
console.info("  /owner/        <- owner-app");
console.info("  /admin/        <- super-admin-panel");
console.info("  /legal/        <- privacy, terms, data-use drafts");
console.info("  /.well-known/  <- assetlinks draft (if present)");
console.info("  shared/js      <- canonical road modules (also inlined into app js/)");
