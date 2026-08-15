/**
 * Stage 6A browser regression: History and E2E hooks load outside startup.
 */
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";

const HOST = process.env.MAP_DIAGNOSTIC_HOST || "http://127.0.0.1:5000";
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.STAGE1_CHROMIUM_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
});

try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  await page.goto(`${HOST}?emulators=1`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForFunction(() => Boolean(window.SwiftGo && document.querySelector("#map.leaflet-container")));

  const initialHistoryRequests = await page.evaluate(
    () => performance.getEntriesByType("resource").filter((entry) => /\/js\/history\.js$/.test(entry.name)).length
  );
  assert.equal(initialHistoryRequests, 0, "History must not load on the Home startup path");

  await page.evaluate(() => window.SwiftGo.navigate("history"));
  await page.waitForFunction(
    () => performance.getEntriesByType("resource").some((entry) => /\/js\/history\.js$/.test(entry.name))
  );
  const firstHistoryRequests = await page.evaluate(
    () => performance.getEntriesByType("resource").filter((entry) => /\/js\/history\.js$/.test(entry.name)).length
  );
  await page.evaluate(() => {
    window.SwiftGo.navigate("home");
    window.SwiftGo.navigate("history");
  });
  await page.waitForTimeout(100);
  const repeatedHistoryRequests = await page.evaluate(
    () => performance.getEntriesByType("resource").filter((entry) => /\/js\/history\.js$/.test(entry.name)).length
  );
  assert.equal(repeatedHistoryRequests, firstHistoryRequests, "History module must initialize only once");

  await page.waitForFunction(() => Boolean(window.__SWIFTGO_E2E__?.ready), null, { timeout: 5_000 });
  assert.deepEqual(consoleErrors, [], "Lazy modules must not produce console errors");
  console.log(
    JSON.stringify(
      {
        homeHistoryRequests: initialHistoryRequests,
        firstHistoryRequests,
        repeatedHistoryRequests,
        e2eReady: true,
        consoleErrors,
      },
      null,
      2
    )
  );
} finally {
  await browser.close();
}
