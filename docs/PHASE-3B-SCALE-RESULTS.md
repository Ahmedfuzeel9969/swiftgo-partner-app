# PHASE 3B — Scale Results

**Harness:** `npm run test:phase3b`  
**Fixture pattern:** 30 nearby online drivers + (N−30) online drivers ≥ ~12 km away  

| N online | Queried cells | Vehicle reads | Partner reads | Candidates returned | Match ms | Old reads | New reads | Reduction |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 100 | 35 | 30 | 30 | 10 | ~510 | 200 | 60 | 70% |
| 1,000 | 36 | 43 | 43 | 10 | ~379 | 2,000 | 86 | 95.7% |
| 10,000 | 36 | 46 | 46 | 10 | ~4119 | 20,000 | 92 | 99.5% |

## Proof statement

Adding thousands of distant online drivers **did not** cause matching to read the full fleet. Vehicle reads stayed on the order of **tens**, not N.

`usedFullFleetScan` was **false** in all scale rows.

## Timing note

10k seed ≈ 1.8s; match ≈ 4s on local emulator (partner sequential gets dominate). Production latency should be profiled after deploy; algorithm is bounded by local density, not N.
