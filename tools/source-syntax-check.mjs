/** Parse every first-party JavaScript source without resolving imports. */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const roots = [
  "customer-app/js",
  "driver-app/js",
  "owner-app/js",
  "super-admin-panel/js",
  "shared/js",
  "functions",
  "tools",
];

function walk(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules" || entry.name === "hosting-dist") return [];
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(absolute) : [absolute];
  });
}

const files = roots
  .flatMap((item) => walk(path.join(ROOT, item)))
  .filter((filePath) => /\.(?:js|mjs|cjs)$/i.test(filePath));
const failures = [];

for (const filePath of files) {
  try {
    const source = fs.readFileSync(filePath, "utf8");
    if (filePath.endsWith(".cjs")) {
      new vm.Script(source, { filename: filePath });
    } else {
      new vm.SourceTextModule(source, { identifier: filePath });
    }
  } catch (error) {
    failures.push(`${path.relative(ROOT, filePath)}: ${error?.message || error}`);
  }
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.info(`[source-syntax-check] PASS (${files.length} files)`);
}
