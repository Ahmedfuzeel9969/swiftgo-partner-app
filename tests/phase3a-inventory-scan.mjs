/**
 * Phase 3A — static Firebase usage inventory (repo scan).
 * No Production / no network billing traffic.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "tests", "phase3a-inventory-results.json");

const APP_DIRS = [
  ["customer", "customer-app/js"],
  ["driver", "driver-app/js"],
  ["owner", "owner-app/js"],
  ["admin", "super-admin-panel/js"],
  ["functions", "functions"],
];

const PATTERNS = [
  { re: /\bonSnapshot\s*\(/g, op: "listener", service: "firestore" },
  { re: /\bgetDoc\s*\(/g, op: "read", service: "firestore" },
  { re: /\bgetDocs\s*\(/g, op: "read", service: "firestore" },
  { re: /\bgetCountFromServer\s*\(/g, op: "read-aggregate", service: "firestore" },
  { re: /\bsetDoc\s*\(/g, op: "write", service: "firestore" },
  { re: /\bupdateDoc\s*\(/g, op: "write", service: "firestore" },
  { re: /\baddDoc\s*\(/g, op: "write", service: "firestore" },
  { re: /\bdeleteDoc\s*\(/g, op: "delete", service: "firestore" },
  { re: /\bwriteBatch\s*\(/g, op: "write-batch", service: "firestore" },
  { re: /\brunTransaction\s*\(/g, op: "transaction", service: "firestore" },
  { re: /\bhttpsCallable\s*\(/g, op: "function-call", service: "functions" },
  { re: /\bonCall\s*\(/g, op: "function-export", service: "functions" },
  { re: /\buploadBytes\s*\(/g, op: "upload", service: "storage" },
  { re: /\bgetDownloadURL\s*\(/g, op: "download", service: "storage" },
  { re: /\bsignInWithEmailAndPassword\s*\(/g, op: "auth", service: "auth" },
  { re: /\bsignInWithPopup\s*\(/g, op: "auth", service: "auth" },
  { re: /\bonAuthStateChanged\s*\(/g, op: "auth-listener", service: "auth" },
];

function walk(dir, files = []) {
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      walk(p, files);
    } else if (/\.(js|mjs|cjs)$/.test(entry.name)) files.push(p);
  }
  return files;
}

const inventory = [];
const totals = {};

for (const [app, rel] of APP_DIRS) {
  const files = walk(path.join(ROOT, rel));
  for (const file of files) {
    const src = fs.readFileSync(file, "utf8");
    const relFile = path.relative(ROOT, file).replace(/\\/g, "/");
    for (const { re, op, service } of PATTERNS) {
      re.lastIndex = 0;
      let m;
      let count = 0;
      while ((m = re.exec(src))) count += 1;
      if (!count) continue;
      const key = `${service}:${op}`;
      totals[key] = (totals[key] || 0) + count;
      inventory.push({
        app,
        file: relFile,
        service,
        operation: op,
        callSites: count,
        recurringHint:
          op.includes("listener") || /LOCATION|onSnapshot|watch/i.test(relFile)
            ? "possibly-recurring"
            : "one-time-or-event",
      });
    }
  }
}

const summary = {
  generatedAt: new Date().toISOString(),
  note: "Static call-site counts — not billable units. See PHASE-3A-FIREBASE-USAGE-INVENTORY.md for semantics.",
  totals,
  entries: inventory,
};

fs.writeFileSync(OUT, JSON.stringify(summary, null, 2));
console.log(`[phase3a-inventory] ${inventory.length} entries → ${OUT}`);
console.log(JSON.stringify(totals, null, 2));
