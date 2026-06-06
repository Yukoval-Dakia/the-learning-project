/**
 * Shared guard for "should this request actually enqueue a pg-boss background
 * job?" (YUK-239, STB-5).
 *
 * Why this exists: six production route handlers each gated their
 * `boss.send(...)` on `!process.env.VITEST` to keep the test suite from
 * accumulating pg-boss state / exhausting the testcontainer connection pool.
 * That seam was (a) duplicated six times and (b) keyed only on `VITEST`, which
 * is set by the vitest runner but is not the canonical "are we in a test
 * environment" signal — a non-vitest test harness (or a future runner) would
 * silently start enqueuing real jobs.
 *
 * This helper centralises the decision and keys it on `NODE_ENV === 'test'`
 * (the canonical env signal — verified set to `'test'` in BOTH the unit and db
 * vitest partitions) while ALSO honouring `VITEST` for safety. The OR means the
 * skip can only ever fire in *more* test contexts than before, never fewer —
 * so every existing test that relied on "no enqueue under vitest" stays green.
 *
 * Returns `true` when background jobs should be enqueued (i.e. NOT a test run).
 *
 * Note: this is intentionally a plain env read (not a config object) so it can
 * be `vi.stubEnv`-toggled in unit tests without DI plumbing through six routes.
 *
 * Location: lives at `src/server/runtime-env.ts` (not under `src/server/boss/`)
 * on purpose — it has ZERO pg-boss / DB imports, so it must stay out of the
 * `DB_TAINTED_DIRS` that the test-partition auditor uses (scripts/
 * audit-test-partition.ts). Keeping it here lets its unit test live in the unit
 * partition without tripping the P0 "unit + unmocked DB import" check.
 */
export function shouldEnqueueBackgroundJobs(): boolean {
  const isTestEnv = process.env.NODE_ENV === 'test' || !!process.env.VITEST;
  return !isTestEnv;
}
