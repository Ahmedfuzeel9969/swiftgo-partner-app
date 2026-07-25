/**
 * Support contact numbers — change these for production.
 * Phone: E.164 without spaces (missed-call / fallback dial).
 * WhatsApp: digits only (country code + number), no leading +.
 */
export const SUPPORT = {
  phoneE164: "+923032908936",
  whatsappNumbers: [
    { digits: "923032908936", label: "0303 2908936" },
    { digits: "923332119714", label: "0333 2119714" },
  ],
};

/** @deprecated use whatsappNumbers[0]; kept for single-link callers */
export const whatsappDigits = SUPPORT.whatsappNumbers[0].digits;

export function phoneHref() {
  return `tel:${SUPPORT.phoneE164}`;
}

export function whatsappHref(message = "", index = 0) {
  const entry = SUPPORT.whatsappNumbers[index] || SUPPORT.whatsappNumbers[0];
  const base = `https://wa.me/${entry.digits}`;
  if (!message) return base;
  return `${base}?text=${encodeURIComponent(message)}`;
}

export function whatsappEntries() {
  return SUPPORT.whatsappNumbers.slice();
}
