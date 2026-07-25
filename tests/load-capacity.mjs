/**
 * Real HTTP load capacity probe against live Firebase Hosting for all 4 apps.
 * Does NOT authenticate or write to Firestore (safe for production data).
 *
 * Usage: node tests/load-capacity.mjs
 */

const BASE = process.env.LOAD_BASE || "https://swiftgo-ride-app.web.app";

const APPS = [
  { id: "customer", name: "Customer (صارف)", path: "/" },
  { id: "driver", name: "Driver (ڈرائیور)", path: "/partner/" },
  { id: "owner", name: "Owner (مالک)", path: "/owner/" },
  { id: "admin", name: "Super Admin", path: "/admin/" },
];

/** concurrency ladders */
const LEVELS = [25, 50, 100, 200, 400];
const REQUESTS_PER_LEVEL = 400;
const WARMUP = 10;

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

async function fetchOnce(url, timeoutMs = 15000) {
  const start = performance.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
        "User-Agent": "SwiftGo-LoadCapacity/1.0",
      },
    });
    const buf = await res.arrayBuffer();
    const ms = performance.now() - start;
    return {
      ok: res.ok,
      status: res.status,
      ms,
      bytes: buf.byteLength,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      ms: performance.now() - start,
      bytes: 0,
      error: err?.name || String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function runPool(url, total, concurrency) {
  const results = [];
  let next = 0;

  async function worker() {
    while (true) {
      const i = next++;
      if (i >= total) return;
      results.push(await fetchOnce(url));
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, total) }, () => worker());
  const t0 = performance.now();
  await Promise.all(workers);
  const wallMs = performance.now() - t0;
  return { results, wallMs };
}

function summarize(label, concurrency, { results, wallMs }) {
  const lat = results.map((r) => r.ms).sort((a, b) => a - b);
  const ok = results.filter((r) => r.ok).length;
  const fail = results.length - ok;
  const statuses = {};
  const errors = {};
  for (const r of results) {
    statuses[r.status] = (statuses[r.status] || 0) + 1;
    if (r.error) errors[r.error] = (errors[r.error] || 0) + 1;
  }
  const bytes = results.reduce((s, r) => s + r.bytes, 0);
  return {
    label,
    concurrency,
    requests: results.length,
    ok,
    fail,
    errorRatePct: Number(((fail / results.length) * 100).toFixed(2)),
    rps: Number((results.length / (wallMs / 1000)).toFixed(1)),
    wallSec: Number((wallMs / 1000).toFixed(2)),
    latencyMs: {
      min: Number(lat[0]?.toFixed(1)),
      p50: Number(percentile(lat, 50)?.toFixed(1)),
      p95: Number(percentile(lat, 95)?.toFixed(1)),
      p99: Number(percentile(lat, 99)?.toFixed(1)),
      max: Number(lat[lat.length - 1]?.toFixed(1)),
    },
    avgBytes: Math.round(bytes / results.length),
    statuses,
    errors,
  };
}

async function probeApp(app) {
  const url = new URL(app.path, BASE).href;
  console.log(`\n=== ${app.name} → ${url}`);

  // warmup
  for (let i = 0; i < WARMUP; i++) await fetchOnce(url);

  const levels = [];
  for (const c of LEVELS) {
    process.stdout.write(`  concurrency=${c} ... `);
    const raw = await runPool(url, REQUESTS_PER_LEVEL, c);
    const row = summarize(app.id, c, raw);
    levels.push(row);
    console.log(
      `ok=${row.ok}/${row.requests} err=${row.errorRatePct}% rps=${row.rps} p50=${row.latencyMs.p50}ms p95=${row.latencyMs.p95}ms`
    );
    // brief pause between levels to avoid unfair burst stacking
    await new Promise((r) => setTimeout(r, 800));
  }

  // find highest concurrency with <1% errors and p95 < 3000ms
  const healthy = [...levels].reverse().find((l) => l.errorRatePct < 1 && l.latencyMs.p95 < 3000);
  const soft = [...levels].reverse().find((l) => l.errorRatePct < 5 && l.latencyMs.p95 < 8000);

  return {
    app: app.id,
    name: app.name,
    url,
    levels,
    hostingVerdict: {
      healthyConcurrentPageLoads: healthy?.concurrency ?? null,
      softLimitConcurrentPageLoads: soft?.concurrency ?? null,
      peakObservedRps: Math.max(...levels.map((l) => l.rps)),
    },
  };
}

async function main() {
  const startedAt = new Date().toISOString();
  console.log(`SwiftGo load capacity probe`);
  console.log(`Base: ${BASE}`);
  console.log(`Started: ${startedAt}`);
  console.log(`Levels: ${LEVELS.join(", ")} | requests/level: ${REQUESTS_PER_LEVEL}`);

  const apps = [];
  for (const app of APPS) {
    apps.push(await probeApp(app));
  }

  // Architecture-derived Firestore model (not live write stress — avoids corrupting prod / billing spike)
  const firestoreModel = {
    note: "Derived from app code + Firebase documented soft limits; not a live authenticated write storm against production.",
    firebaseSoftLimits: {
      sustainedWritesPerSec: 10000,
      sustainedReadsPerSec: 50000,
      maxConcurrentConnections: 1000000,
      maxSnapshotListenersPerClient: 100,
    },
    measuredCodePatterns: {
      driverGpsWriteIntervalMs: 8000,
      gpsWritesPerDriverPerMin: 7.5,
      searchingDriverFanout: "Every online driver listens to same searching_driver query (limit 1)",
      adminVehiclesListeners: 2,
      adminUnboundedCollections: ["rides (total count)", "rides status=completed (revenue)", "vehicles", "partners", "drivers"],
    },
    scenarios: [
      {
        name: "Comfortable ops (low risk)",
        concurrentCustomers: 200,
        onlineDrivers: 50,
        ownersOnline: 10,
        adminSessions: 1,
        estimatedGpsWritesPerSec: Number(((50 + 10) * (1000 / 8000)).toFixed(2)),
        estimatedSearchingFanoutListeners: 60,
        risk: "low",
        rationale: "GPS write rate ~7.5/s; search fan-out small; admin scans still light if history small.",
      },
      {
        name: "Practical ceiling today (architecture)",
        concurrentCustomers: 800,
        onlineDrivers: 200,
        ownersOnline: 30,
        adminSessions: 1,
        estimatedGpsWritesPerSec: Number(((200 + 30) * (1000 / 8000)).toFixed(2)),
        estimatedSearchingFanoutListeners: 230,
        risk: "medium-high",
        rationale:
          "GPS ~28.75 writes/s still within Firebase write soft limit, but each write fans out to admin's 2 full-vehicles listeners; searching_driver updates notify all 230 online drivers; public OSRM/Nominatim/OSM will throttle UX before Firestore hard-fails.",
      },
      {
        name: "Stress / likely degradation",
        concurrentCustomers: 2000,
        onlineDrivers: 500,
        ownersOnline: 50,
        adminSessions: 2,
        estimatedGpsWritesPerSec: Number(((500 + 50) * (1000 / 8000)).toFixed(2)),
        estimatedSearchingFanoutListeners: 550,
        risk: "high",
        rationale:
          "GPS ~68.75 writes/s + 550 search listeners + unbounded admin history listeners. Accept races + rule get(vehicle) amplify. External map APIs fail first; Firestore listener fan-out causes laggy offer screens.",
      },
    ],
    bottlenecksOrdered: [
      "Public OSRM / Nominatim / OSM tiles (shared free endpoints)",
      "Driver searching_driver query fan-out to all online drivers",
      "8s GPS vehicle writes × fleet size notifying admin double listeners",
      "Admin unbounded full-collection listeners (rides/completed/vehicles)",
      "Firebase Hosting static HTML (high capacity; measured in this probe)",
    ],
  };

  const report = {
    startedAt,
    finishedAt: new Date().toISOString(),
    baseUrl: BASE,
    methodology: {
      type: "HTTP GET load against Firebase Hosting SPA entry pages",
      authenticatedFirestoreWrites: false,
      reasonNoFirestoreWriteStorm:
        "Production write storms would create fake rides/users, risk billing spikes, and corrupt operational data. Hosting was load-tested live; backend capacity modeled from code + Firebase quotas.",
      levels: LEVELS,
      requestsPerLevel: REQUESTS_PER_LEVEL,
      healthyCriteria: "errorRate < 1% AND p95 < 3000ms",
      softCriteria: "errorRate < 5% AND p95 < 8000ms",
    },
    apps,
    firestoreModel,
  };

  const outPath = new URL("./load-capacity-results.json", import.meta.url);
  const fs = await import("node:fs/promises");
  await fs.writeFile(outPath, JSON.stringify(report, null, 2), "utf8");
  console.log(`\nWrote ${outPath.pathname}`);
  console.log(JSON.stringify({ hosting: apps.map((a) => ({ app: a.app, ...a.hostingVerdict })), firestoreScenarios: firestoreModel.scenarios.map((s) => ({ name: s.name, risk: s.risk })) }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
