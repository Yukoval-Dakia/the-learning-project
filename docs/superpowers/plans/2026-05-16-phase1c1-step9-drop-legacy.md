# Phase 1c.1 Step 9 — DROP legacy tables (point of no return) + final invariant audit

> Step 9 ("DROP 旧表") + Step 11 ("烟测 + 验证 invariant") expansion. Parent plan §§Step 9 + Step 11. Combined into one plan since the invariant audit is the success criterion for the DROP.
>
> **Prerequisites**: Steps 1-8 all merged. Migration script `scripts/migrate-phase1c1.ts` production-ready and (assumed for testing) already run successfully against legacy data on prod.
>
> **Scope**: Drop 4 legacy tables (`mistake`, `review_event`, `dreaming_proposal`, `ingestion_session`). Migrate the remaining route handlers and helper modules that still read/write them. Remove transitional dual-write/dual-path code from Steps 4 + 6. Update artifact comment per issue #34. Final invariant audit asserting zero legacy-table writes outside migration script + zero legacy-table reads outside docs/audit code.
>
> **This is the irreversible point**: post-Step-9 there is no rollback to legacy schema without a database restore from backup.

---

## Audit: legacy table references still alive

Source-of-truth grep performed 2026-05-16 on `phase1c1-step8-prep` tip. Hits classified:

### A. Active read/write (MUST migrate or remove)

- `app/api/review/submit/route.ts` — reads `mistake`, INSERTs `review_event`. **Rewrite over event stream**.
- `app/api/review/due/route.ts` — reads `mistake` for FSRS scheduling. **Rewrite over `material_fsrs_state` + event stream**.
- `app/api/knowledge/proposals/route.ts` — reads `dreaming_proposal`. **Rewrite to project from event stream** (`event` table where `action='propose'`).
- `src/server/knowledge/proposals.ts` — defines `writeDreamingProposal`. **Replace with event-based propose path** (`writeEvent` with `ProposeKnowledge` shape).
- `app/api/mistakes/route.ts` POST — Step 4 left dual-write (mistake row + attempt event). **Remove legacy mistake row INSERT**.
- `app/api/ingestion/[id]/import/route.ts` — Step 5 left dual-write similar pattern. **Remove legacy mistake row INSERT** (the question row INSERT stays — `question` is not legacy).
- `src/server/export/csv.ts` — Step 4 dual-path (legacy mistake + event stream). **Remove legacy branch**; keep only event-stream projection.

### B. Test fixtures (update to event-stream seeds)

- `src/server/knowledge/proposals.test.ts` — fixtures use `dreaming_proposal`. Rewrite as event seeds.
- `src/server/knowledge/propose.test.ts` — references mistake fixtures.
- `src/server/knowledge/review.test.ts` — uses `dreaming_proposal` for propose path.
- `src/server/boss/handlers/knowledge_propose_nightly.test.ts` — references mistake fixtures.
- `app/api/ingestion/[id]/import/route.test.ts` — references mistake INSERTs.
- `app/api/mistakes/route.test.ts` — references mistake INSERTs.
- `app/api/review/submit/route.test.ts` — references mistake + review_event.

### C. Allowed readers (migration / legacy audit / archived tests)

These references are EXPECTED to remain after Step 9 — they're either (a) the migration script itself, or (b) intentionally archived. **Step 9 does NOT remove these.**

- `scripts/migrate-phase1c1.ts` — Step 3 migration script READS legacy tables. **Becomes a no-op after Step 9 since tables are gone**. The script itself remains in repo as historical record but cannot be re-run successfully. Add a top-of-file comment: "// HISTORICAL: legacy tables DROP'd in Step 9; this script is no longer runnable."
- `scripts/migrate-phase1c1.test.ts` — tests legacy → event mapping logic. After Step 9 the tables are gone; tests will break unless we mark them `.skip` or **remove the test file entirely** (since the production migration has run). **Decision**: REMOVE the test file in 9.K. The integration test `tests/integration/migrate-phase1c1.integration.test.ts` also becomes infeasible — REMOVE.
- `tests/integration/learning-session-read-roundtrip.test.ts` (Step 5) — uses `ingestion_session` in negative-case fixture. **Update**: remove the negative case (or replace with a learning_session-only fixture).
- `tests/integration/session-single-owner.test.ts` (Step 5) — audits `ingestion_session` writes. **Update**: since ingestion_session is gone, the audit is trivially satisfied; remove that branch of the audit. Keep the `learning_session` single-owner audit.
- `src/db/schema.ts:278-280` artifact comment — outdated. Update per issue #34 finding 1.

### D. Generated code

- `src/core/schema/generated.ts` — drizzle-zod generated from schema.ts. After dropping tables in schema.ts, **re-generate** via `pnpm db:generate` (or update file by hand if generate command isn't wired).

---

## Per-file rewrites

### `app/api/review/submit/route.ts`

**Current**: reads mistake by id, updates `mistake.fsrs_state`, inserts `review_event`.

**New**: 
- Read latest `material_fsrs_state` for the question (from Step 4's queries)
- Compute new FSRS state via `ts-fsrs`
- Write a `review` event via `writeEvent` (action='review', subject_kind='question', payload includes fsrs_rating + fsrs_state_after + user_response_md + referenced_knowledge_ids)
- Update `material_fsrs_state` projection (latest review's fsrs_state_after; this is the single-owner of `material_fsrs_state` — add `src/server/fsrs/state.ts` if there's no existing single-owner module)

**API contract preserved**: POST body shape + response shape unchanged from client's perspective.

### `app/api/review/due/route.ts`

**Current**: reads mistakes where `fsrs_state.due <= now()`.

**New**: query `material_fsrs_state` where `due_at <= now()`. Returns mistake-shape JSON via projection (same fields as Step 6's `/api/mistakes/recent`).

### `app/api/knowledge/proposals/route.ts`

**Current**: reads `dreaming_proposal` rows where `kind='knowledge'` and `status='pending'`.

**New**: project from `event` table where `action='propose'`, `subject_kind='knowledge'`, `outcome='partial'` (= legacy 'pending'). Map event.payload to legacy proposal-shape JSON for back-compat.

### `src/server/knowledge/proposals.ts`

**Current**: `writeDreamingProposal(db, { payload, reasoning })` INSERTs into `dreaming_proposal`.

**New**: Replace with `writeKnowledgeProposeEvent(db, { name, parent_id, reasoning, mutation })` that writes a `ProposeKnowledge` event via `writeEvent`. Other mutation kinds (reparent / merge / split / archive) go through `experimental:knowledge_<mutation>` event namespace until Lane B promotes them.

**Callers update**:
- `src/server/knowledge/propose.ts` (was `runProposeAndWrite`)
- `src/server/knowledge/review.ts` (was `write_proposal` tool dispatch)

Tool description in `review.ts` updates to reflect: tree mutations now go through event stream too (no more legacy dreaming_proposal landing point).

### `src/server/export/csv.ts`

**Current**: Step 4 dual-path — `if (tables.mistake?.length > 0) { legacy } else { event-stream }`.

**New**: Single path — event-stream projection only. Remove `tables.mistake` / `tables.review_event` parameter handling.

### `app/api/mistakes/route.ts` POST

**Current**: dual-writes mistake row + attempt event.

**New**: writes only attempt event (+ chained judge if cause supplied). Remove `db.insert(mistake)` call.

### `app/api/ingestion/[id]/import/route.ts`

**Current**: still hand-rolls `db.insert(mistake)` for legacy mistakes from imported sessions.

**New**: writes attempt event (action='attempt', outcome='failure') for each imported failure block. Remove `db.insert(mistake)` call.

### `src/db/schema.ts`

- Remove `export const mistake = pgTable(...)`
- Remove `export const review_event = pgTable(...)`
- Remove `export const dreaming_proposal = pgTable(...)`
- Remove `export const ingestion_session = pgTable(...)`
- Remove `judgment` table if not already (per data-assumptions §O2)
- Update artifact comment per #34 finding 1
- Update FK_ORDER in `src/server/export/constants.ts` (remove the 4 dropped tables)
- `pnpm db:generate` → produces `drizzle/0006_drop_legacy_tables.sql`
- `src/core/schema/generated.ts` — re-generate via drizzle-zod (or hand-remove the entries)

---

## TDD substep breakdown

12 substeps (Step 9 is the largest — many surface areas).

### 9.A — Rewrite `/api/review/submit` over event stream

- **9.A.1** (red): rewrite `submit/route.test.ts` to seed events + assert review event written + material_fsrs_state updated
- **9.A.5** (commit): `refactor(1c.1 Step 9): /api/review/submit writes review event + updates material_fsrs_state`

### 9.B — Rewrite `/api/review/due` over material_fsrs_state

- **9.B.1** (red): rewrite test to seed material_fsrs_state rows + assert returned shape matches legacy expectation
- **9.B.5** (commit): `refactor(1c.1 Step 9): /api/review/due reads from material_fsrs_state`

### 9.C — Rewrite `/api/knowledge/proposals` over event stream

- **9.C.1** (red): seed propose events, assert route returns legacy proposal-shape projection
- **9.C.5** (commit): `refactor(1c.1 Step 9): /api/knowledge/proposals projects from event stream`

### 9.D — Replace `writeDreamingProposal` with event-based propose handler

- **9.D.1** (red): tests for `writeKnowledgeProposeEvent(db, ...)` writing `ProposeKnowledge` event via `writeEvent`; assert callers (`propose.ts`, `review.ts`) use new path
- **9.D.5** (commit): `refactor(1c.1 Step 9): replace writeDreamingProposal with event-based propose path`

### 9.E — Remove `csv.ts` legacy dual-path

- **9.E.1** (red): update `csv.test.ts` removing legacy `tables.mistake` cases; assert event-stream-only path produces same output for the same data
- **9.E.5** (commit): `refactor(1c.1 Step 9): csv export reads only from event stream (remove Step 4 dual-path)`

### 9.F — Remove POST `/api/mistakes` mistake row dual-write

- **9.F.1** (red): assertion changes: POST no longer inserts `mistake` row; legacy `mistake` table SELECT in tests now returns 0 rows. Event chain still correct.
- **9.F.5** (commit): `refactor(1c.1 Step 9): POST /api/mistakes writes only events (remove mistake row legacy)`

### 9.G — Remove ingestion import route mistake INSERT

- **9.G.1** (red): rewrite import route test to assert event written (no mistake row)
- **9.G.5** (commit): `refactor(1c.1 Step 9): ingestion import writes attempt events for legacy mistakes`

### 9.H — Update artifact comment + Step 3 historical marker

- **9.H.1** (red): a documentation-style assertion test, e.g., grep `src/db/schema.ts` for outdated artifact comment substring; assert NOT present
- **9.H.5** (commit): `docs(schema): artifact table active comment (closes #34 finding 1) + Step 3 migration historical marker`

### 9.I — Update test fixtures across remaining *.test.ts files

- **9.I.1**: replace mistake/review_event/dreaming_proposal seed inserts with event/learning_session seeds. The affected files: proposals.test.ts, propose.test.ts, review.test.ts, knowledge_propose_nightly.test.ts, learning-session-read-roundtrip.test.ts, session-single-owner.test.ts.
- **9.I.5** (commit): `refactor(1c.1 Step 9): test fixtures use event/learning_session seeds (post-DROP)`

### 9.J — DROP tables in schema.ts + generate migration

- **9.J.1**: remove 4 table definitions from `src/db/schema.ts`; `pnpm db:generate` produces `drizzle/0006_drop_legacy_tables.sql`; re-generate `src/core/schema/generated.ts`; update `src/server/export/constants.ts` FK_ORDER (remove the 4 dropped tables) + bump `SCHEMA_VERSION` to `'3.0'`
- **9.J.5** (commit): `feat(1c.1 Step 9): DROP 4 legacy tables (mistake/review_event/dreaming_proposal/ingestion_session) — point of no return`

### 9.K — Remove Step 3 migration test files (now infeasible)

- **9.K.1**: delete `scripts/migrate-phase1c1.test.ts` + `tests/integration/migrate-phase1c1.integration.test.ts`. The script itself stays as historical record (with top-of-file marker added in 9.H).
- **9.K.5** (commit): `chore(1c.1 Step 9): remove Step 3 migration test files (tables DROP'd; tests no longer runnable)`

### 9.L — Final single-owner invariant audit

- **9.L.1**: pure-Node fs walker test asserts:
  - `db.insert(event)` only in `src/server/events/queries.ts`, `src/server/knowledge/edges.ts`, `src/server/knowledge/proposals.ts` (new event-based writer), `src/server/session/events.ts`, `src/server/knowledge/attribute.ts`, `src/server/knowledge/review.ts`, `scripts/migrate-phase1c1.ts` (historical), test fixtures + helpers
  - `db.update(learning_session)` only in `src/server/session/`
  - `db.update/insert(mistake|review_event|dreaming_proposal|ingestion_session)` returns ZERO hits in `src/` + `app/` (only `scripts/migrate-phase1c1.ts` historical references the SHAPE in comments, no actual table refs since tables gone)
  - `artifact` table appears in `src/server/ai/` writes (per parent plan §11 — "C 档 generate 路径"; this MAY be deferred to Phase 1c.2 if no AI generate handler exists yet; if so, the assertion is "appears in AI module OR is documented as Phase 1c.2 pending")
- **9.L.5** (commit): `test(1c.1 Step 9): single-owner invariant audit — zero legacy writes; event/learning_session writers locked`

---

## Locked contract

- **Point of no return**: after 9.J commit, schema is event-only. Rollback requires pg_restore.
- **All event INSERTs go through documented writers** (events/queries.ts, session/events.ts, knowledge/edges.ts, etc.). Single-owner audit (9.L) enforces.
- **Step 3 migration script stays in repo** as historical reference (with top-of-file marker). Its tests are removed.
- **External API URLs preserved**: `/api/mistakes/*` + `/api/review/*` + `/api/knowledge/proposals/*` URL + JSON shapes stable from client's perspective.
- **`SCHEMA_VERSION` bumps to `'3.0'`** in `src/server/export/constants.ts` (Lane A bumped to '2.0' for event-driven core; Step 9 bumps for DROP).
- 12 separate commits, conventional `feat|refactor|test|chore|docs(1c.1 Step 9): ...`. Each ends with `Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>`.

---

## Subagent prompt

```markdown
You are executing Phase 1c.1 Step 9 of the-learning-project. Worktree-isolated. **This is the largest step** — 12 TDD substeps covering route rewrites + writeDreamingProposal removal + DROP TABLE + invariant audit.

## BOOTSTRAP

```bash
git fetch origin
git merge origin/phase1c1-step9-prep --ff-only
```

Verify: `ls docs/superpowers/plans/2026-05-16-phase1c1-step9-drop-legacy.md`, plus all Step 1-8 prerequisites.

## Authoritative spec

`docs/superpowers/plans/2026-05-16-phase1c1-step9-drop-legacy.md` — read in full. Per-file rewrites + TDD breakdown supersede parent plan §§Step 9 + Step 11.

## Required reading

1. `CLAUDE.md`
2. `docs/superpowers/plans/2026-05-16-phase1c1-step9-drop-legacy.md` (authoritative)
3. ADR-0005 (single-owner) + ADR-0006 v2 (event-driven core) + ADR-0010 (mesh) + ADR-0011 (KnownEvent extensions)
4. `src/db/schema.ts` — current with all tables (you DROP 4 + keep rest)
5. `src/core/schema/event/known.ts` — KnownEvent shapes for all the event writes Step 9 introduces
6. `src/server/events/queries.ts` — `writeEvent` (the only event INSERT path)
7. `src/server/knowledge/proposals.ts` — `writeDreamingProposal` (you replace)
8. `src/server/knowledge/{propose,review,attribute}.ts` — callers
9. `app/api/review/{submit,due}/route.ts` — you rewrite
10. `app/api/knowledge/proposals/route.ts` — you rewrite
11. `app/api/mistakes/route.ts` + `app/api/ingestion/[id]/import/route.ts` — remove legacy mistake INSERTs
12. `src/server/export/csv.ts` — remove dual-path
13. `src/server/export/constants.ts` — bump SCHEMA_VERSION + FK_ORDER
14. `tests/integration/session-single-owner.test.ts` — Step 5 audit (extend/update for 9.L)

## Locked contract

- **POINT OF NO RETURN at 9.J** — DROP migration produced. Cannot roll back schema without pg_restore.
- **External API URLs + JSON shapes stable**.
- **All event INSERTs via documented writers** (single-owner audit in 9.L enforces).
- **Step 3 migration script stays** with historical marker; its tests removed.
- **12 separate commits**, conventional format. Each ends with `Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>`.

## Implementation guidance

- **9.A `/api/review/submit` rewrite**: read latest `material_fsrs_state` for question; compute new FSRS via `ts-fsrs`; write `review` event via `writeEvent`; UPDATE `material_fsrs_state` (this is its single-owner — add `src/server/fsrs/state.ts` module if not present).
- **9.B `/api/review/due`**: query `material_fsrs_state WHERE due_at <= now()`. Return mistake-shape projection (similar to Step 6's `/api/mistakes/recent`).
- **9.C `/api/knowledge/proposals`**: project from `event WHERE action='propose' AND subject_kind='knowledge' AND outcome='partial'`. Map event.payload to legacy proposal-shape JSON.
- **9.D `writeKnowledgeProposeEvent`**: new function in `src/server/knowledge/proposals.ts` (replace `writeDreamingProposal`). For propose_new use `ProposeKnowledge` (Lane B). For other mutations (reparent/merge/split/archive), use `experimental:knowledge_<mutation>` namespace via `ExperimentalEvent` until Lane B promotes them.
- **9.E csv.ts cleanup**: remove `tables.mistake` / `tables.review_event` branches entirely; output is event-stream-only. Update tests accordingly.
- **9.I test fixtures**: this is the bulk of cleanup work. Each test file has its own pattern; rewrite seed inserts to write events directly (similar to Step 4/6/7 test patterns).
- **9.J DROP migration**: `pnpm db:generate` should produce DROP TABLE statements for the 4 tables. Verify the generated SQL before committing. Also re-generate `src/core/schema/generated.ts` (or hand-remove the 4 entries if the generate command is unwired).
- **9.J FK_ORDER + SCHEMA_VERSION**: in `src/server/export/constants.ts`, remove `'mistake'`, `'review_event'`, `'dreaming_proposal'`, `'ingestion_session'` from FK_ORDER. Bump `SCHEMA_VERSION` from `'2.0'` to `'3.0'`. Update the route tests' SCHEMA_VERSION assertion (3 lines in `app/api/_/{export,import}/route.test.ts`).
- **9.L invariant audit**: pure-Node fs walker (same pattern as Step 5's `session-single-owner.test.ts`). Asserts:
  - `db.insert(event)` allowlist
  - `db.update(learning_session)` allowlist
  - Zero hits on dropped tables in any source file (only `scripts/migrate-phase1c1.ts` has historical references via comments)

## Out of scope (DO NOT TOUCH)

- Lane A/B schemas beyond the 4 DROPs
- Lane B Zod schemas
- `src/server/session/` (Step 5)
- AI prompts (Step 7)
- New routes
- UI code

## Verification gates

- `pnpm typecheck` green
- `pnpm test` full suite green (Step 8 baseline 666 — but expect this number to CHANGE since 9.K removes ~25 migration tests)
- `pnpm lint` no new errors
- `pnpm audit:schema` green (stub allowlist may need 3-mastery-stub entries removed since those columns are gone)
- `pnpm db:generate` produces clean DROP migration
- 12 commits, conventional format

## Return (under 1000 words — Step 9 is bigger)

1. Branch name
2. 12 commit hashes + subjects
3. Verification gate outputs (final lines)
4. Generated DROP migration content (`drizzle/0006_*.sql`)
5. Sample API responses post-Step-9: `GET /api/review/due`, `GET /api/knowledge/proposals?status=pending`
6. Edge cases — esp. anything where event-stream projection didn't cleanly preserve legacy shape
7. Out-of-scope discoveries
8. Outstanding risks for Step 10-13 (final smoke + docs + commit + PR + merge + deploy)
```

---

## Risks

- **Backwards-compat shape breakage**: external clients consuming `/api/review/due` / `/api/knowledge/proposals` may expect the legacy id (mistake.id, dreaming_proposal.id) as opaque tokens. Step 9 changes the id to the corresponding event.id. Document the breakage explicitly; if clients exist, version the API.
- **FSRS state divergence**: `material_fsrs_state` is the single-owner of FSRS data post-Step-9. If any reader still reads mistake.fsrs_state (because the test fixtures weren't all updated), it'll fail silently with stale data. Audit (9.L) catches.
- **drizzle-kit DROP migration is destructive**: must run in a maintenance window with backup ready. The runbook (Step 8.D) covers this.
- **`generated.ts` re-generation**: if drizzle-zod auto-generate isn't wired to schema.ts changes, subagent must hand-remove the 4 generated Zod schemas. Check `package.json` for the generate script first.
- **Test count drops**: Step 9.K removes ~25 migration tests. `pnpm test` baseline goes from 666 → ~641. Expected; not a regression.

---

## After Step 9

Remaining steps from parent plan:
- **Step 10** (UI scaffold Lane C1) — **already done** (PR #38 merged earlier)
- **Step 11** (invariant audit) — **integrated into Step 9.L** above
- **Step 12** (docs final pass) — short follow-up: update `docs/architecture.md` + `CONTEXT.md` with post-Step-9 reality
- **Step 13** (PR + merge + deploy) — execute deploy runbook (Step 8.D)

Phase 1c.1 complete after Step 12 docs + Step 13 deploy.
