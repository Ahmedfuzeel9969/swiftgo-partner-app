/**
 * Phase 4A — UI responsive / visual evidence (audit only).
 * Serves hosting-dist locally; captures sanitized screenshots; records overflow + basic a11y.
 * Does not deploy, does not write Production, does not redesign UI.
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "hosting-dist");
const EVIDENCE = path.join(ROOT, "docs", "phase4a-ui-evidence");
const RESULTS = path.join(ROOT, "tests", "phase4a-ui-results.json");

const VIEWPORTS = [
  { name: "320x568", width: 320, height: 568 },
  { name: "360x800", width: 360, height: 800 },
  { name: "390x844", width: 390, height: 844 },
  { name: "412x915", width: 412, height: 915 },
  { name: "768x1024", width: 768, height: 1024 },
  { name: "1366x768", width: 1366, height: 768 },
  { name: "390x844-landscape", width: 844, height: 390 },
  { name: "412x915-landscape", width: 915, height: 412 },
];

const APPS = [
  {
    id: "customer",
    path: "/",
    label: "Customer",
    actions: async (page) => {
      await page.waitForTimeout(800);
      await page.locator("#menuBtn").click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(400);
      await page.screenshot({ path: shot("customer", "sidebar"), fullPage: false });
      await page.keyboard.press("Escape").catch(() => {});
      await page.locator("#sheetHandle").click({ timeout: 2000 }).catch(() => {});
      await page.waitForTimeout(400);
      await page.screenshot({ path: shot("customer", "sheet-expanded"), fullPage: false });
      // Urdu
      await page.locator('[data-lang="ur"]').click({ timeout: 2000 }).catch(() => {});
      await page.waitForTimeout(500);
      await page.screenshot({ path: shot("customer", "urdu"), fullPage: false });
      await page.locator('[data-lang="en"]').click({ timeout: 2000 }).catch(() => {});
    },
  },
  {
    id: "partner",
    path: "/partner/",
    label: "Driver/Partner",
    actions: async (page) => {
      await page.waitForTimeout(800);
      await page.screenshot({ path: shot("partner", "auth-or-shell"), fullPage: false });
      const radar = page.locator("#openRideRadarBtn");
      if (await radar.isVisible().catch(() => false)) {
        await radar.click();
        await page.waitForTimeout(600);
        await page.screenshot({ path: shot("partner", "ride-radar"), fullPage: false });
      }
    },
  },
  {
    id: "owner",
    path: "/owner/",
    label: "Owner",
    actions: async (page) => {
      await page.waitForTimeout(800);
      await page.screenshot({ path: shot("owner", "auth-or-shell"), fullPage: false });
    },
  },
  {
    id: "admin",
    path: "/admin/",
    label: "Super Admin",
    actions: async (page) => {
      await page.waitForTimeout(800);
      await page.screenshot({ path: shot("admin", "login"), fullPage: false });
    },
  },
];

const findings = [];
const shots = [];
let currentVp = "default";
let currentApp = "app";

function shot(app, state) {
  const file = `${app}__${state}__${currentVp}.png`;
  const full = path.join(EVIDENCE, file);
  shots.push({ app, state, viewport: currentVp, file: `docs/phase4a-ui-evidence/${file}` });
  return full;
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return (
    {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".json": "application/json",
      ".png": "image/png",
      ".svg": "image/svg+xml",
      ".ico": "image/x-icon",
      ".woff2": "font/woff2",
      ".map": "application/json",
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
          // SPA fallbacks
          const candidates = [
            path.join(DIST, urlPath, "index.html"),
            path.join(DIST, "partner", "index.html"),
            path.join(DIST, "owner", "index.html"),
            path.join(DIST, "admin", "index.html"),
            path.join(DIST, "customer", "index.html"),
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

async function measureOverflow(page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const body = document.body;
    const scrollWidth = Math.max(doc.scrollWidth, body?.scrollWidth || 0);
    const clientWidth = doc.clientWidth;
    const horizontalOverflow = scrollWidth > clientWidth + 2;

    function isInert(el) {
      if (!el) return true;
      if (el.disabled) return true;
      if (el.getAttribute("aria-hidden") === "true") return true;
      if (el.hidden) return true;
      if (el.tabIndex < 0 && el.tagName === "BUTTON") return true;
      if (el.closest("[hidden], [aria-hidden='true']")) return true;
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") return true;
      return false;
    }

    function hasAccessibleName(el) {
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

    const smallTargets = [];
    const nodes = Array.from(document.querySelectorAll("button, a, [role='button'], input, select, textarea"));
    for (const el of nodes.slice(0, 200)) {
      if (isInert(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.width < 40 || r.height < 40) {
        smallTargets.push({
          tag: el.tagName.toLowerCase(),
          id: el.id || null,
          w: Math.round(r.width),
          h: Math.round(r.height),
          label: (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 40),
        });
      }
    }
    const unlabeledIconButtons = Array.from(document.querySelectorAll("button"))
      .filter((b) => {
        if (isInert(b)) return false;
        const text = (b.textContent || "").trim();
        const aria = b.getAttribute("aria-label");
        const title = b.getAttribute("title");
        return !text && !aria && !title;
      })
      .slice(0, 20)
      .map((b) => ({ id: b.id || null, className: String(b.className || "").slice(0, 60) }));

    const missingLabels = Array.from(document.querySelectorAll("input, select, textarea"))
      .filter((el) => {
        if (el.type === "hidden") return false;
        if (isInert(el)) return false;
        return !hasAccessibleName(el);
      })
      .slice(0, 20)
      .map((el) => ({ id: el.id || null, name: el.name || null, type: el.type || el.tagName }));

    // Phase 4B required controls — check even if currently hidden in UI
    const requiredIds = [
      "payMethodCash",
      "payMethodEasypaisa",
      "payMethodJazzcash",
      "payMethodBusiness",
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
      "rechargeMethod",
      "notificationMuteToggle",
      "notificationToneSelect",
      "notificationVolumeRange",
      "rate-bike-baseFare",
      "candidateDriverLimitInput",
      "pricingWalletThreshold",
    ];
    const requiredMissing = requiredIds
      .map((id) => document.getElementById(id))
      .filter(Boolean)
      .filter((el) => {
        if (el.id === "addStopBtn") {
          return !(el.tabIndex < 0 || el.getAttribute("aria-hidden") === "true" || el.hidden);
        }
        return !hasAccessibleName(el);
      })
      .map((el) => el.id);

    return {
      horizontalOverflow,
      scrollWidth,
      clientWidth,
      dir: doc.getAttribute("dir") || document.body?.dir || "ltr",
      lang: doc.getAttribute("lang") || "",
      smallTargetCount: smallTargets.length,
      smallTargets: smallTargets.slice(0, 15),
      unlabeledIconButtons,
      missingLabels,
      requiredMissing,
      title: document.title || "",
    };
  });
}

async function keyboardSample(page) {
  const order = [];
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press("Tab");
    const info = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      return {
        tag: el.tagName.toLowerCase(),
        id: el.id || null,
        role: el.getAttribute("role"),
        aria: el.getAttribute("aria-label"),
        text: (el.textContent || "").trim().slice(0, 40),
      };
    });
    if (info) order.push(info);
  }
  return order;
}

async function main() {
  fs.mkdirSync(EVIDENCE, { recursive: true });
  if (!fs.existsSync(path.join(DIST, "index.html"))) {
    console.error("hosting-dist missing — run npm run build:hosting first");
    process.exit(2);
  }

  const { server, base } = await startStaticServer();
  const launchOpts = { headless: true };
  const channel = process.env.PHASE4A_BROWSER_CHANNEL || process.env.PHASE2E_BROWSER_CHANNEL || "chrome";
  if (channel) launchOpts.channel = channel;
  let browser;
  try {
    browser = await chromium.launch(launchOpts);
  } catch (err) {
    console.warn("[phase4a] channel launch failed, falling back to bundled chromium:", err?.message || err);
    browser = await chromium.launch({ headless: true });
  }
  const summary = {
    startedAt: new Date().toISOString(),
    base,
    viewports: VIEWPORTS.map((v) => v.name),
    apps: APPS.map((a) => a.id),
    findings: [],
    screenshots: [],
    keyboardSamples: [],
  };

  try {
    for (const vp of VIEWPORTS) {
      currentVp = vp.name;
      for (const app of APPS) {
        currentApp = app.id;
        const context = await browser.newContext({
          viewport: { width: vp.width, height: vp.height },
          deviceScaleFactor: 1,
        });
        const page = await context.newPage();
        const url = `${base}${app.path}`;
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
        await page.waitForTimeout(1000);

        const homeShot = shot(app.id, "home");
        await page.screenshot({ path: homeShot, fullPage: false });

        const metrics = await measureOverflow(page);
        if (metrics.horizontalOverflow) {
          findings.push({
            severity: "P1",
            app: app.id,
            viewport: vp.name,
            issue: "horizontal_overflow",
            evidence: metrics,
          });
        }
        if (metrics.smallTargetCount > 8 && vp.width <= 412) {
          findings.push({
            severity: "P2",
            app: app.id,
            viewport: vp.name,
            issue: "many_small_touch_targets",
            evidence: { count: metrics.smallTargetCount, sample: metrics.smallTargets },
          });
        }
        if (metrics.unlabeledIconButtons.length) {
          findings.push({
            severity: "P2",
            app: app.id,
            viewport: vp.name,
            issue: "unlabeled_icon_buttons",
            evidence: metrics.unlabeledIconButtons,
          });
        }
        if (metrics.missingLabels.length) {
          findings.push({
            severity: "P2",
            app: app.id,
            viewport: vp.name,
            issue: "inputs_missing_accessible_name",
            evidence: metrics.missingLabels,
          });
        }
        if (metrics.requiredMissing?.length) {
          findings.push({
            severity: "P1",
            app: app.id,
            viewport: vp.name,
            issue: "phase4b_required_controls_missing_name",
            evidence: metrics.requiredMissing,
          });
        }

        // Primary viewport extras + keyboard
        if (vp.name === "390x844") {
          await app.actions(page);
          const kb = await keyboardSample(page);
          summary.keyboardSamples.push({ app: app.id, viewport: vp.name, order: kb });
        }

        // Landscape map/control surfaces
        if (vp.name.includes("landscape") && (app.id === "customer" || app.id === "partner")) {
          await page.screenshot({ path: shot(app.id, "landscape-map"), fullPage: false });
        }

        await context.close();
        console.log(`✓ ${app.label} @ ${vp.name}`);
      }
    }
  } finally {
    await browser.close();
    server.close();
  }

  // Deduplicate findings loosely by app+issue+viewport
  summary.findings = findings;
  summary.screenshots = shots;
  summary.finishedAt = new Date().toISOString();
  summary.counts = {
    screenshots: shots.length,
    findings: findings.length,
    p1: findings.filter((f) => f.severity === "P1").length,
    p2: findings.filter((f) => f.severity === "P2").length,
  };
  fs.writeFileSync(RESULTS, JSON.stringify(summary, null, 2));
  console.log(`\nWrote ${RESULTS}`);
  console.log(`Screenshots: ${shots.length} → ${EVIDENCE}`);
  console.log(`Findings: ${findings.length} (P1=${summary.counts.p1}, P2=${summary.counts.p2})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
