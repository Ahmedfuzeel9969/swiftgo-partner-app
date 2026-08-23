/**
 * Emergency fix verification — hosting import resolve + runtime consistency intact.
 * Run after: npm run build:hosting
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CFG_MIN_LOCATION_MOVE_M,
  CFG_IDLE_LOCATION_INTERVAL_MS,
  CFG_P2P_FALLBACK_AFTER_MS,
  CFG_FIREBASE_BACKUP_READ_INTERVAL_MS,
} from "../shared/js/phase1-billing-diagnostics.mjs";
import {
  MIN_LOCATION_MOVE_M,
  IDLE_LOCATION_INTERVAL_MS,
} from "../driver-app/js/location-checkpoint-policy.mjs";
import {
  P2P_FALLBACK_AFTER_MS,
  FIREBASE_BACKUP_READ_INTERVAL_MS,
} from "../driver-app/js/p2p-protocol.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "tests", "emergency-fix-verification-report.json");
const items = [];

function row(item, pass, detail = "") {
  items.push({ item, result: pass ? "PASS" : "FAIL", detail });
  console.log(`${pass ? "PASS" : "FAIL"} | ${item}${detail ? ` — ${detail}` : ""}`);
}

row(
  "200m movement threshold",
  CFG_MIN_LOCATION_MOVE_M === 200 && CFG_MIN_LOCATION_MOVE_M === MIN_LOCATION_MOVE_M,
  String(CFG_MIN_LOCATION_MOVE_M)
);
row(
  "5-minute idle checkpoint",
  CFG_IDLE_LOCATION_INTERVAL_MS === 300_000 &&
    CFG_IDLE_LOCATION_INTERVAL_MS === IDLE_LOCATION_INTERVAL_MS,
  String(CFG_IDLE_LOCATION_INTERVAL_MS)
);
row(
  "30-second P2P fallback",
  CFG_P2P_FALLBACK_AFTER_MS === 30_000 && CFG_P2P_FALLBACK_AFTER_MS === P2P_FALLBACK_AFTER_MS,
  String(CFG_P2P_FALLBACK_AFTER_MS)
);
row(
  "4-second Firebase backup",
  CFG_FIREBASE_BACKUP_READ_INTERVAL_MS === 4_000 &&
    CFG_FIREBASE_BACKUP_READ_INTERVAL_MS === FIREBASE_BACKUP_READ_INTERVAL_MS,
  String(CFG_FIREBASE_BACKUP_READ_INTERVAL_MS)
);

const src = fs.readFileSync(path.join(ROOT, "shared/js/phase1-billing-diagnostics.mjs"), "utf8");
row(
  "SSoT monorepo imports retained in source",
  src.includes("../../driver-app/js/location-checkpoint-policy.mjs") &&
    src.includes("../../driver-app/js/p2p-protocol.mjs") &&
    src.includes("../../customer-app/js/live-location-render.mjs")
);
row(
  "no duplicate 12s/10m literals",
  !/CFG_P2P_FALLBACK_AFTER_MS\s*=\s*12_000/.test(src) &&
    !/CFG_MIN_LOCATION_MOVE_M\s*=\s*10\b/.test(src)
);
row("CFG aliases still re-export runtime", /CFG_P2P_FALLBACK_AFTER_MS = P2P_FALLBACK_AFTER_MS/.test(src));

const dests = [
  "hosting-dist/partner/js",
  "hosting-dist/customer/js",
  "hosting-dist/js",
];
for (const d of dests) {
  const p1 = path.join(ROOT, d, "phase1-billing-diagnostics.mjs");
  if (!fs.existsSync(p1)) {
    row(`${d} phase1 exists`, false);
    continue;
  }
  const text = fs.readFileSync(p1, "utf8");
  row(
    `${d} rewritten to ./ imports`,
    text.includes("./location-checkpoint-policy.mjs") && !text.includes("../../driver-app/")
  );
  for (const f of [
    "location-checkpoint-policy.mjs",
    "p2p-protocol.mjs",
    "live-location-render.mjs",
    "location-envelope.mjs",
    "phase1-billing-diagnostics.mjs",
  ]) {
    row(`${d}/${f}`, fs.existsSync(path.join(ROOT, d, f)));
  }
  const re = /from\s+["'](\.[^"']+)["']/g;
  let m;
  while ((m = re.exec(text))) {
    const target = path.normalize(path.join(ROOT, d, m[1]));
    row(`${d} resolve ${m[1]}`, fs.existsSync(target), target);
  }
}

const pass = items.filter((i) => i.result === "PASS").length;
const fail = items.filter((i) => i.result === "FAIL").length;
const report = {
  generatedAt: new Date().toISOString(),
  pass,
  fail,
  items,
  status: fail ? "FAIL — do not deploy" : "PASS",
};
fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log(`\nVerification: ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
