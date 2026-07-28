/**
 * Static repository audit for canonical data-source violations (Phase 2C).
 * Does not touch Firebase.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const results = [];

function record(name, expected, actual, status, detail = "") {
  results.push({ name, expected, actual, status, detail, suite: "phase2c-audit" });
}

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (
      ent.name === "node_modules" ||
      ent.name === "hosting-dist" ||
      ent.name === ".git" ||
      ent.name === "www" ||
      ent.name === "build" ||
      ent.name === ".gradle"
    ) {
      continue;
    }
    const p = path.join(dir, ent.name);
    const rel = path.relative(ROOT, p).replace(/\\/g, "/");
    // Generated Capacitor / Android embeds are not source-of-truth for client audits.
    if (rel.startsWith("mobile/") && (rel.includes("/android/") || rel.includes("/www/"))) {
      continue;
    }
    if (ent.isDirectory()) walk(p, out);
    else if (/\.(js|mjs|cjs|html)$/.test(ent.name)) out.push(p);
  }
  return out;
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

const files = walk(ROOT);

// Active client PIN query bypass (apps only; Admin SDK pin-link may legacy-fallback)
const pinQueryFiles = files.filter((f) => {
  const rel = path.relative(ROOT, f).replace(/\\/g, "/");
  if (rel.startsWith("tests/") || rel.startsWith("functions/") || rel.startsWith("tools/")) {
    return false;
  }
  const t = fs.readFileSync(f, "utf8");
  return /where\(\s*[\"']pin[\"']\s*,\s*[\"']==[\"']/.test(t);
});
record(
  "A01-no-client-plaintext-pin-query",
  "no active where(pin==) in client apps",
  pinQueryFiles.map((f) => path.relative(ROOT, f)).join(", ") || "none",
  pinQueryFiles.length === 0 ? "PASS" : "FAIL",
  "functions/pin-link.js may Admin-query legacy pin during migration (lockout + strip)"
);

// Settlement must not write users wallet
const settlement = read("functions/settlement.js");
record(
  "A02-settlement-partners-only",
  "settlement updates partners wallet, not users",
  settlement.includes('collection("partners")') && !settlement.includes('collection("users")')
    ? "partners only"
    : "users referenced",
  settlement.includes("walletBalance: FieldValue.increment") &&
    settlement.includes('collection("partners")') &&
    !/collection\(["']users["']\)/.test(settlement)
    ? "PASS"
    : "FAIL"
);

// ride_requests writers in apps
const rideReqWriters = files.filter((f) => {
  if (f.includes(`${path.sep}tests${path.sep}`)) return false;
  const t = fs.readFileSync(f, "utf8");
  return (
    /ride_requests/.test(t) &&
    /(addDoc|setDoc|updateDoc|writeBatch).*ride_requests|collection\([^)]*ride_requests/.test(t)
  );
});
// Narrower: client write APIs targeting ride_requests
const activeRideReqWrite = [];
for (const f of files) {
  if (f.includes("tests") || f.includes("docs")) continue;
  const t = fs.readFileSync(f, "utf8");
  if (!t.includes("ride_requests")) continue;
  if (
    /updateDoc\([^)]*ride_requests|setDoc\([^)]*ride_requests|addDoc\([^)]*ride_requests|collection\(db,\s*[\"']ride_requests[\"']\)/.test(
      t
    )
  ) {
    // settlement-client forcing rides is ok; radar comments ok
    if (t.includes('collectionName: "rides"') && !t.includes('collection(db, "ride_requests")')) {
      continue;
    }
    if (/collection\(db,\s*[\"']ride_requests[\"']\)/.test(t)) {
      activeRideReqWrite.push(path.relative(ROOT, f));
    }
  }
}
record(
  "A03-no-active-ride-requests-writes",
  "apps do not write ride_requests",
  activeRideReqWrite.join(", ") || "none",
  activeRideReqWrite.length === 0 ? "PASS" : "FAIL"
);

// Client wallet increment bypass
const walletInc = files.filter((f) => {
  if (f.includes("tests") || f.includes("functions") || f.includes("super-admin-panel")) return false;
  const t = fs.readFileSync(f, "utf8");
  return /walletBalance:\s*increment/.test(t);
});
record(
  "A04-no-driver-owner-client-wallet-increment",
  "driver/owner/customer apps do not increment walletBalance",
  walletInc.map((f) => path.relative(ROOT, f)).join(", ") || "none",
  walletInc.length === 0 ? "PASS" : "FAIL"
);

// Admin panel may increment on recharge (super admin only) — note separately
const adminInc = read("super-admin-panel/js/admin-app.js").includes("walletBalance: increment");
record(
  "A05-admin-recharge-wallet-path-documented",
  "Super Admin recharge may increment partners wallet (allowed)",
  adminInc ? "present (admin-only)" : "absent",
  "PASS",
  "Not a violation; Rules require isSuperAdmin"
);

// Canonical booking create uses rides
const customerCreate = read("customer-app/js/data.js");
record(
  "A06-customer-creates-rides",
  "createRideRequest writes rides collection",
  customerCreate.includes('collection(db, "rides")') ? "rides" : "missing",
  customerCreate.includes('collection(db, "rides")') &&
    !customerCreate.includes('collection(db, "ride_requests")')
    ? "PASS"
    : "FAIL"
);

const rules = read("firestore.rules");
record(
  "A07-rules-ride-requests-readonly",
  "ride_requests create/update/delete false",
  /match \/ride_requests\/\{requestId\}[\s\S]*?allow create, update, delete: if false/.test(rules)
    ? "readonly"
    : "writable?",
  /allow create, update, delete: if false/.test(
    rules.slice(rules.indexOf("match /ride_requests/{requestId}"))
  )
    ? "PASS"
    : "FAIL"
);

record(
  "A08-rules-claim-admin-primary",
  "isClaimAdmin used in isSuperAdmin",
  rules.includes("isClaimAdmin()") && rules.includes("adminBootstrapEnabled")
    ? "claim+bootstrap flag"
    : "missing",
  rules.includes("function isClaimAdmin") && rules.includes("adminBootstrapEnabled")
    ? "PASS"
    : "FAIL"
);

// Driver/owner financial wallet must read partners (not users) for balance display sources
const earningsSvc = read("driver-app/js/earnings-service.js");
record(
  "A09-driver-wallet-reads-partners",
  "earnings-service derives wallet from partners",
  earningsSvc.includes("partners") && earningsSvc.includes("walletBalance")
    ? "partners"
    : "unexpected",
  /partners/.test(earningsSvc) && !/collection\([^)]*[\"']users[\"']\)/.test(earningsSvc)
    ? "PASS"
    : "FAIL"
);

const ownerWallet = read("owner-app/js/owner-app.js");
record(
  "A10-owner-wallet-reads-partners",
  "owner walletBalance sourced from partners",
  ownerWallet.includes("walletBalance") && ownerWallet.includes("partners")
    ? "partners"
    : "unexpected",
  /getDoc\([^)]*partners|doc\([^)]*[\"']partners[\"']/.test(ownerWallet) ? "PASS" : "FAIL"
);

const customerWallet = read("customer-app/js/data.js");
record(
  "A11-customer-wallet-users",
  "customer profile/wallet on users collection",
  customerWallet.includes("walletBalance") && customerWallet.includes('collection(db, "users")')
    ? "users"
    : "check",
  /users/.test(customerWallet) && customerWallet.includes("walletBalance") ? "PASS" : "FAIL"
);

// Remaining intentional legacy references (read-only archive / comments) — not FAIL
const legacyRefs = [];
for (const f of files) {
  if (f.includes(`${path.sep}tests${path.sep}`) || f.includes(`${path.sep}docs${path.sep}`)) continue;
  const rel = path.relative(ROOT, f);
  const t = fs.readFileSync(f, "utf8");
  if (!t.includes("ride_requests")) continue;
  if (/collection\(db,\s*[\"']ride_requests[\"']\)/.test(t)) {
    legacyRefs.push(`${rel}: active collection(db,\"ride_requests\")`);
  } else if (/sourceCollection\s*===\s*[\"']ride_requests[\"']/.test(t)) {
    legacyRefs.push(`${rel}: sourceCollection branch (legacy-aware)`);
  }
}
record(
  "A12-legacy-ride-requests-inventory",
  "inventory remaining ride_requests references outside tests/docs",
  legacyRefs.join(" | ") || "none",
  legacyRefs.some((x) => x.includes('collection(db,"ride_requests")')) ? "FAIL" : "PASS",
  "Legacy-aware sourceCollection branches are allowed if non-writing"
);

const passed = results.filter((r) => r.status === "PASS").length;
const failed = results.filter((r) => r.status === "FAIL").length;
const blocked = results.filter((r) => r.status === "BLOCKED").length;
const out = {
  generatedAt: new Date().toISOString(),
  results,
  passed,
  failed,
  blocked,
  total: results.length,
};
fs.writeFileSync(
  path.join(ROOT, "tests", "phase2c-canonical-audit-results.json"),
  JSON.stringify(out, null, 2)
);
console.log(`[phase2c-audit] passed=${passed} failed=${failed} blocked=${blocked}`);
process.exit(failed > 0 ? 1 : 0);
