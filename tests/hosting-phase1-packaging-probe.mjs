/**
 * Fail if hosting-dist or live phase1-billing-diagnostics is still the broken wrapper.
 * Run: node tests/hosting-phase1-packaging-probe.mjs
 *      node tests/hosting-phase1-packaging-probe.mjs --url https://swiftgo-ride-app.web.app
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PHASE1_HOSTING_TARGETS,
  isPackagedPhase1Diagnostics,
} from "../tools/hosting-build-config.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LIVE = process.argv.includes("--url")
  ? process.argv[process.argv.indexOf("--url") + 1]
  : null;
const DIST = path.join(ROOT, "hosting-dist");

async function read(rel) {
  if (LIVE) {
    const base = LIVE.replace(/\/$/, "");
    const res = await fetch(`${base}/${rel}?probe=${Date.now()}`);
    return { ok: res.ok, text: await res.text(), url: `${base}/${rel}` };
  }
  const abs = path.join(DIST, ...rel.split("/"));
  if (!fs.existsSync(abs)) return { ok: false, text: "", url: abs };
  return { ok: true, text: fs.readFileSync(abs, "utf8"), url: abs };
}

let fail = 0;
for (const rel of PHASE1_HOSTING_TARGETS) {
  const f = await read(rel);
  const ok = f.ok && isPackagedPhase1Diagnostics(f.text);
  console.log(`${ok ? "PASS" : "FAIL"} ${rel} len=${f.text.length}`);
  if (!ok) fail += 1;
}
if (fail) process.exit(1);
