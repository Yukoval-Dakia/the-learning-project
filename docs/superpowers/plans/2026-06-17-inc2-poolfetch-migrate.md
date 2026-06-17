# inc-2 — queryExistingPool 迁 poolFetch (YUK-398)

Phase 1 检索底座 increment 2. Equivalence refactor: move the live `queryExistingPool`
SQL pool query (`src/server/quiz/sourcing-sequence.ts` ~83-162) onto the unified
`poolFetch` operator (`src/server/quiz/pool-fetch.ts`, YUK-396). **Zero behavior change.**

## 改面

1. **`src/server/quiz/pool-fetch.ts`** — widen projection
   - `PoolRow` += `source: string`, `kind: string`, `metadata: Record<string, unknown> | null`.
   - `poolFetch`'s `.select({...})` projects those three columns unconditionally.
   - WHERE / ORDER / `PoolFetchCriteria` signature UNCHANGED. Existing `pool-fetch.db.test.ts`
     only asserts `id`/`difficulty` → additive, non-breaking. matcher (inc-3) reuses these.

2. **`src/server/quiz/sourcing-sequence.ts`** — re-wire `queryExistingPool`
   - Replace the inline `db.select(...).from(question).where(and(...)).orderBy(...)` with
     `poolFetch(db, { knowledgeId, activeOnly: true (default), difficultyMin, compositeParentOnly: unit === '篇', limit: NOT PASSED })`.
   - **Keep all in-memory logic verbatim** on top of the returned rows:
     `.filter(kind === null || kindsMatch(r.kind, kind))` → `.map` to
     `{ question_id, source, tier: deriveSourceTier(...).tier, whitelistMatch: readWhitelistMatch(...) }`
     → `.sort(compareBySourceTierThenWhitelist)` → `.slice(0, limit)` →
     `.map({ question_id, source, tier })`.
   - `readWhitelistMatch` helper stays local (only the jsonb read; the sort is the shared 合约五).

## 测试点

- Existing `sourcing-sequence.test.ts` (DB) is the in-place regression suite — it exercises
  tier order, kind filter (A2 + cross-vocab), draft exclusion, difficultyMin, unit='篇',
  F2 (limit-after-sort), OF-2 whitelist demotion. Must pass UNCHANGED post-refactor.
- Existing `pool-fetch.db.test.ts` (DB) — must pass unchanged (additive projection).
- NEW dedicated equivalence test (`sourcing-pool-equivalence.db.test.ts`): one seeded set
  that simultaneously spans tier 1/2/4, kind reading vs computation, a draft, a sub-floor
  difficulty, and a composite parent — assert the exact selected id sequence matches the
  spec'd order across several `runSourcingSequence` calls. This is the single combined
  "selection unchanged" anchor for the migration.

## A2 风险点

- **limit must NOT go into `poolFetch`.** poolFetch's SQL `.limit()` truncates by the SQL
  ORDER (created_at, id), BEFORE the in-memory tier sort. Slicing in SQL = F2 regression
  (a new high-tier row dropped in favour of old low-tier ones). Fetch the FULL single-KC
  candidate set, tier-sort in memory, slice last. (Bounded: one KC's active pool is tens.)
- WHERE must be byte-equivalent — 4 predicates already covered by poolFetch:
  KC containment / draft exclusion (`activeOnly` default true) / difficultyMin floor
  (`difficultyMin != null` ≡ caller's `!== null` since value is never undefined) /
  unit='篇' composite (`compositeParentOnly`). ORDER = asc(created_at), asc(id) (non-vector).
- kind filter + tier sort + whitelist demotion + slice all stay app-layer (unchanged).

## 不扩 scope

- 不碰 YUK-287 difficulty/composite forward (保持现状转发).
- 不动 matcher (inc-3).
