# Phase 1c.1 Step 3 — TDD substeps + subagent prompt

> Step 3 ("数据迁移脚本") expansion. Parent plan: `2026-05-14-phase1c1-encounter-session-ui-scaffold.md`.
>
> **Prerequisites**: PR #35 (prep) + #36 (Lane A schema) + #37 (Lane B Zod) must be merged. PR #38 (Lane C1) is independent — can defer.
>
> **Scope**: Build a one-shot, idempotent migration script that maps 4 legacy tables to the new event-driven shape. Does NOT execute against production data (that's Step 8); only writes the script + fixture tests.

---

## Mapping reference (source → target)

### `mistake` → `event` (action='attempt') + optional `event` (action='judge')

For each `mistake` row:

```ts
// 1. Write attempt event (always)
const attemptEvent = {
  id: newEventId(),
  session_id: null,                       // legacy mistakes had no session linkage
  actor_kind: 'user',
  actor_ref: 'self',
  action: 'attempt',
  subject_kind: 'question',
  subject_id: mistake.question_id,
  outcome: 'failure',
  payload: {
    user_answer_md: mistake.wrong_answer_md,
    user_answer_image_refs: mistake.wrong_answer_image_refs ?? [],
    referenced_knowledge_ids: mistake.knowledge_ids ?? [],   // for mastery view
  },
  caused_by_event_id: null,
  task_run_id: null,
  cost_micro_usd: null,
  created_at: mistake.created_at,
};

// 2. If mistake.cause exists: write judge event chained to attempt
if (mistake.cause) {
  const judgeEvent = {
    id: newEventId(),
    session_id: null,
    actor_kind: 'agent',
    actor_ref: 'legacy_attribution',      // marker — these came from pre-v2 attribution
    action: 'judge',
    subject_kind: 'event',
    subject_id: attemptEvent.id,
    outcome: 'success',
    payload: {
      cause: mistake.cause,
      analysis_md: mistake.analysis_md ?? null,
      confidence: mistake.confidence ?? null,
    },
    caused_by_event_id: attemptEvent.id,
    task_run_id: null,                    // legacy data lost task_run linkage
    cost_micro_usd: null,
    created_at: mistake.cause_attributed_at ?? mistake.created_at,
  };
}
```

### `review_event` → `event` (action='review') + `material_fsrs_state` projection

For each `review_event` row in chronological order per question:

```ts
const reviewEvent = {
  id: newEventId(),
  session_id: null,
  actor_kind: 'user',
  actor_ref: 'self',
  action: 'review',
  subject_kind: 'question',
  subject_id: reviewEvent.question_id,
  outcome: reviewEvent.rating === 'again' ? 'failure' : 'success',
  payload: {
    rating: reviewEvent.rating,
    fsrs_state_before: reviewEvent.fsrs_state_before,
    fsrs_state_after: reviewEvent.fsrs_state_after,
    elapsed_ms: reviewEvent.elapsed_ms,
  },
  caused_by_event_id: null,
  created_at: reviewEvent.created_at,
};
```

After processing ALL review_events per question, write the LATEST as `material_fsrs_state`:

```ts
// Only most recent review_event per question
const fsrsState = {
  id: newSyntheticId(),
  subject_kind: 'question',
  subject_id: latestReviewEvent.question_id,
  state: latestReviewEvent.fsrs_state_after,
  due_at: latestReviewEvent.next_due_at,
  last_review_event_id: latestReviewEvent.id,
  updated_at: latestReviewEvent.created_at,
};
```

### `dreaming_proposal` → `event` (action='propose')

```ts
const proposeEvent = {
  id: newEventId(),
  session_id: null,
  actor_kind: 'agent',
  actor_ref: 'dreaming',                   // matches new agent identity convention
  action: 'propose',
  subject_kind: 'knowledge',
  subject_id: proposal.proposed_knowledge_id ?? newKnowledgeId(),
  outcome: proposal.status === 'accepted' ? 'success' : 'partial',
  payload: {
    proposed_knowledge: proposal.proposed_knowledge_body,
    parent_id: proposal.parent_knowledge_id,
    reasoning: proposal.reasoning,
    legacy_status: proposal.status,         // 'pending' | 'accepted' | 'rejected'
  },
  created_at: proposal.created_at,
};
```

### `ingestion_session` → `learning_session` (type='ingestion')

```ts
const session = {
  id: ingestion_session.id,                // preserve ID for FK reference continuity
  type: 'ingestion',
  status: ingestion_session.status,        // status enum is preserved verbatim
  source_document_id: ingestion_session.source_document_id,
  source_asset_ids: ingestion_session.source_asset_ids ?? [],
  entrypoint: ingestion_session.entrypoint,
  warnings: ingestion_session.warnings ?? [],
  error_message: ingestion_session.error_message,
  summary_md: null,                        // ingestion didn't have summaries
  goal_id: null,
  started_at: ingestion_session.created_at,
  ended_at: ingestion_session.completed_at,
  version: ingestion_session.version ?? 0,
  created_at: ingestion_session.created_at,
  updated_at: ingestion_session.updated_at,
};
```

### `judgment` table

Per data-assumptions §O2 and Lane A's DROP — should be empty in production. Script asserts `count = 0` and skips. If non-zero, log warning + abort (data assumption violation, manual triage required).

---

## TDD substep breakdown

> Pattern: **X.1 red test → X.2 verify fail → X.3 green impl → X.4 verify pass → X.5 commit**. Each lettered phase is a TDD cycle.

Test file: `scripts/migrate-phase1c1.test.ts` (vitest, uses testcontainer Postgres).

Script file: `scripts/migrate-phase1c1.ts`.

### 3.A — mistake → attempt event (no-cause path)

- **3.A.1** (red): insert fixture mistake with no cause; run migration helper `migrateMistakes(db)`; expect 1 event row with action='attempt' / subject_kind='question' / outcome='failure' / payload contains user_answer_md
- **3.A.2** (verify fail): test fails — `migrateMistakes` doesn't exist
- **3.A.3** (green): create `scripts/migrate-phase1c1.ts` with `migrateMistakes` writing attempt events
- **3.A.4** (verify pass): test passes; `pnpm typecheck` green
- **3.A.5** (commit): `feat(1c.1 Step 3): migrate mistake → attempt event (no-cause path)`

### 3.B — mistake with cause → attempt + judge chain

- **3.B.1** (red): fixture mistake with cause='concept' + analysis_md; expect 2 events; judge.caused_by_event_id = attempt.id; judge.actor_ref='legacy_attribution'; payload.cause='concept'
- **3.B.2** (verify fail)
- **3.B.3** (green): extend `migrateMistakes` to emit chained judge event
- **3.B.4** (verify pass)
- **3.B.5** (commit): `feat(1c.1 Step 3): migrate mistake.cause → judge event chained on attempt`

### 3.C — review_event → review event + fsrs_state projection

- **3.C.1** (red): fixture 3 review_events on same question over 3 days, ratings [good, hard, again]; expect 3 events (action='review'), expect 1 material_fsrs_state row for that question with state = latest review's fsrs_state_after, due_at = latest's next_due_at
- **3.C.2** (verify fail)
- **3.C.3** (green): add `migrateReviewEvents` writing review events + grouping by question to find latest → write fsrs_state
- **3.C.4** (verify pass)
- **3.C.5** (commit): `feat(1c.1 Step 3): migrate review_event → review events + material_fsrs_state projection`

### 3.D — dreaming_proposal → propose event

- **3.D.1** (red): fixture dreaming_proposal with status='pending'; expect 1 event (action='propose', actor_kind='agent', actor_ref='dreaming', outcome='partial' for pending, payload.legacy_status='pending')
- **3.D.2** (verify fail)
- **3.D.3** (green): add `migrateDreamingProposals`
- **3.D.4** (verify pass)
- **3.D.5** (commit): `feat(1c.1 Step 3): migrate dreaming_proposal → propose event`

### 3.E — ingestion_session → learning_session

- **3.E.1** (red): fixture ingestion_session at status='imported'; expect 1 learning_session row with type='ingestion', same id, status preserved
- **3.E.2** (verify fail)
- **3.E.3** (green): add `migrateIngestionSessions`
- **3.E.4** (verify pass)
- **3.E.5** (commit): `feat(1c.1 Step 3): migrate ingestion_session → learning_session(type=ingestion)`

### 3.F — judgment empty assertion

- **3.F.1** (red): test with 0 judgment rows; expect migration runs to completion. Separate test with 1 judgment row; expect migration logs warning + returns error result (does NOT throw, but exits non-zero)
- **3.F.2** (verify fail)
- **3.F.3** (green): add `assertJudgmentEmpty` precheck
- **3.F.4** (verify pass)
- **3.F.5** (commit): `feat(1c.1 Step 3): assert judgment table empty (data-assumptions §O2)`

### 3.G — orchestrator + idempotent re-run

- **3.G.1** (red): write `runMigration(db)` test that:
  - inserts mixed fixture (2 mistakes, 1 review_event chain, 1 dreaming_proposal, 1 ingestion_session)
  - runs migration once → asserts expected row counts in target tables
  - runs migration **a second time** → asserts row counts unchanged (idempotent)
  - asserts ALL legacy data is still in source tables (additive migration)
- **3.G.2** (verify fail)
- **3.G.3** (green): write top-level `runMigration` that calls migrate{Mistakes,ReviewEvents,DreamingProposals,IngestionSessions} + assertJudgmentEmpty in correct order. Each migrate fn checks "already migrated?" via a probe (e.g., `SELECT COUNT(*) FROM event WHERE action='attempt' AND subject_id IN (SELECT question_id FROM mistake)`) and skips if data already present.
- **3.G.4** (verify pass)
- **3.G.5** (commit): `feat(1c.1 Step 3): orchestrator + idempotent re-run guard`

### 3.H — global integration test

- **3.H.1** (red): integration test loading a realistic 50-row fixture (export from a NAS snapshot or hand-built JSON); asserts complete migration produces correct event chains, mastery view returns NULL for un-attempted knowledge, mastery ∈ [0,1] for attempted
- **3.H.2** (verify fail)
- **3.H.3** (green): generate fixture (use `scripts/seed.ts` style); ensure migration handles edge cases (mistake with no question_id should NOT crash — log + skip)
- **3.H.4** (verify pass)
- **3.H.5** (commit): `test(1c.1 Step 3): full integration test 50-row realistic fixture`

---

## Subagent prompt (ready when lanes merge)

```markdown
You are executing Phase 1c.1 Step 3 in an isolated git worktree of the-learning-project. Your scope is the **data migration script + tests** — do NOT touch server read-path code (that's Step 4), API routes (Step 6), AI prompts (Step 7), or DB schema (Lane A already landed).

# Prerequisites

Verify these are in main BEFORE starting:
- `git log --oneline main | head -10` shows commits with `feat(1c.1 Lane A)` (event/learning_session/material_fsrs_state/knowledge_edge tables present)
- `git log --oneline main | head -10` shows commits with `feat(1c.1 Lane B)` (src/core/schema/event/* present)
- `ls src/db/schema.ts` references `event`, `learning_session`, `material_fsrs_state`, `knowledge_edge` tables
- `ls src/core/schema/event/index.ts` exports `Event` union + `parseEvent`

If any prerequisite is missing, STOP and report — Step 3 cannot start.

# Project context

Self-hosted single-user AI learning tool. Stack: Next.js 15 + Postgres + Drizzle ORM, Zod for runtime validation, Vitest with @testcontainers/postgresql. Read CLAUDE.md.

# Required reading

1. `CLAUDE.md`
2. `docs/superpowers/plans/2026-05-14-phase1c1-encounter-session-ui-scaffold.md` — **Step 3 body**
3. `docs/superpowers/plans/2026-05-16-phase1c1-step3-migration.md` — TDD substep breakdown (this doc)
4. `docs/adr/0006-encounter-replaces-mistake.md` (v2) — event payload Zod守护策略
5. `docs/adr/0008-learning-session-multi-type-envelope.md` — per-type state machines
6. `src/db/schema.ts` — current schema (read mistake / review_event / dreaming_proposal / ingestion_session columns to know source shape; event / learning_session / material_fsrs_state for target)
7. `src/core/schema/event/known.ts` — 11 KnownEvent shapes
8. `scripts/seed.ts` or any existing migration script — adopt the testcontainer + drizzle test pattern

# Tasks (TDD discipline)

Follow the TDD substeps in `2026-05-16-phase1c1-step3-migration.md` exactly. **Each substep = its own commit** (3.A.5 / 3.B.5 / ... / 3.H.5). Do NOT batch commits; the discipline is "red → fail → green → pass → commit" per cycle. This produces 8 focused commits.

The end state:
- `scripts/migrate-phase1c1.ts` — orchestrator + 4 migrate fns + assertJudgmentEmpty
- `scripts/migrate-phase1c1.test.ts` — unit tests per migrate fn
- `tests/integration/migrate-phase1c1.integration.test.ts` — realistic 50-row fixture

# Locked contract

- Use Lane B's Zod `Event` schema to VALIDATE every event you construct before INSERT. `parseEvent(eventObj)` should pass; if it throws, fix your mapping until it passes.
- Migration is **additive** — never UPDATE / DELETE legacy tables (Step 9 drops them later)
- Migration is **idempotent** — running 2x produces same end state
- Use Drizzle ORM for writes, NOT raw SQL (consistency with rest of codebase)
- Event IDs: use existing `src/core/id.ts` `newCuid()` helper (or whatever the project uses)

# Out of scope

- Do NOT execute migration against production. Test against testcontainer only.
- Do NOT touch any `src/server/**` files (Step 4 is the server read-path rewrite, separate work).
- Do NOT touch `app/api/**` (Step 6).
- Do NOT touch `src/ai/registry.ts` (Step 7).
- Do NOT DROP any tables (Step 9).
- Do NOT call migration from `tests/global-setup.ts` yet — that integration is Step 8.

# Verification before final commit

- [ ] `pnpm typecheck` green
- [ ] `pnpm test scripts/migrate-phase1c1.test.ts` all green
- [ ] `pnpm test tests/integration/migrate-phase1c1.integration.test.ts` green
- [ ] `pnpm test` overall green (no regressions)
- [ ] `pnpm lint` green
- [ ] 8 commits, conventional format `feat(1c.1 Step 3): ...` / `test(1c.1 Step 3): ...`

# Commit format

End each commit with:
```
Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
```

# Return

When done, return:
- Branch name (worktree-assigned)
- 8 commit hashes + subjects
- Verification command outputs
- Sample event shape produced from a fixture mistake (paste it as JSON — useful for review)
- Any edge case discoveries (e.g., legacy data shapes that didn't map cleanly)
```

---

## Sanity checks before dispatching

1. Confirm `mistake` table source columns (read `src/db/schema.ts` BEFORE Lane A's DROPs — i.e., on `main` before Step 9). Schema as of 2026-05-16 should still have `mistake.wrong_answer_md`, `mistake.knowledge_ids` (jsonb), `mistake.cause`, etc. Lane A merge doesn't DROP these yet — those drop in Step 9.

2. Confirm `dreaming_proposal` column names match the mapping above. If different (e.g., `proposed_knowledge_body` vs `body_md`), update the mapping doc inline.

3. Decide: write event IDs deterministically (e.g., `evt_mistake_<mistake.id>`) so migration is **truly** idempotent (same input → same IDs), OR use random CUIDs + dedup probe? **Recommend deterministic IDs** — simpler idempotency story, easier to debug.

---

## Risk register (Step 3-specific)

- **Legacy data shape drift** — if production has mistakes with null fields the schema didn't anticipate (e.g., `knowledge_ids = NULL` vs `[]`), handler must coalesce
- **`mistake.cause` enum** — if legacy data has cause values outside the ADR-0006 v2 10-enum, log warning + map to 'other'. Do NOT crash migration.
- **`dreaming_proposal.parent_knowledge_id` may reference now-deleted knowledge** — handler must defensive-check FK existence; if missing, skip with warning
- **Migration runtime** — fixture tests will be fast (<10s); production data could be 10k+ rows. Add progress logging every 1000 rows.

---

## Next-step planning (after Step 3 merges)

Step 4 (server read-path rewrite) is the next big phase. Its subagent prompt should be planned separately — see future doc `2026-05-XX-phase1c1-step4-server-rewrite.md`.
