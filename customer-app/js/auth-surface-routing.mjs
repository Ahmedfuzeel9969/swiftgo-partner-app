/**
 * Canonical auth/surface routing policy — single source used by apps and tests.
 * Pure functions only; apps apply outcomes (UI, setDoc) locally.
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

/** Partner roles allowed to enter the owner dashboard surface. */
export const OWNER_SURFACE_ROLES = Object.freeze(["owner"]);

/** Legacy god-mode role — super admin driver mode only, not owner dashboard by itself. */
export const OWNER_ADMIN_DRIVER_ROLE = "admin_driver";

/** Partner roles normalized before partner-surface entry. */
export const PARTNER_NORMALIZE_ROLES = Object.freeze({
  admin_driver: "driver",
});

/**
 * Role precedence by surface:
 *
 * Customer (/): Firebase Auth session only — no partners role gate.
 *
 * Partner (/partner/):
 *   1. partners/{uid}.accountStatus blocked/suspended → blocked overlay
 *   2. missing partners doc/role → client may create role "driver" (driver onboarding only)
 *   3. admin_driver → normalize to driver in Firestore
 *   4. role ∈ {driver, owner} → enter partner app (owner-as-driver allowed by product policy)
 *   5. other roles → login error, stay on surface
 *
 * Owner (/owner/):
 *   1. blocked/suspended → blocked overlay
 *   2. role === "owner" → owner dashboard
 *   3. role === admin_driver AND super-admin bootstrap identity → admin driver mode shell only
 *   4. driver, missing role, invalid role, customer-only → login denied (NO client role writes)
 *
 * Admin (/admin/):
 *   1. admin custom claim
 *   2. else verified bootstrap super-admin email
 *   3. users/{uid}.role is server-side audit only — not a client gate
 *   4. unauthorized → signOut + at most one redirect to /partner/
 */

function isBlockedStatus(accountStatus) {
  return accountStatus === "blocked" || accountStatus === "suspended";
}

/**
 * @param {object} input
 * @param {"customer"|"partner"|"owner"|"admin"} input.surface
 * @param {string|null|undefined} input.partnerRole
 * @param {string|null|undefined} input.accountStatus
 * @param {boolean} [input.signedIn]
 * @param {boolean} [input.superAdminBootstrap]
 * @param {boolean} [input.partnerDocExists]
 */
export function resolveSurfaceEntry(input) {
  const surface = input.surface;
  const signedIn = Boolean(input.signedIn);
  const partnerRole = String(input.partnerRole || "").trim();
  const accountStatus = String(input.accountStatus || "").trim();
  const partnerDocExists = input.partnerDocExists !== false;

  if (!signedIn) {
    return { outcome: "login_ui", redirect: null, reason: "signed_out", allowRoleWrite: false };
  }

  if (isBlockedStatus(accountStatus)) {
    return {
      outcome: "blocked_overlay",
      redirect: null,
      reason: accountStatus === "suspended" ? "account_suspended" : "account_blocked",
      allowRoleWrite: false,
    };
  }

  if (surface === "customer") {
    return {
      outcome: "app_shell",
      redirect: null,
      reason: "customer_no_role_gate",
      allowRoleWrite: false,
    };
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
        allowRoleWrite: false,
      };
    }
    if (!partnerDocExists || !partnerRole) {
      return {
        outcome: "provision_driver",
        redirect: null,
        reason: "missing_partner_role",
        allowRoleWrite: true,
        provisionRole: "driver",
      };
    }
    return {
      outcome: "login_error",
      redirect: null,
      reason: "invalid_partner_role",
      allowRoleWrite: false,
    };
  }

  if (surface === "owner") {
    if (!partnerDocExists || !partnerRole) {
      return {
        outcome: "login_denied",
        redirect: null,
        reason: "missing_owner_role",
        allowRoleWrite: false,
      };
    }
    if (OWNER_SURFACE_ROLES.includes(partnerRole)) {
      return {
        outcome: "app_shell",
        redirect: null,
        reason: "owner_role_allowed",
        allowRoleWrite: false,
      };
    }
    if (
      partnerRole === OWNER_ADMIN_DRIVER_ROLE &&
      input.superAdminBootstrap === true
    ) {
      return {
        outcome: "admin_driver_mode",
        redirect: null,
        reason: "super_admin_admin_driver_mode",
        allowRoleWrite: false,
      };
    }
    return {
      outcome: "login_denied",
      redirect: null,
      reason: partnerRole === "driver" ? "driver_not_owner_surface" : "invalid_owner_role",
      allowRoleWrite: false,
    };
  }

  return { outcome: "login_ui", redirect: null, reason: "unknown_surface", allowRoleWrite: false };
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

export function isSuperAdminBootstrapEmail(email) {
  return (
    String(email || "")
      .trim()
      .toLowerCase() === SUPER_ADMIN_BOOTSTRAP_EMAIL
  );
}

/**
 * Validates an explicit cross-surface redirect plan.
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
      partnerDocExists: input.partnerDocExists,
    });
  }
  if (surface === "owner") {
    return resolveSurfaceEntry({
      surface: "owner",
      signedIn: true,
      partnerRole,
      accountStatus: input.accountStatus,
      partnerDocExists: input.partnerDocExists,
      superAdminBootstrap: isSuperAdminBootstrapEmail(input.email),
    });
  }
  return {
    outcome: "app_shell",
    redirect: null,
    reason: "customer_ignores_users_role",
    allowRoleWrite: false,
    note: usersRole ? "users.role ignored on customer surface" : "no_users_role",
  };
}
