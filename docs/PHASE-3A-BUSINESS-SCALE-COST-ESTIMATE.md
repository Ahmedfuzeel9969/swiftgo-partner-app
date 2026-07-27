# PHASE 3A — Business-Scale Cost Estimate

**Date accessed (pricing):** 2026-07-27  
**Intended Production region (Functions / default):** `us-central1`  
**Firestore edition assumed:** Standard (document R/W pricing)  
**Currency:** USD list prices; **taxes / PKR conversion not included** (add locally)

### Pricing sources

| Item | Source | Notes |
|---|---|---|
| Firestore Standard free + unit prices | https://cloud.google.com/firestore/pricing , https://firebase.google.com/docs/firestore/standard-edition | Free/day: 50k reads, 20k writes, 20k deletes; stored 1 GiB. Beyond: **$0.03/100k reads**, **$0.09/100k writes**, **$0.01/100k deletes** (us-central1) |
| Cloud Functions invocations (Blaze) | https://firebase.google.com/pricing/ | **2M invocations/month free**, then ~**$0.40 / million** (plus CPU/memory — not fully modelled) |
| Budgets | Google Cloud Billing budgets docs | **Alerts are warnings, not hard spend caps** |

**Uncertainty:** Ride mix, online fraction, admin hours, match scan size, and listener fan-out dominate. Figures are **ranges**, not invoices.

---

## Shared unit model

| Unit | Assumed ops |
|---|---|
| Complete ride (limit 10, light bargain) | ~**63 billable reads** (35 server + 28 listeners), **24 writes**, **5 Function invocations** |
| Complete ride (limit 20, light) | ~**99 reads**, **34 writes**, **5 invocations** |
| Heavy bargain (+3 counters) | +~6 reads, +3 writes, +3 invocations |
| Online driver-day location | **640 writes** (see location model) |
| Ambient admin (logged in, map closed) | **Highly variable** — treat as +10–30% Firestore reads in medium+ scenarios when admin console used |

Default tables below use **candidate limit 10** and **50% of fleet online × 10 h/day** unless noted. Match function still scans all online vehicles — large fleets inflate reads **beyond** the per-ride baseline; an uplift factor is applied in Medium/Large.

---

## Small pilot — 20 drivers, 100 customers

| | Low | Normal | High |
|---|---:|---:|---:|
| Rides / day | 20 | 50 | 100 |
| Online drivers (avg) | 8 | 12 | 16 |
| Location writes / day | ~5.1k | ~7.7k | ~10.2k |
| Ride writes / day | ~0.5k | ~1.2k | ~2.4k |
| Ride reads / day (approx) | ~1.3k | ~3.2k | ~6.3k |
| Function invocations / day | ~100 | ~250 | ~500 |
| **Monthly Firebase ops cost range** | **~$0–5** | **~$0–15** | **~$5–40** |

Mostly inside or near free quotas on quiet days; Hosting/Auth noise dominates perception more than Firestore.

---

## Early operation — 100 drivers, 1,000 customers

| | Low | Normal | High |
|---|---:|---:|---:|
| Rides / day | 100 | 300 | 800 |
| Online drivers | 30 | 50 | 70 |
| Location writes / day | ~19k | ~32k | ~45k |
| Ride-path writes / day | ~2.4k | ~7.2k | ~19k |
| Ride-path reads / day | ~6.3k | ~19k | ~50k |
| Match uplift (scan) | modest | noticeable | material |
| Functions / day | ~0.5k | ~1.5k | ~4k |
| **Monthly cost range (USD)** | **~$15–60** | **~$40–150** | **~$100–350** |

Location alone exceeds free write quota most days once ~30+ drivers stay online.

---

## Medium operation — 1,000 drivers, 10,000 customers

| | Low | Normal | High |
|---|---:|---:|---:|
| Rides / day | 1,000 | 3,000 | 8,000 |
| Online drivers | 200 | 400 | 600 |
| Location writes / day | ~128k | ~256k | ~384k |
| Ride writes / day | ~24k | ~72k | ~192k |
| Ride+match reads / day | ~0.1–0.4M | ~0.4–1.5M | ~1–4M+ |
| Functions / day | ~5k | ~15k | ~40k |
| **Monthly cost range (USD)** | **~$250–900** | **~$700–2,500** | **~$2,000–7,000** |

**Dominant risks:** location writes × online fleet; **matchRideCandidates O(online)** reads; admin/owner live listeners.

---

## Large target — 10,000 drivers, 100,000 customers

| | Low | Normal | High |
|---|---:|---:|---:|
| Rides / day | 10,000 | 30,000 | 80,000 |
| Online drivers | 2,000 | 3,500 | 5,000 |
| Location writes / day | ~1.3M | ~2.2M | ~3.2M |
| Ride writes / day | ~0.24M | ~0.72M | ~1.9M |
| Reads / day (ride+match+listeners) | **multi-million** | **tens of millions** | **very high** |
| Functions / day | ~50k | ~150k | ~400k |
| **Monthly cost range (USD)** | **~$4k–15k** | **~$12k–40k** | **~$30k–100k+** |

Without geo-scoped matching / candidate pre-index (future approved change), match scans alone can dominate. **Not financially safe to scale blindly on Blaze.**

---

## Storage & Hosting (order-of-magnitude)

| Size | Storage (KYC images) | Hosting/CDN |
|---|---|---|
| Pilot | tens–hundreds MB | low (static SPA) |
| Early | ~1–5 GiB | low–moderate |
| Medium | ~10–50 GiB | moderate if admin reviews media often |
| Large | 100 GiB+ | watch download patterns |

Storage/Hosting usually **secondary** to Firestore until KYC media is naively re-downloaded.

---

## Summary verdict on money

| Stage | Blaze financially “ready”? |
|---|---|
| Pilot | Yes, with budget **alerts** + daily review |
| Early | Conditional — location + match monitoring required |
| Medium / Large | **No** until match scan cost and admin listeners are architecturally bounded (separate approval) |

Ranges exclude tax, support, Maps third-party APIs, and SMS Auth.
