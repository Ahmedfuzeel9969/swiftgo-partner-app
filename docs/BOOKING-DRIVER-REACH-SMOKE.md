# Booking → Driver reach — live smoke checklist

**Cache bust:** `booking_driver_reach_1`  
**Project:** `swiftgo-ride-app`

After deploy, on one Customer + one Driver (same area, ≤3 km):

1. Driver: go online → diag shows **میچنگ تیار** (not stuck on syncing).
2. Customer: create booking → toast either invites count or “تلاش جاری”.
3. Firestore `rides/{id}`: `matchingStatus`, `matchingSource`, `matchingUsedProbe`, `candidateCount`.
4. `ride_candidates` for that ride: at least one `status=invited` for the test Driver when eligible.
5. Driver FAB / list shows the ride within a few seconds (listen works off-home while online).
6. Wait ~30s with Driver coming online mid-search → rematch invites without new booking.
7. Gate: 4 active still blocks 5th; cancel-all still clears searching.

Do **not** widen 3 km; do **not** enable Scheduler without billing approval.
