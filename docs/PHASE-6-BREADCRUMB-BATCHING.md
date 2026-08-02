# Phase 6 — Breadcrumb batching & shadow distance (local notes)

## Scope
Dense raw-GPS breadcrumb batches during `in_progress` only. Shadow chord distance is **diagnostic only**. It must not become financial truth without a separately approved trust and fraud design.

Fare, wallet, earnings, commission, settlement, partial-cancellation fare, and ride `traveledDistanceKm` continue to use existing sparse checkpoint / fare fields — not breadcrumb shadow aggregates.

## Sampling (cost-aware default)
- High-frequency raw GPS may continue for local map / P2P **display**.
- Breadcrumb telemetry samples approximately **one accepted point every 4 seconds**.
- Target ~15 points per ~60-second batch → about **one callable per minute** when healthy and online.
- Do **not** describe this as 1 Hz server telemetry.
- Intentional sample skips and overflows record gaps; missing time is never invented as distance.

## Local queue
- Mechanism: IndexedDB (`swiftgo_breadcrumb_v1`) with memory fallback only when IDB was never available.
- If IDB fails after durable use, mutations fail safely (privacy-safe `breadcrumb_idb_unavailable`); coverage is marked incomplete — **no silent switch to an empty memory queue**.
- **Not** localStorage.
- Partition key: `rideId|driverId|vehicleId|assignmentSessionToken|trackingSessionId`.
- Bounds: `BREADCRUMB_MAX_QUEUE_POINTS` (180), `BREADCRUMB_MAX_QUEUE_BYTES` (80_000).
- Retention: `BREADCRUMB_QUEUE_RETENTION_MS` (2 hours) then purge.
- Offline catch-up: at most `BREADCRUMB_MAX_UPLOADS_PER_WAKE` (3) upload attempts **per wake tick total** (including the first).
- Normal scheduled timer ticks use `BREADCRUMB_MAX_UPLOADS_PER_SCHEDULED_TICK` (1) — healthy online operation remains about one callable per minute.

## Privacy
- Raw coordinates in the queue **are sensitive location / personal data**.
- The queue does **not** store names, phone numbers, email, addresses, pickup/dropoff text, fare, wallet data, SDP, ICE, authentication tokens, or user-agent strings.
- There is **no application-level encryption** or key management for this queue; browsers/OS may encrypt profile storage at rest depending on platform settings.
- Telemetry is diagnostic and driver-device supplied.

## Assignment binding
- Server writes immutable `rides.assignmentSessionToken` at assignment finalization (Admin/CF only).
- Callable also requires `vehicles.activeRideId === rideId` and matching tracking session.
- Clients cannot choose or mutate the assignment token (ride updates are status-only for drivers).

## Final flush
- Bounded flush (≤4s) runs **before** settlement while ride is still `in_progress`.
- Flush failure never blocks settlement.
- After settlement, local queue is purged without a doomed post-complete upload.
- Terminal snapshots purge locally and do not retry server upload.

## Server retention (proposed; not activated)
- Collection: `rideBreadcrumbTelemetry/{rideId}` — aggregate only (no per-point docs).
- Proposed evaluation retention: 7–30 days.
- **Do not enable Firestore TTL billing** without explicit approval.

## Callable
`submitRideBreadcrumbBatch` — Admin SDK writes only; client rules deny get/list/create/update/delete.
