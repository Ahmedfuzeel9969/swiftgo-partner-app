/** Shared Hosting build constants — safe to import without running a build. */

export const SHARED_JS_MODULES = [
  "geometry-quality.mjs",
  "marker-heading.mjs",
  "route-geometry.mjs",
  "road-route-provider.mjs",
  "two-leg-route-controller.mjs",
  "two-leg-route-layers.mjs",
  "route-projection.mjs",
  "route-progress.mjs",
  "route-motion-controller.mjs",
  "off-route-detector.mjs",
  "display-location-pipeline.mjs",
  "breadcrumb-schema.mjs",
  "vehicle-catalog.mjs",
  "idle-publish-config.mjs",
  "location-reporting-config.mjs",
  "location-reporting-config-cache.mjs",
  "ride-location-report-schema.mjs",
  "ride-location-local-counter-store.mjs",
  "ride-location-report-client.mjs",
  "ride-location-report-pending-queue.mjs",
];

export const HOSTING_DIST_JS_TARGETS = [
  "js",
  "customer/js",
  "partner/js",
  "owner/js",
  "admin/js",
  "shared/js",
];
