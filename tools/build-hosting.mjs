/**
 * Package the four independent apps into hosting-dist/ for Firebase Hosting.
 * Usage: node tools/build-hosting.mjs
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

rmrf(DIST);
ensureDir(DIST);

// Customer app at site root and mirrored under /customer/
copyApp("customer-app", ".");
copyApp("customer-app", "customer");

// Driver app stays at /partner/ (God Mode + legacy bookmarks)
copyApp("driver-app", "partner");

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
