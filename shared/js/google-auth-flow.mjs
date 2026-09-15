export const CANONICAL_AUTH_HOST = "swiftgo-ride-app.firebaseapp.com";
export const AUTH_START_PARAM = "swiftgoGoogleAuth";

const POPUP_FALLBACK_CODES = new Set([
  "auth/popup-blocked",
  "auth/cancelled-popup-request",
  "auth/operation-not-supported-in-this-environment",
]);

export function shouldFallBackToRedirect(error) {
  return POPUP_FALLBACK_CODES.has(String(error?.code || ""));
}

async function signInOnCanonicalHost({
  auth,
  provider,
  signInWithPopup,
  signInWithRedirect,
}) {
  if (typeof signInWithPopup === "function") {
    try {
      await signInWithPopup(auth, provider);
      return "popup";
    } catch (error) {
      if (!shouldFallBackToRedirect(error)) throw error;
    }
  }
  await signInWithRedirect(auth, provider);
  return "redirecting";
}

export function buildCanonicalAuthUrl(currentHref) {
  const url = new URL(currentHref);
  url.protocol = "https:";
  url.hostname = CANONICAL_AUTH_HOST;
  url.port = "";
  url.searchParams.set(AUTH_START_PARAM, "1");
  return url.toString();
}

export function consumeCanonicalAuthStart(locationLike, historyLike) {
  const url = new URL(locationLike.href);
  if (url.hostname !== CANONICAL_AUTH_HOST || url.searchParams.get(AUTH_START_PARAM) !== "1") {
    return false;
  }
  url.searchParams.delete(AUTH_START_PARAM);
  historyLike.replaceState(historyLike.state ?? null, "", url.toString());
  return true;
}

export async function beginCanonicalGoogleSignIn({
  auth,
  provider,
  signInWithPopup,
  signInWithRedirect,
  locationLike = window.location,
}) {
  if (locationLike.hostname !== CANONICAL_AUTH_HOST) {
    locationLike.assign(buildCanonicalAuthUrl(locationLike.href));
    return "navigating";
  }
  return signInOnCanonicalHost({ auth, provider, signInWithPopup, signInWithRedirect });
}

export async function resumeCanonicalGoogleSignIn({
  auth,
  provider,
  signInWithPopup,
  signInWithRedirect,
  locationLike = window.location,
  historyLike = window.history,
}) {
  if (!consumeCanonicalAuthStart(locationLike, historyLike)) return false;
  await signInOnCanonicalHost({ auth, provider, signInWithPopup, signInWithRedirect });
  return true;
}
