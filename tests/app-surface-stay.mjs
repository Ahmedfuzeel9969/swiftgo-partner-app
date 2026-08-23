/**
 * Same Gmail may use customer / partner / owner URLs independently.
 * Apps must not redirect across surfaces on lang or auth refresh.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ownerJs = fs.readFileSync(path.join(ROOT, "owner-app", "js", "owner-app.js"), "utf8");
const driverJs = fs.readFileSync(path.join(ROOT, "driver-app", "js", "driver-app.js"), "utf8");

let pass = 0;
let fail = 0;
function check(name, ok) {
  if (ok) {
    pass++;
    console.log(`✓ ${name}`);
  } else {
    fail++;
    console.log(`✗ ${name}`);
  }
}

check("owner never redirects drivers to partner", !ownerJs.includes('window.location.replace("/partner/")'));
check("driver never redirects to owner", !driverJs.includes('window.location.replace("/owner/")'));
check("driver does not force owner→driver role rewrite", !driverJs.includes("reconcileOwnerRoleOnDriverApp"));
check(
  "driver allows owner role on partner surface",
  driverJs.includes('from "./auth-surface-routing.mjs"') &&
    driverJs.includes('resolveSurfaceEntry({') &&
    driverJs.includes('surface: "partner"') &&
    !driverJs.includes('window.location.replace("/owner/")')
);

console.log(`\nSurface stay: ${pass} pass / ${fail} fail`);
if (fail) process.exitCode = 1;
