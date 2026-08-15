/**
 * Stage 6B: repeated, read-only startup graph profiling.
 * App instrumentation is injected only into the browser response.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOST = process.env.MAP_DIAGNOSTIC_HOST || "http://127.0.0.1:5000";
const OUT = path.join(ROOT, "tests", "startup-module-graph-profile-results.json");
const RUNS = 5;

function inject(source) {
  let output = source.replace(/\r\n/g, "\n");
  const replacements = [
    ["async function boot() {", 'async function boot() { window.__startupMarks.push({ name: "boot", at: performance.now() });'],
    [
      "function ensureMap() {",
      'function ensureMap() { window.__startupMarks.push({ name: "ensureMap", at: performance.now() });',
    ],
    [
      '  const instance = initMap("map");',
      '  window.__startupMarks.push({ name: "initMap:start", at: performance.now() }); const instance = initMap("map"); window.__startupMarks.push({ name: "mapCreated", at: performance.now() });',
    ],
  ];
  for (const [needle, replacement] of replacements) {
    if (!output.includes(needle)) throw new Error(`instrumentation anchor missing: ${needle}`);
    output = output.replace(needle, replacement);
  }
  return output;
}

function stats(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  return {
    medianMs: sorted[Math.floor(sorted.length / 2)],
    minMs: sorted[0],
    maxMs: sorted.at(-1),
    valuesMs: sorted,
  };
}

async function configurePage(context) {
  const page = await context.newPage();
  await page.addInitScript(() => {
    window.__startupMarks = [];
    new MutationObserver((records) => {
      if (window.__startupTile) return;
      for (const record of records) {
        if (record.target instanceof HTMLImageElement && record.target.classList.contains("leaflet-tile-loaded")) {
          window.__startupTile = true;
          window.__startupMarks.push({ name: "tileVisible", at: performance.now() });
          return;
        }
      }
    }).observe(document, { subtree: true, attributes: true, attributeFilter: ["class"] });
  });
  await page.route("**/js/app.js*", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, body: inject(await response.text()) });
  });
  return page;
}

async function capture(page, label) {
  await page.goto(HOST, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForFunction(() => Boolean(document.querySelector("#map.leaflet-container")), null, { timeout: 30_000 });
  await page.waitForSelector("#map img.leaflet-tile-loaded", { state: "visible", timeout: 30_000 });
  return page.evaluate((runLabel) => {
    const marks = window.__startupMarks;
    const at = (name) => marks.find((mark) => mark.name === name)?.at ?? null;
    const boot = at("boot");
    const resources = performance
      .getEntriesByType("resource")
      .filter((entry) => entry.initiatorType === "script")
      .map((entry) => ({
        url: entry.name,
        startMs: Math.round(entry.startTime),
        responseEndMs: Math.round(entry.responseEnd),
        durationMs: Math.round(entry.duration),
        transferSize: entry.transferSize,
      }));
    const preBootResources = resources.filter((entry) => boot != null && entry.responseEndMs <= boot);
    return {
      label: runLabel,
      marks: {
        moduleGraphCompleteMs: preBootResources.length
          ? Math.max(...preBootResources.map((entry) => entry.responseEndMs))
          : null,
        bootStartMs: boot,
        ensureMapMs: at("ensureMap"),
        mapCreatedMs: at("mapCreated"),
        firstTileVisibleMs: at("tileVisible"),
      },
      preBootResources,
    };
  }, label);
}

function summarize(runs) {
  const keys = ["moduleGraphCompleteMs", "bootStartMs", "ensureMapMs", "mapCreatedMs", "firstTileVisibleMs"];
  return Object.fromEntries(keys.map((key) => [key, stats(runs.map((run) => run.marks[key]))]));
}

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.STAGE1_CHROMIUM_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
});
try {
  const cold = [];
  for (let index = 0; index < RUNS; index += 1) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await configurePage(context);
    cold.push(await capture(page, `cold-${index + 1}`));
    await context.close();
  }

  const warmContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const warmPage = await configurePage(warmContext);
  await capture(warmPage, "warm-prime");
  const warm = [];
  for (let index = 0; index < RUNS; index += 1) {
    warm.push(await capture(warmPage, `warm-${index + 1}`));
  }
  await warmContext.close();

  const latestCold = cold.at(-1);
  const result = {
    generatedAt: new Date().toISOString(),
    host: HOST,
    cold,
    warm,
    coldSummary: summarize(cold),
    warmSummary: summarize(warm),
    preBootModuleInventory: latestCold.preBootResources,
  };
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ coldSummary: result.coldSummary, warmSummary: result.warmSummary }, null, 2));
} finally {
  await browser.close();
}
