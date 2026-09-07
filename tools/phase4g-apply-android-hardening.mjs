/** Retired version-resetting mutator. This command now only verifies source hardening. */
import { verifyMobileSources } from "./mobile-verify.mjs";
console.log(JSON.stringify(verifyMobileSources()));
