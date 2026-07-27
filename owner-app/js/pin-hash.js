/**
 * Client-side PIN hash (must match functions/pin-security.js).
 */

const PIN_PEPPER = "swiftgo-phase2b-pin-v1";

export async function hashVehiclePin(pin) {
  const normalized = String(pin || "").trim();
  const data = new TextEncoder().encode(`${PIN_PEPPER}:${normalized}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
