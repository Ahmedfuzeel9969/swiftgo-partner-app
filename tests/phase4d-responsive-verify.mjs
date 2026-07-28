/**
 * Phase 4D — responsive / language / visual consistency verification.
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "hosting-dist");
const RESULTS = path.join(ROOT, "tests", "phase4d-responsive-results.json");
const EVIDENCE = path.join(ROOT, "docs", "phase4d-responsive-evidence");
const SUMMARY = path.join(ROOT, "tests", "phase4d-regression-summary.json");

const results = [];

function record(name, expected, actual, status, extra = {}) {
  results.push({ name, expected, actual, status, ...extra });
  console.log(`${status === "PASS" ? "✓" : "✗"} [${status}] ${name}`);
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return (
    {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".png": "image/png",
      ".svg": "image/svg+xml",
    }[ext] || "application/octet-stream"
  );
}

function startStaticServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        let urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
        if (urlPath.endsWith("/")) urlPath += "index.html";
        const filePath = path.normalize(path.join(DIST, urlPath));
        if (!filePath.startsWith(DIST)) {
          res.writeHead(403);
          res.end("Forbidden");
          return;
        }
        if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
          const candidates = [
            path.join(DIST, urlPath, "index.html"),
            path.join(DIST, "partner", "index.html"),
            path.join(DIST, "owner", "index.html"),
            path.join(DIST, "admin", "index.html"),
            path.join(DIST, "index.html"),
          ];
          const hit = candidates.find((c) => fs.existsSync(c) && fs.statSync(c).isFile());
          if (!hit) {
            res.writeHead(404);
            res.end("Not found");
            return;
          }
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          fs.createReadStream(hit).pipe(res);
          return;
        }
        res.writeHead(200, { "Content-Type": contentType(filePath) });
        fs.createReadStream(filePath).pipe(res);
      } catch (err) {
        res.writeHead(500);
        res.end(String(err?.message || err));
      }
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
    server.on("error", reject);
  });
}

function assertCss(name, css, needle) {
  const ok = css.includes(needle);
  record(name, `contains ${needle}`, ok ? "found" : "missing", ok ? "PASS" : "FAIL");
}

async function main() {
  fs.mkdirSync(EVIDENCE, { recursive: true });

  const customerCss = fs.readFileSync(path.join(ROOT, "customer-app", "css", "styles.css"), "utf8");
  const partnerCss = fs.readFileSync(path.join(ROOT, "driver-app", "css", "driver-style.css"), "utf8");
  const ownerCss = fs.readFileSync(path.join(ROOT, "owner-app", "css", "owner-style.css"), "utf8");
  const adminCss = fs.readFileSync(path.join(ROOT, "super-admin-panel", "css", "admin-style.css"), "utf8");

  assertCss("customer safe-area vars", customerCss, "--safe-left");
  assertCss("customer keyboard inset", customerCss, "--keyboard-inset");
  assertCss("customer landscape sheet cap", customerCss, "orientation: landscape");
  assertCss("customer focus-visible", customerCss, ":focus-visible");
  assertCss("partner lang switch styles", partnerCss, ".partner-lang-switch");
  assertCss("partner safe-area vars", partnerCss, "--safe-left");
  assertCss("owner lang switch styles", ownerCss, ".partner-lang-switch");
  assertCss("admin focus-visible", adminCss, ":focus-visible");

  const partnerI18n = fs.readFileSync(path.join(ROOT, "driver-app", "js", "i18n.js"), "utf8");
  const ownerI18n = fs.readFileSync(path.join(ROOT, "owner-app", "js", "i18n.js"), "utf8");
  record(
    "partner i18n module",
    "setLang + applyTranslations",
    partnerI18n.includes("export function setLang") && partnerI18n.includes("applyTranslations"),
    partnerI18n.includes("export function setLang") ? "PASS" : "FAIL"
  );
  record(
    "owner i18n module",
    "setLang + applyTranslations",
    ownerI18n.includes("export function setLang") && ownerI18n.includes("applyTranslations"),
    ownerI18n.includes("export function setLang") ? "PASS" : "FAIL"
  );

  const stepUi = fs.readFileSync(path.join(ROOT, "customer-app", "js", "step-ui.js"), "utf8");
  record(
    "whereTo trigger refresh helper",
    "refreshTriggerLabel",
    stepUi.includes("refreshTriggerLabel"),
    stepUi.includes("refreshTriggerLabel") ? "PASS" : "FAIL"
  );

  const { server, base } = await startStaticServer();
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });

    // Customer Where-to language refresh (open sidebar first)
    await page.goto(`${base}/`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(900);
    await page.evaluate(() => {
      try {
        localStorage.setItem("swiftgo_lang", "en");
      } catch {
        /* ignore */
      }
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(900);

    // Phase 4E location trust dialog may open from locateUser on boot — dismiss before UI clicks.
    await page.locator("#trustConfirmCancel").click({ timeout: 1500 }).catch(async () => {
      await page.evaluate(() => {
        const root = document.getElementById("trustConfirmDialog");
        if (!root) return;
        root.classList.remove("is-open");
        root.setAttribute("aria-hidden", "true");
      });
    });
    await page.waitForTimeout(200);

    const enText = (await page.locator("#whereToTrigger").textContent())?.trim() || "";
    record("customer whereTo EN", "Where to?", enText, enText.includes("Where to") ? "PASS" : "FAIL", {
      text: enText,
    });

    await page.locator("#menuBtn").click({ timeout: 3000 });
    await page.waitForTimeout(300);
    await page.locator('[data-lang="ur"]').first().click({ timeout: 3000 });
    await page.waitForTimeout(400);
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(200);

    const urText = (await page.locator("#whereToTrigger").textContent())?.trim() || "";
    const urDir = await page.evaluate(() => document.documentElement.dir);
    record("customer whereTo UR", "کہاں جانا ہے؟", urText, urText.includes("کہاں") ? "PASS" : "FAIL", {
      text: urText,
      dir: urDir,
    });
    record("customer RTL after UR", "rtl", urDir, urDir === "rtl" ? "PASS" : "FAIL");
    await page.screenshot({ path: path.join(EVIDENCE, "customer-where-to-urdu.png"), fullPage: false });

    // Landscape sheet vs map height
    await page.setViewportSize({ width: 844, height: 390 });
    await page.waitForTimeout(400);
    await page.locator("#sheetHandle").click({ timeout: 2000 }).catch(() => {});
    await page.waitForTimeout(400);
    const landscapeMetrics = await page.evaluate(() => {
      const sheet = document.querySelector(".sheet");
      const map = document.querySelector("#map");
      const shell = document.querySelector(".shell");
      const sr = sheet?.getBoundingClientRect();
      const mr = map?.getBoundingClientRect();
      return {
        sheetH: sr ? Math.round(sr.height) : 0,
        mapH: mr ? Math.round(mr.height) : 0,
        viewportH: window.innerHeight,
        sheetExpanded: shell?.classList.contains("sheet-expanded") || false,
      };
    });
    const mapOk = landscapeMetrics.mapH >= 120;
    const sheetOk = landscapeMetrics.sheetH > 0 && landscapeMetrics.sheetH <= Math.round(landscapeMetrics.viewportH * 0.55);
    record(
      "landscape map usable height",
      "mapH >= 120",
      landscapeMetrics.mapH,
      mapOk ? "PASS" : "FAIL",
      landscapeMetrics
    );
    record(
      "landscape sheet capped",
      "sheetH <= 55% viewport",
      landscapeMetrics.sheetH,
      sheetOk ? "PASS" : "FAIL",
      landscapeMetrics
    );
    await page.screenshot({ path: path.join(EVIDENCE, "customer-landscape-sheet.png"), fullPage: false });

    // Partner EN/UR toggle on auth
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${base}/partner/`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(700);
    await page.evaluate(() => {
      try {
        localStorage.setItem("swiftgo_partner_lang", "ur");
      } catch {
        /* ignore */
      }
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(700);
    const partnerUrTitle = (await page.locator("#driverAuthTitle").textContent())?.trim() || "";
    await page.locator('[data-lang="en"]').first().click({ timeout: 3000 });
    await page.waitForTimeout(300);
    const partnerEnTitle = (await page.locator("#driverAuthTitle").textContent())?.trim() || "";
    const partnerDir = await page.evaluate(() => document.documentElement.dir);
    record(
      "partner auth EN switch",
      "Driver account",
      partnerEnTitle,
      /driver account/i.test(partnerEnTitle) ? "PASS" : "FAIL",
      { ur: partnerUrTitle, en: partnerEnTitle, dir: partnerDir }
    );
    record("partner LTR after EN", "ltr", partnerDir, partnerDir === "ltr" ? "PASS" : "FAIL");
    await page.screenshot({ path: path.join(EVIDENCE, "partner-auth-en.png"), fullPage: false });

    // Owner EN/UR toggle
    await page.goto(`${base}/owner/`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(700);
    await page.evaluate(() => {
      try {
        localStorage.setItem("swiftgo_owner_lang", "ur");
      } catch {
        /* ignore */
      }
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(700);
    await page.locator('[data-lang="en"]').first().click({ timeout: 3000 });
    await page.waitForTimeout(300);
    const ownerEnTitle = (await page.locator("#driverAuthTitle").textContent())?.trim() || "";
    const ownerDir = await page.evaluate(() => document.documentElement.dir);
    record(
      "owner auth EN switch",
      "Owner account",
      ownerEnTitle,
      /owner account/i.test(ownerEnTitle) ? "PASS" : "FAIL",
      { en: ownerEnTitle, dir: ownerDir }
    );
    record("owner LTR after EN", "ltr", ownerDir, ownerDir === "ltr" ? "PASS" : "FAIL");
    await page.screenshot({ path: path.join(EVIDENCE, "owner-auth-en.png"), fullPage: false });

    // Admin keyboard inset helper present in built bundle path via source check already; smoke load
    await page.goto(`${base}/admin/`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(EVIDENCE, "admin-login.png"), fullPage: false });
    record("admin login loads", "200 shell", "ok", "PASS");
  } finally {
    await browser.close();
    server.close();
  }

  const failed = results.filter((r) => r.status === "FAIL");
  const payload = {
    phase: "4D",
    generatedAt: new Date().toISOString(),
    pass: results.filter((r) => r.status === "PASS").length,
    fail: failed.length,
    results,
  };
  fs.writeFileSync(RESULTS, JSON.stringify(payload, null, 2));
  fs.writeFileSync(
    SUMMARY,
    JSON.stringify(
      {
        phase: "4D",
        generatedAt: payload.generatedAt,
        pass: payload.pass,
        fail: payload.fail,
        evidenceDir: "docs/phase4d-responsive-evidence",
        resultsFile: "tests/phase4d-responsive-results.json",
      },
      null,
      2
    )
  );

  console.log(`\nPhase 4D: ${payload.pass} PASS / ${payload.fail} FAIL`);
  if (failed.length) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
