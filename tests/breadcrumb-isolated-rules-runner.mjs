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
 * The default 5-second tolerance permits small parent/child clock skew at both
 * ends of the child execution window.
 * @param {{ startedAtMs: number, childFinishedAtMs: number, maxSkewMs?: number }} opts
 */
export function validateIsolatedRulesResults(parsed, opts) {
  const startedAtMs = Number(opts?.startedAtMs) || 0;
  const childFinishedAtMs = Number(opts?.childFinishedAtMs) || 0;
  const maxSkewMs = opts?.maxSkewMs ?? 5_000;
  if (!parsed || typeof parsed !== "object") {
    return { ok: false, reason: "missing_or_invalid_json" };
  }
  if (parsed.suite !== "breadcrumb-telemetry-rules") {
    return { ok: false, reason: `unexpected_suite:${parsed.suite}` };
  }
  const countFields = ["total", "pass", "fail", "blocked"];
  for (const field of countFields) {
    if (!Number.isInteger(parsed[field]) || parsed[field] < 0) {
      return { ok: false, reason: `invalid_non_negative_integer:${field}` };
    }
  }
  if (!Array.isArray(parsed.results)) {
    return { ok: false, reason: "results_not_array" };
  }
  if (
    parsed.total !== parsed.results.length ||
    parsed.total !== parsed.pass + parsed.fail + parsed.blocked ||
    parsed.total !== EXPECTED_ISOLATED_RULES.length
  ) {
    return {
      ok: false,
      reason: `count_mismatch:total=${parsed.total}_results=${parsed.results.length}_sum=${
        parsed.pass + parsed.fail + parsed.blocked
      }_expected=${EXPECTED_ISOLATED_RULES.length}`,
    };
  }
  if (parsed.pass !== EXPECTED_ISOLATED_RULES.length || parsed.fail !== 0 || parsed.blocked !== 0) {
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
  if (!childFinishedAtMs || generatedAtMs > childFinishedAtMs + maxSkewMs) {
    return {
      ok: false,
      reason: `future_generatedAt:${parsed.generatedAt}_finished=${new Date(
        childFinishedAtMs
      ).toISOString()}`,
    };
  }
  const nameCounts = new Map();
  for (const result of parsed.results) {
    nameCounts.set(result?.name, (nameCounts.get(result?.name) || 0) + 1);
  }
  const byName = Object.fromEntries(parsed.results.map((r) => [r.name, r]));
  for (const name of EXPECTED_ISOLATED_RULES) {
    if (nameCounts.get(name) !== 1) {
      return { ok: false, reason: `result_name_count:${name}:${nameCounts.get(name) || 0}` };
    }
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
  const childFinishedAtMs = Date.now();

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

  const validated = validateIsolatedRulesResults(parsed, { startedAtMs, childFinishedAtMs });
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
