/**
 * Shared Firebase Hosting routing guards for protected app surfaces.
 * Used by tests/hosting-routing.mjs and tools/hosting-deploy-integrity.mjs.
 */
import fs from "node:fs";
import path from "node:path";

/** App surfaces that must use rewrite-only routing (no trailing-slash redirects). */
export const PROTECTED_APP_SLUGS = ["partner", "owner", "admin", "customer"];

export const PROTECTED_ROUTE_VARIANTS = PROTECTED_APP_SLUGS.flatMap((slug) => [
  `/${slug}`,
  `/${slug}/`,
]);

export const CUSTOMER_ROOT_PATHS = ["/", "/index.html"];

/** Paths exercised by routing tests (protected + customer root). */
export const ROUTING_PROBE_PATHS = [
  "/",
  ...PROTECTED_ROUTE_VARIANTS,
];

/** Maximum redirect hops allowed before treating a route as looping. */
export const MAX_REDIRECT_CHAIN = 5;

/**
 * Files that define or generate Firebase Hosting deployment configuration.
 * Uncommitted changes to any of these must block production Hosting deploy.
 */
export const HOSTING_DEPLOY_SOURCE_PATHS = [
  "firebase.json",
  ".firebaserc",
  "tools/build-hosting.mjs",
  "tools/hosting-build-config.mjs",
  "tools/hosting-deploy-integrity.mjs",
  "tools/hosting-routing-config.mjs",
  "tools/sync-shared-js-wrappers.mjs",
  "tools/sync-vehicle-catalog.mjs",
];

/**
 * Load and parse firebase.json hosting section.
 * @param {string} root
 */
export function loadHostingConfig(root) {
  const raw = fs.readFileSync(path.join(root, "firebase.json"), "utf8");
  const json = JSON.parse(raw);
  if (!json.hosting) {
    throw new Error("firebase.json is missing a hosting section");
  }
  return json.hosting;
}

/**
 * Normalize a URL path for comparison (trailing slash stripped except root).
 * @param {string} pathname
 */
export function normalizePath(pathname) {
  if (!pathname || pathname === "/") return "/";
  const trimmed = pathname.replace(/\/+$/, "");
  return trimmed || "/";
}

/**
 * Conservative Firebase Hosting glob match for redirect/rewrite sources.
 * Supports `**` splats used in firebase.json.
 * @param {string} pattern
 * @param {string} requestPath
 */
export function hostingSourceMatches(pattern, requestPath) {
  const pathOnly = requestPath.split("?")[0].split("#")[0];
  if (pattern === "**") return true;
  if (pattern === pathOnly) return true;

  // Trailing-slash normalization: /partner matches /partner/ and vice versa.
  if (normalizePath(pattern) === normalizePath(pathOnly)) return true;

  if (pattern.endsWith("/**")) {
    const base = pattern.slice(0, -3);
    if (pathOnly === base || pathOnly === `${base}/`) return true;
    if (pathOnly.startsWith(`${base}/`)) return true;
  }

  return false;
}

/**
 * Resolve redirect destination for a request path (supports :splat).
 * @param {string} destination
 * @param {string} requestPath
 * @param {string} sourcePattern
 */
export function resolveRedirectDestination(destination, requestPath, sourcePattern) {
  if (!destination.includes(":splat")) return destination;
  const pathOnly = requestPath.split("?")[0];
  const base = sourcePattern.endsWith("/**") ? sourcePattern.slice(0, -3) : sourcePattern;
  const splat = pathOnly.startsWith(`${base}/`) ? pathOnly.slice(base.length + 1) : "";
  return destination.replace(/:splat/g, splat);
}

/**
 * Detect redirect rules that can send a protected path to itself (ERR_TOO_MANY_REDIRECTS).
 * @param {Array<{source:string, destination:string, type?:number}>} redirects
 */
export function findSelfRedirectViolations(redirects = []) {
  const violations = [];

  for (const rule of redirects) {
    const type = rule.type ?? 301;
    if (type !== 301 && type !== 302) continue;

    for (const probePath of PROTECTED_ROUTE_VARIANTS) {
      if (!hostingSourceMatches(rule.source, probePath)) continue;

      const resolved = resolveRedirectDestination(rule.destination, probePath, rule.source);
      if (normalizePath(resolved) === normalizePath(probePath)) {
        violations.push({
          probePath,
          source: rule.source,
          destination: rule.destination,
          resolvedDestination: resolved,
          reason: "redirect destination equals request path (self-redirect)",
        });
      }
    }
  }

  return violations;
}

/**
 * Protected surfaces must not have dedicated redirect rules; rewrites handle them.
 * @param {Array<{source:string, destination:string}>} redirects
 */
export function findProtectedSurfaceRedirectRules(redirects = []) {
  const violations = [];
  for (const rule of redirects) {
    for (const slug of PROTECTED_APP_SLUGS) {
      const isProtectedSource =
        rule.source === `/${slug}` ||
        rule.source === `/${slug}/` ||
        rule.source === `/${slug}/**` ||
        rule.source.startsWith(`/${slug}/`);
      if (isProtectedSource) {
        violations.push({
          source: rule.source,
          destination: rule.destination,
          reason: `protected surface /${slug} must use rewrite-only routing (no redirects)`,
        });
        break;
      }
    }
  }
  return violations;
}

/**
 * Simulate redirect chain for a request path against committed hosting config.
 * @param {string} requestPath
 * @param {object} hosting
 */
export function simulateRedirectChain(requestPath, hosting) {
  const hops = [];
  let current = requestPath;
  const seen = new Set();

  for (let i = 0; i <= MAX_REDIRECT_CHAIN; i++) {
    const key = normalizePath(current);
    if (seen.has(key)) {
      return { hops, terminal: false, loop: true, finalPath: current };
    }
    seen.add(key);

    const rule = (hosting.redirects || []).find((r) =>
      hostingSourceMatches(r.source, current)
    );
    if (!rule) {
      return { hops, terminal: true, loop: false, finalPath: current };
    }

    const next = resolveRedirectDestination(rule.destination, current, rule.source);
    hops.push({ from: current, to: next, type: rule.type ?? 301, source: rule.source });
    current = next;
  }

  return { hops, terminal: false, loop: true, finalPath: current };
}

/**
 * Validate hosting config against rewrite-only protected routing policy.
 * @param {object} hosting
 */
export function analyzeHostingRouting(hosting) {
  const selfRedirects = findSelfRedirectViolations(hosting.redirects || []);
  const protectedRedirects = findProtectedSurfaceRedirectRules(hosting.redirects || []);
  const chainViolations = [];

  for (const probePath of ROUTING_PROBE_PATHS) {
    const chain = simulateRedirectChain(probePath, hosting);
    if (chain.loop) {
      chainViolations.push({
        probePath,
        hops: chain.hops,
        reason: "redirect chain loops or exceeds bounded hop count",
      });
    }
  }

  const rewrites = hosting.rewrites || [];
  const requiredRewriteTargets = [
    ["/partner", "/partner/index.html"],
    ["/partner/**", "/partner/index.html"],
    ["/owner", "/owner/index.html"],
    ["/owner/**", "/owner/index.html"],
    ["/admin", "/admin/index.html"],
    ["/admin/**", "/admin/index.html"],
    ["/customer", "/customer/index.html"],
    ["/customer/**", "/customer/index.html"],
    ["**", "/index.html"],
  ];

  const missingRewrites = requiredRewriteTargets.filter(([source, destination]) => {
    return !rewrites.some((r) => r.source === source && r.destination === destination);
  });

  return {
    ok:
      selfRedirects.length === 0 &&
      protectedRedirects.length === 0 &&
      chainViolations.length === 0 &&
      missingRewrites.length === 0,
    selfRedirects,
    protectedRedirects,
    chainViolations,
    missingRewrites,
  };
}
