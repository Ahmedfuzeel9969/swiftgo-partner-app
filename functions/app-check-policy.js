"use strict";

/**
 * Firebase callable options require a resolved literal boolean for enforceAppCheck.
 * A BooleanParam object is truthy even when its configured value is false.
 * The CLI still declares/defaults the parameter; its resolved environment value
 * is parsed at cold start, before the SDK constructs the callable middleware.
 */
function readAppCheckEnforcement(env = process.env) {
  const value = env.ENFORCE_APP_CHECK;
  if (value === undefined || value === "false") return false;
  if (value === "true") return true;
  throw new Error("INVALID_ENFORCE_APP_CHECK: expected true or false");
}

module.exports = { readAppCheckEnforcement };
