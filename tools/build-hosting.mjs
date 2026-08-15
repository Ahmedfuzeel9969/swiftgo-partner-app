/**
 * Package the four independent apps into hosting-dist/ for Firebase Hosting.
 * Usage: node tools/build-hosting.mjs
 *
 * POLICY: Never overlay live/hybrid Customer or Driver JS onto this output.
 * Deploy only a coherent tree from this script, then run
 * tools/hosting-startup-health.mjs (firebase.json predeploy).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
  "route-provider-bootstrap.mjs",
  "two-leg-route-controller.mjs",
  "two-leg-route-layers.mjs",
  "route-projection.mjs",
  "route-progress.mjs",
  "route-motion-controller.mjs",
  "off-route-detector.mjs",
  "display-location-pipeline.mjs",
  "breadcrumb-schema.mjs",
  "field-diagnostics.mjs",
  "phase1-billing-diagnostics.mjs",
  "phase1-billing-reports.mjs",
  "phase2-runtime-verification.mjs",
  "phase2-runtime-reports.mjs",
  "phase3-billing-proof.mjs",
  "phase3-billing-reports.mjs",
  "diagnostics-screen-core.mjs",
  "p2p-comm-protocol.mjs",
  "p2p-comm-session.mjs",
  "p2p-comm-router.mjs",
  "p2p-comm-voice.mjs",
  "p2p-comm-call.mjs",
  "p2p-comm-panel.mjs",
  "p2p-comm-module.mjs",
  "p2p-pipeline-trace.mjs",
  "p2p-ice-bootstrap-core.mjs",
  "location-reporting-config.mjs",
  "location-reporting-config-cache.mjs",
  "ride-location-local-counter-store.mjs",
  "ride-location-report-client.mjs",
  "ride-location-report-pending-queue.mjs",
  "ride-location-report-schema.mjs",
];

function syncSharedJsInto(destJsDir) {
  const sharedDir = path.join(ROOT, "shared", "js");
  ensureDir(destJsDir);
  for (const name of SHARED_JS_MODULES) {
    const from = path.join(sharedDir, name);
    if (!fs.existsSync(from)) {
      throw new Error(`Missing canonical shared module: shared/js/${name}`);
    }
    if (name === "phase1-billing-diagnostics.mjs") {
      // Monorepo source imports ../../driver-app|customer-app (Node tests).
      // Hosting packages apps as /partner and /customer — rewrite to local ./ deps.
      let content = fs.readFileSync(from, "utf8");
      for (const [fromPath, toPath] of PHASE1_HOSTING_IMPORT_REWRITES) {
        content = content.split(fromPath).join(toPath);
      }
      fs.writeFileSync(path.join(destJsDir, name), content);
    } else {
      fs.copyFileSync(from, path.join(destJsDir, name));
    }
  }
  // Ensure SSoT runtime modules sit beside rewritten phase1 imports.
  for (const dep of PHASE1_RUNTIME_DEPS) {
    const src = path.join(ROOT, dep.from);
    if (!fs.existsSync(src)) {
      throw new Error(`Missing phase1 runtime dep: ${dep.from}`);
    }
    fs.copyFileSync(src, path.join(destJsDir, dep.name));
  }
}

/** Hosting-safe rewrite for phase1 diagnostics (keeps monorepo source imports intact). */
const PHASE1_HOSTING_IMPORT_REWRITES = [
  ["../../driver-app/js/location-checkpoint-policy.mjs", "./location-checkpoint-policy.mjs"],
  ["../../driver-app/js/p2p-protocol.mjs", "./p2p-protocol.mjs"],
  ["../../customer-app/js/live-location-render.mjs", "./live-location-render.mjs"],
  ["../../driver-app/js/location-envelope.mjs", "./location-envelope.mjs"],
];

/** Pure runtime constant modules required by rewritten phase1 imports. */
const PHASE1_RUNTIME_DEPS = [
  { from: "driver-app/js/location-checkpoint-policy.mjs", name: "location-checkpoint-policy.mjs" },
  { from: "driver-app/js/p2p-protocol.mjs", name: "p2p-protocol.mjs" },
  { from: "customer-app/js/live-location-render.mjs", name: "live-location-render.mjs" },
  { from: "driver-app/js/location-envelope.mjs", name: "location-envelope.mjs" },
];

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
