/**
 * Refuse production Firebase project IDs for business-load runners.
 */
const FORBIDDEN = new Set(["swiftgo-ride-app"]);

export function assertSafeProject(projectId, { allowHostingProbe = false } = {}) {
  const id = String(projectId || "").trim();
  if (!id) {
    throw new Error("Firebase projectId is required");
  }
  if (FORBIDDEN.has(id) && !allowHostingProbe) {
    throw new Error(
      `Refusing to run against production project "${id}". Use a staging project. ` +
        `Hosting-only probes must set allowHostingProbe=true and must not touch Firestore.`
    );
  }
  return id;
}

export function assertNotPublicMapStress(url) {
  const u = String(url || "");
  const banned = [
    "nominatim.openstreetmap.org",
    "router.project-osrm.org",
    "tile.openstreetmap.org",
  ];
  for (const host of banned) {
    if (u.includes(host)) {
      throw new Error(`Refusing stress against public endpoint host: ${host}`);
    }
  }
}
