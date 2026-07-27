/**
 * Phase 2B runner: Phase 2A full suite + Phase 2B security suite.
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

const code2a = run("phase2a-run-all.mjs");
const code2b = run("phase2b-security-suite.mjs");

function readJson(rel, fallback) {
  const full = path.join(ROOT, "tests", rel);
  if (!fs.existsSync(full)) return fallback;
  return JSON.parse(fs.readFileSync(full, "utf8"));
}

const phase2a = readJson("phase2a-emulator-results.json", {
  results: [],
  passed: 0,
  failed: 0,
  blocked: 0,
});
const phase2b = readJson("phase2b-security-results.json", {
  results: [],
  passed: 0,
  failed: 0,
  blocked: 0,
});

const merged = {
  generatedAt: new Date().toISOString(),
  command:
    'firebase emulators:exec --only firestore --project demo-swiftgo-phase1 "node tests/phase2b-run-all.mjs"',
  results: [...(phase2a.results || []), ...(phase2b.results || [])],
  passed: (phase2a.passed || 0) + (phase2b.passed || 0),
  failed: (phase2a.failed || 0) + (phase2b.failed || 0),
  blocked: (phase2a.blocked || 0) + (phase2b.blocked || 0),
  exitCodes: { phase2a: code2a, phase2b: code2b },
};
merged.total = merged.results.length;
fs.writeFileSync(
  path.join(ROOT, "tests", "phase2b-emulator-results.json"),
  JSON.stringify(merged, null, 2)
);
console.log(
  `\n[phase2b-run-all] passed=${merged.passed} failed=${merged.failed} blocked=${merged.blocked}`
);
process.exit(code2a !== 0 || code2b !== 0 ? 1 : 0);
