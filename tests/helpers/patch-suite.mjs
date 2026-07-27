import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const p = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../phase2a-emulator-suite.mjs");
let s = fs.readFileSync(p, "utf8");
const start = s.indexOf("  // Trusted settlement tests");
const end = s.indexOf("  // F25 partner safe profile update");
if (start < 0 || end < 0) {
  console.error("markers not found", start, end);
  process.exit(1);
}
const insert =
  "  // Settlement F15–F24 run in tests/phase2a-settlement-only.mjs (Admin SDK; separate process).\n\n";
s = s.slice(0, start) + insert + s.slice(end);
s = s.replace(/import \{ spawnSync \} from "node:child_process";\n/, "");
s = s.replace(/function runSettle\([\s\S]*?\n\}\n\n/, "");
s = s.replace(/\n  getDocs,\n  collection,\n  query,\n  where,/, "");
fs.writeFileSync(p, s);
console.log("patched ok");
