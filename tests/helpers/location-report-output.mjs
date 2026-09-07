/** Run legacy unit suites without overwriting the user's existing result files. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { syncBuiltinESMExports } from "node:module";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const destination = path.join(root, "emulator-data", "phase-two-legacy-results");
fs.mkdirSync(destination, { recursive: true });
const write = fs.writeFileSync.bind(fs);
fs.writeFileSync = (file, ...args) => {
  const target = path.resolve(file instanceof URL ? fileURLToPath(file) : file);
  if (path.dirname(target) !== path.join(root, "tests") || !/-(results|report)\.json$/.test(target)) {
    throw new Error("Legacy regression runner permits result artifacts only");
  }
  return write(path.join(destination, path.basename(target)), ...args);
};
syncBuiltinESMExports();
