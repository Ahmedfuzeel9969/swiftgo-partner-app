/**
 * Canonical diagnostics boundary — facade API parity, lazy report loader, packaging.
 * Run: node tests/diagnostics-canonical-boundary.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import {
  classifyFirebaseWriteReason,
  explainFirebaseWriteSkipped,
  classifyFirebaseReceive,
  recordPhase1RideComplete,
  CFG_MIN_LOCATION_MOVE_M,
  CFG_RESPONSIVE_INTERVAL_MS,
} from "../shared/js/phase1-billing-diagnostics.mjs";
import {
  explainWriteIntervalTiming,
  classifyDuplicateReceiveReason,
  recordP2pFallbackDetail,
  writeReadLinkKey,
  PHASE2_WRITE_TOLERANCE_MS,
} from "../shared/js/phase2-runtime-verification.mjs";
import { proveFirebaseReadReason } from "../shared/js/phase3-billing-proof.mjs";
import {
  installFieldDiagnostics,
  ensureFieldDiagnosticReports,
  getFieldDiagnostics,
} from "../shared/js/field-diagnostics.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "tests", "diagnostics-canonical-boundary-results.json");
const results = [];

function check(name, ok, detail = "") {
  results.push({ name, status: ok ? "PASS" : "FAIL", detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

function eq(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ---------- Facade parity (locked behaviors) ----------
{
  const forced = classifyFirebaseWriteReason({ force: true });
  check("p1.write.force", forced.code === "forced_write", forced.code);

  const moved = classifyFirebaseWriteReason({
    movedEnough: true,
    ageMs: 5000,
    intervalMs: 4000,
  });
  check("p1.write.both", moved.code === "both_interval_and_movement", moved.code);

  const skipped = explainFirebaseWriteSkipped({
    reason: "interval",
    nowMs: 10_000,
    lastWriteMs: 9_000,
    intervalMs: 4_000,
    distanceMovedM: 1,
    minimumDistanceM: CFG_MIN_LOCATION_MOVE_M,
  });
  check(
    "p1.skip.interval",
    skipped.reasonPlain.includes("Minimum interval") && Number.isFinite(skipped.remainingWaitSec),
    skipped.reasonPlain
  );

  const first = classifyFirebaseReceive(null, { lat: 1, lng: 2, observedAt: 1, sequence: 1 });
  check("p1.recv.first", first.kind === "new_location", first.kind);

  const dup = classifyFirebaseReceive(
    { lat: 1, lng: 2, observedAt: 5, sequence: 9 },
    { lat: 1, lng: 2, observedAt: 5, sequence: 9 }
  );
  check("p1.recv.dup_document", dup.kind === "duplicate_document", dup.kind);

  const timing = explainWriteIntervalTiming({
    actualIntervalMs: CFG_RESPONSIVE_INTERVAL_MS,
    writeReasonCode: "minimum_interval_reached",
  });
  check("p2.timing.about_4s", timing.timingClass === "about_4s" && timing.pass === true, timing.timingClass);

  const early = explainWriteIntervalTiming({
    actualIntervalMs: 500,
    writeReasonCode: "forced_write",
  });
  check("p2.timing.before_force", early.timingClass === "before_4s" && early.pass === true, early.explanation);

  const dupReason = classifyDuplicateReceiveReason({
    classification: "duplicate_document",
    intervalSincePreviousReceiveMs: 100,
    sameSequence: true,
    sameGpsTimestamp: true,
    sameCoordinates: true,
  });
  check("p2.dup.listener_replay", dupReason.code === "listener_replay", dupReason.code);

  check("p2.link.seq", writeReadLinkKey(12, 0) === "seq:12");
  check("p2.link.gps", writeReadLinkKey(null, 99) === "gps:99");
  check("p2.tolerance", PHASE2_WRITE_TOLERANCE_MS === 500);

  const proofNew = proveFirebaseReadReason({ classification: "new_location" });
  check("p3.proof.new", proofNew.code === "new_document_data", proofNew.code);

  const proofDup = proveFirebaseReadReason({
    classification: "duplicate_document",
    intervalSincePreviousReceiveMs: 100,
    sameSequence: true,
    sameGpsTimestamp: true,
    sameCoordinates: true,
  });
  check("p3.proof.listener_replay", proofDup.code === "listener_replay", proofDup.code);
}

// ---------- Lightweight ride-complete marker without reports ----------
{
  const events = [];
  const diag = {
    setMeta(m) {
      this.meta = { ...(this.meta || {}), ...m };
    },
    record(type, data) {
      events.push({ type, data });
    },
  };
  recordPhase1RideComplete(diag, { rideId: "ride-boundary-1" });
  const metaOk = diag.meta?.rideStatus === "completed" && diag.meta?.rideId === "ride-boundary-1";
  const auto = events.find((e) => e.type === "billing_summary_auto");
  check(
    "p1.ride_complete.marker_without_reports",
    metaOk &&
      events.some((e) => e.type === "ride_meta") &&
      auto &&
      String(auto.data.plainText || "").includes("deferred"),
    auto?.data?.plainText?.slice(0, 80)
  );

  const events2 = [];
  const diag2 = {
    setMeta() {},
    record(type, data) {
      events2.push({ type, data });
    },
    buildBillingAnalysisReport() {
      return "FULL_BILLING_REPORT";
    },
  };
  recordPhase1RideComplete(diag2, { rideId: "x" });
  const auto2 = events2.find((e) => e.type === "billing_summary_auto");
  check(
    "p1.ride_complete.uses_attached_builder",
    auto2?.data?.plainText === "FULL_BILLING_REPORT",
    auto2?.data?.plainText
  );
}

// ---------- field-diagnostics: no static phase attach; lazy once ----------
{
  const a = installFieldDiagnostics({ role: "customer" });
  const b = installFieldDiagnostics({ role: "customer" });
  check("field.singleton", a === b && getFieldDiagnostics() === a);

  check(
    "field.no_reports_before_ensure",
    !a.__phase1Attached && !a.__phase2Attached && !a.__phase3Attached && typeof a.copyPhase1Reports !== "function"
  );

  const ready1 = await ensureFieldDiagnosticReports({ role: "customer" });
  const ready2 = await ensureFieldDiagnosticReports({ role: "customer" });
  check("field.ensure_same_instance", ready1 === a && ready2 === a);
  check(
    "field.ensure_attaches_once",
    a.__phase1Attached === true &&
      a.__phase2Attached === true &&
      a.__phase3Attached === true &&
      typeof a.copyPhase1Reports === "function" &&
      typeof a.buildPhase2VerificationReport === "function" &&
      typeof a.buildPhase3BillingProofReport === "function"
  );

  // Re-attach must stay idempotent (flags already set)
  const { attachPhase1Reports } = await import("../shared/js/phase1-billing-reports.mjs");
  const before = a.buildRuntimeConfigReport;
  attachPhase1Reports(a);
  check("field.reattach_idempotent", a.buildRuntimeConfigReport === before);

  a.record("firebase_write_detail", {
    writeReasonCode: "forced_write",
    intervalSincePreviousWriteMs: 1000,
  });
  const p1text = a.buildRuntimeConfigReport();
  const p2text = a.buildPhase2VerificationReport();
  const p3text = a.buildPhase3BillingProofReport();
  check("reports.phase1_text", String(p1text).includes("Phase 1") && String(p1text).includes("Runtime Configuration"));
  check("reports.phase2_text", String(p2text).includes("Phase 2") || String(p2text).includes("verification") || p2text.length > 50, `len=${p2text.length}`);
  check("reports.phase3_text", String(p3text).includes("Phase 3") || String(p3text).includes("billing") || p3text.length > 50, `len=${p3text.length}`);

  // recordP2pFallbackDetail remains sync on facade
  recordP2pFallbackDetail(a, {
    p2pStoppedAt: Date.now() - 12_000,
    firebaseFallbackStartedAt: Date.now(),
    triggerPath: "test",
  });
  check(
    "p2.fallback_detail_event",
    a.getEvents().some((e) => e.type === "p2p_fallback_detail")
  );
}

// ---------- Facades must not statically import report modules ----------
{
  for (const name of [
    "phase1-billing-diagnostics.mjs",
    "phase2-runtime-verification.mjs",
    "phase3-billing-proof.mjs",
    "field-diagnostics.mjs",
  ]) {
    const src = fs.readFileSync(path.join(ROOT, "shared", "js", name), "utf8");
    const bad =
      /from\s+["']\.\/phase1-billing-reports\.mjs["']/.test(src) ||
      /from\s+["']\.\/phase2-runtime-reports\.mjs["']/.test(src) ||
      /from\s+["']\.\/phase3-billing-reports\.mjs["']/.test(src) ||
      (name === "field-diagnostics.mjs" &&
        /import\s+\{\s*attachPhase[123]Reports/.test(src));
    check(`no_static_report_import.${name}`, !bad);
  }

  const fieldSrc = fs.readFileSync(path.join(ROOT, "shared", "js", "field-diagnostics.mjs"), "utf8");
  check(
    "field.dynamic_import_reports",
    fieldSrc.includes('import("./phase1-billing-reports.mjs")') &&
      fieldSrc.includes("ensureFieldDiagnosticReports")
  );
}

// ---------- Hosting packaging ----------
{
  const build = spawnSync(process.execPath, [path.join(ROOT, "tools", "build-hosting.mjs")], {
    cwd: ROOT,
    encoding: "utf8",
  });
  check("hosting.build_exit", build.status === 0, (build.stderr || build.stdout || "").slice(-200));

  const bases = ["js", "customer/js", "partner/js", "shared/js"];
  const names = [
    "phase1-billing-diagnostics.mjs",
    "phase1-billing-reports.mjs",
    "phase2-runtime-verification.mjs",
    "phase2-runtime-reports.mjs",
    "phase3-billing-proof.mjs",
    "phase3-billing-reports.mjs",
    "field-diagnostics.mjs",
    "diagnostics-screen-core.mjs",
  ];
  for (const base of bases) {
    for (const name of names) {
      const abs = path.join(ROOT, "hosting-dist", ...base.split("/"), name);
      check(`hosting.present.${base}/${name}`, fs.existsSync(abs));
    }
  }

  const facade = fs.readFileSync(
    path.join(ROOT, "hosting-dist", "js", "phase1-billing-diagnostics.mjs"),
    "utf8"
  );
  check(
    "hosting.phase1_facade_rewritten",
    facade.includes("./location-checkpoint-policy.mjs") &&
      !facade.includes("../../driver-app/js/location-checkpoint-policy.mjs"),
    "checkpoint rewrite"
  );
  check(
    "hosting.phase1_facade_no_reports_import",
    !facade.includes("phase1-billing-reports.mjs")
  );

  const reports = fs.readFileSync(
    path.join(ROOT, "hosting-dist", "js", "phase1-billing-reports.mjs"),
    "utf8"
  );
  check(
    "hosting.phase1_reports_import_facade",
    reports.includes('./phase1-billing-diagnostics.mjs') && reports.includes("attachPhase1Reports")
  );

  const fieldHost = fs.readFileSync(path.join(ROOT, "hosting-dist", "js", "field-diagnostics.mjs"), "utf8");
  check(
    "hosting.field_lazy_loader",
    fieldHost.includes("ensureFieldDiagnosticReports") &&
      fieldHost.includes('import("./phase1-billing-reports.mjs")') &&
      !/import\s+\{\s*attachPhase1Reports/.test(fieldHost)
  );

  const screenHost = fs.readFileSync(
    path.join(ROOT, "hosting-dist", "js", "diagnostics-screen-core.mjs"),
    "utf8"
  );
  check(
    "hosting.screen_awaits_reports",
    screenHost.includes("ensureFieldDiagnosticReports") &&
      !screenHost.includes('from "./phase1-billing-diagnostics.mjs"')
  );
}

const failed = results.filter((r) => r.status === "FAIL");
fs.writeFileSync(
  OUT,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      passed: results.length - failed.length,
      failed: failed.length,
      results,
    },
    null,
    2
  )
);
console.log(`\n${results.length - failed.length}/${results.length} passed → ${OUT}`);
process.exit(failed.length ? 1 : 0);
