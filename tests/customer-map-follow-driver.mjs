/**
 * Customer map follow-driver mode tests.
 * Run: node tests/customer-map-follow-driver.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "tests", "customer-map-follow-driver-results.json");

const results = [];
function record(name, status, detail = "") {
  results.push({ name, status, detail });
  const mark = status === "PASS" ? "✓" : "✗";
  console.log(`${mark} ${name}${detail ? ` — ${detail}` : ""}`);
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

record(
  "static-map-follow-exports",
  read("customer-app/js/map.js").includes("export function followAssignedDriverIfEnabled") &&
    read("customer-app/js/map.js").includes("export function setFollowDriverEnabled")
    ? "PASS"
    : "FAIL"
);

record(
  "static-map-drag-disables-follow",
  read("customer-app/js/map.js").includes('map.on("dragstart"') &&
    read("customer-app/js/map.js").includes("followDriverEnabled = false")
    ? "PASS"
    : "FAIL"
);

record(
  "static-ride-flow-wires-follow-visible-only",
  read("customer-app/js/ride-flow.js").includes("followAssignedDriverIfEnabled") &&
    read("customer-app/js/ride-flow.js").includes('document.visibilityState !== "hidden"')
    ? "PASS"
    : "FAIL"
);

record(
  "static-follow-does-not-change-zoom",
  (() => {
    const src = read("customer-app/js/map.js");
    const match = src.match(
      /export function followAssignedDriverIfEnabled[\s\S]*?\n\}/
    );
    const body = match ? match[0] : "";
    return body.includes("map.panTo") && !body.includes("flyTo") ? "PASS" : "FAIL";
  })()
);

const pass = results.filter((r) => r.status === "PASS").length;
const fail = results.filter((r) => r.status === "FAIL").length;
fs.writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), pass, fail, results }, null, 2));
console.log(`\ncustomer-map-follow-driver: ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
