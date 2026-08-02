/**
 * Runs Phase 2A rules suite then settlement suite; merges results.
 * Invoked via: firebase emulators:exec ... "node tests/phase2a-run-all.mjs"
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function removePreviousResult(resultFile) {
  const full = path.join(ROOT, "tests", resultFile);
  if (fs.existsSync(full)) fs.unlinkSync(full);
}

function run(script, resultFile) {
  removePreviousResult(resultFile);
  const startedAtMs = Date.now();
  const r = spawnSync(process.execPath, [path.join(ROOT, "tests", script)], {
    env: process.env,
    encoding: "utf8",
    cwd: ROOT,
  });
  process.stdout.write(r.stdout || "");
  process.stderr.write(r.stderr || "");
  const finishedAtMs = Date.now();
  const resultPath = path.join(ROOT, "tests", resultFile);
  let freshResult = false;
  if (fs.existsSync(resultPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(resultPath, "utf8"));
      const generatedAtMs = Date.parse(String(parsed.generatedAt || ""));
      const mtimeMs = fs.statSync(resultPath).mtimeMs;
      freshResult =
        Number.isFinite(generatedAtMs) &&
        generatedAtMs >= startedAtMs - 5_000 &&
        generatedAtMs <= finishedAtMs + 5_000 &&
        mtimeMs >= startedAtMs - 1_000;
    } catch {
      freshResult = false;
    }
  }
  if (r.error) return 1;
  if (r.status !== 0) return r.status ?? 1;
  return freshResult ? 0 : 1;
}

const code1 = run("phase2a-emulator-suite.mjs", "phase2a-emulator-results.json");
const code2 = run("phase2a-settlement-only.mjs", "phase2a-settlement-results.json");
const code3 = run("phase2a-bargaining-suite.mjs", "phase2a-bargaining-results.json");

function readJson(rel, fallback) {
  const full = path.join(ROOT, "tests", rel);
  if (!fs.existsSync(full)) return fallback;
  return JSON.parse(fs.readFileSync(full, "utf8"));
}

const rules = readJson("phase2a-emulator-results.json", {
  results: [],
  passed: 0,
  failed: 0,
  blocked: 0,
});
const settle = readJson("phase2a-settlement-results.json", {
  results: [],
  passed: 0,
  failed: 0,
  blocked: 0,
});
const bargain = readJson("phase2a-bargaining-results.json", {
  results: [],
  passed: 0,
  failed: 0,
  blocked: 0,
});

const merged = {
  generatedAt: new Date().toISOString(),
  command:
    'firebase emulators:exec --only firestore --project demo-swiftgo-phase1 "node tests/phase2a-run-all.mjs"',
  results: [
    ...(rules.results || []),
    ...(settle.results || []),
    ...(bargain.results || []),
  ],
  passed: (rules.passed || 0) + (settle.passed || 0) + (bargain.passed || 0),
  failed: (rules.failed || 0) + (settle.failed || 0) + (bargain.failed || 0),
  blocked: (rules.blocked || 0) + (settle.blocked || 0) + (bargain.blocked || 0),
  exitCodes: { rules: code1, settlement: code2, bargaining: code3 },
};
merged.total = merged.results.length;
fs.writeFileSync(
  path.join(ROOT, "tests", "phase2a-emulator-results.json"),
  JSON.stringify(merged, null, 2)
);
console.log(
  `\n[phase2a-run-all] passed=${merged.passed} failed=${merged.failed} blocked=${merged.blocked}`
);
process.exit(code1 !== 0 || code2 !== 0 || code3 !== 0 ? 1 : 0);
