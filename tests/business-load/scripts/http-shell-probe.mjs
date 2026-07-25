/**
 * Safe Hosting HTML shell probe — does NOT touch Firestore/Auth.
 * Does NOT prove 100k capacity.
 *
 * Usage:
 *   node tests/business-load/scripts/http-shell-probe.mjs
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { assertSafeProject } from "./guardrails.mjs";

const BASE = process.env.LOAD_BASE || "https://swiftgo-ride-app.web.app";
// Hosting probe allowed against prod Hosting only — never Firestore.
assertSafeProject("swiftgo-ride-app", { allowHostingProbe: true });

const APPS = [
  { id: "customer", path: "/" },
  { id: "driver", path: "/partner/" },
  { id: "owner", path: "/owner/" },
  { id: "admin", path: "/admin/" },
];

const concurrency = Number(process.env.CONCURRENCY || 5);
const requests = Number(process.env.REQUESTS || 50);

async function once(url) {
  const t = performance.now();
  try {
    const res = await fetch(url, {
      headers: {
        "Cache-Control": "no-cache",
        "User-Agent": "SwiftGo-BusinessLoad-HttpShell/1.0",
      },
    });
    const buf = await res.arrayBuffer();
    return { ok: res.ok, status: res.status, ms: performance.now() - t, bytes: buf.byteLength };
  } catch (e) {
    return { ok: false, status: 0, ms: performance.now() - t, bytes: 0, error: e.name };
  }
}

async function pool(url, total, c) {
  const out = [];
  let n = 0;
  const t0 = performance.now();
  await Promise.all(
    Array.from({ length: c }, async () => {
      while (true) {
        const i = n++;
        if (i >= total) return;
        out.push(await once(url));
      }
    })
  );
  return { out, wall: performance.now() - t0 };
}

function pct(arr, p) {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
}

const report = {
  label: "MEASURED_http_shell_only",
  warning: "NOT a business capacity proof. JS boot/Auth/Firestore NOT TESTED.",
  startedAt: new Date().toISOString(),
  baseUrl: BASE,
  machine: {
    hostname: os.hostname(),
    cpus: os.cpus().length,
    model: os.cpus()[0]?.model,
    totalMemGB: +(os.totalmem() / 1e9).toFixed(2),
    node: process.version,
  },
  concurrency,
  requestsPerApp: requests,
  apps: [],
};

for (const app of APPS) {
  const url = new URL(app.path, BASE).href;
  const { out, wall } = await pool(url, requests, concurrency);
  const lat = out.map((x) => x.ms);
  const ok = out.filter((x) => x.ok).length;
  report.apps.push({
    app: app.id,
    url,
    ok,
    fail: requests - ok,
    rps: +(requests / (wall / 1000)).toFixed(1),
    latencyMs: {
      p50: +pct(lat, 50).toFixed(1),
      p95: +pct(lat, 95).toFixed(1),
      p99: +pct(lat, 99).toFixed(1),
      max: +pct(lat, 100).toFixed(1),
    },
    statuses: out.reduce((m, x) => ((m[x.status] = (m[x.status] || 0) + 1), m), {}),
  });
}

report.finishedAt = new Date().toISOString();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rawDir = path.resolve(__dirname, "../results/raw");
fs.mkdirSync(rawDir, { recursive: true });
const file = path.join(rawDir, `http-shell-${Date.now()}.json`);
fs.writeFileSync(file, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
console.error(`Wrote ${file}`);
