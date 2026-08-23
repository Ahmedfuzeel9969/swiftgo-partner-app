/**
 * Package the four independent apps into hosting-dist/ for Firebase Hosting.
 * Usage: node tools/build-hosting.mjs
 *
 * Build order (deterministic):
 *   1. Sync functions vehicle catalog (functions/ only)
 *   2. Copy every app tree into hosting-dist/
 *   3. Copy static legal / .well-known assets
 *   4. Overlay canonical shared/js modules LAST into each dist js/ folder
 *   5. Stamp hosting-dist/.hosting-source.json with git HEAD
 *
 * Source app trees are never mutated during Hosting packaging.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync, execSync } from "node:child_process";
import {
  HOSTING_DIST_JS_TARGETS,
  SHARED_JS_MODULES,
} from "./hosting-build-config.mjs";

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

function stampModuleEntrypoint(htmlRel, modulePath, headSha) {
  const htmlPath = path.join(DIST, htmlRel);
  const html = fs.readFileSync(htmlPath, "utf8");
  const escapedPath = modulePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(src=["']${escapedPath})(?:\\?[^"']*)?(["'])`);
  const stamped = html.replace(pattern, `$1?v=${headSha.slice(0, 12)}$2`);
  if (stamped === html) {
    throw new Error(`Could not stamp module entrypoint ${modulePath} in ${htmlRel}`);
  }
  fs.writeFileSync(htmlPath, stamped);
}

function main() {
  const syncCatalog = spawnSync(process.execPath, [path.join(ROOT, "tools", "sync-vehicle-catalog.mjs")], {
    cwd: ROOT,
    stdio: "inherit",
  });
  if (syncCatalog.status !== 0) {
    throw new Error("sync-vehicle-catalog failed");
  }

  rmrf(DIST);
  ensureDir(DIST);

  // Step 1 — copy application packages (never mutate source trees here).
  copyApp("customer-app", ".");
  copyApp("customer-app", "customer");
  copyApp("driver-app", "partner");
  copyApp("owner-app", "owner");
  copyApp("super-admin-panel", "admin");

  // Step 2 — static assets.
  copyDir(path.join(ROOT, "legal"), path.join(DIST, "legal"));
  const wellKnownSrc = path.join(ROOT, "hosting-static", ".well-known");
  if (fs.existsSync(wellKnownSrc)) {
    copyDir(wellKnownSrc, path.join(DIST, ".well-known"));
  }

  // Step 3 — canonical shared overlays LAST so stale app-local copies cannot win.
  for (const rel of HOSTING_DIST_JS_TARGETS) {
    syncSharedJsInto(path.join(DIST, ...rel.split("/")));
  }

  // Step 3b — full shared/js mirror into dist shared/ only (not app folders).
  // Customer/partner import graphs resolve ../../shared/js/*; do not replace
  // app-local wrappers with diagnostics modules that import ../../driver-app/*.
  const sharedSrc = path.join(ROOT, "shared", "js");
  const sharedDist = path.join(DIST, "shared", "js");
  ensureDir(sharedDist);
  for (const entry of fs.readdirSync(sharedSrc, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".mjs") && !entry.name.endsWith(".js")) continue;
    fs.copyFileSync(path.join(sharedSrc, entry.name), path.join(sharedDist, entry.name));
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

  let headSha = "unknown";
  try {
    headSha = execSync("git rev-parse HEAD", { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    console.warn("[build-hosting] warning: could not resolve git HEAD for hosting source stamp");
  }
  stampModuleEntrypoint("partner/index.html", "js/driver-app.js", headSha);
  stampModuleEntrypoint("admin/index.html", "/admin/js/admin-app.js", headSha);
  fs.writeFileSync(
    path.join(DIST, ".hosting-source.json"),
    JSON.stringify(
      {
        headSha,
        builtAt: new Date().toISOString(),
        builder: "tools/build-hosting.mjs",
      },
      null,
      2
    ) + "\n"
  );
  console.info(`[build-hosting] source stamp HEAD ${headSha}`);
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  main();
}
