# Phase 6 — Breadcrumb batching & shadow distance (local notes)

## Scope
Dense raw-GPS breadcrumb batches during `in_progress` only. Shadow chord distance is **diagnostic**; fare, wallet, earnings, and settlement continue to use existing sparse `traveledDistanceKm` / fare fields.

## Local queue
- Mechanism: IndexedDB (`swiftgo_breadcrumb_v1`) with in-memory fallback if IDB unavailable.
- **Not** localStorage.
- Partition key: `rideId|driverId|vehicleId|assignmentVersion|trackingSessionId`.
- Bounds: `BREADCRUMB_MAX_QUEUE_POINTS` (180), `BREADCRUMB_MAX_QUEUE_BYTES` (80_000).
- Retention: `BREADCRUMB_QUEUE_RETENTION_MS` (2 hours) then purge.
- Acknowledged batches removed promptly; terminal / sign-out / mismatch purges.

## Device encryption
Browsers/OS may encrypt profile storage at rest depending on platform settings. **This phase does not implement application-level encryption or key management** for the breadcrumb queue. Do not claim app-level encryption.

## Server retention (proposed; not activated)
- Collection: `rideBreadcrumbTelemetry/{rideId}` — aggregate only (no per-point docs).
- Proposed evaluation retention: delete or archive shadow docs after controlled evaluation window (e.g. 7–30 days).
- **Do not enable Firestore TTL billing** without explicit approval.

## Callable
`submitRideBreadcrumbBatch` — Admin SDK writes only; client rules deny get/list/create/update/delete.
