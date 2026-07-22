/**
 * Support contact numbers — change these for production.
 * Phone: E.164 without spaces. WhatsApp: digits only (country code + number).
 */
export const SUPPORT = {
  phoneE164: "+923001234567",
  whatsappDigits: "923001234567",
};

export function phoneHref() {
  return `tel:${SUPPORT.phoneE164}`;
}

export function whatsappHref(message = "") {
  const base = `https://wa.me/${SUPPORT.whatsappDigits}`;
  if (!message) return base;
  return `${base}?text=${encodeURIComponent(message)}`;
}
