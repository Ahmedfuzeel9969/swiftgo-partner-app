/**
 * Phase 2C runner — Phase 2B suite + Phase 2C E2E (includes Phase 1/2A via 2B).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(script) {
  const r = spawnSync(process.execPath, [path.join(ROOT, "tests", script)], {
    env: process.env,
    encoding: "utf8",
    cwd: ROOT,
  });
  process.stdout.write(r.stdout || "");
  process.stderr.write(r.stderr || "");
  return r.status ?? 1;
}

const code2b = run("phase2b-run-all.mjs");
const code2c = run("phase2c-e2e-suite.mjs");
const codeAudit = run("phase2c-canonical-audit.mjs");

function readJson(rel, fallback) {
  const full = path.join(ROOT, "tests", rel);
  if (!fs.existsSync(full)) return fallback;
  return JSON.parse(fs.readFileSync(full, "utf8"));
}

const phase2b = readJson("phase2b-emulator-results.json", {
  results: [],
  passed: 0,
  failed: 0,
  blocked: 0,
});
const e2e = readJson("phase2c-e2e-results.json", {
  results: [],
  passed: 0,
  failed: 0,
  blocked: 0,
});
const audit = readJson("phase2c-canonical-audit-results.json", {
  results: [],
  passed: 0,
  failed: 0,
  blocked: 0,
});

const merged = {
  generatedAt: new Date().toISOString(),
  command:
    'firebase emulators:exec --only firestore,storage,auth --project demo-swiftgo-phase1 "node tests/phase2c-run-all.mjs"',
  results: [...(phase2b.results || []), ...(e2e.results || []), ...(audit.results || [])],
  passed: (phase2b.passed || 0) + (e2e.passed || 0) + (audit.passed || 0),
  failed: (phase2b.failed || 0) + (e2e.failed || 0) + (audit.failed || 0),
  blocked: (phase2b.blocked || 0) + (e2e.blocked || 0) + (audit.blocked || 0),
  exitCodes: { phase2b: code2b, e2e: code2c, audit: codeAudit },
};
merged.total = merged.results.length;
fs.writeFileSync(
  path.join(ROOT, "tests", "phase2c-emulator-results.json"),
  JSON.stringify(merged, null, 2)
);
console.log(
  `\n[phase2c-run-all] passed=${merged.passed} failed=${merged.failed} blocked=${merged.blocked}`
);
process.exit(code2b !== 0 || code2c !== 0 || codeAudit !== 0 ? 1 : 0);
