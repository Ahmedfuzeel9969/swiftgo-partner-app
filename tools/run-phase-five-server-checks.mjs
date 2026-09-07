import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { requireBreadcrumbEmulators } from "../tests/helpers/breadcrumb-test-safety.mjs";
requireBreadcrumbEmulators();
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "emulator-data/phase-five-server-checks"); fs.mkdirSync(out, { recursive: true });
const results = [];
for (const [name, args] of [
  ["remediation", ["--test", "tests/remediation-phase-five-emulator.test.mjs"]],
  ["breadcrumb-batching", ["tests/breadcrumb-batching.mjs"]],
  ["breadcrumb-hardening", ["tests/breadcrumb-hardening.mjs"]],
]) {
  const result = await new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: root, windowsHide: true, env: process.env });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => { output += chunk; });
    child.once("error", (e) => resolve({ name, exitCode: -1, output: e.message }));
    child.once("exit", (code) => resolve({ name, exitCode: code, output }));
  });
  fs.writeFileSync(path.join(out, `${name}.log`), result.output); results.push({ name, exitCode: result.exitCode });
  console.log(`${name}: ${result.exitCode === 0 ? "PASS" : "FAIL"}`);
  if (result.exitCode !== 0) console.log(result.output);
}
fs.writeFileSync(path.join(out, "summary.json"), JSON.stringify({ results, generatedAt: new Date().toISOString(), synthetic: true }, null, 2));
if (results.some((r) => r.exitCode !== 0)) process.exitCode = 1;
