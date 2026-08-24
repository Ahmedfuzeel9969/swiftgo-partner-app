/**
 * CI gate for pull-request Firebase Hosting preview.
 * Static + contract checks only — no emulator, no production deploy.
 *
 * Run: node tests/ci-preview-gate.mjs
 */

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const require = createRequire(import.meta.url);

function step(label, fn) {
  process.stdout.write(`→ ${label}…\n`);
  fn();
  process.stdout.write(`  ✓ ${label}\n`);
}

console.log("\n=== SwiftGo CI preview gate ===\n");

step("booking false-success contract suite", () => {
  execSync("node tests/booking-false-success-suite.mjs", { cwd: root, stdio: "inherit" });
});

step("dispatch completion rating latency regressions", () => {
  execSync("node tests/ride-latency-rating-regression.mjs", {
    cwd: root,
    stdio: "inherit",
  });
});

step("hosting build", () => {
  execSync("npm run build:hosting", { cwd: root, stdio: "inherit" });
});

step("functions entry load", () => {
  require(join(root, "functions", "index.js"));
});

step("workflow deploy scope (hosting preview only)", () => {
  const workflow = readFileSync(
    join(root, ".github", "workflows", "pr-firebase-preview.yml"),
    "utf8"
  );
  if (!workflow.includes("FirebaseExtended/action-hosting-deploy")) {
    throw new Error("preview workflow must use Firebase hosting preview action");
  }
  if (/firebase deploy(?!.*--only hosting)/.test(workflow.replace(/\s+/g, " "))) {
    throw new Error("workflow must not run full firebase deploy");
  }
  if (workflow.includes("firestore:rules") || workflow.includes("--only functions")) {
    throw new Error("workflow must not deploy rules or functions");
  }
});

console.log("\nCI preview gate: PASS\n");
