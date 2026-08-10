/**
 * Canonical auth/surface routing policy — pure functions for tests and documentation.
 * Does not perform redirects; apps implement these outcomes locally.
 */

export const SUPER_ADMIN_BOOTSTRAP_EMAIL = "fuzail1158@gmail.com";

export const APP_SURFACES = Object.freeze({
  customer: "/",
  partner: "/partner/",
  owner: "/owner/",
  admin: "/admin/",
});

/** Maximum cross-surface redirects allowed for one auth/navigation event. */
export const MAX_AUTH_REDIRECT_HOPS = 1;

/** Partner roles allowed to enter the driver/partner surface. */
export const PARTNER_SURFACE_ROLES = Object.freeze(["driver", "owner"]);

/** Partner roles normalized before partner-surface entry. */
export const PARTNER_NORMALIZE_ROLES = Object.freeze({
  admin_driver: "driver",
});

/**
 * Role precedence by surface (documented — apps must not silently promote):
 *
 * Customer (/):
 *   - Firebase Auth session only; no partners/users role gate for routing.
 *
 * Partner (/partner/):
 *   1. partners/{uid}.accountStatus === "blocked" → blocked overlay (stay)
 *   2. partners/{uid}.role missing → merge-create role "driver" (first visit only)
 *   3. partners/{uid}.role === "admin_driver" → normalize to "driver" in Firestore
 *   4. partners/{uid}.role ∈ {driver, owner} → enter partner app (stay on /partner/)
 *   5. any other partners role → login error overlay (stay, no cross-surface redirect)
 *   - Firebase Auth custom claims and users/{uid}.role are NOT used for partner routing.
 *
 * Owner (/owner/):
 *   1. partners/{uid}.accountStatus === "blocked" → blocked overlay
 *   2. partners/{uid} missing role → merge-create role "owner" (first visit only)
 *   3. any signed-in partner → stay on /owner/ (never auto-bounce to /partner/)
 *   - Explicit user action may navigate to /partner/ or /admin/ (max one hop).
 *
 * Admin (/admin/):
 *   1. Firebase Auth custom claim admin === true (token or reloadUserInfo)
 *   2. else bootstrap email SUPER_ADMIN_BOOTSTRAP_EMAIL when emailVerified
 *   3. users/{uid}.role is set server-side for audit/rules — NOT a client routing gate
 *   4. unauthorized → signOut + at most one redirect to /partner/
 *   - partners/{uid}.role does not grant /admin/ access.
 */

/**
 * @param {object} input
 * @param {"customer"|"partner"|"owner"|"admin"} input.surface
 * @param {string|null|undefined} input.partnerRole
 * @param {string|null|undefined} input.accountStatus
 * @param {boolean} [input.signedIn]
 */
export function resolveSurfaceEntry(input) {
  const surface = input.surface;
  const signedIn = Boolean(input.signedIn);
  const partnerRole = String(input.partnerRole || "").trim();
  const accountStatus = String(input.accountStatus || "").trim();

  if (!signedIn) {
    return { outcome: "login_ui", redirect: null, reason: "signed_out" };
  }

  if (accountStatus === "blocked") {
    return { outcome: "blocked_overlay", redirect: null, reason: "account_blocked" };
  }

  if (surface === "customer") {
    return { outcome: "app_shell", redirect: null, reason: "customer_no_role_gate" };
  }

  if (surface === "partner") {
    const normalized =
      partnerRole in PARTNER_NORMALIZE_ROLES
        ? PARTNER_NORMALIZE_ROLES[partnerRole]
        : partnerRole;
    if (PARTNER_SURFACE_ROLES.includes(normalized)) {
      return {
        outcome: "app_shell",
        redirect: null,
        reason: normalized === partnerRole ? "partner_role_allowed" : "partner_role_normalized",
        normalizedPartnerRole: normalized,
      };
    }
    if (!partnerRole) {
      return { outcome: "provision_driver", redirect: null, reason: "missing_partner_role" };
    }
    return { outcome: "login_error", redirect: null, reason: "invalid_partner_role" };
  }

  if (surface === "owner") {
    if (!partnerRole) {
      return { outcome: "provision_owner", redirect: null, reason: "missing_partner_role" };
    }
    return { outcome: "app_shell", redirect: null, reason: "owner_surface_stay" };
  }

  return { outcome: "login_ui", redirect: null, reason: "unknown_surface" };
}

/**
 * @param {object} input
 * @param {boolean} [input.signedIn]
 * @param {boolean} [input.adminClaim]
 * @param {string|null|undefined} input.email
 * @param {boolean} [input.emailVerified]
 */
export function resolveAdminAccess(input) {
  if (!input.signedIn) {
    return { authorized: false, reason: "signed_out", denyRedirect: null };
  }
  if (input.adminClaim === true) {
    return { authorized: true, reason: "admin_claim", denyRedirect: null };
  }
  const email = String(input.email || "")
    .trim()
    .toLowerCase();
  if (email === SUPER_ADMIN_BOOTSTRAP_EMAIL && input.emailVerified !== false) {
    return { authorized: true, reason: "bootstrap_email", denyRedirect: null };
  }
  return {
    authorized: false,
    reason: "not_super_admin",
    denyRedirect: APP_SURFACES.partner,
  };
}

/**
 * Validates an explicit cross-surface redirect plan.
 * @param {object} input
 * @param {string} input.fromPath
 * @param {string} input.toPath
 * @param {string} input.trigger
 */
export function validateCrossSurfaceRedirect(input) {
  const fromPath = normalizeUrlPath(input.fromPath);
  const toPath = normalizeUrlPath(input.toPath);
  if (fromPath === toPath) {
    return { allowed: false, selfRedirect: true, reason: "self_redirect" };
  }
  const allowedEdges = [
    ["admin", "partner", "admin_deny_signout"],
    ["owner", "partner", "owner_select_driver_role"],
    ["owner", "admin", "owner_return_from_admin_driver_mode"],
  ];
  const fromSurface = pathToSurface(fromPath);
  const toSurface = pathToSurface(toPath);
  const ok = allowedEdges.some(
    ([from, to, trigger]) =>
      from === fromSurface && to === toSurface && trigger === input.trigger
  );
  return {
    allowed: ok,
    selfRedirect: false,
    reason: ok ? "allowed_edge" : "unexpected_cross_surface_redirect",
  };
}

/**
 * Simulate redirect chain termination for auth-related navigation.
 * @param {Array<{from:string,to:string}>} hops
 */
export function analyzeRedirectChain(hops, maxHops = MAX_AUTH_REDIRECT_HOPS) {
  const seen = new Set();
  for (const hop of hops) {
    const from = normalizeUrlPath(hop.from);
    const to = normalizeUrlPath(hop.to);
    if (from === to) {
      return { ok: false, loop: true, reason: "self_redirect", hops: hops.length };
    }
    if (seen.has(to)) {
      return { ok: false, loop: true, reason: "redirect_loop", hops: hops.length };
    }
    seen.add(to);
  }
  if (hops.length > maxHops) {
    return { ok: false, loop: true, reason: "hop_limit_exceeded", hops: hops.length };
  }
  return { ok: true, loop: false, reason: "terminates", hops: hops.length };
}

export function normalizeUrlPath(pathname) {
  if (!pathname || pathname === "/") return "/";
  const noQuery = String(pathname).split("?")[0].split("#")[0];
  if (noQuery.length > 1 && noQuery.endsWith("/")) return noQuery.slice(0, -1);
  return noQuery;
}

function pathToSurface(pathname) {
  const p = normalizeUrlPath(pathname);
  if (p === "/" || p.startsWith("/customer")) return "customer";
  if (p.startsWith("/partner")) return "partner";
  if (p.startsWith("/owner")) return "owner";
  if (p.startsWith("/admin")) return "admin";
  return "unknown";
}

/**
 * When Auth claim and Firestore partner role disagree, routing must follow
 * surface-local rules without silent promotion.
 */
export function resolveClaimDocumentDisagreement(input) {
  const { surface, adminClaim, partnerRole, usersRole } = input;
  if (surface === "admin") {
    return resolveAdminAccess({
      signedIn: true,
      adminClaim,
      email: input.email,
      emailVerified: input.emailVerified,
    });
  }
  if (surface === "partner") {
    return resolveSurfaceEntry({
      surface: "partner",
      signedIn: true,
      partnerRole,
      accountStatus: input.accountStatus,
    });
  }
  if (surface === "owner") {
    return resolveSurfaceEntry({
      surface: "owner",
      signedIn: true,
      partnerRole,
      accountStatus: input.accountStatus,
    });
  }
  return {
    outcome: "app_shell",
    redirect: null,
    reason: "customer_ignores_users_role",
    note: usersRole ? "users.role ignored on customer surface" : "no_users_role",
  };
}
