/**
 * Phase 4E — trust/legal static + DOM verification (no Production deploy).
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "hosting-dist");
const RESULTS = path.join(ROOT, "tests", "phase4e-trust-results.json");
const SUMMARY = path.join(ROOT, "tests", "phase4e-regression-summary.json");

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
          res.writeHead(404);
          res.end("Not found");
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

async function main() {
  for (const page of ["privacy.html", "terms.html", "data-use.html"]) {
    const p = path.join(ROOT, "legal", page);
    const html = fs.readFileSync(p, "utf8");
    record(`legal draft banner ${page}`, "DRAFT", html.includes("DRAFT"), html.includes("DRAFT") ? "PASS" : "FAIL");
  }

  const delSrc = fs.readFileSync(path.join(ROOT, "functions", "account-deletion.js"), "utf8");
  record(
    "deletion retains ledger categories",
    "ledger_transactions + audit_logs",
    delSrc.includes("ledger_transactions") && delSrc.includes("audit_logs"),
    delSrc.includes("ledger_transactions") && delSrc.includes("audit_logs") ? "PASS" : "FAIL"
  );
  record(
    "deletion module soft-disable only",
    "updateUser disabled + no recursive wipe helpers",
    delSrc.includes("disabled: true") && !delSrc.includes("recursiveDelete"),
    delSrc.includes("disabled: true") && !delSrc.includes("recursiveDelete") ? "PASS" : "FAIL"
  );

  const indexJs = fs.readFileSync(path.join(ROOT, "functions", "index.js"), "utf8");
  record(
    "CF exports requestAccountDeletion",
    "exports.requestAccountDeletion",
    indexJs.includes("exports.requestAccountDeletion"),
    indexJs.includes("exports.requestAccountDeletion") ? "PASS" : "FAIL"
  );
  record(
    "CF exports submitSupportReport",
    "exports.submitSupportReport",
    indexJs.includes("exports.submitSupportReport"),
    indexJs.includes("exports.submitSupportReport") ? "PASS" : "FAIL"
  );

  const rules = fs.readFileSync(path.join(ROOT, "firestore.rules"), "utf8");
  record(
    "rules account_deletion_requests",
    "match present",
    rules.includes("account_deletion_requests"),
    rules.includes("account_deletion_requests") ? "PASS" : "FAIL"
  );

  const { server, base } = await startStaticServer();
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });

    const privacy = await page.goto(`${base}/legal/privacy.html`, { waitUntil: "domcontentloaded" });
    record("serve privacy.html", "200", String(privacy?.status()), privacy?.status() === 200 ? "PASS" : "FAIL");

    await page.goto(`${base}/`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(600);
    const hasPrivacy = await page.locator('[data-legal="privacy"]').count();
    const hasDelete = await page.locator("#deleteAccountBtn").count();
    const hasComplaint = await page.locator("#complaintSubmitBtn").count();
    record("customer privacy link", ">=1", hasPrivacy, hasPrivacy >= 1 ? "PASS" : "FAIL");
    record("customer delete CTA", "1", hasDelete, hasDelete === 1 ? "PASS" : "FAIL");
    record("customer complaint CTA", "1", hasComplaint, hasComplaint === 1 ? "PASS" : "FAIL");

    // Location permission dialog appears on locate — accept once for smoke
    await page.evaluate(() => localStorage.setItem("swiftgo_location_consent_v1", "1"));

    await page.goto(`${base}/partner/`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(500);
    const partnerLegal = await page.locator('[data-legal="privacy"]').count();
    const partnerDelete = await page.locator("#partnerDeleteAccountBtn").count();
    record("partner privacy link", ">=1", partnerLegal, partnerLegal >= 1 ? "PASS" : "FAIL");
    record("partner delete CTA", "1", partnerDelete, partnerDelete === 1 ? "PASS" : "FAIL");

    await page.goto(`${base}/owner/`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(500);
    const ownerLegal = await page.locator('[data-legal="terms"]').count();
    const ownerDelete = await page.locator("#ownerDeleteAccountBtn").count();
    record("owner terms link", ">=1", ownerLegal, ownerLegal >= 1 ? "PASS" : "FAIL");
    record("owner delete CTA", "1", ownerDelete, ownerDelete === 1 ? "PASS" : "FAIL");

    await page.goto(`${base}/admin/`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(400);
    const adminLegal = await page.locator('a[href="/legal/privacy.html"]').count();
    record("admin privacy link", ">=1", adminLegal, adminLegal >= 1 ? "PASS" : "FAIL");
  } finally {
    await browser.close();
    server.close();
  }

  const failed = results.filter((r) => r.status === "FAIL");
  const payload = {
    phase: "4E",
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
        phase: "4E",
        generatedAt: payload.generatedAt,
        pass: payload.pass,
        fail: payload.fail,
        resultsFile: "tests/phase4e-trust-results.json",
      },
      null,
      2
    )
  );
  console.log(`\nPhase 4E trust UI: ${payload.pass} PASS / ${payload.fail} FAIL`);
  if (failed.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
