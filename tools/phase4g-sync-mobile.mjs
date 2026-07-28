/**
 * Sync hosting-dist slices into Capacitor www/ folders for each Android shell.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "hosting-dist");

const APPS = [
  { id: "customer", distRel: ".", mobileRel: "mobile/customer/www" },
  { id: "partner", distRel: "partner", mobileRel: "mobile/partner/www" },
  { id: "owner", distRel: "owner", mobileRel: "mobile/owner/www" },
];

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

const build = spawnSync(process.execPath, [path.join(ROOT, "tools", "build-hosting.mjs")], {
  cwd: ROOT,
  stdio: "inherit",
});
if (build.status !== 0) process.exit(build.status || 1);

for (const app of APPS) {
  const src = path.join(DIST, app.distRel);
  const dest = path.join(ROOT, app.mobileRel);
  if (!fs.existsSync(src)) throw new Error(`Missing hosting slice: ${src}`);
  rmrf(dest);
  copyDir(src, dest);
  // Capacitor needs index at www root
  if (!fs.existsSync(path.join(dest, "index.html"))) {
    throw new Error(`No index.html in ${dest}`);
  }
  console.info(`[phase4g-sync] ${app.id} ← ${app.distRel}`);
}
