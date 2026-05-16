# Phase 1c.1 Step 8 — Wire migration into test setup + mastery view smoke

> Step 8 ("跑数据迁移 + mastery view smoke") expansion. Parent plan §Step 8.
>
> **Prerequisites**: Steps 1-7 merged. Migration script `scripts/migrate-phase1c1.ts` (Step 3), event schema (Lane A), Lane B Zod, Step 4-7 server + routes + prompts all done. `knowledge_mastery` PG view exists in `drizzle/0005_phase1c1_event_payload_gin_and_mastery_view.sql`.
>
> **Scope**:
> 1. Make `tests/global-setup.ts` apply hand-written SQL migrations (e.g., the mastery view DDL) after `db:push --force`. Currently `db:push` skips hand-written `.sql` files.
> 2. Add an idempotent migration run as a test fixture helper (or in global-setup), so any integration test that exercises post-migration state has both legacy fixtures + projected events available.
> 3. Add `tests/integration/mastery-view.test.ts` — asserts `knowledge_mastery` view returns NULL for un-attempted nodes; returns `mastery ∈ [0,1]` + `evidence_count ≥ N` for nodes with N failure attempts.
> 4. Document the production deploy runbook in `docs/deploy/phase1c1-migration-runbook.md`.

---

## Mapping reference

### `tests/global-setup.ts` current behavior

```ts
export async function setup() {
  ensureDockerHost();
  container = await new PostgreSqlContainer('postgres:16').start();
  const uri = container.getConnectionUri();
  process.env.TEST_DATABASE_URL = uri;
  process.env.DATABASE_URL = uri;
  const result = spawnSync('pnpm', ['db:push', '--force'], ...);
  if (result.status !== 0) throw new Error(`drizzle-kit push failed`);
}
```

Problem: `db:push` pushes the inferred schema from `src/db/schema.ts` but **does NOT** apply hand-written SQL files in `drizzle/*.sql`. The mastery view DDL (in `drizzle/0005_*.sql`) never runs. Tests that touch the view fail (and Step 5 worked around it inline in `tests/integration/learning-session-read-roundtrip.test.ts`).

### `tests/global-setup.ts` new behavior

After `db:push --force`, apply the mastery view DDL + GIN index from `drizzle/0005_phase1c1_event_payload_gin_and_mastery_view.sql`. Two approaches:

**Approach A (recommended)**: switch from `db:push` to `drizzle-kit migrate` which respects journal + applies all `.sql` files in order. Cleaner long-term. Risk: behavior change for any tests currently relying on `db:push --force` overriding schema state (none observed in current codebase per quick scan, but `--force` means "drop conflicting").

**Approach B**: keep `db:push --force` for schema-state push, then `spawnSync('pnpm', ['db:execute', '--file=drizzle/0005_phase1c1_event_payload_gin_and_mastery_view.sql'])` (drizzle-kit's hand-written executor). Or run via `psql` if available. Tighter scope but doesn't generalize: every future hand-written migration needs its own line.

**Decision**: **Approach A** (`drizzle-kit migrate`). Reasons:
1. Future-proof: any new hand-written `.sql` migration auto-applied.
2. Mirrors production behavior — production also runs `migrate` (or will, per Step 8 runbook).
3. The `--force` semantics (drop-and-recreate on conflict) is overkill for ephemeral testcontainers; `migrate` is a clean roll-forward.

Test for the change: `tests/integration/mastery-view.test.ts` (new). If view DDL isn't applied, the test fails with "relation knowledge_mastery does not exist".

### `tests/integration/mastery-view.test.ts` (new)

```ts
// Asserts mastery view returns expected shape for un-attempted vs attempted knowledge.
//
// Per ADR-0012, mastery is a DERIVED metric — NULL for un-attempted nodes (no event
// references), [0,1] for attempted with sufficient evidence (≥3 failure attempts
// within 180d for a high-confidence read; below threshold returns NULL).

describe('knowledge_mastery view', () => {
  beforeEach(async () => { await resetDb(); });

  it('returns mastery=NULL + evidence_count=0 for un-attempted knowledge', async () => {
    // seed a knowledge node, no events
    await seedKnowledge('k_unused');
    const row = await db.execute(sql`SELECT * FROM knowledge_mastery WHERE knowledge_id = 'k_unused'`);
    expect(row[0]?.mastery).toBeNull();
    expect(Number(row[0]?.evidence_count)).toBe(0);
  });

  it('returns mastery ∈ [0,1] + evidence_count >= 3 for knowledge with multiple failure attempts', async () => {
    await seedKnowledge('k_practiced');
    // seed 4 attempts (3 failure, 1 review)
    for (let i = 0; i < 3; i++) {
      await seedEvent({
        action: 'attempt', subject_kind: 'question',
        outcome: 'failure', payload: { referenced_knowledge_ids: ['k_practiced'], ... }
      });
    }
    await seedEvent({
      action: 'review', subject_kind: 'question',
      outcome: 'success', payload: { referenced_knowledge_ids: ['k_practiced'], ... }
    });
    const row = await db.execute(sql`SELECT * FROM knowledge_mastery WHERE knowledge_id = 'k_practiced'`);
    expect(row[0]?.mastery).toBeGreaterThanOrEqual(0);
    expect(row[0]?.mastery).toBeLessThanOrEqual(1);
    expect(Number(row[0]?.evidence_count)).toBeGreaterThanOrEqual(3);
  });

  it('decays older events (180d window)', async () => {
    // event from 200 days ago is excluded (per view's `created_at > now() - interval '180 days'`)
    await seedKnowledge('k_ancient');
    await seedEvent({ ..., created_at: new Date(Date.now() - 200 * 86400 * 1000) });
    const row = await db.execute(sql`SELECT * FROM knowledge_mastery WHERE knowledge_id = 'k_ancient'`);
    expect(Number(row[0]?.evidence_count)).toBe(0);
  });

  it('weight decays exponentially with age (half-life 30d)', async () => {
    // event 30 days old has half the weight of a same-day event
    await seedKnowledge('k_decay');
    await seedEvent({ ..., created_at: new Date() });          // weight ≈ 1.0
    await seedEvent({ ..., created_at: new Date(Date.now() - 30 * 86400 * 1000) }); // weight ≈ 0.5
    const row = await db.execute(sql`SELECT * FROM knowledge_mastery WHERE knowledge_id = 'k_decay'`);
    expect(Number(row[0]?.evidence_count)).toBe(2);
    // mastery should reflect weighted avg of outcomes (test specific numeric within tolerance)
  });
});
```

### Migration helper for integration tests

Some integration tests want to exercise the migration: seed legacy data → call `runMigration(db)` → assert event projections. Currently `scripts/migrate-phase1c1.ts` exports `runMigration` but it's not wired into a test helper.

Add `tests/helpers/migration.ts`:
```ts
export async function runMigrationInTest(db: Db): Promise<MigrationResult> {
  return runMigration(db);   // re-export from scripts/migrate-phase1c1.ts
}
```

Use in any test that needs the full Step 3 → Step 5 chain validated end-to-end.

### Production deploy runbook

New: `docs/deploy/phase1c1-migration-runbook.md`. Outlines deploy steps:

1. **Pre-flight checks**:
   - `git log --oneline | head -10` shows Steps 1-7 commits
   - `pnpm db:check` (or equivalent) shows pending migrations
2. **Maintenance window** start. Confirm with user.
3. **Backup**: `pg_dump` to a timestamped file. Verify restorability.
4. **Schema migrate**: `pnpm db:migrate` (applies 0004 + 0005 hand-written SQL on top of base schema).
5. **Data migrate**: `pnpm tsx scripts/migrate-phase1c1.ts` (idempotent — re-runs are no-ops via deterministic IDs + ON CONFLICT DO NOTHING).
6. **Smoke**: `SELECT COUNT(*) FROM event;` should be `>= COUNT(mistake) + COUNT(review_event) + COUNT(dreaming_proposal)`. `SELECT * FROM knowledge_mastery LIMIT 5;` should return non-zero rows for active knowledge nodes.
7. **Deploy app code**: docker compose pull + up.
8. **Smoke (post-deploy)**: `curl /api/health` → 200. `curl /api/mistakes/recent` with internal token → returns expected shape. `curl /api/events?action=attempt&limit=5` → 5 rows.
9. **End maintenance window**.
10. **Rollback plan**: pg_restore from step 3 backup; redeploy previous app version. App code is forward-compat with legacy data (Step 4 csv.ts dual-path; routes have legacy fallbacks until Step 9 explicitly removes them — wait, no, Step 6 ROUTES read only from event stream. Rollback after Step 6 means losing access to in-flight ingestions/mistakes that didn't make it through migration. Document this carefully.).

---

## TDD substep breakdown

5 substeps (smaller than 5/6/7 — infrastructure work).

### 8.A — Switch global-setup to `drizzle-kit migrate`

- **8.A.1** (red): make a new test `tests/integration/migration-applied.test.ts` that asserts `SELECT * FROM information_schema.views WHERE table_name = 'knowledge_mastery'` returns one row. Should fail today (db:push doesn't create views).
- **8.A.5** (commit): `feat(1c.1 Step 8): global-setup applies all migrations via drizzle-kit migrate`

### 8.B — `tests/integration/mastery-view.test.ts` — view smoke

- **8.B.1** (red): the 4 cases above (un-attempted / attempted / 180d window / 30d weight decay). Should fail because tests aren't written.
- **8.B.5** (commit): `test(1c.1 Step 8): integration — knowledge_mastery view smoke`

### 8.C — Migration helper for tests

- **8.C.1** (red): `tests/helpers/migration.ts` test that calls `runMigrationInTest(db)` on a fixture of mistake + review_event + dreaming_proposal + ingestion_session legacy rows → asserts `event` + `learning_session` populated correctly. Already mostly covered by Step 3's integration test (`tests/integration/migrate-phase1c1.integration.test.ts`), so this is light — just a helper re-export + smoke.
- **8.C.5** (commit): `test(1c.1 Step 8): tests/helpers/migration — re-export runMigration for cross-suite use`

### 8.D — Production runbook documentation

- **8.D.1** (red): `tests/integration/migration-applied.test.ts` is already covering the test-side. The runbook is documentation only — assert it exists via a meta-test? Skip; just write the doc.
- **8.D.5** (commit): `docs(deploy): Phase 1c.1 migration runbook (pre-flight + maintenance window + rollback)`

### 8.E — Full-suite smoke

- **8.E.1** (red): regress nothing. Re-run `pnpm test` post-Step-8 changes; expect every previously-passing test still green AND the new view smoke tests pass.
- **8.E.5** (commit): no commit needed unless verification surfaces a bug.

---

## Locked contract

- **`drizzle-kit migrate` replaces `db:push --force`** in `tests/global-setup.ts`. If a test relies on idempotent re-push semantics, surface it now or fix it.
- **`knowledge_mastery` view test fixtures use `seedEvent`** — same direct-insert pattern as Step 4 fixtures. Don't go through `writeEvent` (that's for production write path; tests can fast-path).
- **Migration runbook is **documentation only**, NOT executable in tests. Production execution is manual (per Step 8 spec: maintenance window).
- **Rollback paragraph in runbook is non-trivial** — Step 4 + 6 routes read ONLY from event stream. After Step 6 deploy, rolling back means restoring legacy data from pre-deploy backup. Document carefully.
- **No new schema changes** — `knowledge_mastery` view already exists in `drizzle/0005_*.sql`; Step 8 just makes the test container apply it.
- 5 commits, conventional format. Each ends with `Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>`.

---

## Subagent prompt

```markdown
You are executing Phase 1c.1 Step 8 of the-learning-project. Worktree-isolated.

## BOOTSTRAP

```bash
git fetch origin
git merge origin/phase1c1-step8-prep --ff-only
```

Verify: `ls docs/superpowers/plans/2026-05-16-phase1c1-step8-migration-wire.md`, `ls drizzle/0005_*.sql`, `ls scripts/migrate-phase1c1.ts`, `grep "runMigration" scripts/migrate-phase1c1.ts`.

## Authoritative spec

`docs/superpowers/plans/2026-05-16-phase1c1-step8-migration-wire.md` — read in full.

## Required reading

1. `CLAUDE.md`
2. `docs/superpowers/plans/2026-05-16-phase1c1-step8-migration-wire.md` (authoritative)
3. `docs/adr/0012-mastery-derived-view.md` (or whichever ADR-0012 file exists) — mastery view design intent
4. `drizzle/0005_phase1c1_event_payload_gin_and_mastery_view.sql` — view DDL (your target test fixture)
5. `tests/global-setup.ts` — current setup (you replace `db:push` with `drizzle-kit migrate`)
6. `package.json` — confirm `db:migrate` script exists or add one
7. `scripts/migrate-phase1c1.ts` — `runMigration` (re-export for tests/helpers/migration.ts)
8. `tests/integration/migrate-phase1c1.integration.test.ts` — Step 3 integration test (your reference for runMigration fixture pattern)

## Locked contract

- Replace `db:push --force` with `drizzle-kit migrate` in global-setup. If a script for `pnpm db:migrate` doesn't exist, add one to package.json.
- `knowledge_mastery` view tests use direct DB insert seeding (not writeEvent), per fixture pattern.
- Migration runbook is docs only; don't auto-execute.
- 5 separate commits, conventional `feat|test|docs(1c.1 Step 8): ...`. Each ends with `Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>`.

## Implementation guidance

- **`drizzle-kit migrate` invocation**: check existing `package.json` scripts. Likely needs adding `"db:migrate": "drizzle-kit migrate"`. The drizzle-kit migrate command uses `drizzle/meta/_journal.json` to track which migrations applied.
- **Idempotent re-run guard**: testcontainer is ephemeral — same-test container starts fresh, no carry-over state. But `drizzle-kit migrate` is itself idempotent (skips already-applied). Should Just Work.
- **`tests/integration/mastery-view.test.ts` seedEvent helper**: use `db.insert(event).values(...)` directly with explicit `id`, `created_at`, `payload`, etc. Don't import writeEvent — that's for production write path; in tests we want full control over `created_at` for the 30d/180d window assertions.
- **Weight decay test**: `mastery_view` SQL uses `exp(-ln(2) * elapsed_days / 30.0)`. A 30-day-old event has weight 0.5; a 60-day-old event has weight 0.25. Use these numbers as expected values with reasonable tolerance (±0.05).
- **Runbook draft**: write the runbook in CN+EN bilingual or mostly CN (matches project's docs/ style). Include the 10 numbered steps in this spec, with concrete commands.

## Out of scope

- DB schema changes (view DDL already exists; just need to apply it)
- Removing legacy tables (Step 9)
- New routes
- AI prompts
- Schema-level optimizations

## Verification gates

- `pnpm typecheck` green
- `pnpm test tests/integration/mastery-view.test.ts` green (new)
- `pnpm test tests/integration/migration-applied.test.ts` green (new)
- `pnpm test tests/integration/migrate-phase1c1.integration.test.ts` green (still passes via the new global-setup path)
- `pnpm test` full suite green (Step 7 baseline + new tests)
- `pnpm lint` no new errors
- 5 commits

## Return (under 800 words)

1. Branch name
2. 5 commit hashes + subjects
3. Verification gate outputs (final lines)
4. Sample query output: `SELECT * FROM knowledge_mastery WHERE knowledge_id = '<test fixture>'` (paste row)
5. Edge cases (esp. anything surprising about drizzle-kit migrate vs db:push behavior)
6. Out-of-scope discoveries
7. Outstanding risks for Step 9
```

---

## Risks

- **`drizzle-kit migrate` first-time on testcontainer**: if `meta/_journal.json` lists 5 migrations and the container starts empty, drizzle should apply all 5 sequentially. If anything is order-sensitive (e.g., 0004's CREATE TABLE before 0005's CREATE VIEW with LATERAL JOIN on those tables), order is respected per the journal.
- **CI flakiness**: changing test setup affects every test file. If a test had a hidden dependency on `db:push --force`'s drop-and-recreate semantics, it might break silently. Mitigation: run full suite + watch for unrelated regressions.
- **Production runbook coverage**: rollback after Step 6 is genuinely risky (event-only reads). Document with explicit user authorization requirement.
- **Mastery view tolerance**: weight-decay test asserts numeric values; floating-point precision in PG `exp()` may vary. Use ±0.05 tolerance.

---

## Next-step planning

Step 9 (DROP legacy tables) drafted after Step 8 lands. Step 9 is the irreversible point — DROP `mistake`, `review_event`, `dreaming_proposal`, `ingestion_session`. Plus removing all legacy fallback code (Step 4 csv.ts dual-path; Step 6 POST /api/mistakes mistake row dual-write).
