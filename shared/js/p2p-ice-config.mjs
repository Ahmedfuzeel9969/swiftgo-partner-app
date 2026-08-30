// Browser-safe ICE URL validation. Port 53 is blocked by browsers and delays
// bundled non-trickle gathering; never include it in a browser configuration.
export function normalizeIceUrl(raw, kind = "turn") {
  if (typeof raw !== "string" || raw.length > 512) return null;
  const url = raw.trim();
  const match = /^(stuns?|turns?):([A-Za-z0-9.-]+|\[[A-Fa-f0-9:]+\])(?::(\d{1,5}))?(?:\?transport=(udp|tcp))?$/.exec(url);
  if (!match || !match[1].startsWith(kind)) return null;
  const port = match[3] ? Number(match[3]) : null;
  if (port != null && (port < 1 || port > 65535 || port === 53)) return null;
  if (match[1] === "turns" && match[4] === "udp") return null;
  return url;
}

export function normalizeTurnServer(turn) {
  if (!turn || typeof turn.username !== "string" || typeof turn.credential !== "string" ||
      !turn.username || !turn.credential || turn.username.length > 1024 || turn.credential.length > 2048) return null;
  const urls = [...new Set([turn.urls].flat().map((u) => normalizeIceUrl(u)).filter(Boolean))].slice(0, 8);
  return urls.length ? { urls, username: turn.username, credential: turn.credential } : null;
}
