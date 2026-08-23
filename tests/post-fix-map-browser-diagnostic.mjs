/**
 * Read-only hosted-map availability diagnostic. Does not alter app behavior.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const host = process.env.MAP_DIAGNOSTIC_HOST || "https://swiftgo-ride-app.web.app";
const out = path.join(ROOT, "tests", "post-fix-map-browser-diagnostic-results.json");

async function capture(page, label) {
  const startedAt = Date.now();
  await page.goto(host, { waitUntil: "domcontentloaded", timeout: 30_000 });
  const leaflet = await page
    .waitForFunction(() => Boolean(window.L && document.querySelector("#map.leaflet-container")), null, {
      timeout: 35_000,
    })
    .then(() => ({ available: true, elapsedMs: Date.now() - startedAt }))
    .catch(() => ({ available: false, elapsedMs: Date.now() - startedAt }));
  const tile = await page
    .waitForSelector("#map img.leaflet-tile-loaded", { state: "visible", timeout: 10_000 })
    .then(() => ({ visible: true, elapsedMs: Date.now() - startedAt }))
    .catch(() => ({ visible: false, elapsedMs: Date.now() - startedAt }));
  const details = await page.evaluate(() => ({
    leafletGlobal: Boolean(window.L),
    mapContainer: Boolean(document.querySelector("#map.leaflet-container")),
    visibleTile: Boolean(document.querySelector("#map img.leaflet-tile-loaded")),
    gpsMarks: window.__mapGpsMarks || [],
    resources: performance
      .getEntriesByType("resource")
      .filter((entry) => /unpkg|openstreetmap|arcgisonline|nominatim|project-osrm/i.test(entry.name))
      .map((entry) => ({
        name: entry.name,
        durationMs: Math.round(entry.duration),
        transferSize: entry.transferSize,
      })),
  }));
  return { label, ...leaflet, tile, ...details };
}

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.STAGE1_CHROMIUM_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
});
try {
  const context = await browser.newContext({
    geolocation: { latitude: 24.8607, longitude: 67.0011, accuracy: 12 },
    permissions: ["geolocation"],
    viewport: { width: 390, height: 844 },
  });
  const failures = [];
  const errors = [];
  const page = await context.newPage();
  await page.addInitScript(() => {
    window.__mapGpsMarks = [];
    const original = navigator.geolocation.getCurrentPosition.bind(navigator.geolocation);
    navigator.geolocation.getCurrentPosition = (success, failure, options) => {
      window.__mapGpsMarks.push({ event: "requested", atMs: performance.now(), options });
      return original(
        (position) => {
          window.__mapGpsMarks.push({ event: "callback", atMs: performance.now(), accuracy: position.coords.accuracy });
          success(position);
        },
        (error) => {
          window.__mapGpsMarks.push({ event: "error", atMs: performance.now(), code: error.code });
          failure(error);
        },
        options
      );
    };
  });
  page.on("requestfailed", (request) => failures.push({ url: request.url(), error: request.failure()?.errorText || "" }));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  const cold = await capture(page, "cold");
  const warm = await capture(page, "warm");
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.clearBrowserCache");
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 150,
    downloadThroughput: 400 * 1024 / 8,
    uploadThroughput: 400 * 1024 / 8,
    connectionType: "cellular3g",
  });
  const throttled = await capture(page, "throttled-400kbps-150ms");
  const result = { generatedAt: new Date().toISOString(), host, cold, warm, throttled, failures, errors };
  fs.writeFileSync(out, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
