/**
 * Shared runner for isolated rideBreadcrumbTelemetry rules tests.
 * Prevents stale results JSON from being accepted as a fresh PASS.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync as defaultSpawnSync } from "node:child_process";

export const BREADCRUMB_TELEMETRY_RULES_RESULTS = "breadcrumb-telemetry-rules-results.json";
export const EXPECTED_ISOLATED_RULES = Object.freeze([
  "static-telemetry-deny-all-architecture",
  "rules-client-read-denied",
  "rules-client-write-denied",
]);

/**
 * @param {object} parsed
 * @param {{ startedAtMs: number, maxSkewMs?: number }} opts
 */
export function validateIsolatedRulesResults(parsed, opts) {
  const startedAtMs = Number(opts?.startedAtMs) || 0;
  const maxSkewMs = opts?.maxSkewMs ?? 5_000;
  if (!parsed || typeof parsed !== "object") {
    return { ok: false, reason: "missing_or_invalid_json" };
  }
  if (parsed.suite !== "breadcrumb-telemetry-rules") {
    return { ok: false, reason: `unexpected_suite:${parsed.suite}` };
  }
  if (parsed.pass !== 3 || parsed.fail !== 0 || parsed.blocked !== 0) {
    return {
      ok: false,
      reason: `counts_pass=${parsed.pass}_fail=${parsed.fail}_blocked=${parsed.blocked}`,
    };
  }
  const generatedAtMs = Date.parse(String(parsed.generatedAt || ""));
  if (!Number.isFinite(generatedAtMs)) {
    return { ok: false, reason: "invalid_generatedAt" };
  }
  if (generatedAtMs + maxSkewMs < startedAtMs) {
    return {
      ok: false,
      reason: `stale_generatedAt:${parsed.generatedAt}_started=${new Date(startedAtMs).toISOString()}`,
    };
  }
  const byName = Object.fromEntries((parsed.results || []).map((r) => [r.name, r]));
  for (const name of EXPECTED_ISOLATED_RULES) {
    const r = byName[name];
    if (!r) return { ok: false, reason: `missing_result:${name}` };
    if (r.status !== "PASS") {
      return { ok: false, reason: `${name}_status_${r.status}` };
    }
  }
  if ((parsed.results || []).length !== EXPECTED_ISOLATED_RULES.length) {
    return { ok: false, reason: `unexpected_result_count:${(parsed.results || []).length}` };
  }
  return { ok: true, byName, generatedAtMs };
}

/**
 * Delete previous results, spawn isolated rules child, validate fresh output.
 *
 * @param {{
 *   root: string,
 *   spawnSyncFn?: typeof spawnSync,
 *   childArgs?: string[],
 *   env?: NodeJS.ProcessEnv,
 *   resultsFileName?: string,
 *   echoOutput?: boolean,
 * }} opts
 */
export function runIsolatedBreadcrumbTelemetryRules(opts) {
  const root = opts.root;
  const spawnSyncFn = opts.spawnSyncFn || defaultSpawnSync;
  const resultsPath = path.join(
    root,
    "tests",
    opts.resultsFileName || BREADCRUMB_TELEMETRY_RULES_RESULTS
  );
  const scriptPath = path.join(root, "tests", "breadcrumb-telemetry-rules.mjs");
  const childArgs = opts.childArgs || [scriptPath];

  try {
    if (fs.existsSync(resultsPath)) fs.unlinkSync(resultsPath);
  } catch (e) {
    return {
      ok: false,
      status: "FAIL",
      reason: `could_not_delete_stale_results:${String(e.message || e).slice(0, 80)}`,
      resultsPath,
      child: null,
      parsed: null,
    };
  }

  const startedAtMs = Date.now();
  const child = spawnSyncFn(process.execPath, childArgs, {
    cwd: root,
    env: { ...(opts.env || process.env) },
    encoding: "utf8",
  });

  if (opts.echoOutput !== false) {
    if (child?.stdout) process.stdout.write(child.stdout);
    if (child?.stderr) process.stderr.write(child.stderr);
  }

  if (child?.error) {
    return {
      ok: false,
      status: "BLOCKED",
      reason: `child_error:${String(child.error.message || child.error).slice(0, 120)}`,
      resultsPath,
      child,
      parsed: null,
      startedAtMs,
    };
  }
  if (child?.status !== 0) {
    return {
      ok: false,
      status: "FAIL",
      reason: `child_status_${child?.status}`,
      resultsPath,
      child,
      parsed: null,
      startedAtMs,
    };
  }
  if (!fs.existsSync(resultsPath)) {
    return {
      ok: false,
      status: "FAIL",
      reason: "results_file_missing_after_child",
      resultsPath,
      child,
      parsed: null,
      startedAtMs,
    };
  }

  let parsed = null;
  try {
    parsed = JSON.parse(fs.readFileSync(resultsPath, "utf8"));
  } catch (e) {
    return {
      ok: false,
      status: "FAIL",
      reason: `results_parse_error:${String(e.message || e).slice(0, 80)}`,
      resultsPath,
      child,
      parsed: null,
      startedAtMs,
    };
  }

  const validated = validateIsolatedRulesResults(parsed, { startedAtMs });
  if (!validated.ok) {
    const stale = String(validated.reason || "").startsWith("stale_");
    return {
      ok: false,
      status: stale ? "FAIL" : "FAIL",
      reason: validated.reason,
      resultsPath,
      child,
      parsed,
      startedAtMs,
    };
  }

  return {
    ok: true,
    status: "PASS",
    reason: "fresh_isolated_rules_ok",
    resultsPath,
    child,
    parsed,
    startedAtMs,
    byName: validated.byName,
  };
}
