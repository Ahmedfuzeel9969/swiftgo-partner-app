# P2P Pipeline Root-Cause Report

**Status:** Investigation complete — no speculative fixes applied.  
**Scope:** Offer → Answer → ICE → DataChannel → Healthy → First packet  
**Excluded:** Chat / Voice / Call UI, Firebase business logic, Ride Flow, Billing, Location policy, Diagnostics UI.

---

## Verdict

**The WebRTC session fails after signaling (`p2p_answer_ready`) and before DataChannel open / first packet.**

Failed stage (from field evidence + code):

> **ICE connectivity → DataChannel open**

Communication modules are **not** the root cause: they never receive a live transport when this pipeline stalls.

---

## Field evidence (operator)

| Side | Observation | Meaning |
|------|-------------|---------|
| Customer | `p2p_answer_ready` | Local answer created & published — signaling reached “answer ready” |
| Customer | `p2p_firebase_fallback` | Session left CONNECTING into Firebase backup |
| Customer | `lastSendAt=null`, `lastRecvAt=null` | Field diag never saw P2P send/recv |
| Customer | P2P sends=0 / receives=0 | No DataChannel traffic |
| Driver | `driver_p2p_unhealthy` | Peer session never reached `P2P_HEALTHY` |
| Driver | `authUidPresent=false` | Anomalous for a live assigned ride dump — see Hypothesis B |

Absent from reports (critical):

- No `p2p_channel_open`
- No `p2p_healthy`
- No `p2p_first_valid_fix` / heartbeat activity

That pattern matches **DC never opened** (or opened/closed with zero frames — less likely given zero counters).

---

## Pipeline map (code)

```
Driver                          Signaling (Firebase)              Customer
──────                          ────────────────────              ────────
createPC + createDataChannel
createOffer + setLocalDesc
waitIceComplete (≤4s)
publish offer  ──────────────►  offer doc
                                                                  setRemoteDescription(offer)
                                                                  createAnswer + setLocalDesc
                                                                  waitIceComplete (≤4s)
                    ◄────────── publish answer                    ANSWER_READY ✓ (observed)
acceptRemoteAnswer(answer)      ← must happen
ICE checks both sides
DataChannel onopen  ──────────► CHANNEL_OPEN
heartbeat / loc / ack           ──────────────────────────────►   first packet
evaluateHealth → P2P_HEALTHY
```

Non-trickle ICE: SDP is published only after `waitIceComplete` (complete **or** 4s timeout).  
Default ICE: **STUN only** (`hasTurn: false` unless `__SWIFTGO_P2P_ICE__.turn` is injected).

---

## Why `firebase_fallback` can fire without Channel Open

Customer health poll (`evaluateHealth` silence → fallback) starts **only** in `channel.onopen`.

Therefore, with **no** `p2p_channel_open`, customer `p2p_firebase_fallback` after `answer_ready` must come from one of:

1. `iceConnectionState === "failed"` → `FIREBASE_FALLBACK` (`ice_connection_failed`)
2. `connectionState === "failed"` → `FIREBASE_FALLBACK` (`pc_connection_failed`)
3. DataChannel `onerror` / `onclose` after wire (would still imply a channel object existed)
4. Early abort paths (bad SDP / RTC unavailable) — **ruled out** once `answer_ready` fired
5. `suspend()` — secondary; not indicated by the reported codes alone

So the code path that matches the field dump is: **post-answer ICE / PC failure (or never completing ICE)** → fallback, **without** ever emitting `CHANNEL_OPEN`.

---

## Root-cause hypotheses (ordered)

### A — Primary: ICE never connects (STUN-only / carrier NAT)

**Why it fits**

- Answer signaling succeeded on customer.
- Zero P2P packets; no channel-open breadcrumb.
- Default config is public STUN; **no TURN** unless injected.
- Two Android phones on cellular often sit behind symmetric / CGNAT where host+srflx candidates cannot form a working pair without a relay.

**Why not proven yet**

- Field dumps did not previously record `iceConnectionState` transitions or gather timeout vs complete.

### B — Secondary: Driver never applied remote answer

**Why it fits**

- Customer can reach `ANSWER_READY` and publish answer while driver still has only a local offer.
- Without `setRemoteDescription(answer)` on the driver, ICE cannot complete → customer ICE eventually fails → fallback.
- Driver dump `authUidPresent=false` is suspicious: answer watch / signaling attach may not run correctly in that context.

**Why not proven yet**

- No prior breadcrumb for `answer_applied` vs `answer_apply_skipped`.

### C — Ruled out as root cause for *this* evidence

| Claim | Why ruled out |
|-------|----------------|
| Chat / voice / call modules | Require open DC; never reached |
| Comm subscribe / UI binding | Same — post-`CHANNEL_OPEN` |
| “Messages fail but P2P location healthy” | Evidence shows P2P never healthy / no packets |
| Offer creation failure | Customer applied offer and answered |
| First-packet protocol bugs | No channel ⇒ no packets to decode |

---

## Instrumentation added (diag only — not deployed)

Files:

- `driver-app/js/p2p-protocol.mjs` / `customer-app/js/p2p-protocol.mjs` — pipeline `P2P_DIAG` codes
- `driver-app/js/p2p-peer-session.mjs` / `customer-app/js/p2p-peer-session.mjs` — stage probes

Every stage now emits into `window.__SWIFTGO_P2P_PIPELINE__` (ring, no SDP/IP PII) and matching `p2p_pipeline_*` diag codes:

| Stage | Ring `stage` | Distinguishes |
|-------|--------------|---------------|
| ICE config | `ice_config` | `hasStun` / `hasTurn` |
| Local / remote SDP applied | `local_desc` / `remote_desc` | type + candidate **counts** only |
| ICE gather | `ice_gathering` / `ice_gather_done` / `ice_gather_timeout` | complete vs 4s timeout |
| Answer applied (driver) | `answer_applied` / `answer_apply_skipped` / `answer_apply_error` | Hypothesis B |
| ICE / PC state | `ice_connection` / `connection_state` | Hypothesis A |
| DC create / open / close / error | `dc_*` | Channel stage |
| First packet in/out | `first_packet_*` | Healthy path entry |
| Fallback | `fallback` + `reason` | Exact exit cause |

**Field capture (next run, after deploy of instrumentation only):**

```js
copy(JSON.stringify(window.__SWIFTGO_P2P_PIPELINE__, null, 2))
```

on **both** phones after failure.

### Decision table for next dump

| Pipeline pattern | Conclusion |
|------------------|------------|
| Customer: `answer_ready` → `ice_connection:failed` (never `dc_open`); Driver: **no** `answer_applied` | **B** — answer not applied on driver |
| Customer: `answer_ready` → `ice_connection:failed`; Driver: `answer_applied` then ICE failed; `hasTurn:false` | **A** — ICE/NAT (STUN insufficient) |
| Either side: `ice_gather_timeout` with `candidates.srflx=0` | Gather/STUN failure before connect |
| Either side: `dc_open` then `first_packet_*` then fallback | Failure moved **after** this report’s window (re-open investigation) |

---

## What was deliberately not done

- No TURN enablement / ICE redesign  
- No Chat / Voice / Call / Firebase / Ride Flow / Billing / Location / Diagnostics changes  
- No hosting deploy (instrumentation is local until you authorize)  
- No speculative “fix” PR  

---

## STOP

Root-cause report complete.  
Next step when you authorize: deploy **instrumentation only**, capture `__SWIFTGO_P2P_PIPELINE__` from both phones, then lock Hypothesis A vs B from the decision table.
