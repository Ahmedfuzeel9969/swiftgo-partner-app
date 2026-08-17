# P2P Communication — Emergency Debug Report

**Date:** 2026-08-04  
**Status:** FIX READY — **NOT DEPLOYED** (awaiting real-device proof)  
**Scope:** Communication only (no ride/location/Firebase/billing/diagnostics changes beyond DC receive path)

---

## First break point (evidence)

```
Driver UI → Comm session → DataChannel.send  ✅ (when P2P open)
     → Customer DataChannel.onmessage       ✅
     → peekCommType("comm_text")            ✅
     → commHandlers.forEach(...)            ❌ STOPPED HERE
     → Conversation session / UI            (never reached)
```

**Root cause:** Contact UI was often created **before** the WebRTC DataChannel existed.  
`createCommTransport()` returned `null` → no `subscribe()` → `commHandlers` stayed **empty**.  
Customer never rebound on channel open → inbound `comm_*` frames were **dropped**.

Automated loopback tests always subscribed both sides first, so they stayed green while phones failed.

**Secondary risk (Android):** `binaryType = "blob"` + `String(blob)` can corrupt payloads on some WebViews.  
Fixed by decoding `ArrayBuffer` / `Blob` via `TextDecoder`.

---

## Minimal fix

| Change | Why |
|--------|-----|
| `onChannelOpen` → `syncRideCommChat` / `syncDriverRideCommChat` | Bind/subscribe as soon as DC opens |
| Contact panel `onOpen` + send refresh/retry | Catch late bind when user opens Contact |
| Robust DC `onmessage` decode | Android Blob/ArrayBuffer safety |
| `window.__SWIFTGO_COMM_TRACE__` | Field evidence ring (not diagnostics module) |

---

## Lab verification (this machine)

| Suite | Result |
|-------|--------|
| Device-path reproduction | **13/13 PASS** |
| Phase 1–4 comm | **81/81 PASS** |

Report: `tests/p2p-comm-device-path-report.json`

---

## Field proof checklist (TWO Android phones)

**Do not treat this as done until phones pass.**

1. Hard-refresh both apps after hosting deploy (when approved).
2. Start a live assigned ride; wait until map location moves (P2P up).
3. Open **Contact** on both.
4. In Chrome remote debug (optional): `copy(__SWIFTGO_COMM_TRACE__)`

### Text
- Driver sends: `Hello` → Customer shows `Hello`
- Customer sends: `OK` → Driver shows `OK`
- Expect status → `delivered` after ACK

### Voice note
- Driver hold-to-talk → Customer can play
- Customer hold-to-talk → Driver can play

### Voice call
- Driver 📞 → Customer Accept → both hear
- Mute / Speaker / End both directions

### Trace healthy pattern
```
comm_subscribe (handlers≥1) → dc_out → dc_in (handlers≥1) → ui_recv_text
```
Bad pattern (old bug):
```
dc_in_dropped_no_handler
```

### Regression spot-check
- Live location still moves  
- Ride status buttons still work  
- No new Firebase chat collections (comm stays on DC)

---

## Deployment

| Action | Status |
|--------|--------|
| `npm run build:hosting` | Done (local `hosting-dist/`) |
| `firebase deploy --only hosting` | **BLOCKED** until phone proof |

---

## Next step

Approve a **hosting-only** deploy for field test, then re-run the checklist on two phones.  
If all three features pass both ways → production confirm + final report.  
If not → paste `__SWIFTGO_COMM_TRACE__` from both devices and STOP for the next fix.
