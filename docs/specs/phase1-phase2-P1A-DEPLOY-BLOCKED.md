# P1-A Validation Deploy — Status

**Status:** Lab validation **complete (Option A PASS)**. Deploy still **blocked** until operator approves the lab report and authorizes commit + P1-A-only deploy.  
**Worktree:** `F:/ride-app-p1a-validate`  
**Branch:** `validate/p1a-idle-publish-20260805` (from `origin/main` @ `969f2ff`)  
**Report:** `docs/specs/phase1-phase2-P1A-OPTION-A-VALIDATION-REPORT.md`

---

## Decision locked

**Option A** — Preserve live main behaviour:

| Setting | Production / code default |
|---------|---------------------------|
| Idle interval | **4 seconds** (`4000` ms) |
| Idle move | **10 meters** |

Super Admin may change values; until then runtime matches `origin/main`.

---

## Still blocked

1. **No deploy from dirty `F:/ride-app`** (unrelated P2P/comm/CSS changes).
2. **No deploy** until lab report approval + commit on validate branch.
3. **P1-B** blocked until P1-A fully validated and explicitly approved.

---

## When you authorize next

1. Commit P1-A-only files (+ report/checklist) on validate branch.  
2. Deploy CF `setCandidateDriverLimit` + Super Admin + driver hosting from that commit only.  
3. Run Option A physical checklist.  
4. Restore Admin to **4s / 10m** after observability tests if raised.
