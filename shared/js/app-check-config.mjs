// Public site key, not a secret. Configure in a reviewed staging release first.
// Do not enable ENFORCE_APP_CHECK on the server until every supported app/device
// has passed attestation in staging. Native shells need a validated provider too.
export const APP_CHECK_CONFIG = Object.freeze({ siteKey: "" });
