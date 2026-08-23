/**
 * Hosting startup health check — blocks deploy of incoherent Customer/Driver bundles.
 *
 * Verifies after `tools/build-hosting.mjs`:
 * - Entry HTML/JS exist for customer (/, /customer/) and driver (/partner/)
 * - Static import graph resolves to real JS/MJS files (never HTML SPA fallbacks)
 * - Every named import in that graph is actually exported by its target module
 * - Home shell markers present
 * - Firebase config modules load as JS
 * - P2P controller / peer-session modules present and are JS
 *
 * Usage:
 *   node tools/hosting-startup-health.mjs
 *   node tools/hosting-startup-health.mjs --dist path/to/hosting-dist
 *   node tools/hosting-startup-health.mjs --url https://swiftgo-ride-app.web.app
 *
 * Exit 0 = PASS, 1 = FAIL
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const args = process.argv.slice(2);
function argValue(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
}

const LIVE_URL = argValue("--url");
const DIST = path.resolve(ROOT, argValue("--dist") || "hosting-dist");
const NO_WRITE = args.includes("--no-write");

const results = [];
function record(name, ok, detail = "") {
  results.push({ name, status: ok ? "PASS" : "FAIL", detail });
  const tag = ok ? "PASS" : "FAIL";
  console.log(`${tag}  ${name}${detail ? ` — ${detail}` : ""}`);
}

function isHtmlContent(text) {
  const head = String(text || "").slice(0, 200).toLowerCase();
  return head.includes("<!doctype html") || head.includes("<html");
}

function looksLikeJs(text) {
  if (isHtmlContent(text)) return false;
  const t = String(text || "").trimStart();
  return (
    t.startsWith("import ") ||
    t.startsWith("export ") ||
    t.startsWith("/**") ||
    t.startsWith("/*") ||
    t.startsWith("//") ||
    t.startsWith("const ") ||
    t.startsWith("let ") ||
    t.startsWith("var ") ||
    t.startsWith("function ") ||
    t.startsWith("'use strict'") ||
    t.startsWith('"use strict"')
  );
}

async function readTarget(relPosix) {
  if (LIVE_URL) {
    const base = LIVE_URL.replace(/\/$/, "");
    const url = `${base}/${relPosix.replace(/^\//, "")}`;
    const res = await fetch(url, { redirect: "follow" });
    const text = await res.text();
    return {
      ok: res.ok,
      status: res.status,
      contentType: res.headers.get("content-type") || "",
      text,
      url,
    };
  }
  const abs = path.join(DIST, ...relPosix.split("/"));
  if (!fs.existsSync(abs)) {
    return { ok: false, status: 404, contentType: "", text: "", url: abs };
  }
  const text = fs.readFileSync(abs, "utf8");
  const ext = path.extname(abs).toLowerCase();
  const contentType =
    ext === ".html"
      ? "text/html"
      : ext === ".css"
        ? "text/css"
        : ext === ".js" || ext === ".mjs"
          ? "text/javascript"
          : "application/octet-stream";
  return { ok: true, status: 200, contentType, text, url: abs };
}

function extractScriptSrcs(html) {
  const out = [];
  const re = /<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const src = m[1].split("?")[0];
    if (src.startsWith("http://") || src.startsWith("https://")) continue;
    out.push(src.replace(/^\.\//, ""));
  }
  return out;
}

function extractStaticImports(jsText) {
  const out = new Set();
  // Clause may span lines (multi-line specifier lists) but never crosses a quote or `;`.
  const re = /(?:import|export)\s+(?:[^'";]*?\s+from\s*)?["'](\.[^"']+)["']/g;
  let m;
  while ((m = re.exec(jsText))) {
    out.add(m[1].split("?")[0]);
  }
  const reSide = /import\s*\(\s*["'](\.[^"']+)["']\s*\)/g;
  while ((m = reSide.exec(jsText))) {
    out.add(m[1].split("?")[0]);
  }
  return [...out];
}

/** Drop block comments and whole-line comments so JSDoc samples never look like real syntax. */
function stripComments(jsText) {
  return String(jsText || "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

function parseSpecifierList(clause) {
  return String(clause)
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [left, right] = part.split(/\s+as\s+/);
      return { imported: left.trim(), exported: (right || left).trim() };
    })
    .filter((s) => s.imported);
}

/** Named/default bindings this module requests from relative specifiers. */
function extractImportBindings(jsText) {
  const src = stripComments(jsText);
  const out = [];

  // Clause excludes quotes/semicolons so a preceding bare-URL import is never swallowed.
  const reImport = /import\s+([^"';]*?)\s+from\s*["'](\.[^"']+)["']/g;
  let m;
  while ((m = reImport.exec(src))) {
    const clause = m[1].trim();
    const spec = m[2].split("?")[0];
    if (/^\*\s+as\s+/.test(clause)) continue;
    const names = [];
    const braces = clause.match(/\{([\s\S]*?)\}/);
    if (braces) names.push(...parseSpecifierList(braces[1]).map((s) => s.imported));
    const beforeBrace = clause.split("{")[0].replace(/,\s*$/, "").trim();
    if (beforeBrace && !beforeBrace.startsWith("*")) names.push("default");
    if (names.length) out.push({ spec, names });
  }

  const reReexport = /export\s*\{([\s\S]*?)\}\s*from\s*["'](\.[^"']+)["']/g;
  while ((m = reReexport.exec(src))) {
    const spec = m[2].split("?")[0];
    const names = parseSpecifierList(m[1]).map((s) => s.imported);
    if (names.length) out.push({ spec, names });
  }

  return out;
}

/** Names this module exports directly, plus `export * from` specifiers to follow. */
function extractExportInfo(jsText) {
  const src = stripComments(jsText);
  const names = new Set();
  const stars = [];
  let m;

  const reStar = /export\s*\*\s*from\s*["']([^"']+)["']/g;
  while ((m = reStar.exec(src))) stars.push(m[1].split("?")[0]);

  const reStarAs = /export\s*\*\s*as\s+([A-Za-z_$][\w$]*)\s+from\s*["'][^"']+["']/g;
  while ((m = reStarAs.exec(src))) names.add(m[1]);

  const reList = /export\s*\{([\s\S]*?)\}/g;
  while ((m = reList.exec(src))) {
    for (const s of parseSpecifierList(m[1])) names.add(s.exported);
  }

  const reDecl =
    /export\s+(?:async\s+)?(?:const|let|var|function\s*\*?|class)\s+([A-Za-z_$][\w$]*)/g;
  while ((m = reDecl.exec(src))) names.add(m[1]);

  if (/export\s+default\b/.test(src)) names.add("default");

  return { names, stars };
}

function resolveImport(fromRelPosix, spec) {
  const fromDir = path.posix.dirname(fromRelPosix);
  let resolved = path.posix.normalize(path.posix.join(fromDir, spec));
  if (resolved.startsWith("../")) {
    // prevent escaping dist root in checks
    resolved = resolved.replace(/^(\.\.\/)+/, "");
  }
  return resolved.replace(/^\.\//, "");
}

/**
 * Names a module exposes, following `export * from` chains.
 * Returns null when the surface cannot be fully determined (unresolvable
 * re-export or cycle), so callers skip it rather than report a false break.
 */
function collectExportedNames(rel, texts, cache = new Map(), stack = new Set()) {
  if (cache.has(rel)) return cache.get(rel);
  if (stack.has(rel)) return null;
  const text = texts.get(rel);
  if (text === undefined) return null;

  stack.add(rel);
  const info = extractExportInfo(text);
  const names = new Set(info.names);
  let complete = true;
  for (const spec of info.stars) {
    const inherited = spec.startsWith(".")
      ? collectExportedNames(resolveImport(rel, spec), texts, cache, stack)
      : null;
    if (!inherited) {
      complete = false;
      break;
    }
    for (const n of inherited) names.add(n);
  }
  stack.delete(rel);

  const result = complete ? names : null;
  cache.set(rel, result);
  return result;
}

/**
 * Catches the deploy-killer that file-existence checks miss: a module importing a
 * name its target no longer exports, which aborts the whole graph at link time.
 */
function checkExportBindings(label, texts) {
  const cache = new Map();
  const broken = [];

  for (const [rel, text] of texts) {
    if (!rel.endsWith(".js") && !rel.endsWith(".mjs")) continue;
    for (const { spec, names } of extractImportBindings(text)) {
      const target = resolveImport(rel, spec);
      const exported = collectExportedNames(target, texts, cache);
      if (!exported) continue;
      for (const name of names) {
        if (!exported.has(name)) broken.push(`${rel} → ${spec} lacks '${name}'`);
      }
    }
  }

  record(
    `${label}-export-bindings-resolve`,
    broken.length === 0,
    broken.length ? broken.slice(0, 8).join("; ") : `modules=${texts.size}`
  );
  return broken;
}

async function walkImportGraph(entryRel, label, opts = {}) {
  const maxFiles = opts.maxFiles || 400;
  const queue = [entryRel];
  const seen = new Set();
  const texts = new Map();
  const missing = [];
  const htmlServed = [];

  while (queue.length && seen.size < maxFiles) {
    const rel = queue.shift();
    if (seen.has(rel)) continue;
    seen.add(rel);
    const file = await readTarget(rel);
    if (!file.ok) {
      missing.push(rel);
      continue;
    }
    if (isHtmlContent(file.text) || (file.contentType.includes("text/html") && !rel.endsWith(".html"))) {
      htmlServed.push(rel);
      continue;
    }
    if (!rel.endsWith(".html") && !looksLikeJs(file.text) && (rel.endsWith(".js") || rel.endsWith(".mjs"))) {
      htmlServed.push(`${rel} (non-JS body)`);
      continue;
    }
    if (!(rel.endsWith(".js") || rel.endsWith(".mjs"))) continue;
    texts.set(rel, file.text);
    for (const spec of extractStaticImports(file.text)) {
      const next = resolveImport(rel, spec);
      if (!seen.has(next)) queue.push(next);
    }
  }

  record(
    `${label}-import-graph-complete`,
    missing.length === 0 && htmlServed.length === 0,
    missing.length || htmlServed.length
      ? `missing=${missing.slice(0, 8).join(", ") || "—"} htmlFallback=${htmlServed.slice(0, 8).join(", ") || "—"} scanned=${seen.size}`
      : `scanned=${seen.size}`
  );

  const brokenBindings = checkExportBindings(label, texts);
  return { seen, texts, missing, htmlServed, brokenBindings };
}

async function checkApp({ name, htmlRel, homeMarkers, firebaseRel, p2pRels }) {
  const html = await readTarget(htmlRel);
  record(`${name}-html-loads`, html.ok && isHtmlContent(html.text), html.url);
  if (!html.ok) return;

  for (const marker of homeMarkers) {
    record(`${name}-home-marker:${marker}`, html.text.includes(marker), htmlRel);
  }

  const scripts = extractScriptSrcs(html.text);
  const localEntry = scripts.find((s) => s.includes("app.js") || s.includes("driver-app.js"));
  record(`${name}-entry-script`, Boolean(localEntry), localEntry || "none");
  if (!localEntry) return;

  const entryRel = path.posix.normalize(
    path.posix.join(path.posix.dirname(htmlRel), localEntry)
  ).replace(/^\.\//, "");
  // html at "" (root) dirname is "." → join("./js/app.js")
  const entry = localEntry.startsWith("/")
    ? localEntry.replace(/^\//, "")
    : htmlRel === "index.html" || htmlRel === ""
      ? localEntry.replace(/^\.\//, "")
      : path.posix.join(path.posix.dirname(htmlRel), localEntry).replace(/\\/g, "/");

  const entryFile = await readTarget(entry);
  record(
    `${name}-entry-is-js`,
    entryFile.ok && looksLikeJs(entryFile.text) && !isHtmlContent(entryFile.text),
    `${entry} ct=${entryFile.contentType}`
  );

  await walkImportGraph(entry, name);

  if (firebaseRel) {
    const fb = await readTarget(firebaseRel);
    record(
      `${name}-firebase-init-module`,
      fb.ok && looksLikeJs(fb.text) && !isHtmlContent(fb.text),
      firebaseRel
    );
  }

  for (const rel of p2pRels || []) {
    const mod = await readTarget(rel);
    const hasTrace =
      mod.text.includes("__SWIFTGO_COMM_TRACE__") ||
      mod.text.includes("COMM_TRACE") ||
      mod.text.includes("createDriverP2pController") ||
      mod.text.includes("createCustomerP2pController") ||
      mod.text.includes("RTCPeerConnection") ||
      mod.text.includes("p2p");
    record(
      `${name}-p2p:${path.posix.basename(rel)}`,
      mod.ok && looksLikeJs(mod.text) && !isHtmlContent(mod.text) && hasTrace,
      rel
    );
  }
}

async function main() {
  console.log(
    LIVE_URL
      ? `[hosting-startup-health] live probe ${LIVE_URL}`
      : `[hosting-startup-health] dist ${DIST}`
  );

  if (!LIVE_URL && !fs.existsSync(DIST)) {
    record("hosting-dist-exists", false, DIST);
  } else if (!LIVE_URL) {
    record("hosting-dist-exists", true, DIST);
  }

  await checkApp({
    name: "customer-root",
    htmlRel: "index.html",
    homeMarkers: ['id="screen-home"', 'id="sheet"', 'id="map"'],
    firebaseRel: "js/firebase.js",
    p2pRels: ["js/p2p-ride-controller.mjs", "js/p2p-peer-session.mjs"],
  });

  await checkApp({
    name: "customer-alias",
    htmlRel: "customer/index.html",
    homeMarkers: ['id="screen-home"', 'id="sheet"', 'id="map"'],
    firebaseRel: "customer/js/firebase.js",
    p2pRels: ["customer/js/p2p-ride-controller.mjs", "customer/js/p2p-peer-session.mjs"],
  });

  await checkApp({
    name: "driver",
    htmlRel: "partner/index.html",
    homeMarkers: ['id="driverHomeRoot"', "js/driver-app.js"],
    firebaseRel: "partner/js/firebase.js",
    p2pRels: [
      "partner/js/p2p-ride-controller.mjs",
      "partner/js/p2p-peer-session.mjs",
      "partner/js/p2p-comm-panel.mjs",
    ],
  });

  await checkApp({
    name: "admin",
    htmlRel: "admin/index.html",
    homeMarkers: ['id="adminGoogleLoginBtn"', "admin-app.js"],
    firebaseRel: "admin/js/firebase.js",
    p2pRels: [],
  });

  // Guard: known hybrid footguns must not be HTML when referenced by live graphs
  for (const rel of [
    "partner/js/phase1-billing-diagnostics.mjs",
    "partner/js/route-provider-bootstrap.mjs",
    "partner/js/p2p-comm-session.mjs",
    "js/phase1-billing-diagnostics.mjs",
  ]) {
    const f = await readTarget(rel);
    // Optional if entry graph does not import them — only fail when present as HTML
    if (!f.ok) {
      record(`asset-optional:${rel}`, true, "absent (ok if unused)");
      continue;
    }
    record(
      `asset-not-html:${rel}`,
      !isHtmlContent(f.text) && looksLikeJs(f.text),
      `ct=${f.contentType} len=${f.text.length}`
    );
  }

  const failed = results.filter((r) => r.status === "FAIL");
  const outPath = path.join(
    ROOT,
    "tests",
    LIVE_URL ? "hosting-startup-health-live-results.json" : "hosting-startup-health-results.json"
  );
  if (!NO_WRITE) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(
      outPath,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          mode: LIVE_URL ? "live" : "dist",
          target: LIVE_URL || DIST,
          pass: results.length - failed.length,
          fail: failed.length,
          results,
        },
        null,
        2
      )
    );
  }

  console.log(`\nSummary pass=${results.length - failed.length} fail=${failed.length}`);
  if (!NO_WRITE) console.log(`Wrote ${outPath}`);
  if (failed.length) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
