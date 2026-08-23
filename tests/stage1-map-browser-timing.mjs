/**
 * Stage 1 measurement only: browser map and geolocation baseline.
 * Run with Firebase Hosting emulator:
 * firebase emulators:exec --only hosting --project demo-swiftgo-phase1
 *   "node tests/stage1-map-browser-timing.mjs"
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOST = process.env.STAGE1_MAP_HOST || "http://127.0.0.1:5000";
const OUT = path.join(ROOT, "tests", "stage1-map-browser-timing-results.json");

async function main() {
  const browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.STAGE1_CHROMIUM_PATH ||
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  });
  const context = await browser.newContext({
    geolocation: { latitude: 24.8607, longitude: 67.0011, accuracy: 12 },
    permissions: ["geolocation"],
    viewport: { width: 390, height: 844 },
  });
  const page = await context.newPage();
  await page.addInitScript(() => {
    const original = navigator.geolocation.getCurrentPosition.bind(navigator.geolocation);
    window.__stage1GpsResultMs = null;
    navigator.geolocation.getCurrentPosition = (ok, fail, options) =>
      original(
        (position) => {
          window.__stage1GpsResultMs = performance.now();
          ok(position);
        },
        (error) => {
          window.__stage1GpsResultMs = performance.now();
          fail(error);
        },
        options
      );
  });

  const requestedAt = performance.now();
  await page.goto(`${HOST}/?emulators=1`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.locator("#map .leaflet-container").waitFor({ state: "visible", timeout: 30_000 });
  const shellVisibleAt = performance.now();
  await page.locator("#map img.leaflet-tile-loaded").first().waitFor({ state: "visible", timeout: 30_000 });
  const firstTileAt = performance.now();
  await page.waitForFunction(() => window.__stage1GpsResultMs !== null, null, { timeout: 15_000 });
  const pageMarks = await page.evaluate(() => ({
    gpsResultMs: window.__stage1GpsResultMs,
    navigationStartMs: performance.timeOrigin,
  }));
  const navigationEntry = await page.evaluate(() => performance.getEntriesByType("navigation")[0]?.startTime || 0);
  const browserNow = await page.evaluate(() => performance.now());

  const result = {
    generatedAt: new Date().toISOString(),
    host: HOST,
    requestedToMapShellVisibleMs: Math.round(shellVisibleAt - requestedAt),
    requestedToFirstTileVisibleMs: Math.round(firstTileAt - requestedAt),
    pageGpsResultAtMs: Math.round(pageMarks.gpsResultMs),
    pageNowAtCollectionMs: Math.round(browserNow),
    navigationStartOffsetMs: Math.round(navigationEntry),
    environment: "Playwright Chromium with an emulated granted geolocation result",
  };
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
