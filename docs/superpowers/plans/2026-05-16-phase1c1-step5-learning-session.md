# Phase 1c.1 Step 5 — IngestionSession → `src/server/session/` multi-type module

> Step 5 ("IngestionSession 模块演化") expansion. Parent plan: `2026-05-14-phase1c1-encounter-session-ui-scaffold.md` §Step 5. ADRs: ADR-0005 (single-owner invariant) evolved by ADR-0008 (multi-type envelope).
>
> **Prerequisites**: Step 4 (PR #47, `src/server/events/queries.ts` with `writeEvent`) merged. Lane A `learning_session` table on main. Lane B `LearningSessionStatusByType` discriminated Zod union on main.
>
> **Scope**: Relocate `src/server/ingestion/session.ts` → `src/server/session/ingestion.ts` (namespaced), add `src/server/session/review.ts` (minimal state machine), add `src/server/session/index.ts` (polymorphic entry). Switch all live writes from `ingestion_session` table → `learning_session(type='ingestion')`. **Each state transition writes an event row** via `writeEvent` (from Step 4) — chained via `session_id`. Single-owner invariant extends to all session types.
>
> **Parent plan calls this "the most complex step"** — multi-file lift-and-shift, table swap, event-write integration, plus a new minimal state machine. Plan budget: 10 TDD substeps.

---

## Mapping reference

### Table swap: `ingestion_session` → `learning_session(type='ingestion')`

| Old column | New column | Notes |
|---|---|---|
| `ingestion_session.id` | `learning_session.id` | ID preserved verbatim (FK continuity per Step 3 migration) |
| `ingestion_session.status` | `learning_session.status` | enum same (Lane B `IngestionStatus`) |
| `ingestion_session.source_document_id` | `learning_session.source_document_id` | nullable for non-ingestion types; required when `type='ingestion'` |
| `ingestion_session.source_asset_ids` | `learning_session.source_asset_ids` | jsonb array |
| `ingestion_session.entrypoint` | `learning_session.entrypoint` | nullable for non-ingestion |
| `ingestion_session.warnings` | `learning_session.warnings` | jsonb array |
| `ingestion_session.error_message` | `learning_session.error_message` | |
| `ingestion_session.created_at / updated_at` | `learning_session.created_at / updated_at` | |
| `ingestion_session.version` | `learning_session.version` | |
| — | `learning_session.type` | **NEW**: literal `'ingestion'` for all ingestion writes |
| — | `learning_session.started_at` | maps from `created_at` |
| — | `learning_session.ended_at` | set when status transitions to `imported` or `failed` |
| — | `learning_session.summary_md / goal_id` | leave NULL for ingestion (conversation/review fields) |

### Event-write pattern (per state transition)

Each `LearningSession.Ingestion.<transition>` call writes:
1. `learning_session` row UPDATE/INSERT (status transition)
2. `event` row via `writeEvent` (action depends on transition — see table below)
3. `job_events` row via existing `writeJobEvent` (Sub 0c pg-boss SSE plumbing) — kept unchanged

| Transition | event.action | event.subject_kind | event.subject_id | event.actor_kind | event.actor_ref |
|---|---|---|---|---|---|
| `initiateUpload` | (state-only — no domain event; user picks file, not yet an "extract" action) | — | — | — | — |
| `enqueueExtraction` | (state-only — pg-boss internal; `job_events` covers) | — | — | — | — |
| `markExtractionStarted` | (state-only — pg-boss internal) | — | — | — | — |
| `applyExtractionResult` | `extract` | `source_document` | `source_document_id` | `agent` | `tencent_ocr` |
| `markExtractionFailed` | `extract` (outcome='failure') | `source_document` | `source_document_id` | `agent` | `tencent_ocr` |
| `applyRescue` | `extract` (outcome='success') | `source_document` | `source_document_id` | `agent` | `vision_rescue` |
| `markReviewed` | (state-only) | — | — | — | — |
| `commitImport` | (state-only — no `import` action in KnownEvent v1; reconsider Phase 1d) | — | — | — | — |

**Decision**: only the 3 extract-flavored transitions write `event` rows (`extract` is a KnownEvent per `ExtractSourceDocument` in Lane B). Other transitions remain state-only — `job_events` already covers async observability; domain `event` log is for user-/agent-facing actions. Reconsider in Phase 1d if user-facing event timeline surfaces a need.

### New: `LearningSession.Review.*` minimal state machine

```
started → completed | abandoned
```

| Transition | Allowed from-state | Writes |
|---|---|---|
| `startReviewSession()` | (new) | learning_session INSERT (type='review', status='started') |
| `completeReviewSession()` | `started` | learning_session UPDATE status='completed', ended_at=now |
| `abandonReviewSession()` | `started` | learning_session UPDATE status='abandoned', ended_at=now |

Review sessions in Phase 1c.1 are state envelopes only — actual review events (per question) are written by the review route (Step 6) using `writeEvent` (with `session_id` linkage). Step 5 sets up the session-level state machine.

---

## New module structure

```
src/server/session/
  index.ts        — polymorphic exports + dispatcher: re-exports namespaces and type helpers
  ingestion.ts    — IngestionSession.* (lifted from src/server/ingestion/session.ts, table swap + event write integration)
  review.ts       — Review.* (new, 3 transition fns)
  guards.ts       — shared assertFromState helper (lifted, generic over status enum)
  events.ts       — internal helper to construct ExtractSourceDocument event + delegate to writeEvent (single point for session→event mapping)
```

### Public API surface (re-exported via `index.ts`)

```ts
export * as Ingestion from './ingestion';
export * as Review from './review';
export type { LearningSessionTypeT } from '@/core/schema/learning_session';
```

Callers import `import { Ingestion } from '@/server/session'` and use `Ingestion.enqueueExtraction(...)` etc.

---

## Per-file changes

### Delete: `src/server/ingestion/session.ts`

All contents move to `src/server/session/ingestion.ts`. Tests move to `src/server/session/ingestion.test.ts`.

### Modify: `src/server/boss/handlers/tencent_ocr_extract.ts`

Change import from `'@/server/ingestion/session'` → `'@/server/session'`, then call `Ingestion.markExtractionStarted(...)` etc.

### Modify: `app/api/ingestion/route.ts`

Same import switch.

### Modify: `app/api/ingestion/[id]/extract/route.ts`

Same import switch.

### Modify: `app/api/ingestion/[id]/rescue/route.ts` (if exists)

Same import switch.

### Modify: `app/api/ingestion/[id]/import/route.ts` (commitImport caller)

Same import switch.

### Migration: `scripts/migrate-phase1c1.ts`

The `migrateIngestionSessions` fn already writes `learning_session` rows (Step 3 mapped). No change needed for Step 5.

### Out of scope: legacy `ingestion_session` table readers

Audit: grep `from(ingestion_session)`. The legacy table is read in `_round_trip` test, export route, and possibly debug routes. **Step 5 leaves these untouched** — Step 9 drops the table and removes the readers.

---

## TDD substep breakdown

> Pattern: red → fail → green → pass → commit. 10 substeps (Step 5 is bigger than 8-substep peers).

### 5.A — `guards.ts` generic assertFromState

- **5.A.1** (red): unit test for `assertFromState(current, allowed, sessionId, transitionName)` — throws `ApiError('conflict', 409)` on disallowed; silent on allowed
- **5.A.2** (verify fail)
- **5.A.3** (green): create `src/server/session/guards.ts` with generic guard typed over status enums
- **5.A.4** (verify pass)
- **5.A.5** (commit): `feat(1c.1 Step 5): session/guards — generic assertFromState (lifted from ingestion/session)`

### 5.B — `events.ts` session → event helper

- **5.B.1** (red): test `writeSessionEvent({ tx, session_id, action, subject_kind, subject_id, actor_kind, actor_ref, outcome, payload })` constructs an event matching `ExtractSourceDocument` shape, writes via `writeEvent`, returns event_id; passes parseEvent guard
- **5.B.2** (verify fail)
- **5.B.3** (green): create `src/server/session/events.ts` wrapping `writeEvent`; constrain action='extract' for Phase 1c.1 (assert in code, document for Phase 1d expansion)
- **5.B.4** (verify pass)
- **5.B.5** (commit): `feat(1c.1 Step 5): session/events — writeSessionEvent helper (delegates to Step 4 writeEvent)`

### 5.C — `ingestion.ts` move + table swap

- **5.C.1** (red): copy `src/server/ingestion/session.test.ts` → `src/server/session/ingestion.test.ts`; switch imports `from './ingestion'`; switch fixture inserts from `ingestion_session` → `learning_session` with `type='ingestion'`; switch assertions to read from `learning_session`
- **5.C.2** (verify fail): tests fail — new file doesn't exist; old still passes
- **5.C.3** (green): copy `src/server/ingestion/session.ts` → `src/server/session/ingestion.ts`; swap all `ingestion_session` → `learning_session` table references; add `type: 'ingestion'` to INSERT; update `loadSessionForUpdate` SELECT predicate (`WHERE id=? AND type='ingestion'`); KEEP old `src/server/ingestion/session.ts` for now (deleted in 5.G)
- **5.C.4** (verify pass): both test files pass (transitional dual-existence)
- **5.C.5** (commit): `refactor(1c.1 Step 5): lift ingestion session module → src/server/session/ingestion (table swap to learning_session)`

### 5.D — Integrate event writes in ingestion transitions

- **5.D.1** (red): add tests asserting `applyExtractionResult` writes an `event(action='extract', subject_kind='source_document', actor_kind='agent', actor_ref='tencent_ocr', outcome='success')` chained to the session via `session_id`; same for `markExtractionFailed` (outcome='failure'); same for `applyRescue` (actor_ref='vision_rescue')
- **5.D.2** (verify fail)
- **5.D.3** (green): wire `writeSessionEvent` calls into each extract-flavored transition (same transaction as the status update)
- **5.D.4** (verify pass)
- **5.D.5** (commit): `feat(1c.1 Step 5): ingestion transitions write extract events (via writeSessionEvent)`

### 5.E — `review.ts` new minimal state machine

- **5.E.1** (red): test `startReviewSession()` inserts `learning_session(type='review', status='started')`; `completeReviewSession(id)` updates status='completed' with ended_at; `abandonReviewSession(id)` → status='abandoned'. Invalid from-state → ApiError(409)
- **5.E.2** (verify fail)
- **5.E.3** (green): create `src/server/session/review.ts` with 3 transition fns; use `guards.ts` `assertFromState`; **no event writes** in Step 5 — review events are written by route layer in Step 6 (per design intent)
- **5.E.4** (verify pass)
- **5.E.5** (commit): `feat(1c.1 Step 5): session/review — minimal state machine (started → completed/abandoned)`

### 5.F — `index.ts` polymorphic dispatcher

- **5.F.1** (red): test that `import { Ingestion, Review } from '@/server/session'` works (both namespaces); type-level test that `LearningSessionTypeT` re-export works
- **5.F.2** (verify fail)
- **5.F.3** (green): create `src/server/session/index.ts` with namespace re-exports
- **5.F.4** (verify pass)
- **5.F.5** (commit): `feat(1c.1 Step 5): session/index — polymorphic namespace dispatcher`

### 5.G — Migrate callers + delete old module

- **5.G.1** (red): write a "single-owner invariant" vitest test in `tests/integration/session-single-owner.test.ts` that walks the file tree under `src/` + `app/` using `fs.readdir`/`fs.readFile` (no shell exec), scans each file's source for `db.update(learning_session)` and `db.insert(learning_session)` regex patterns, and asserts every hit's file path starts with `src/server/session/` or `scripts/migrate-phase1c1.ts`. Pure-Node, deterministic, fast.
- **5.G.2** (verify fail): scan currently finds hits in places like `tencent_ocr_extract.ts` (after caller migration intermediate state) — adjust caller migration to fix
- **5.G.3** (green): update all callers to import from `'@/server/session'`; delete `src/server/ingestion/session.ts` + `src/server/ingestion/session.test.ts`
- **5.G.4** (verify pass): single-owner test passes
- **5.G.5** (commit): `refactor(1c.1 Step 5): migrate ingestion module callers + delete old src/server/ingestion/session.ts`

### 5.H — Integration: session → event chain end-to-end

- **5.H.1** (red): `tests/integration/session-event-chain.test.ts`: simulate a full ingestion lifecycle (initiateUpload → enqueueExtraction → markExtractionStarted → applyExtractionResult); assert (a) all status transitions in `learning_session`, (b) 1 `event(action='extract', outcome='success')` written with `session_id` matching, (c) `job_events` rows present too (Sub 0c plumbing untouched)
- **5.H.2** (verify fail)
- **5.H.3** (green): verify all moving parts wired
- **5.H.4** (verify pass)
- **5.H.5** (commit): `test(1c.1 Step 5): integration — ingestion lifecycle writes extract events chained via session_id`

### 5.I — Backwards-compat read smoke

- **5.I.1** (red): `tests/integration/learning-session-read-roundtrip.test.ts`: seed a fixture in `learning_session(type='ingestion')` directly, exercise read paths (e.g., a real route via Next.js handler invocation) → asserts read paths now return data from learning_session (NOT ingestion_session). Verify export route still works (Step 4 csv.ts dual-path covers ingestion_session readers, but this verifies the new write path didn't accidentally bypass any read site).
- **5.I.2** (verify fail)
- **5.I.3** (green): adjust as needed
- **5.I.4** (verify pass)
- **5.I.5** (commit): `test(1c.1 Step 5): integration — read paths return data from learning_session`

### 5.J — Audit: legacy `ingestion_session` writes have zero hits in src/

- **5.J.1** (red): extend the Node-based source scanner from 5.G.1 to also assert: `db.insert(ingestion_session)` and `db.update(ingestion_session)` regex patterns have ZERO hits across `src/server/` + `app/api/`. Allowed hits: `src/db/schema.ts` (table definition), `src/core/schema/generated.ts` (drizzle-zod generated), `scripts/migrate-phase1c1.ts` (Step 3 read).
- **5.J.2** (verify fail) if any stragglers remain
- **5.J.3** (green): clean up
- **5.J.4** (verify pass)
- **5.J.5** (commit): `chore(1c.1 Step 5): assert legacy ingestion_session has zero write callers in src/server/ + app/`

---

## Subagent prompt (ready after PR #47 merges + Step 5 plan committed to phase1c1-step5-prep branch)

```markdown
You are executing Phase 1c.1 Step 5 of the-learning-project. You are running in a fresh worktree; the parent session will review and merge your work.

## BOOTSTRAP

Your worktree was created from `origin/main`. Step 5 depends on Step 4 content + the Step 5 expansion plan. These live on `origin/phase1c1-step5-prep` (created by parent before dispatching). Bootstrap:

```bash
git fetch origin
git merge origin/phase1c1-step5-prep --ff-only
```

Verify:
```bash
ls docs/superpowers/plans/2026-05-16-phase1c1-step5-learning-session.md   # plan
ls src/server/events/queries.ts                                          # Step 4 writeEvent
grep "writeEvent" src/server/events/queries.ts                           # confirm export
```

## Authoritative spec

`docs/superpowers/plans/2026-05-16-phase1c1-step5-learning-session.md` — read this in full. Mapping + TDD breakdown supersede parent plan §Step 5.

## Required reading

1. `CLAUDE.md`
2. `docs/superpowers/plans/2026-05-16-phase1c1-step5-learning-session.md` (your authoritative spec)
3. `docs/adr/0005-ingestion-session-single-owner.md` — invariant that extends to all session types
4. `docs/adr/0008-learning-session-multi-type-envelope.md` — multi-type design
5. `docs/adr/0011-tool-use-and-edge-event-paths.md` — KnownEvent union including `ExtractSourceDocument`
6. `src/core/schema/learning_session.ts` — Lane B per-type status enums + `LearningSessionStatusByType` discriminated union
7. `src/core/schema/event/known.ts` — `ExtractSourceDocument` shape (your event-write target)
8. `src/server/events/queries.ts` — Step 4 `writeEvent` (the only INSERT path for `event`)
9. `src/server/ingestion/session.ts` — module you're lifting (read FULL — ~330 lines)
10. `src/server/ingestion/session.test.ts` — tests you're moving
11. Callers (audit before editing): `src/server/boss/handlers/tencent_ocr_extract.ts`, `app/api/ingestion/route.ts`, `app/api/ingestion/[id]/extract/route.ts`, `app/api/ingestion/[id]/rescue/route.ts` (if exists), `app/api/ingestion/[id]/import/route.ts`

## Locked contract

- **NEW `src/server/session/` is the single-owner module for `learning_session` writes**. After Step 5, the single-owner test (5.G/5.J) returns ONLY allowed hits inside `src/server/session/` (plus the Step 3 migration script).
- **All extract-flavored ingestion state transitions write an event** via `writeSessionEvent` (which delegates to Step 4 `writeEvent`). Event: `action='extract'`, `subject_kind='source_document'`, `session_id=<learning_session.id>`. Use `ExtractSourceDocument` schema from Lane B.
- **State-only transitions** (`initiateUpload`, `enqueueExtraction`, `markExtractionStarted`, `markReviewed`, `commitImport`) write NO domain events — `job_events` covers async observability. Document this decision inline with reference to Phase 1d.
- **Review state machine** (`startReviewSession` / `completeReviewSession` / `abandonReviewSession`): NO event writes in Step 5 — per-question review events are wired by Step 6 routes.
- 10 separate commits, conventional format `feat|refactor|test|chore(1c.1 Step 5): ...`. Each ends with:
  ```
  Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
  ```

## Implementation guidance

- **Lift-and-shift first, then refactor**: do 5.C as a near-mechanical copy. Table swap is search-and-replace `ingestion_session` → `learning_session` + add `type: 'ingestion'` filter to predicates. Keep guard structure intact.
- **`assertFromState` generic refactor in 5.A**: the existing fn is typed for the ingestion enum. Generalize to: `assertFromState<S extends string>(current: string, allowed: readonly S[], sessionId: string, transitionName: string): asserts current is S`.
- **`writeSessionEvent` event construction**: read `ExtractSourceDocument` shape in `known.ts` for required payload. Likely `payload: { source_document_id, ... }` — confirm exact shape before writing.
- **Read predicate for `loadSessionForUpdate`**: MUST filter `type='ingestion'` so a malformed review session can't accidentally be loaded by ingestion transitions.
- **Single-owner test (5.G.1, 5.J.1)**: pure Node `fs.readdir` + `fs.readFile` recursive walk + regex match. NO shell exec, NO `child_process`. Build a simple recursive walker in the test file itself (~30 LOC).
- **Caller migration**: update each caller's import individually, run tests after each, then delete the old module last.

## Out of scope (DO NOT TOUCH)

- DB schema changes (Lane A locked)
- Lane B Zod (`src/core/schema/event/**` + `learning_session.ts`)
- AI prompts (Step 7)
- New routes (Step 6 — `/api/events`, `/api/knowledge/edges`)
- DROP TABLE migrations (Step 9 — including dropping `ingestion_session`)
- `src/server/ingestion/`'s OTHER files (`crop.ts`, `figure_attach.ts`, `rescue.ts`, `tencent_mark*.ts`, `vision.ts`) — those are extraction logic, not session state. Leave intact.

## Verification gates

- `pnpm typecheck` — green
- `pnpm test src/server/session/` (all session tests) — green
- `pnpm test src/server/boss/handlers/tencent_ocr_extract.test.ts` — green
- `pnpm test app/api/ingestion/` — green (callers migrated)
- `pnpm test tests/integration/session-event-chain.test.ts` — green
- `pnpm test tests/integration/session-single-owner.test.ts` — green
- `pnpm test tests/integration/learning-session-read-roundtrip.test.ts` — green
- `pnpm test` full suite — green (no regressions)
- `pnpm lint` — no new errors
- `pnpm audit:schema` — green
- Single-owner test (5.G) asserts `db.{insert,update}(learning_session)` only in `src/server/session/` + `scripts/migrate-phase1c1.ts`
- Legacy audit (5.J) asserts `db.{insert,update}(ingestion_session)` returns ZERO hits in `src/server/` + `app/api/`
- 10 commits, conventional format

## Return (under 800 words)

1. Branch name (worktree-assigned)
2. 10 commit hashes + subjects
3. Verification gate outputs (final line each)
4. Sample event paste: one extract event chained to an ingestion session (JSON)
5. Edge cases (bullets)
6. Out-of-scope discoveries (bullets)
7. Outstanding risks for Step 6/7/8/9
```

---

## Risk register (Step 5-specific)

- **Lift-and-shift bugs**: the ingestion module has ~8 transition functions and intricate ghost-job semantics (see `enqueueExtraction` comment in current file). Mechanical move + table swap risks subtle behavior drift. Mitigation: keep the test file as the authoritative behavior contract; if a test fails after the move, fix the move not the test.
- **`learning_session.type='ingestion'` filter forgotten**: if `loadSessionForUpdate` doesn't filter by type, a review session in `learning_session` could be loaded by ingestion transitions and partially mutated. Mitigation: filter in `loadSessionForUpdate` + assert type in transition entry guards.
- **Event-write atomicity**: `writeSessionEvent` must run in the same transaction as the status UPDATE. If event INSERT fails after status UPDATE, the transition is half-applied. Mitigation: both writes inside `params.db.transaction()`; existing pattern.
- **`ExtractSourceDocument` payload mismatch**: Lane B's exact payload shape may not perfectly match all 3 extract-flavored transitions (success / failure / rescue). Mitigation: subagent reads `known.ts` and chooses between mapping cleanly or using `ExperimentalEvent` namespace (`experimental:extract_rescue` etc.) for cases that don't fit `ExtractSourceDocument` envelope. Document the decision inline.
- **Review state machine vs Phase 1d expansion**: deliberately minimal in Step 5. If Phase 1d needs `paused / resumed` states, that's a state-machine expansion (new transitions) not a redesign — current 3-state design supports forward extension.
- **Read paths between Step 5 and Step 8 prod migration**: code reads from `learning_session`; production `learning_session` is empty (migration not yet run). If Step 5 deploys to prod before Step 8 runs, users lose access to existing sessions. Mitigation: deployment runbook (Step 8) runs migration BEFORE the new code activates. Step 5 itself does not need a fallback.

---

## Next-step planning

Step 6 (API routes rewrite — `/api/mistakes` body over event stream, new `/api/events` + `/api/knowledge/edges`) plan should be drafted after Step 5 lands. Step 6 will call into Step 4's `getFailureAttempts` and Step 5's `Ingestion.*` namespace heavily.
