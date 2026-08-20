/**
 * Hosting routing regression tests — static firebase.json analysis plus optional
 * live probes against the Firebase Hosting emulator or production URL.
 *
 * Usage:
 *   node tests/hosting-routing.mjs
 *   node tests/hosting-routing.mjs --live http://127.0.0.1:5000
 *   npm run test:hosting-routing
 *   npm run test:hosting-routing:emulator
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CUSTOMER_ROOT_PATHS,
  MAX_REDIRECT_CHAIN,
  PROTECTED_ROUTE_VARIANTS,
  ROUTING_PROBE_PATHS,
  analyzeHostingRouting,
  loadHostingConfig,
  normalizePath,
  simulateRedirectChain,
} from "../tools/hosting-routing-config.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const args = process.argv.slice(2);

function argValue(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
}

const LIVE_BASE = argValue("--live");
const RESULTS_PATH = path.join(ROOT, "tests", "hosting-routing-results.json");

const results = [];

function record(name, ok, detail = "") {
  results.push({ name, status: ok ? "PASS" : "FAIL", detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

function runStaticAnalysis(hosting) {
  record("hosting-config-loaded", Boolean(hosting), "firebase.json hosting section");

  const analysis = analyzeHostingRouting(hosting);
  record(
    "no-protected-self-redirects",
    analysis.selfRedirects.length === 0,
    analysis.selfRedirects.length
      ? JSON.stringify(analysis.selfRedirects[0])
      : "none detected"
  );
  record(
    "protected-surfaces-rewrite-only",
    analysis.protectedRedirects.length === 0,
    analysis.protectedRedirects.length
      ? JSON.stringify(analysis.protectedRedirects[0])
      : "no protected-surface redirects"
  );
  record(
    "redirect-chains-terminate",
    analysis.chainViolations.length === 0,
    analysis.chainViolations.length
      ? JSON.stringify(analysis.chainViolations[0])
      : `bounded at ${MAX_REDIRECT_CHAIN} hops`
  );
  record(
    "required-rewrites-present",
    analysis.missingRewrites.length === 0,
    analysis.missingRewrites.length
      ? JSON.stringify(analysis.missingRewrites)
      : "d504309 rewrite set intact"
  );

  for (const probePath of PROTECTED_ROUTE_VARIANTS) {
    const chain = simulateRedirectChain(probePath, hosting);
    record(
      `static-chain:${probePath}`,
      !chain.loop && chain.hops.every((h) => normalizePath(h.to) !== normalizePath(h.from)),
      chain.hops.length ? `${chain.hops.length} hop(s)` : "terminates without redirect"
    );
  }

  for (const probePath of CUSTOMER_ROOT_PATHS) {
    const chain = simulateRedirectChain(probePath, hosting);
    record(
      `static-customer:${probePath}`,
      !chain.loop,
      chain.hops.length ? `${chain.hops.length} hop(s)` : "no redirect loop"
    );
  }

  return analysis.ok;
}

async function probeLiveRoute(baseUrl, requestPath) {
  const url = new URL(requestPath, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  const hops = [];
  let currentUrl = url.toString();
  const seenPaths = new Set();

  for (let i = 0; i <= MAX_REDIRECT_CHAIN; i++) {
    const currentPath = new URL(currentUrl).pathname;
    if (seenPaths.has(currentPath)) {
      return { hops, ok: false, reason: "redirect loop", finalStatus: null, finalPath: currentPath };
    }
    seenPaths.add(currentPath);

    const res = await fetch(currentUrl, { redirect: "manual" });
    const status = res.status;
    const location = res.headers.get("location");

    if (status >= 300 && status < 400 && location) {
      const nextPath = new URL(location, currentUrl).pathname;
      hops.push({ from: currentPath, to: nextPath, status, location });
      if (nextPath === currentPath) {
        return { hops, ok: false, reason: "self-redirect", finalStatus: status, finalPath: currentPath };
      }
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }

    return {
      hops,
      ok: status >= 200 && status < 400,
      reason: status >= 200 && status < 400 ? "ok" : `unexpected status ${status}`,
      finalStatus: status,
      finalPath: currentPath,
    };
  }

  return { hops, ok: false, reason: "redirect chain exceeded bound", finalStatus: null, finalPath: null };
}

async function runLiveProbes(baseUrl) {
  console.log(`\n[hosting-routing] live probes against ${baseUrl}`);

  for (const probePath of ROUTING_PROBE_PATHS) {
    const probe = await probeLiveRoute(baseUrl, probePath);
    record(
      `live:${probePath}`,
      probe.ok,
      probe.hops.length
        ? `${probe.hops.length} redirect(s) → ${probe.finalStatus ?? probe.reason}`
        : `${probe.finalStatus ?? probe.reason}`
    );
    if (probe.reason === "self-redirect" || probe.reason === "redirect loop") {
      record(`live-no-self-redirect:${probePath}`, false, probe.reason);
    } else {
      record(`live-no-self-redirect:${probePath}`, true, "no self-redirect");
    }
  }

  const customer = await probeLiveRoute(baseUrl, "/");
  record("live-customer-root-available", customer.ok, `status=${customer.finalStatus}`);
}

async function main() {
  const hosting = loadHostingConfig(ROOT);

  // Regression: PR #9 post-deploy incident — trailing-slash redirects on protected paths.
  const incidentHosting = {
    redirects: [
      { source: "/partner", destination: "/partner/", type: 301 },
      { source: "/owner", destination: "/owner/", type: 301 },
      { source: "/admin", destination: "/admin/", type: 301 },
      { source: "/customer", destination: "/customer/", type: 301 },
      ...hosting.redirects,
    ],
    rewrites: hosting.rewrites,
  };
  const incidentAnalysis = analyzeHostingRouting(incidentHosting);
  record(
    "regression-incident-config-rejected",
    !incidentAnalysis.ok && incidentAnalysis.selfRedirects.length > 0,
    `${incidentAnalysis.selfRedirects.length} self-redirect(s), ${incidentAnalysis.protectedRedirects.length} protected redirect rule(s)`
  );

  const staticOk = runStaticAnalysis(hosting);

  if (LIVE_BASE) {
    await runLiveProbes(LIVE_BASE.replace(/\/$/, ""));
  } else {
    record("live-probes", true, "skipped (pass --live URL or npm run test:hosting-routing:emulator)");
  }

  const failed = results.filter((r) => r.status === "FAIL");
  fs.writeFileSync(
    RESULTS_PATH,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        liveBase: LIVE_BASE || null,
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

  if (failed.length || !staticOk) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
