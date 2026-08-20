/**
 * Hosting build order, Admin asset resolution, and source-drift regression tests.
 *
 * Run: npm run test:hosting-build-order
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  HOSTING_DIST_JS_TARGETS,
  SHARED_JS_MODULES,
} from "../tools/hosting-build-config.mjs";
import {
  WRAPPER_APP_JS_DIRS,
  WRAPPER_MODULE_NAMES,
} from "../tools/sync-shared-js-wrappers.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DIST = path.join(ROOT, "hosting-dist");
const RESULTS_PATH = path.join(ROOT, "tests", "hosting-build-order-results.json");

const results = [];
function record(name, ok, detail = "") {
  results.push({ name, status: ok ? "PASS" : "FAIL", detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

function sha256File(absPath) {
  return crypto.createHash("sha256").update(fs.readFileSync(absPath)).digest("hex");
}

function sha256DistExcludingStamp() {
  const files = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.name !== ".hosting-source.json") files.push(abs);
    }
  }
  walk(DIST);
  files.sort();
  const hash = crypto.createHash("sha256");
  for (const file of files) {
    hash.update(path.relative(DIST, file));
    hash.update("\0");
    hash.update(fs.readFileSync(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function git(args) {
  return execSync(`git ${args}`, { cwd: ROOT, encoding: "utf8" }).trim();
}

function wrapperWatchPaths() {
  return WRAPPER_APP_JS_DIRS.flatMap((dir) =>
    WRAPPER_MODULE_NAMES.map((name) => `${dir}/${name}`)
  );
}

function wrapperDiffSnapshot() {
  const paths = wrapperWatchPaths().join(" ");
  try {
    return git(`diff HEAD -- ${paths}`);
  } catch {
    return "";
  }
}

function wrapperStatusSnapshot() {
  const paths = wrapperWatchPaths().join(" ");
  return git(`status --porcelain -- ${paths}`);
}

function runBuild() {
  execSync("node tools/build-hosting.mjs", { cwd: ROOT, stdio: "pipe" });
}

function extractStaticImports(jsText) {
  const out = new Set();
  const re = /(?:import|export)\s+(?:[^'"\n]+from\s+)?["'](\.[^"']+)["']/g;
  let m;
  while ((m = re.exec(jsText))) out.add(m[1].split("?")[0]);
  return [...out];
}

function resolveImport(fromRelPosix, spec) {
  let resolved = path.posix.normalize(path.posix.join(path.posix.dirname(fromRelPosix), spec));
  if (!resolved.endsWith(".js") && !resolved.endsWith(".mjs")) {
    if (fs.existsSync(path.join(DIST, `${resolved}.mjs`))) resolved += ".mjs";
    else if (fs.existsSync(path.join(DIST, `${resolved}.js`))) resolved += ".js";
  }
  return resolved.replace(/^\.\//, "");
}

function walkAdminImportGraph(entryRel) {
  const queue = [entryRel];
  const seen = new Set();
  const missing = [];
  while (queue.length) {
    const rel = queue.shift();
    if (seen.has(rel)) continue;
    seen.add(rel);
    const abs = path.join(DIST, ...rel.split("/"));
    if (!fs.existsSync(abs)) {
      missing.push(rel);
      continue;
    }
    if (!(rel.endsWith(".js") || rel.endsWith(".mjs"))) continue;
    for (const spec of extractStaticImports(fs.readFileSync(abs, "utf8"))) {
      const next = resolveImport(rel, spec);
      if (!seen.has(next)) queue.push(next);
    }
  }
  return { seen: [...seen], missing };
}

function auditBuildHostingSource() {
  const src = read("tools/build-hosting.mjs");

  record(
    "build-hosting-does-not-sync-wrappers-into-source",
    !src.includes("sync-shared-js-wrappers.mjs"),
    "wrapper generation removed from Hosting packaging"
  );

  const copyAdmin = src.indexOf('copyApp("super-admin-panel", "admin")');
  const copyOwner = src.indexOf('copyApp("owner-app", "owner")');
  const syncLoop = src.indexOf("for (const rel of HOSTING_DIST_JS_TARGETS)");

  record(
    "build-order-apps-before-shared-overlay",
    copyAdmin > 0 && copyOwner > 0 && syncLoop > copyAdmin && syncLoop > copyOwner,
    "all copyApp calls precede HOSTING_DIST_JS_TARGETS overlay loop"
  );

  record(
    "build-order-deterministic-target-list",
    HOSTING_DIST_JS_TARGETS.join(",") ===
      ["js", "customer/js", "partner/js", "owner/js", "admin/js", "shared/js"].join(","),
    `${HOSTING_DIST_JS_TARGETS.length} dist js targets`
  );
}

function auditAdminAssetPaths() {
  const html = read("super-admin-panel/index.html");
  record(
    "admin-css-absolute-path",
    html.includes('href="/admin/css/admin-style.css'),
    "/admin/css/admin-style.css"
  );
  record(
    "admin-entry-script-absolute-path",
    html.includes('src="/admin/js/admin-app.js'),
    "/admin/js/admin-app.js"
  );
  record(
    "admin-legal-links-absolute",
    html.includes('href="/legal/privacy.html') && html.includes('href="/legal/terms.html'),
    "legal links rooted at site root"
  );
}

function verifyBuiltAdminCanonicalModules() {
  for (const name of SHARED_JS_MODULES) {
    const sharedPath = path.join(ROOT, "shared", "js", name);
    const builtPath = path.join(DIST, "admin", "js", name);
    const ok =
      fs.existsSync(builtPath) &&
      sha256File(sharedPath) === sha256File(builtPath);
    record(`admin-canonical:${name}`, ok, ok ? "matches shared/js" : "missing or stale");
  }

  const builtConfig = read(path.join("hosting-dist", "admin", "js", "location-reporting-config.mjs"));
  record(
    "admin-built-location-reporting-export",
    builtConfig.includes("LOCATION_REPORTING_UPLOAD_MODES_IMPLEMENTED"),
    "canonical export present in built admin bundle"
  );

  const staleSource = read("super-admin-panel/js/location-reporting-config.mjs");
  record(
    "regression-stale-admin-source-lacks-export",
    !staleSource.includes("LOCATION_REPORTING_UPLOAD_MODES_IMPLEMENTED"),
    "proves overlay fixes stale super-admin-panel copy"
  );
}

function verifyAdminImportGraph() {
  const graph = walkAdminImportGraph("admin/js/admin-app.js");
  record(
    "admin-import-graph-resolves",
    graph.missing.length === 0,
    graph.missing.length ? graph.missing.slice(0, 5).join(", ") : `${graph.seen.length} modules`
  );
}

function verifyBuildReproducibility() {
  runBuild();
  const hash1 = sha256DistExcludingStamp();
  const stamp1 = JSON.parse(read("hosting-dist/.hosting-source.json"));

  runBuild();
  const hash2 = sha256DistExcludingStamp();
  const stamp2 = JSON.parse(read("hosting-dist/.hosting-source.json"));

  record("two-builds-equivalent-output", hash1 === hash2, `hash=${hash1.slice(0, 16)}…`);
  record(
    "build-stamp-head-sha",
    stamp2.headSha === git("rev-parse HEAD"),
    stamp2.headSha
  );
  record(
    "build-stamp-stable-across-rebuild",
    stamp1.headSha === stamp2.headSha,
    stamp2.headSha
  );
}

function verifyNoWrapperSourceDrift() {
  const diffBefore = wrapperDiffSnapshot();
  const statusBefore = wrapperStatusSnapshot();
  runBuild();
  const diffAfter = wrapperDiffSnapshot();
  const statusAfter = wrapperStatusSnapshot();

  record(
    "build-no-wrapper-diff-drift",
    diffBefore === diffAfter,
    diffBefore === diffAfter ? "wrapper git diff unchanged" : "new wrapper diff detected"
  );
  record(
    "build-no-wrapper-status-drift",
    statusBefore === statusAfter,
    statusBefore === statusAfter ? "wrapper git status unchanged" : "new wrapper status changes"
  );
}

function main() {
  auditBuildHostingSource();
  auditAdminAssetPaths();

  verifyNoWrapperSourceDrift();
  verifyBuildReproducibility();
  verifyBuiltAdminCanonicalModules();
  verifyAdminImportGraph();

  const failed = results.filter((r) => r.status === "FAIL");
  fs.writeFileSync(
    RESULTS_PATH,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        pass: results.length - failed.length,
        fail: failed.length,
        results,
      },
      null,
      2
    )
  );

  console.log(`\nSummary pass=${results.length - failed.length} fail=${failed.length}`);
  console.log(`Wrote ${RESULTS_PATH}`);
  if (failed.length) process.exitCode = 1;
}

main();
