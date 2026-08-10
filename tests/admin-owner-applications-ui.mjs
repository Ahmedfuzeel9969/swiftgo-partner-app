/**
 * Task 3C — Super Admin owner applications UI static proofs.
 *
 * Run: npm run test:admin-owner-applications-ui
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "tests", "admin-owner-applications-ui-results.json");

const results = [];

function record(name, ok, detail = "") {
  results.push({ name, status: ok ? "PASS" : "FAIL", detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

function main() {
  const html = read("super-admin-panel/index.html");
  const adminJs = read("super-admin-panel/js/admin-app.js");
  const clientJs = read("super-admin-panel/js/admin-owner-applications-client.js");

  record(
    "ui-section-present",
    html.includes('id="ownerApplicationsSection"') &&
      html.includes('data-view-panel="owner-applications"') &&
      html.includes('id="ownerApplicationsTableBody"'),
    "owner applications panel exists"
  );
  record(
    "ui-nav-entry",
    html.includes('data-view="owner-applications"') && html.includes("مالک درخواستیں"),
    "sidebar navigation wired"
  );
  record(
    "ui-approve-reject-actions",
    html.includes("ownerApplicationsTableBody") &&
      adminJs.includes("data-owner-approve") &&
      adminJs.includes("data-owner-reject") &&
      adminJs.includes("approveOwnerApplication") &&
      adminJs.includes("rejectOwnerApplication"),
    "approve and reject controls defined"
  );
  record(
    "ui-confirmation-before-approve",
    adminJs.includes("window.confirm") && adminJs.includes("approveOwnerAccessClient"),
    "approval requires explicit confirmation"
  );
  record(
    "ui-on-demand-fetch-not-live-listener",
    adminJs.includes("fetchOwnerApplicationsOnDemand") &&
      adminJs.includes("getDocs") &&
      !adminJs.includes('onSnapshot(\n      query(\n        collection(db, "owner_applications")'),
    "pending list loaded on demand"
  );
  record(
    "ui-bounded-firestore-reads",
    adminJs.includes("OWNER_APPLICATIONS_FETCH_LIMIT = 50") &&
      adminJs.includes("limit(OWNER_APPLICATIONS_FETCH_LIMIT)"),
    "fetch capped at 50 documents"
  );
  record(
    "ui-safe-fields-only",
    adminJs.includes("application.fullName") &&
      adminJs.includes("application.businessName") &&
      !adminJs.includes("application.email") &&
      !adminJs.match(/console\.(log|info|debug)\([^\)]*email/i),
    "table avoids email logging"
  );
  record(
    "ui-refresh-after-action",
    adminJs.includes("renderOwnerApplicationsTable") &&
      adminJs.includes("ownerApplicationsRefreshBtn") &&
      adminJs.includes("showAdminToast"),
    "list refresh + Urdu toast feedback"
  );
  record(
    "ui-loading-empty-error-states",
    adminJs.includes("لوڈ ہو رہا ہے") &&
      adminJs.includes("کوئی زیر التواء مالک درخواست نہیں") &&
      adminJs.includes("مالک درخواستیں لوڈ نہیں ہو سکیں"),
    "loading, empty, and error copy present"
  );
  record(
    "ui-callable-clients-wired",
    clientJs.includes("approveOwnerAccess") &&
      clientJs.includes("rejectOwnerAccess") &&
      adminJs.includes('from "./admin-owner-applications-client.js'),
    "super admin uses trusted callables"
  );
  record(
    "ui-view-switch-loads-on-demand",
    adminJs.includes('if (key === "owner-applications")') &&
      adminJs.includes("fetchOwnerApplicationsOnDemand()"),
    "opening view triggers bounded fetch"
  );

  const failed = results.filter((r) => r.status === "FAIL");
  fs.writeFileSync(
    OUT,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        pass: results.length - failed.length,
        fail: failed.length,
        results,
      },
      null,
      2
    )
  );

  console.log(`\nSummary pass=${results.length - failed.length} fail=${failed.length}`);
  console.log(`Wrote ${OUT}`);
  if (failed.length) process.exitCode = 1;
}

main();
