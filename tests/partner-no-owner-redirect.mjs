/**
 * Partner URL must never auto-navigate to /owner/ on lang or auth refresh.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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

check("no partner→owner redirect", !driverJs.includes('window.location.replace("/owner/")'));
check("reconcile keeps user on partner", driverJs.includes("never auto-open Owner app"));

console.log(`\nPartner surface: ${pass} pass / ${fail} fail`);
if (fail) process.exitCode = 1;
