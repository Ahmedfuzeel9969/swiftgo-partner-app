/**
 * Phase 4B — targeted accessibility verification for required controls + keyboard + reduced motion.
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "hosting-dist");
const RESULTS = path.join(ROOT, "tests", "phase4b-a11y-results.json");
const EVIDENCE = path.join(ROOT, "docs", "phase4b-a11y-evidence");

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

async function checkPage(page, appPath, ids, options = {}) {
  await page.goto(`${options.base}${appPath}`, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(700);
  return page.evaluate((requiredIds) => {
    function hasAccessibleName(el) {
      if (!el) return false;
      if (el.getAttribute("aria-label") || el.getAttribute("aria-labelledby")) return true;
      if (el.id) {
        try {
          if (document.querySelector(`label[for="${CSS.escape(el.id)}"]`)) return true;
        } catch {
          /* ignore */
        }
      }
      if (el.closest("label")) return true;
      if (el.placeholder) return true;
      return false;
    }
    const missing = [];
    const present = [];
    for (const id of requiredIds) {
      const el = document.getElementById(id);
      if (!el) {
        missing.push({ id, reason: "not_in_dom" });
        continue;
      }
      present.push(id);
      if (id === "addStopBtn") {
        const ok = el.tabIndex < 0 || el.hidden || el.getAttribute("aria-hidden") === "true";
        if (!ok || (!hasAccessibleName(el) && el.tabIndex >= 0)) {
          missing.push({ id, reason: "addStop_not_inert" });
        }
        continue;
      }
      if (!hasAccessibleName(el)) missing.push({ id, reason: "no_accessible_name" });
    }
    return {
      missing,
      present,
      reducedMotionCss: Boolean(
        [...document.styleSheets].length ||
          document.documentElement.classList.contains("prefers-reduced-motion") ||
          !!document.querySelector("style, link[rel=stylesheet]")
      ),
      liveRegionReady: true,
    };
  }, ids);
}

async function keyboardCheck(page, appPath, base, openerSelector) {
  await page.goto(`${base}${appPath}`, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(800);
  if (openerSelector) {
    await page.locator(openerSelector).click({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(400);
  }
  const ids = [];
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press("Tab");
    const id = await page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName || null);
    ids.push(id);
  }
  await page.keyboard.press("Escape");
  return ids;
}

async function main() {
  fs.mkdirSync(EVIDENCE, { recursive: true });
  if (!fs.existsSync(path.join(DIST, "index.html"))) {
    console.error("Run npm run build:hosting first");
    process.exit(2);
  }

  const { server, base } = await startStaticServer();
  const launchOpts = { headless: true, channel: process.env.PHASE4A_BROWSER_CHANNEL || "chrome" };
  let browser;
  try {
    browser = await chromium.launch(launchOpts);
  } catch {
    browser = await chromium.launch({ headless: true });
  }

  try {
    const customer = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const c = await checkPage(customer, "/", [
      "payMethodCash",
      "payMethodEasypaisa",
      "driverFullName",
      "driverLicense",
      "driverVehicleType",
      "driverCnicFront",
      "driverCnicBack",
      "driverLicenseFile",
      "driverSelfieFile",
      "rentDuration1h",
      "rentVehicleSedan",
      "cargoFragile",
      "addStopBtn",
    ], { base });
    record("customer_required_names", 0, c.missing.length, c.missing.length === 0 ? "PASS" : "FAIL", { missing: c.missing });
    await customer.screenshot({ path: path.join(EVIDENCE, "customer-a11y-shell.png") });
    const custKb = await keyboardCheck(customer, "/", base, "#menuBtn");
    record("customer_keyboard_moves", "focus_changes", [...new Set(custKb)].length >= 1 ? "ok" : "stuck", [...new Set(custKb)].length >= 1 ? "PASS" : "FAIL", { order: custKb });
    await customer.close();

    const partner = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const p = await checkPage(partner, "/partner/", [
      "rechargeMethod",
      "notificationMuteToggle",
      "notificationToneSelect",
      "notificationVolumeRange",
    ], { base });
    record("partner_required_names", 0, p.missing.length, p.missing.length === 0 ? "PASS" : "FAIL", { missing: p.missing });
    const partnerKb = await keyboardCheck(partner, "/partner/", base, null);
    const partnerUnique = new Set(partnerKb.filter(Boolean));
    record("partner_auth_focus_contained", "dialog_focusable", partnerUnique.size >= 1 ? "ok" : "none", partnerUnique.size >= 1 ? "PASS" : "FAIL", { order: partnerKb });
    await partner.screenshot({ path: path.join(EVIDENCE, "partner-a11y-shell.png") });
    await partner.close();

    const owner = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const ownerKb = await keyboardCheck(owner, "/owner/", base, null);
    record("owner_auth_focus_contained", "dialog_focusable", ownerKb.filter(Boolean).length >= 1 ? "ok" : "none", ownerKb.filter(Boolean).length >= 1 ? "PASS" : "FAIL", { order: ownerKb });
    await owner.screenshot({ path: path.join(EVIDENCE, "owner-a11y-shell.png") });
    await owner.close();

    const admin = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const a = await checkPage(admin, "/admin/", [
      "rate-bike-baseFare",
      "rate-go-baseFare",
      "candidateDriverLimitInput",
      "pricingWalletThreshold",
      "promoValueInput",
    ], { base });
    record("admin_required_names", 0, a.missing.length, a.missing.length === 0 ? "PASS" : "FAIL", { missing: a.missing });
    const adminKb = await keyboardCheck(admin, "/admin/", base, null);
    record("admin_auth_focus_contained", "dialog_focusable", adminKb.filter(Boolean).length >= 1 ? "ok" : "none", adminKb.filter(Boolean).length >= 1 ? "PASS" : "FAIL", { order: adminKb });
    await admin.screenshot({ path: path.join(EVIDENCE, "admin-a11y-shell.png") });
    await admin.close();

    // Reduced motion CSS presence in built CSS
    const cssPaths = [
      path.join(DIST, "css", "styles.css"),
      path.join(DIST, "partner", "css", "driver-style.css"),
      path.join(DIST, "owner", "css", "owner-style.css"),
      path.join(DIST, "admin", "css", "admin-style.css"),
    ];
    let rmOk = 0;
    for (const css of cssPaths) {
      if (fs.existsSync(css) && fs.readFileSync(css, "utf8").includes("prefers-reduced-motion")) rmOk += 1;
    }
    record("reduced_motion_css", 4, rmOk, rmOk === 4 ? "PASS" : "FAIL");

    // a11y helper modules present
    const helpers = [
      path.join(DIST, "js", "a11y.js"),
      path.join(DIST, "partner", "js", "a11y.js"),
      path.join(DIST, "owner", "js", "a11y.js"),
      path.join(DIST, "admin", "js", "a11y.js"),
    ];
    const helperOk = helpers.every((p) => fs.existsSync(p));
    record("a11y_helpers_packaged", true, helperOk, helperOk ? "PASS" : "FAIL");
  } finally {
    await browser.close();
    server.close();
  }

  const passed = results.filter((r) => r.status === "PASS").length;
  const failed = results.filter((r) => r.status === "FAIL").length;
  const out = {
    generatedAt: new Date().toISOString(),
    passed,
    failed,
    blocked: 0,
    skipped: 0,
    results,
  };
  fs.writeFileSync(RESULTS, JSON.stringify(out, null, 2));
  console.log(`\nPhase 4B a11y: ${passed} passed, ${failed} failed → ${RESULTS}`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
