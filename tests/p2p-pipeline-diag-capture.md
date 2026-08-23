# P2P Pipeline Investigation — Diagnostic Deploy

**Phase:** P2P Pipeline Investigation  
**Status:** DIAGNOSTIC ONLY deployed — STOP after dual-phone capture.  
**No fixes.** No Chat / Voice / Call / Billing / Location / Ride Flow / Matching / Diagnostics behaviour changes.

## What this deploy adds

Per-device ring + auto Q1–Q8 report:

- `window.__SWIFTGO_P2P_PIPELINE__` — ordered stage events  
- `window.__SWIFTGO_P2P_PIPELINE_REPORT__` — answers Q1–Q8 for **this** phone only

ICE mode is **bundled non-trickle SDP** (unchanged behaviour). Candidate “upload/receive/apply” are counted from SDP + `onicecandidate` (privacy: type/protocol only, no IPs).

## Capture (BOTH Android phones)

After a failed (or any) assigned ride attempt:

```js
copy(JSON.stringify({
  side: location.pathname.includes("partner") ? "driver" : "customer",
  href: location.href,
  report: window.__SWIFTGO_P2P_PIPELINE_REPORT__,
  events: window.__SWIFTGO_P2P_PIPELINE__
}, null, 2))
```

Save as:

- `driver-pipeline.json`
- `customer-pipeline.json`

Do **not** mix devices. Do **not** edit the JSON.

## Questions the report answers (per device)

| Q | Meaning |
|---|--------|
| Q1 | Did Driver apply the Customer Answer? (customer device → UNKNOWN) |
| Q2 | ICE candidates both directions on this device? |
| Q3 | ICE ever connected/completed? |
| Q4 | DataChannel created? |
| Q5 | DataChannel onopen? |
| Q6 | First outbound packet? |
| Q7 | First inbound packet? |
| Q8 | First missing expected stage on this device (no guess) |

Definitive cross-device verdict requires **both** dumps.

## STOP

After both reports are collected → STOP. No speculative fixes.
