# Phase 1c.1 Step 4 — Server read-path rewrite (mistake → event stream)

> Step 4 ("Server 端 read-path 重写") expansion. Parent plan: `2026-05-14-phase1c1-encounter-session-ui-scaffold.md` §Step 4.
>
> **Prerequisites**: PR #33/#36 (Lane A schema), PR #37 (Lane B Zod), PR #46 (Step 3 migration script) all merged into main. PR #38 (Lane C1 UI) independent. Verify with `git log --oneline main | head` showing all "feat(1c.1 Step 3): ..." commits.
>
> **Scope**: Rewrite `src/server/knowledge/{attribute,propose,review}.ts` + `src/server/export/csv.ts` to read/write from event stream instead of `mistake` table. **Add** `src/server/events/queries.ts` as the single-owner module for event reads (per ADR-0005 single-owner invariant). Maintain external function signatures wherever possible so call sites (Step 6) update independently. **Do not change** API routes (Step 6).

---

## Design intent (recap from parent plan)

- `mistake` 是单表实体；`event` 是 action log。同一份"错题"在新模型下是 **attempt event + optional chained judge event** 的 view。
- 用户面"错题"概念**稳定**——server library 函数签名尽量保持 mistake-shape 输入输出，内部换查询模式。
- 业务层封装：上层（routes / boss handlers）调 `src/server/events/queries.ts` helper，**不**写裸 event SQL。
- 老 `mistake` 表本步**仍未删**（Step 9）；新代码读 event，老数据靠 Step 8 migration 迁过来。

---

## New module: `src/server/events/queries.ts` (single-owner read API)

Per ADR-0005，`event` 表所有 read 都从此模块出。其他模块 `import { ... } from '@/server/events/queries'`，不直接写裸 `db.select().from(event)`.

### API surface (export)

```ts
// 1. 失败 attempts —— 用户面"错题"的核心 view
export async function getFailureAttempts(
  db: Db,
  opts?: { limit?: number; questionIds?: string[]; since?: Date }
): Promise<FailureAttempt[]>

export type FailureAttempt = {
  attempt_event_id: string;     // event.id
  question_id: string;          // event.subject_id
  answer_md: string | null;     // event.payload.answer_md
  answer_image_refs: string[];
  referenced_knowledge_ids: string[];
  created_at: Date;
  // Joined judge event (if exists, via caused_by_event_id reverse lookup):
  judge?: {
    judge_event_id: string;
    cause: CauseSchemaT;       // 'analysis_md' (Lane B), not legacy 'ai_analysis_md'
    referenced_knowledge_ids: string[];
    created_at: Date;
  };
};

// 2. 单一 attempt's chained judge (for caused_by traversal)
export async function getJudgeForAttempt(
  db: Db,
  attemptEventId: string
): Promise<JudgeEvent | null>

// 3. Recent FSRS reviews —— mistake.fsrs_state 旧入口的等价
export async function getRecentReviewEvents(
  db: Db,
  opts?: { limit?: number; questionIds?: string[]; since?: Date }
): Promise<ReviewEvent[]>

// 4. Single event by id (caused_by chain navigation)
export async function getEventById(db: Db, id: string): Promise<KnownEventT | null>

// 5. Write-side (event INSERT) —— centralized for parseEvent guard
export async function writeEvent(db: Db | Tx, event: unknown): Promise<string>
// internally: parseEvent(event) → INSERT → return event.id
```

### Implementation notes

- **All reads `LEFT JOIN`/`LATERAL` event-to-event for judge chain.** Use Drizzle subquery or two queries with in-memory join (start with two queries for clarity, optimize later).
- **`getFailureAttempts.referenced_knowledge_ids` query path**: use the GIN index on `event.payload` (declared in `drizzle/0005_phase1c1_event_payload_gin_and_mastery_view.sql`) — `WHERE payload @> '{"referenced_knowledge_ids": [...]}'`.
- **`writeEvent` is the single INSERT path**. Every caller MUST call `writeEvent` not direct `db.insert(event)`. Enforces parseEvent guard. The migration script (Step 3) is the historical exception (bulk insert without re-parse since it pre-validates).

### Test: `src/server/events/queries.test.ts`

- 9 unit tests: 1 per exported fn × happy path + 1 edge case. Fixtures seed `event` table directly (no Step 3 migration in tests).

---

## Per-file rewrites

### `src/server/knowledge/attribute.ts`

**Currently**: takes `mistakeId + expectedVersion`, runs AttributionTask, UPDATE `mistake.cause` with optimistic version check.

**New**: takes `attemptEventId`, runs AttributionTask, writes `event(action='judge', subject_kind='event', caused_by_event_id=attemptEventId, payload.cause=...)`. Idempotency: if a judge event with `caused_by_event_id=attemptEventId` already exists, skip + warn (mirrors old "cause already set" check).

```ts
export interface RunAttributionAndWriteJudgeEventParams {
  db: Db;
  attemptEventId: string;          // ← was mistakeId + expectedVersion
  input: AttributionInput;
  runTaskFn: RunTaskFn;
  env?: unknown;
}

export async function runAttributionAndWriteJudgeEvent(
  params: RunAttributionAndWriteJudgeEventParams
): Promise<void>
```

**Signature change**: forced by domain model — there is no `mistake.id` anymore. Caller (route, Step 6) must be updated. **Step 4 includes minimal route.ts adjustment** to keep compilation: route inserts attempt event (using `writeEvent`), then passes `attemptEventId` to `runAttributionAndWriteJudgeEvent`. The mistake-table row also still gets inserted (additive, for transition; Step 6 will remove the dual-write).

The `AttributionOutputSchema` Zod stays — it's the LLM output contract. Bridge: Lane B `CauseSchema` uses `analysis_md` not `ai_analysis_md`. **Rename in AttributionOutputSchema too** (`ai_analysis_md` → `analysis_md`), and update the AttributionTask prompt in `src/ai/registry.ts` (Step 7 will redo prompts more broadly; Step 4 does the minimal rename to keep types aligned).

### `src/server/knowledge/propose.ts`

**Currently**: takes `mistakeContent` parameter (caller provides), loads tree, calls KnowledgeProposeTask, writes `dreaming_proposal` rows via `writeDreamingProposal`.

**New**: keep same signature. The internal `writeDreamingProposal` write is **already event-stream-relevant** indirectly (dreaming_proposal is the legacy table; Step 4 doesn't migrate that table — Step 3 migration handles it, future writes go through Phase 1c.2's new proposal mechanism). Step 4 leaves `writeDreamingProposal` alone — `propose.ts` does not need rewrite. Only the **caller** (boss handler `knowledge_propose_nightly.ts`) changes: instead of `SELECT * FROM mistake WHERE created_at > now()-24h`, it does `getFailureAttempts(db, { since: ... })`.

**Effective scope in Step 4**: rewrite **`src/server/boss/handlers/knowledge_propose_nightly.ts`** to source mistake-shape data from `getFailureAttempts`. Construct `mistakeContent` argument from `FailureAttempt` view.

### `src/server/knowledge/review.ts`

**Currently**: `buildReviewInput` reads `knowledge` tree + `mistake` table (latest 100, ordered by created_at desc).

**New**: read `knowledge` tree (unchanged) + recent failure attempts via `getFailureAttempts(db, { limit: 100 })`. Project each FailureAttempt to mistake-shape:

```ts
const mistakes = (await getFailureAttempts(db, { limit: 100 })).map(fa => ({
  id: fa.attempt_event_id,
  question_id: fa.question_id,
  knowledge_ids: fa.referenced_knowledge_ids,
  cause: fa.judge?.cause ?? null,    // null if no judge yet
}));
```

This keeps the `KnowledgeReviewTask` prompt input shape stable (model sees same mistake-list structure). Step 7 will redo the prompt to natively speak event-stream language.

### `src/server/export/csv.ts`

**Currently**: `buildMistakesCsv(tables)` and `buildReviewEventsCsv(tables)` take a `tables` dict (export-time JSON dump). Operate on `tables.mistake[]`, `tables.review_event[]`, etc.

**New**: same function signatures; new internal logic that ALSO accepts `tables.event[]` and `tables.material_fsrs_state[]`. Projects events back to mistake-shape rows by:
- Filter `tables.event` for `action='attempt' AND outcome='failure'`
- For each attempt, find chained judge in same list by `caused_by_event_id` reverse
- Find latest review event for same `subject_id` → fsrs_state_after
- Synthesize a mistake-shape row preserving the existing CSV column list (back-compat)

**Decision**: Keep old `tables.mistake[]` path active for **back-compat** during transition. If `tables.mistake[]` is non-empty (legacy export), use it. If `tables.event[]` is non-empty and `tables.mistake[]` is empty (post-Step-9 future), use event projection. This eliminates the need to coordinate csv.ts with the export route's table selection.

`buildReviewEventsCsv` follows the same dual-path approach: if `tables.review_event[]` present, use it; else project from `tables.event WHERE action='review'`.

---

## Out-of-scope ("Step 6 will handle")

- `app/api/mistakes/route.ts` POST: still inserts mistake row + calls attribution. Step 4 patches the call site only to use `runAttributionAndWriteJudgeEvent(attemptEventId, ...)`. Step 6 rewrites the route's body shape.
- `app/api/mistakes/recent/route.ts`: still reads `mistake` table. Step 6 switches to `getFailureAttempts`.
- New `app/api/events/*` routes — Step 6.
- AI prompt rewrites — Step 7.

## Out-of-scope ("Step 9 will handle")

- DROP `mistake` / `review_event` / `dreaming_proposal` / `judgment` / `user_appeal` tables.
- Remove dual-write paths (Step 4 inserts BOTH mistake row AND attempt event for transition safety).
- Final cleanup of legacy `import { mistake } from '@/db/schema'`.

---

## TDD substep breakdown

> Pattern: **X.1 red test → X.2 verify fail → X.3 green impl → X.4 verify pass → X.5 commit**. Each lettered phase is a TDD cycle.

### 4.A — `getFailureAttempts` + `getJudgeForAttempt` (events queries module)

- **4.A.1** (red): write `src/server/events/queries.test.ts`; insert fixture: 2 attempt events (1 with chained judge, 1 without); call `getFailureAttempts(db)` → expect [2 FailureAttempt rows, judge populated on row 1, null on row 2]
- **4.A.2** (verify fail): test fails — `queries.ts` doesn't exist
- **4.A.3** (green): create `src/server/events/queries.ts` with `getFailureAttempts` + `getJudgeForAttempt`
- **4.A.4** (verify pass)
- **4.A.5** (commit): `feat(1c.1 Step 4): events queries module — getFailureAttempts + getJudgeForAttempt`

### 4.B — `getRecentReviewEvents` + `getEventById`

- **4.B.1** (red): fixture 3 review events on same question; call `getRecentReviewEvents(db, { questionIds:[q1] })` → expect 3 rows ordered desc by created_at. `getEventById(db, id)` returns single event or null.
- **4.B.2** (verify fail)
- **4.B.3** (green): implement both fns
- **4.B.4** (verify pass)
- **4.B.5** (commit): `feat(1c.1 Step 4): events queries — getRecentReviewEvents + getEventById`

### 4.C — `writeEvent` (single INSERT path with parseEvent guard)

- **4.C.1** (red): test `writeEvent(db, validEvent)` returns id and row exists; `writeEvent(db, invalidEvent)` throws ZodError; double `writeEvent` with same `deterministicId` returns first id (idempotent via PK conflict do-nothing)
- **4.C.2** (verify fail)
- **4.C.3** (green): implement using `parseEvent` from `src/core/schema/event`
- **4.C.4** (verify pass)
- **4.C.5** (commit): `feat(1c.1 Step 4): events queries — writeEvent single-owner INSERT path`

### 4.D — `attribute.ts` rewrite (judge event instead of mistake.cause UPDATE)

- **4.D.1** (red): rewrite `attribute.test.ts`: insert attempt event fixture; call `runAttributionAndWriteJudgeEvent({ attemptEventId, ... })`; expect a judge event written with `caused_by_event_id === attemptEventId`, payload.cause matches AttributionOutput parsed shape (with `analysis_md` not `ai_analysis_md`); 2nd call with same attemptEventId → skip + warn (idempotent)
- **4.D.2** (verify fail)
- **4.D.3** (green): rewrite `runAttributionAndWrite` → `runAttributionAndWriteJudgeEvent`; rename Zod schema field `ai_analysis_md` → `analysis_md`; use `writeEvent`. Update the caller in `app/api/mistakes/route.ts` (minimal patch — pass attemptEventId; keep mistake row insert for transition)
- **4.D.4** (verify pass)
- **4.D.5** (commit): `refactor(1c.1 Step 4): attribute — write judge event chained on attempt (replaces mistake.cause UPDATE)`

### 4.E — `review.ts` rewrite (read failure attempts from event stream)

- **4.E.1** (red): rewrite `review.test.ts`: pre-seed attempt+judge events instead of mistake rows; call `streamReviewTask`; verify input to LLM contains `recent_mistakes` array with shape `{id, question_id, knowledge_ids, cause}` projected from events
- **4.E.2** (verify fail)
- **4.E.3** (green): rewrite `buildReviewInput` to use `getFailureAttempts` projection
- **4.E.4** (verify pass)
- **4.E.5** (commit): `refactor(1c.1 Step 4): review — buildReviewInput reads failure attempts from event stream`

### 4.F — boss handler `knowledge_propose_nightly.ts` source switch

- **4.F.1** (red): rewrite handler test: seed attempt events instead of mistake rows; call handler; verify it iterates events via `getFailureAttempts(db, { since: ... })`
- **4.F.2** (verify fail)
- **4.F.3** (green): switch handler's SELECT to `getFailureAttempts`; construct `mistakeContent` from FailureAttempt projection
- **4.F.4** (verify pass)
- **4.F.5** (commit): `refactor(1c.1 Step 4): knowledge_propose_nightly handler reads failure attempts from event stream`

### 4.G — `export/csv.ts` dual-path (mistake table OR event stream)

- **4.G.1** (red): write `csv.test.ts` new cases: (a) `tables.mistake=[]`, `tables.event=[attempt, judge]` → expect CSV row projected from events with judge's cause.primary_category in column; (b) `tables.mistake=[legacy], tables.event=[]` → existing legacy path unchanged. Same dual-path for `buildReviewEventsCsv`.
- **4.G.2** (verify fail)
- **4.G.3** (green): rewrite both CSV builders with dual-path branching at function entry
- **4.G.4** (verify pass)
- **4.G.5** (commit): `refactor(1c.1 Step 4): export csv — dual-path (legacy mistake + new event stream) for back-compat`

### 4.H — integration back-compat test

- **4.H.1** (red): `tests/integration/mistake-readpath.test.ts`: seed event+judge fixtures; call each public function (`getFailureAttempts`, `streamReviewTask`, `buildMistakesCsv`, etc.); compare output against historical mistake-shape baseline (a hand-written JSON fixture)
- **4.H.2** (verify fail)
- **4.H.3** (green): make sure projections match; tweak as needed
- **4.H.4** (verify pass)
- **4.H.5** (commit): `test(1c.1 Step 4): integration mistake-readpath back-compat`

---

## Subagent prompt (ready when PR #46 merges)

```markdown
You are executing Phase 1c.1 Step 4 in an isolated git worktree of the-learning-project. Your scope is the **server read-path rewrite** — replace `mistake` table queries with event stream queries. Do NOT touch API routes outside the minimal `app/api/mistakes/route.ts` patch in 4.D (Step 6 owns routes). Do NOT touch DB schema (Lane A). Do NOT rewrite AI prompts (Step 7).

# Prerequisites

Verify these are in main BEFORE starting:
- `git log --oneline main | head -20` shows commits with `feat(1c.1 Step 3): ...` (migration script in main)
- `ls scripts/migrate-phase1c1.ts` exists
- `ls src/core/schema/event/index.ts` exports `parseEvent`, `Event`
- `src/db/schema.ts` exports `event`, `learning_session`, `material_fsrs_state`
- `pnpm test` baseline passes (516 passing)

If any prerequisite fails, STOP and report.

# Project context

Self-hosted single-user AI learning tool. Stack: Next.js 15 + Postgres + Drizzle ORM, Zod for runtime validation, Vitest with @testcontainers/postgresql. Read CLAUDE.md.

# Required reading

1. `CLAUDE.md` — project conventions
2. `docs/superpowers/plans/2026-05-16-phase1c1-step4-server-readpath.md` — **this doc is the authoritative Step 4 spec**; mapping + TDD breakdown both supersede any conflicting text in the parent plan
3. `docs/superpowers/plans/2026-05-14-phase1c1-encounter-session-ui-scaffold.md` §Step 4 — high-level context only
4. `docs/adr/0005-single-owner-write-path.md` — single-owner invariant (`src/server/events/queries.ts` is the only event writer module)
5. `docs/adr/0006-encounter-replaces-mistake.md` (v2) — event payload Zod 守护策略
6. `src/db/schema.ts` — read `event`, `learning_session`, `material_fsrs_state` schemas; understand `event.caused_by_event_id` for judge chaining
7. `src/core/schema/event/known.ts` — KnownEvent shapes; `AttemptOnQuestion`, `JudgeOnEvent`, `ReviewOnQuestion` are your main targets
8. `src/core/schema/event/index.ts` — `parseEvent` (call before every INSERT)
9. `scripts/migrate-phase1c1.ts` — Step 3 migration script; reference for legacy → event mapping (do NOT re-derive — reuse `deterministicId` helper from `src/core/ids.ts`)
10. Current files you'll rewrite: `src/server/knowledge/{attribute,review}.ts`, `src/server/boss/handlers/knowledge_propose_nightly.ts`, `src/server/export/csv.ts`. Read each carefully to understand current behavior before TDD.

# Locked contract

- **MANDATORY**: every event INSERT goes through `writeEvent(db, eventObj)` in `src/server/events/queries.ts`. Direct `db.insert(event)` outside this module is forbidden.
- **MANDATORY**: `writeEvent` calls `parseEvent(eventObj)` before INSERT. parseEvent failures throw, not swallow.
- **Field names**: Lane B contract (see `known.ts`). Bridge legacy if needed; never invent new field names.
- **Function signatures**: keep external signatures stable wherever possible (review.ts internal change; csv.ts dual-path; propose.ts unchanged). Only `attribute.ts` has a forced signature change (no more `mistakeId + expectedVersion` — use `attemptEventId`).
- **Dual-write transition**: route `app/api/mistakes/route.ts` POST must STILL insert mistake row (legacy) AND attempt event (new) AND chained judge event (new) for transition safety. Step 9 will remove the dual-write.
- **No new test patterns**: use `testDb()` + `resetDb()` from `tests/helpers/db.ts`; reuse the `beforeEach(async () => resetDb())` cadence.
- 8 separate commits, one per TDD substep (4.A.5 / 4.B.5 / ... / 4.H.5). Do NOT batch.

# Implementation guidance

- **`writeEvent` idempotency**: use `.onConflictDoNothing({ target: event.id })`. If conflict → SELECT the existing row and return its id. Document this in code comment.
- **Judge chain reverse lookup**: query `event WHERE caused_by_event_id IN (attemptIds)` and group by `caused_by_event_id` in JS. Index `event_caused_by_idx` exists.
- **`getFailureAttempts` LIMIT default**: 100 (matches legacy `RECENT_MISTAKES_LIMIT`).
- **`csv.ts` dual-path**: branch at function entry — `if (tables.event && tables.event.length > 0 && (!tables.mistake || tables.mistake.length === 0)) { /* event-stream path */ } else { /* legacy mistake path */ }`. Document the precedence rule inline.
- **Attribution Zod rename `ai_analysis_md` → `analysis_md`**: this is a contract break for the LLM output parser. Existing prompts in `src/ai/registry.ts` still emit `ai_analysis_md` shape. Step 7 will redo prompts. **Step 4 must bridge** by accepting BOTH names in `AttributionOutputSchema.parse` (Zod `.transform()` or `.preprocess()`); when emitting events use `analysis_md`. Document the bridge with a comment referencing Step 7 for full cutover.

# Out of scope (DO NOT TOUCH)

- DB schema changes
- `src/core/schema/event/**` (Lane B locked contract)
- `src/ai/registry.ts` prompts (Step 7)
- `app/api/mistakes/recent/route.ts` (Step 6)
- New `app/api/events/*` routes (Step 6)
- Any `DROP TABLE` migration (Step 9)
- `tests/global-setup.ts` mastery_view DDL fix (separate Step 8 prep concern; the integration test added in Step 3 inlines view DDL — leave that pattern in place if you need the view)

# Verification gates

- `pnpm typecheck` — green
- `pnpm test src/server/events/queries.test.ts` — all green
- `pnpm test src/server/knowledge/attribute.test.ts` — green (rewritten for event-stream)
- `pnpm test src/server/knowledge/review.test.ts` — green
- `pnpm test src/server/boss/handlers/knowledge_propose_nightly.test.ts` — green
- `pnpm test src/server/export/csv.test.ts` — green (both legacy + event-stream cases)
- `pnpm test tests/integration/mistake-readpath.test.ts` — green
- `pnpm test` full suite — green (no regressions)
- `pnpm lint` — no new errors
- `pnpm audit:schema` — green
- 8 commits, conventional format `feat|refactor|test(1c.1 Step 4): ...`. Each commit ends with `Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>`

# Return (under 800 words)

1. Branch name (worktree-assigned)
2. 8 commit hashes + subjects
3. Verification gate outputs (final line of each)
4. Sample FailureAttempt projection: paste JSON of one with judge populated + one without
5. Edge cases encountered (bullet list)
6. Out-of-scope discoveries (bullet list)
7. Outstanding risks for Step 6/7/8
```

---

## Risk register (Step 4-specific)

- **`writeEvent` idempotency under concurrent writes**: PK conflict do-nothing serializes naturally; if same deterministicId is inserted from two concurrent paths, only first wins. Re-read on conflict to return same id. Risk: caller assumes write succeeded when it was a no-op. Mitigation: return `{ id, inserted: boolean }` and let caller decide.
- **Attribution Zod rename leak**: LLM prompts still emit `ai_analysis_md`. If a deployment runs Step 4 code with pre-Step-7 prompts, the parser must accept both names (covered by bridge). Step 7 cleanup removes the bridge.
- **CSV dual-path precedence**: if a developer accidentally exports both `mistake[]` and `event[]` to the dict, legacy wins. Document this and ensure export route emits one or the other, not both. (Out of scope to enforce here — Step 6 will tighten.)
- **`getFailureAttempts` LIMIT impact on KnowledgeReviewTask**: legacy queried 100 most recent mistakes. If event log has many `action='attempt'` events that aren't failures, the LIMIT could miss some. Filter must include `outcome='failure'` (mistake-equivalent). Document & test.
- **Test backwards-compat assertion**: 4.H needs a hand-written baseline JSON of mistake-shape. If the JSON diverges from real legacy data, the test isn't actually proving back-compat. Mitigation: generate baseline from a snapshot of staging data + commit it.

---

## Next-step planning

Step 5 (LearningSession multi-type module → `src/server/session/`) is the next big step. It evolves `src/server/ingestion/session.ts` to handle review / conversation / tutor types polymorphically. Expansion plan should be drafted separately after Step 4 lands.
