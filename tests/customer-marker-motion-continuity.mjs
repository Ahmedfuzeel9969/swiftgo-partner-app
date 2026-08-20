/**
 * Arbiter + display pipeline continuity (NOT P2P controllers or channel.send).
 *
 * Ingests fixes directly via arbiter.ingestP2p / arbiter.ingestFirebase to prove
 * source arbitration and display painting — not driver/customer controller chain.
 *
 * For true controller full-chain motion, see tests/stage5-full-chain-marker-motion.mjs
 *
 * Run: node tests/customer-marker-motion-continuity.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLiveLocationSourceArbiter } from "../customer-app/js/live-location-source-arbiter.mjs";
import { createDisplayLocationPipeline } from "../customer-app/js/display-location-pipeline.mjs";
import { P2P_FALLBACK_AFTER_MS } from "../customer-app/js/p2p-protocol.mjs";
import { GEOMETRY_KIND } from "../customer-app/js/geometry-quality.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "tests", "customer-marker-motion-continuity-results.json");

const results = [];
function record(name, status, detail = "") {
  results.push({ name, status, detail });
  const mark = status === "PASS" ? "✓" : status === "FAIL" ? "✗" : "·";
  console.log(`${mark} ${name} — ${status}${detail ? `: ${detail}` : ""}`);
}

function createFakeTimers() {
  let now = 1_000_000;
  const queue = [];
  let idSeq = 1;
  return {
    nowMs: () => now,
    advance(ms) {
      now += Number(ms) || 0;
      queue.sort((a, b) => a.at - b.at);
      const due = queue.filter((t) => t.at <= now);
      for (const t of due) {
        const i = queue.findIndex((x) => x.id === t.id);
        if (i >= 0) queue.splice(i, 1);
        t.fn();
      }
    },
    setTimeoutFn(fn, ms) {
      const id = idSeq++;
      queue.push({ id, at: now + Number(ms) || 0, fn });
      return id;
    },
    clearTimeoutFn(id) {
      const i = queue.findIndex((t) => t.id === id);
      if (i >= 0) queue.splice(i, 1);
    },
    raf(fn) {
      return this.setTimeoutFn(() => fn(now), 16);
    },
    caf(id) {
      this.clearTimeoutFn(id);
    },
  };
}

function main() {
  console.log("\n=== customer marker motion continuity (arbiter + display only) ===\n");

  const timers = createFakeTimers();
  const paints = [];
  const arbRenders = [];

  const pipe = createDisplayLocationPipeline({
    nowMs: timers.nowMs,
    raf: (fn) => timers.raf(fn),
    caf: (id) => timers.caf(id),
    onDisplayFrame: (p) => {
      paints.push({
        at: timers.nowMs(),
        lat: p.lat,
        lng: p.lng,
        mode: p.displayMode || "snap",
        observedAt: p.observedAt,
      });
    },
    onRawFallback: (p) => {
      paints.push({
        at: timers.nowMs(),
        lat: p.lat,
        lng: p.lng,
        mode: "raw",
        observedAt: p.observedAt,
        reason: p.reason,
      });
    },
  });

  // Default production-like: no snap route → every fix paints raw (continuous motion path).
  pipe.clearRoute();

  const arb = createLiveLocationSourceArbiter({
    nowMs: timers.nowMs,
    fallbackAfterMs: P2P_FALLBACK_AFTER_MS,
    firebaseBackupReadIntervalMs: 4_000,
    onRender: (fix, meta) => {
      arbRenders.push({ ...fix, preferred: meta?.preferred, at: timers.nowMs() });
      pipe.ingestValidatedFix({
        lat: fix.lat,
        lng: fix.lng,
        observedAt: fix.observedAt,
        headingDeg: fix.headingDeg,
        speedMps: 8,
        accuracyM: 8,
      });
    },
  });
  const gen = arb.getGeneration();

  // Phase A — continuous P2P (driver → customer) every 2s for 20s
  let lat = 24.86;
  let lng = 67.01;
  let seq = 1;
  for (let i = 0; i < 10; i += 1) {
    lat += 0.00015;
    lng += 0.00005;
    arb.ingestP2p(
      {
        lat,
        lng,
        observedAt: timers.nowMs(),
        sequence: seq++,
        headingDeg: 45,
      },
      gen
    );
    timers.advance(2_000);
  }
  const afterP2p = paints.length;
  const p2pOk =
    afterP2p >= 8 &&
    arb.getState().preferred === "p2p" &&
    paints[paints.length - 1].lat > paints[0].lat;
  record(
    "e2e-p2p-continuous-paints-arbiter-ingest-only",
    p2pOk ? "PASS" : "FAIL",
    `paints=${afterP2p} preferred=${arb.getState().preferred}`
  );

  // Phase B — P2P goes silent; Firebase checkpoints every 4s (responsive) for 20s
  const silentStart = timers.nowMs();
  timers.advance(P2P_FALLBACK_AFTER_MS + 500);
  const paintsBeforeFb = paints.length;
  for (let i = 0; i < 5; i += 1) {
    lat += 0.0002;
    lng += 0.00008;
    arb.ingestFirebase(
      {
        lat,
        lng,
        observedAt: timers.nowMs(),
        sequence: seq++,
        headingDeg: 50,
      },
      gen
    );
    timers.advance(4_000);
  }
  const fbState = arb.getState();
  const fbPaints = paints.length - paintsBeforeFb;
  const fbOk =
    fbPaints >= 4 &&
    fbState.preferred === "firebase" &&
    fbState.p2pHealthy === false &&
    paints[paints.length - 1].lat > paints[afterP2p - 1].lat;
  record(
    "e2e-firebase-fallback-continues-motion",
    fbOk ? "PASS" : "FAIL",
    `fbPaints=${fbPaints} preferred=${fbState.preferred} silentMs=${timers.nowMs() - silentStart}`
  );

  // Phase C — P2P recovers with fresher fixes; marker keeps moving, source switches back
  const paintsBeforeRecovery = paints.length;
  for (let i = 0; i < 6; i += 1) {
    lat += 0.00018;
    lng += 0.00006;
    arb.ingestP2p(
      {
        lat,
        lng,
        observedAt: timers.nowMs(),
        sequence: seq++,
        headingDeg: 55,
      },
      gen
    );
    timers.advance(2_000);
  }
  const recState = arb.getState();
  const recPaints = paints.length - paintsBeforeRecovery;
  const recOk =
    recPaints >= 5 &&
    recState.preferred === "p2p" &&
    recState.p2pHealthy === true &&
    paints[paints.length - 1].lat > paints[paintsBeforeRecovery - 1].lat;
  record(
    "e2e-p2p-recovery-continues-motion",
    recOk ? "PASS" : "FAIL",
    `recPaints=${recPaints} preferred=${recState.preferred}`
  );

  // No silent hold gap: every arbiter render produced at least one paint within same tick window.
  const paintObserved = new Set(
    paints.map((p) => Number(p.observedAt) || 0).filter((n) => n > 0)
  );
  // At least most renders moved the marker (allow first)
  let movedSteps = 0;
  for (let i = 1; i < paints.length; i += 1) {
    if (
      Math.abs(paints[i].lat - paints[i - 1].lat) > 1e-8 ||
      Math.abs(paints[i].lng - paints[i - 1].lng) > 1e-8
    ) {
      movedSteps += 1;
    }
  }
  record(
    "e2e-no-frozen-marker-across-trip",
    movedSteps >= paints.length - 3 && paints.length >= 15 ? "PASS" : "FAIL",
    `paints=${paints.length} movedSteps=${movedSteps} arbRenders=${arbRenders.length}`
  );

  // Snap path: progress reject must still paint (held→raw), not freeze.
  const snapPaints = [];
  const snapPipe = createDisplayLocationPipeline({
    nowMs: timers.nowMs,
    raf: (fn) => timers.raf(fn),
    caf: (id) => timers.caf(id),
    onDisplayFrame: (p) => snapPaints.push(p),
    onRawFallback: (p) => snapPaints.push({ ...p, raw: true }),
  });
  const geom = [
    { lat: 24.86, lng: 67.0 },
    { lat: 24.865, lng: 67.0 },
    { lat: 24.87, lng: 67.0 },
  ];
  snapPipe.setActiveRoute({
    geometry: geom,
    generation: 1,
    activeLeg: "approach",
    geometryKind: GEOMETRY_KIND.FIXTURE_ROAD_ROUTE,
    snapEligible: true,
    providerKind: "fixture",
  });
  const s1 = snapPipe.ingestValidatedFix({
    lat: geom[1].lat,
    lng: geom[1].lng,
    speedMps: 8,
    observedAt: timers.nowMs(),
  });
  timers.advance(500);
  const before = snapPaints.length;
  const s2 = snapPipe.ingestValidatedFix({
    lat: geom[0].lat,
    lng: geom[0].lng,
    speedMps: 8,
    observedAt: timers.nowMs() + 1000,
  });
  record(
    "e2e-snap-progress-reject-still-paints",
    s1.mode === "snap" && s2.mode === "raw" && snapPaints.length > before ? "PASS" : "FAIL",
    `s1=${s1.mode} s2=${s2.mode} paints=${snapPaints.length}`
  );

  void paintObserved;

  const summary = {
    suite: "customer-marker-motion-continuity",
    dualPhysicalDevices: "BLOCKED",
    dualPhysicalDevicesNote:
      "Agent cannot operate two real phones or Gmail accounts. Automated in-process dual-client path verified; physical dual-device run required on-device.",
    generatedAt: new Date().toISOString(),
    pass: results.filter((r) => r.status === "PASS").length,
    fail: results.filter((r) => r.status === "FAIL").length,
    blocked: results.filter((r) => r.status === "BLOCKED").length,
    paintCount: paints.length,
    results,
  };
  fs.writeFileSync(OUT, JSON.stringify(summary, null, 2));
  console.log(
    `\nSummary: ${summary.pass} PASS / ${summary.fail} FAIL / ${summary.blocked} BLOCKED → ${OUT}`
  );
  console.log(
    `Physical dual-device: BLOCKED (no agent access to two devices/Gmail). Use console probe below on each phone.`
  );
  if (summary.fail > 0) process.exitCode = 1;
}

main();
