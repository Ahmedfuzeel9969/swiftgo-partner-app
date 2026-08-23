/**
 * Read-only cold-start timing. Instruments only the browser-served app.js
 * response; source files and runtime production behavior are not changed.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOST = process.env.MAP_DIAGNOSTIC_HOST || "http://127.0.0.1:5000";
const OUT = path.join(ROOT, "tests", "map-cold-startup-diagnostic-results.json");

function instrumentApp(source) {
  source = source.replace(/\r\n/g, "\n");
  const marks = (name) => `window.__mapColdMarks.push({ name: "${name}", atMs: performance.now() });`;
  const replacements = [
    ["  });\n  initRoutingUi();", `  }); ${marks("boot:location:done")}\n  initRoutingUi();`],
    ["  });\n  initDriverTrack();", `  }); ${marks("boot:ride-flow:done")}\n  initDriverTrack();`],
    ["async function boot() {", `async function boot() { ${marks("boot:start")}`],
    ["  initI18n();", `  initI18n(); ${marks("boot:i18n:done")}`],
    ["  initSheet({ onBookRide: handleBookRide });", `  initSheet({ onBookRide: handleBookRide }); ${marks("boot:sheet:done")}`],
    ["  initFareCalculation();", `  initFareCalculation(); ${marks("boot:fare:done")}`],
    ["  initDriverTrack();", `  initDriverTrack(); ${marks("boot:driver-track:done")}`],
    ["  initRoutingUi();", `  initRoutingUi(); ${marks("boot:routing:done")}`],
    ["  initStepUi();", `  initStepUi(); ${marks("boot:step-ui:done")}`],
    ["  initDashboard({", `  ${marks("boot:dashboard:done")} initDashboard({`],
    ["  await initAuth();", `  ${marks("boot:auth:start")} await initAuth(); ${marks("boot:auth:done")}`],
    ["  bindUserData();", `  bindUserData(); ${marks("boot:user-data:bound")}`],
    ["  bindEvents();", `  bindEvents(); ${marks("boot:events:bound")}`],
    ["  scheduleNonCriticalStartup();", `  scheduleNonCriticalStartup(); ${marks("boot:done")}`],
    [
      "function ensureMap() {",
      `function ensureMap() {
  window.__mapColdMarks.push({
    name: "map:ensure-called",
    atMs: performance.now(),
    homeHidden: document.getElementById("screen-home")?.hasAttribute("hidden") || false,
    homeActive: document.getElementById("screen-home")?.classList.contains("is-active") || false,
    stack: new Error().stack,
  });`,
    ],
    [
      '  const instance = initMap("map");',
      `  ${marks("map:init-start")} const instance = initMap("map"); ${marks("map:init-return")}`,
    ],
  ];
  let output = source;
  for (const [needle, replacement] of replacements) {
    if (!output.includes(needle)) throw new Error(`app.js instrumentation anchor missing: ${needle}`);
    output = output.replace(needle, replacement);
  }
  return output;
}

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.STAGE1_CHROMIUM_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
});
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await page.addInitScript(() => {
    window.__mapColdMarks = [{ name: "navigation:start", atMs: performance.now() }];
    new MutationObserver((records) => {
      if (window.__mapColdTileMarked) return;
      for (const record of records) {
        const target = record.target;
        if (
          target instanceof HTMLImageElement &&
          target.classList.contains("leaflet-tile-loaded")
        ) {
          window.__mapColdTileMarked = true;
          window.__mapColdMarks.push({ name: "map:first-tile-visible", atMs: performance.now() });
          return;
        }
      }
    }).observe(document, { subtree: true, attributes: true, attributeFilter: ["class"] });
  });
  await page.route("**/js/app.js*", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      body: instrumentApp(await response.text()),
      headers: { ...response.headers(), "cache-control": "no-store" },
    });
  });
  await page.goto(HOST, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForFunction(() => document.querySelector("#map.leaflet-container"), null, { timeout: 30_000 });
  await page.waitForSelector("#map img.leaflet-tile-loaded", { state: "visible", timeout: 30_000 });
  const result = await page.evaluate(() => {
    const marks = window.__mapColdMarks;
    const bootStart = marks.find((mark) => mark.name === "boot:start")?.atMs ?? null;
    const resources = performance.getEntriesByType("resource").map((entry) => ({
      name: entry.name,
      initiatorType: entry.initiatorType,
      startTimeMs: Math.round(entry.startTime),
      responseEndMs: Math.round(entry.responseEnd),
      durationMs: Math.round(entry.duration),
    }));
    const jsBeforeBoot = resources.filter(
      (entry) => entry.initiatorType === "script" && bootStart != null && entry.responseEndMs <= bootStart
    );
    return {
      marks,
      moduleGraphLoadedAtMs: jsBeforeBoot.length ? Math.max(...jsBeforeBoot.map((entry) => entry.responseEndMs)) : null,
      appModule: resources.find((entry) => /\/js\/app\.js/.test(entry.name)) || null,
      firstTile: resources.find((entry) => /tile\.openstreetmap\.org/.test(entry.name)) || null,
      jsBeforeBoot,
    };
  });
  fs.writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), host: HOST, ...result }, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
