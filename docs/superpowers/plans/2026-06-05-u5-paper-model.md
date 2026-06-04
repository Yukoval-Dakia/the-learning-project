# U5 — Paper Model + Practice Surface Implementation Plan

> Authority chain: `docs/design/2026-06-04-u0-decisions.md` D2/D3/D4/X6 + `docs/adr/0029-review-engine-lands-on-existing-primitives.md` 决定 #2/#3 + CO spec §5/§5.5/§5.8/§12 (`docs/superpowers/specs/2026-06-03-coach-led-review-engine-design.md`). Conflicts with spec prose resolve to u0-decisions (u0-decisions:4).
> Snapshot: `/tmp/u5` = `yuk-203-u5` @ `1c7bb30b` (deps installed). All assertions carry `file:line` into this snapshot, re-verified at plan time (not trusted from Map alone).
> Map input: `/tmp/u5-map.md` (five-dimension recon, four red-lines verified against source).
> Scope guard: **zero net-new tables**; `learning_session.artifact_id` is **1 new column**; `answer` revival = **reuse + add link columns** (not a new table, per ADR-0029 决定 #3 wording — see RL2); `ToolStateT v2` = additive jsonb variant with Zod parse barrier; `GetReviewDueInputSchema` **not extended** (RL3); `ReviewPlanTask` reads no memory and self-adaptation writes an adaptation event (RL5).

---

## 0. Background

U4 shipped the **producer** side of the review engine: `ReviewPlanTask` + `write_review_plan` write a `tool_quiz` paper artifact (`intent_source='review_plan'`, `tool_kind='review_plan'`) with the full structured plan (`sections[]` / `labels` / `rationale` / `guardrail_checks` / `needs[]`) parked in `tool_state.session_meta` as a documented **transition shape** (`review-plan-tools.ts:723-758`). U4 explicitly deferred to U5: *"promotable to ToolStateT v2 columns in U5 with no data loss"* (`u4-plan:122`) and listed `learning_session.artifact_id` / `answer` revival / ToolStateT v2 / draft autosave / practice UI under **Out-of-U4** (`u4-plan:170`).

U5 ships the **consumer** side: the data model that lets a user actually *take* a paper — promote the parked plan shape to a first-class `ToolStateT` v2 variant behind a Zod barrier; widen the artifact enums so any paper row can be `Artifact.parse()`d without throwing; link a running attempt to its paper via `learning_session.artifact_id`; revive the `answer` table as the answer-sheet draft layer; write each submitted answer + its judgement as events with a visibility gate (judge-now / show-later); and build the first-class 今日/往日 practice page + the paper answering page on top.

This plan implements CO §12 **Slice 2** (question/answer slots — the answer-table half), **Slice 1 tail** (ToolStateT v2 foundation, the half U4 left to U5), and **Slice 4** (dynamic paper UI + practice surface). Slice 1 head (D6 version stamping) and Slice 3 (Coach planning tools) already shipped in U4. Slice 5 (knowledge-state scheduler) lands with the P3 branch and is out of U5 scope.

### Orchestrator rulings already fixed (this plan does not reopen)
- **F1/Q1 — visibility落点**: paper path writes an **independent judge event** (`action='judge'`, `caused_by_event_id` → attempt event), payload carries `visible_to_user` + the D6 three stamps. The existing single-question `submit` embed path is **untouched** (zero regression). Visibility is **derived**: `可见 = payload.visible_to_user !== false || session.status === 'completed'`. No mutation, no reveal event.
- **Q2**: `visible_to_user` is an optional boolean (default = visible); `revealed_at` is **not** introduced (YAGNI — no delayed-reveal product need).
- **Q11**: U5 splits into a **backend lane** (L-paper-core) and a **UI lane** (L-practice-ui), chain-merged into `yuk-203-u5` as a single PR (U-sequence convention). A two-PR alternative is evaluated in §6 and recommended-against.

---

## 1. Scope

In scope for U5:

1. **Artifact enum widen** — `intent_source` + `tool_kind` Zod enums (`index.ts:130,135`) gain the three live values so `Artifact.parse()` stops throwing on every paper row (RL prerequisite for any paper consumer).
2. **ToolStateT v2** — additive `sections[]` variant on `ToolState` (`business.ts:292`) with a Zod parse barrier; flat `question_ids[]` retained; U4 `session_meta` plans forward-compatible (read-time promotion, no backfill migration — see R13 ruling).
3. **`learning_session.artifact_id`** — 1 new nullable column + write path (`startReviewSession` gains the param); `ReviewStatus` Zod enum gains `'paused'` (fixes the live drift R4).
4. **`answer` table revival** — add `session_id` / `paper_artifact_id` / `slot_ref` / `event_id` / `autosaved_at` columns; `submitted_at` → nullable; write path = autosave + freeze; the 5 allowlist entries cleared **same PR**.
5. **Paper submit path** — a new per-slot submit handler that writes an `attempt` event + an **independent `judge` event** with `visible_to_user`, feeding the same knowledge-level FSRS path; the existing `/api/review/submit` embed path stays as-is.
6. **Adaptation event** — `experimental:adaptation` event written when the paper artifact mutates mid-attempt (evidence-first, RL5).
7. **Practice surface UI** — first-class `/practice` 今日/往日 page (route page) + the paper answering page; both through design-doc pre-flight (§5).

### Non-goals (explicit — do not build)
- `knowledge_review_state` / `review_plan` / `review_paper_attempt` / `paper_question_assignment` / `paper_answer` / `paper_judgement` / `paper_evidence_result` tables (ADR-0029 决定 #2/#3 — all DEFER/never).
- `question_knowledge_coverage` m2m table (CO §12 Slice1 DEFER-until-needed; escape hatch only).
- `revealed_at` / delayed-reveal scheduler (Q2 ruling — YAGNI).
- Replacing the existing `/review` FSRS逐张流 (CO §13 non-goal — practice is a *new* surface alongside it; `review/page.tsx` is not retired, only its session-lifecycle helpers are reused).
- Knowledge-state scheduler re-key (CO §12 Slice 5 — P3 branch, out of U5).
- Coach planning tools / brief (shipped U4; U5 only *consumes* the paper they wrote).
- Subject-profile Studio UI (PS spec, separate units).
- Math/physics scratch-image *capture UI* — the data model (`answer.input_kind = scratch_image` / `image_refs`) must not block it (CO §5.7), but the MVP answering page ships text + choice input; image upload UI is DEFER with an explicit field-level comment.

---

## 2. Red lines (plan may not cross — Map §E verified against source at plan time)

- **RL1 — session `type` locked = `'review'`.** No `type='paper'`. `LearningSessionStatusByType` (`learning_session.ts:74`) discriminates on `type='review'`; introducing `'paper'` would break the union. The loom sources use `type='paper'` in two places (`screen-practice.jsx:132` eyebrow string, `data-practice.jsx:2-3` comments) — **pure drift; the UI implementation rewrites them to the real session type.** The existing `review/page.tsx` check `existing.type === 'review'` is already correct and is not touched.
- **RL2 — zero net-new tables.** Verified ADR-0029 决定 #3 wording lists *"闲置 `answer` 表复活"* as **既有原语复用** (`后果` 段: "answer 表复活需补 slot/paper/session 链接列与写路径——一次 migration"), while the 备选否决 段 separately lists `paper_answer` as a rejected new table. The two are semantically distinct; adding link columns to `answer` does **not** violate the zero-new-table line.
- **RL3 — `GetReviewDueInputSchema` not extended.** Verified `context-readers.ts:683-688` = `{limit?, knowledgeIds?, causes?, includeReason?}`, no constraints. U5 paper submit reads the due/question tables directly for the slots it already holds; it does not reach for the shared due tool nor extend its input.
- **RL4 — allowlist discipline.** The 5 `answer.*` entries (`audit-schema-allowlist.json:179,187,195,203,211`, all `resolves_when kind='manual'`) **must be removed in the same PR** that lands the answer write path (D4 iron rule). The new answer link columns **must have a write path** (autosave/freeze) — no allowlist entry without `resolves_when`. `learning_session.artifact_id`: write path = `startReviewSession` binding, lands same PR → **no allowlist entry**. **ToolStateT v2 sections jsonb**: `audit:schema` cannot see jsonb-internal keys → a **Zod parse barrier** is mandatory at every write point (ADR-0029 后果 段 + CO §5.1:526-528), not an allowlist entry.
- **RL5 — governance.** `ReviewPlanTask` reads no memory (U4-landed, not regressed). Mid-attempt self-adaptation that mutates the paper artifact **must** write an `experimental:adaptation` event (`caused_by_event_id` → the triggering judgement) or it violates ADR-0006 v2 evidence-first.

---

## 3. Lane partition + sequencing rationale

Two lanes, chain-merged into `yuk-203-u5` (single PR — U-sequence convention).

- **L-paper-core [backend]** — enum widen, ToolStateT v2 + Zod barrier, `learning_session.artifact_id` migration + write path, `ReviewStatus` paused fix, `answer` revival migration + write path, independent paper judge event + `visible_to_user`, paper submit handler, adaptation event, derived-visibility read query. Owns all DDL (one migration file) + schema + server + route changes. **Ships first** — it is the contract the UI lane consumes (the practice API shapes, the paper artifact read shape, the session-link).
- **L-practice-ui [frontend]** — `/practice` 今日/往日 route page + paper answering page + nav-config 4-place sync + `practice-loom` CSS scope + the practice data API client. Depends entirely on L-paper-core's read API + parseable paper artifact + session-link. **Ships second**, rebased on merged L-paper-core.

**Sequencing**: L-paper-core → L-practice-ui. Crucial non-overlap: L-practice-ui touches only `app/(app)/practice/**`, `src/ui/**`, `nav-config.ts`, `globals.css`, and *new* practice client/API-glue files; L-paper-core touches `src/core/schema/**`, `src/db/schema.ts`, `drizzle/**`, `src/server/**`, `app/api/**`. The only file both might want is a new `GET /api/practice` route — **assigned to L-paper-core** (it is a backend read endpoint; the UI lane consumes it), so there is zero file-overlap chain-merge conflict.

### Within L-paper-core: ordered sub-steps (apply in this order — each is a precondition for the next)
1. **Enum widen** (`index.ts:130,135`) — must precede any code that `Artifact.parse()`s a paper row, else R2 throws. Pure additive Zod.
2. **ReviewStatus paused fix** (`learning_session.ts:37`) — additive enum value; unblocks any Zod parse of a paused review session (R4). Independent of the migration; do early.
3. **ToolStateT v2** (`business.ts:292` + barrier) — the artifact read shape paper consumers depend on.
4. **DDL migration** (one `drizzle/NNNN_*.sql`): `learning_session.artifact_id` (nullable text) + `answer` link columns (`session_id` text null, `paper_artifact_id` text null, `slot_ref` text null, `event_id` text null, `autosaved_at` timestamptz null) + `answer.submitted_at` DROP NOT NULL + the partial unique index for autosave upsert (R10). Mirror Drizzle column defs in `src/db/schema.ts` same commit.
5. **Write paths**: `startReviewSession(artifactId?)`; answer autosave/freeze service; paper submit handler (attempt event + independent judge event + FSRS); adaptation event emit point.
6. **Read paths**: paper artifact read (now parseable), derived-visibility judge query, `GET /api/practice` aggregation.
7. **Allowlist cleanup**: remove the 5 `answer.*` entries (RL4) — this is the LAST step; `audit:schema` must be green only after the write paths exist.

---

## 4. L-paper-core — file manifest + acceptance

### 4.1 Artifact enum widen
- **MODIFY** `src/core/schema/index.ts:130` — `intent_source: z.enum([...existing 4, 'review_plan', 'quiz_gen', 'embedded_check'])`. Verified at plan time: current enum = `['learning_intent','declared','from_mistake','from_dream']` (`index.ts:130`); the three live DB values are `review_plan` (`review-plan-tools.ts:723`), `quiz_gen`, `embedded_check` (Map §A3). All three handlers write `intent_source` = the same string as `tool_kind`.
- **MODIFY** `src/core/schema/index.ts:135` — `tool_kind: z.enum(['quiz','review_plan','quiz_gen','embedded_check']).nullable()`. Verified current = `z.enum(['quiz']).nullable()`.
- **Acceptance**: a unit test that `Artifact.parse()`s a row shaped like the U4 `write_review_plan` output (`intent_source='review_plan'`, `tool_kind='review_plan'`) succeeds; previously it threw. Also assert a `tool_kind='quiz'` legacy row still parses (back-compat).
- **Ruling Q3-related**: enums widened **before** any consumer; this is the precondition for R2 mitigation.

### 4.2 ReviewStatus paused fix (R4)
- **MODIFY** `src/core/schema/learning_session.ts:37` — `ReviewStatus = z.enum(['started','paused','completed','abandoned'])`. Verified: `session/review.ts` already writes/reads `'paused'` (lines 110-111,154-155,164; pause route returns `status:'paused'` at `pause/route.ts:18`) but the Zod enum omits it, so `LearningSessionStatusByType.parse({type:'review',status:'paused'})` throws today. This is a **pre-existing latent drift** the paper flow surfaces (paper sessions go through Zod validation on read for the practice list).
- **Acceptance**: `LearningSessionStatusByType.safeParse({type:'review',status:'paused'})` succeeds; the existing `started/completed/abandoned` cases still pass. Add the regression note that this fixes YUK-57 drift, not just paper.

### 4.3 ToolStateT v2 (RL4 barrier) — **Q3 ruling**
- **MODIFY** `src/core/schema/business.ts:292` — extend `ToolState` to an **additive** shape. **Ruling: a single `ToolState` object with optional `sections?`**, NOT a `z.discriminatedUnion('version')`. Rationale: (a) the flat `question_ids[]` form must coexist on the *same* artifact for `embedded_check` + legacy quizzes (CO §5.1:522,525) — a discriminated union would force every existing flat quiz to declare a version discriminator it does not have, breaking back-compat over the artifact scan window; (b) `sections?` optional is purely additive and parses every existing row. Shape:
  ```
  ToolState = {
    question_ids: string[]                      // retained, flat form
    session_meta?: record<unknown> | null       // retained (U4 transition shape lives here)
    sections?: ToolStateSection[]               // NEW v2 — promoted first-class
  }
  ToolStateSection = {
    knowledge_focus: string[]
    feedback_policy: string                      // enum-narrow if a closed set emerges; string for now
    adaptation_policy: string
    assignments: ToolStateAssignment[]
  }
  ToolStateAssignment = {
    question_id: string
    part_ref?: string                            // StructuredQuestion.id (CO §2.2)
    primary_knowledge_id: string
    secondary_knowledge_ids: string[]            // default []
    selection_reason: string
    review_profile_snapshot: record<unknown>     // snapshot blob; narrow later
  }
  ```
- **Q3 ruling — file placement (F3)**: keep `ToolState` in **`business.ts`** (where v1 lives), NOT a new `artifact/tool_quiz.ts`. Rationale: `ToolState` is imported by `index.ts:133` (`b.ToolState`) and the per-artifact-type split does not exist for any other artifact type yet — introducing it for one type is premature abstraction (anti-overengineering). The section sub-schemas are co-located exports in `business.ts`.
- **Q3 ruling — barrier placement**: the Zod parse barrier lives **at every write point** (`write_review_plan` in `review-plan-tools.ts`, and the paper submit/adaptation paths) **and** is exercised by `Artifact.parse()` (which now references the widened `ToolState`). The write barrier is the load-bearing one (jsonb is opaque to `audit:schema`); `Artifact.parse()` is a defense-in-depth read check. U4's `write_review_plan` currently writes the structured plan into `session_meta` — U5 **also** promotes it into `sections[]` at the same write (see §4.8 forward-compat).
- **Acceptance**: a flat `{question_ids}` tool_state parses; a v2 `{question_ids, sections:[...]}` parses; a malformed section (missing `primary_knowledge_id`) is rejected by the barrier. `audit:schema` stays zero-delta (jsonb widening adds no column).

### 4.4 `learning_session.artifact_id` (R6) — **Q4 ruling**
- **MODIFY** `src/db/schema.ts:524` (learning_session) — add `artifact_id: text('artifact_id')` (nullable). **Q4 ruling: loose coupling, NO FK constraint.** Rationale: the existing precedent is loose (`event.task_run_id`, `learning_record.artifact_id` are plain text refs, no FK); CO §5.2 does not require FK; an FK complicates the orphan-cleanup cron (a deleted paper artifact would block session rows) and the artifact `archived_at` soft-delete pattern. The column is documented as a soft reference.
- **MODIFY** `src/server/session/review.ts:60` (`startReviewSession`) — add optional `artifactId?: string` to `StartReviewSessionParams`; thread into the INSERT (`session/review.ts:68`). Verified this is the single review-session creation entry. Conversation/tutor sessions do not set it (nullable default null).
- **MODIFY** test fixtures / DB helpers that INSERT `learning_session` rows — add the nullable column (defaults null, so most need no change; verify `tests/helpers` + any raw INSERT).
- **DDL**: `ALTER TABLE learning_session ADD COLUMN artifact_id text;` in the migration.
- **RL4**: write path (binding at session creation) lands same PR → **no allowlist entry needed**.
- **Acceptance**: `startReviewSession(db, {artifactId})` persists the link; a paper attempt session JOINs to its artifact; `pnpm audit:schema` green (write path present).

### 4.5 `answer` table revival (R5, RL2, RL4) — **Q5 ruling**
- **MODIFY** `src/db/schema.ts:378` (answer) — add columns:
  - `session_id: text('session_id')` (nullable) — links draft to its `learning_session`
  - `paper_artifact_id: text('paper_artifact_id')` (nullable) — links to the paper
  - `slot_ref: text('slot_ref')` (nullable) — **Q5 ruling: single text column, not jsonb.** The slot key is `question_id` + optional `part_ref`; encode as a single `slot_ref` text (`<question_id>` or `<question_id>#<part_ref>`). Rationale: a jsonb `slot_ref` buys nothing — the slot is a flat composite key, and a text column lets the autosave unique index (R10) be a plain partial index. `question_id` already exists on the table (`schema.ts:380`), so `slot_ref` carries only the optional `part_ref` discriminator; **ruling: store `part_ref` in a dedicated `part_ref text` nullable column** and make the autosave key `(session_id, question_id, part_ref)` — cleaner than concatenation and matches the per-slot grain.
  - `event_id: text('event_id')` (nullable) — back-reference to the attempt/review event written at freeze
  - `autosaved_at: timestamp('autosaved_at', {withTimezone:true})` (nullable) — mutable working-state stamp
  - **MODIFY** `answer.submitted_at` → **DROP NOT NULL** (nullable; null = draft, set at freeze)
  - `part_ref: text('part_ref')` (nullable) — per above
- **Q5 ruling — grain**: draft autosave is **per-slot** (`(session_id, question_id, part_ref)`), not per-question. A composite question with parts gets one answer row per part (the part is the judge boundary, CO §5.4). For atomic questions `part_ref` is null and the row is per-question.
- **DDL**: the column adds + `ALTER COLUMN submitted_at DROP NOT NULL` + a **partial unique index** `CREATE UNIQUE INDEX answer_draft_slot_uk ON answer (session_id, question_id, part_ref) WHERE submitted_at IS NULL` (R10 — guarantees one live draft per slot; submitted rows are append-only history and excluded so re-submission/rejudge does not collide). Note: Postgres treats NULLs as distinct in unique indexes; `part_ref IS NULL` rows need `COALESCE(part_ref,'')` in the index expression or `NULLS NOT DISTINCT` (PG15+). **Ruling: use `COALESCE(part_ref,'')`** in the index expression for portability — document this in the migration.
- **NEW** `src/server/review/answer-draft.ts` (or extend existing review server module) — autosave (upsert on the slot key) + freeze (set `submitted_at` + `event_id`, write the attempt event). `learning_item_id` (`schema.ts:380`) stays nullable/unused for paper (DEFER per Map §B3; explicit comment).
- **RL4 — allowlist**: the 5 existing `answer.*` entries removed **same PR** (`audit-schema-allowlist.json:179-218`). The 6 new columns all have a write path (autosave/freeze) → no new allowlist entries. **This is the last step in L-paper-core; `audit:schema` must be green only after autosave/freeze exists.**
- **Acceptance**: autosave upserts one draft row per slot (no duplicates on repeated saves); freeze sets `submitted_at` + `event_id`; `pnpm audit:schema` green with the 5 entries gone and no new debt; `pnpm test:migration` green.

### 4.6 Paper submit path — independent judge event + visibility (F1/Q1, R1, R8) — **Q6 ruling**
- **NEW** `app/api/practice/[id]/submit/route.ts` (or `app/api/review/sessions/[id]/answer/route.ts` — **route shape ruling in §4.10**) — the per-slot paper submit handler. Distinct from `/api/review/submit` (single-question FSRS流, untouched — RL/zero-regression).
- **MODIFY** `src/core/schema/event/known.ts:51` (`JudgeOnEvent`) — add `visible_to_user: z.boolean().optional()` to the payload. Verified current payload (`known.ts:58-74`): `cause` / `referenced_knowledge_ids` / `profile_version` / `capability_ref` / `judge_route`. **F1 friction (verified at plan time, load-bearing)**: `submit/route.ts:290-296` carries an explicit comment — *"Why not a separate action='judge' event chained via caused_by? JudgeOnEvent requires payload.cause (cause attribution is a downstream 'attribution' agent's job)..."*. So `JudgeOnEvent.payload.cause` is **required** (`known.ts:59`). For the paper path to write an independent judge event it must supply `cause`. **Ruling**: the paper judge event sets `cause` from the judge result's coarse_outcome→cause mapping already available (`ratingFromCoarseOutcome` path in `submit/route.ts:125-136`) OR, if cause attribution is genuinely deferred for paper, makes `cause` carry the existing "unattributed" sentinel the attribution agent later supersedes — **impl lane confirms whether `CauseSchema` (`known.ts:59`) admits an unattributed value; if not, the paper judge event populates `cause` from the synchronous judge result** (paper submit already runs the judge invoker, so a coarse cause is available). The independent judge event chains `caused_by_event_id` → the attempt event (verified `caused_by_event_id` exists at `known.ts:13` via `baseOptionalFields`).
- **Q6 ruling — multi-slot serial vs parallel**: paper submit is **per-slot** (one slot per request), so multi-slot concurrency is bounded by the client submitting one slot at a time on the answering page. **Ruling: per-slot submit, sequential at the UI layer** (the answering page submits the current slot before advancing — matching the loom `reveal → feedback → advance` flow in `screen-review.jsx:18-23`). This sidesteps R8 (no single request judges N slots; no batch advisory-lock contention). Same-knowledge FSRS advisory locks (`material_fsrs_state(subject_kind='knowledge')`, ADR-0028) serialize naturally per request. A future "submit whole paper at once" is DEFER.
- **FSRS writeback**: reuse the existing per-knowledge FSRS path (`submit/route.ts:125-160` pattern — `getFsrsState` → `scheduleReview` → `upsertFsrsState` under `pg_advisory_xact_lock`), keyed on the slot's `primary_knowledge_id` from the assignment (CO §5.6 / ADR-0028). The attempt event uses `AttemptOnQuestion` (`known.ts:27`, verified — `action='attempt'`, payload `answer_md`/`answer_image_refs`/`referenced_knowledge_ids`).
- **R1 mitigation (highest blast-radius)**: `visible_to_user` is `.optional()` so historical judge events still parse; the derived-visibility query (§4.9) treats `undefined` as visible (Q2 default). The paper submit handler sets `visible_to_user: false` for hidden (judge-now/show-later) slots per the section's `feedback_policy`; `true`/omitted otherwise.
- **Acceptance**: submitting a slot writes (a) an `AttemptOnQuestion` event, (b) an independent `JudgeOnEvent` with `visible_to_user` + D6 stamps + `caused_by_event_id` → the attempt, (c) an FSRS upsert on the slot's knowledge. The existing `/api/review/submit` path is byte-for-byte unchanged (diff shows no edit to `submit/route.ts` logic — only `known.ts` payload widening, which it already tolerates as optional).

### 4.7 Adaptation event (RL5, R7) — **Q10 ruling**
- **Q10 ruling — use `ExperimentalEvent`, not a new `KnownEvent`.** Verified at plan time: `known.ts` action literals = attempt/judge/review/propose/generate/rate/correct/suppress/extract/accept_suggestion/tool_use (`known.ts` grep) — **no `adaptation` action exists**. `experimental.ts` provides the escape hatch: `ExperimentalEvent` accepts any `experimental:<name>` action with a loose `record` payload (`experimental.ts:134-160`), and `RESERVED_EXPERIMENTAL_ACTIONS` (`experimental.ts:116`) gates only the three promoted ones. **Ruling: write `experimental:adaptation`** (loose payload: `{ artifact_id, from_version, to_version, change_summary }`, `caused_by_event_id` → the triggering judgement). Rationale: mid-attempt adaptation is exploratory (CO §5.7); promoting to a first-class `KnownEvent` schema + migration is premature until the adaptation shape stabilizes. This is the documented ADR-0006 v2 promotion path.
- **Write point**: wherever the paper artifact is mutated in place mid-attempt (optimistic-concurrency `version` bump). The adaptation event is written in the same transaction as the artifact update so the audit trail cannot drift from the mutation.
- **Acceptance**: a mid-attempt artifact mutation writes one `experimental:adaptation` event with `caused_by_event_id` set and the version delta; an artifact mutation without an adaptation event is treated as a bug (covered by the write-path test asserting both happen together).

### 4.8 U4 forward-compatibility (R13) — **ruling: read-time promotion, no backfill migration**
- U4 wrote the structured plan into `tool_state.session_meta.{sections,labels,rationale,guardrail_checks,needs}` (verified `review-plan-tools.ts:740-757`), with flat `question_ids` also present. **Ruling**: U5 does **not** run a data-backfill migration. Instead:
  - The widened `ToolState` (§4.3) makes `sections?` optional — U4 rows (which have `sections` only inside `session_meta`, not top-level) still parse (top-level `sections` is `undefined`).
  - **MODIFY** `src/server/ai/tools/review-plan-tools.ts:740` — going forward, `write_review_plan` **also** writes `sections[]` at the top level (promoted), keeping the `session_meta` copy during the transition window for any U4-era reader. The promotion is additive; no data loss (`u4-plan:122` guarantee held).
  - **Read shim**: a tiny helper `readPaperSections(toolState)` returns `toolState.sections ?? toolState.session_meta?.sections ?? []` so a paper consumer reads both U4-era (`session_meta`) and U5-era (top-level) plans uniformly. Documented as a transition shim with a removal trigger (when no U4-era `session_meta`-only paper remains, i.e., after the artifact scan window rolls past U4 merge date).
- **Acceptance**: a paper artifact written by U4 (`sections` in `session_meta`) and one written by U5 (`sections` top-level) both render in the practice list and both supply assignments to the answering page via `readPaperSections`.

### 4.9 Derived-visibility read query (F1 edge cases — **ruling on abandoned/reopened**)
- **NEW/MODIFY** a Coach-facing + practice-facing read that resolves judgement visibility: `可见 = payload.visible_to_user !== false || session.status === 'completed'`.
- **Edge case rulings (orchestrator asked for these)**:
  - **Completed session** → all judgements revealed (the `session.status === 'completed'` disjunct). No mutation, no reveal event — visibility is purely derived at read time.
  - **Abandoned session** → judgements stay at their stored `visible_to_user`. **Ruling**: abandonment does **not** reveal hidden judgements (the user walked away; revealing buffered feedback they never finished for would be misleading). So `abandoned` is NOT in the reveal disjunct — only `completed` is. Hidden slots in an abandoned paper remain hidden to the user but **still produce Coach evidence** (CO §5.5 — "hidden from the user but still produce evidence for Coach"); the Coach read ignores `visible_to_user` entirely (it sees all judgements).
  - **Reopened session** (`reopened→started` per YUK-63 state machine) → status returns to a live state (`started`/`paused`), so the `completed` disjunct no longer holds; judgements revert to their stored `visible_to_user`. **Ruling**: this is correct and intended — reopening a completed paper to redo slots re-buffers feedback. A re-submit writes a *new* judge event (rejudge = new event, never rewrites old — D6), so the old revealed judgement and the new buffered one coexist; the read takes the latest per slot.
  - **Coach read** never gates on `visible_to_user` — it always sees every judgement (the gate is user-facing only).
- **Acceptance**: a hidden judgement (`visible_to_user:false`) in a `started` session is filtered out of the user read but present in the Coach read; the same judgement becomes user-visible once the session is `completed`; in an `abandoned` session it stays hidden to the user but visible to Coach.

### 4.10 Practice read API + route shape — **Q7/Q8/Q9 rulings**
- **Q8 ruling — `GET /api/practice`** (new dedicated endpoint, owned by L-paper-core), NOT a raw `GET /api/artifacts?type=tool_quiz` + N session fetches. Rationale: the practice list needs paper artifact + its linked `learning_session` (via `artifact_id`) + derived progress/score in one aggregated shape; doing it client-side means N+1 round trips and leaks the JOIN to the browser. The endpoint returns the practice list shape the UI consumes (§5 maps the 7 mock-vs-real gaps).
- **Q9 ruling — `session.pos` / `gen` data sources**:
  - `pos` (answered-so-far) = **COUNT of submitted answer rows for the session** (`answer WHERE session_id=? AND submitted_at IS NOT NULL`), not an event COUNT — the answer table is the authoritative per-slot submit record and avoids double-counting rejudge events.
  - `right`/`wrong` = aggregate of the latest `JudgeOnEvent.coarse_outcome` per slot (correct/partial → right-ish, incorrect → wrong) OR the `ReviewOnQuestion.fsrs_rating` (good→right, again→wrong) — **ruling: use the judge event `coarse_outcome`** since paper submit writes judge events (§4.6); map `correct`→right, `incorrect`→wrong, `partial`→counted as right for the distribution bar (matches the loom `dist-seg good/again` two-segment split, `practice.css:55-56`).
  - `gen` (generating/ready) = **artifact `generation_status`** (verified column exists, `index.ts:136` `ArtifactGenerationStatus`), NOT a pg-boss job poll. `write_review_plan` already sets `generation_status:'ready'` (`review-plan-tools.ts:752`); a still-generating Coach paper would carry a non-ready status. This avoids coupling the practice list to pg-boss internals.
- **Q7 ruling — answering page route**: **new route `/practice/[id]`** (the paper answering page), NOT `/review?paper=<artifact_id>`. Rationale: the practice answering experience is whole-paper (sections, slots, per-paper progress) and semantically distinct from the FSRS逐张 `/review` flow (CO §5.8 / `data-practice.jsx:3` "distinct from review"); overloading `/review` with a query param would fork its component logic and conflict with the in-flight YUK-169 `/review` redraw (CO §12 Slice4 note). The answering page **reuses** `review/page.tsx`'s session-lifecycle *helpers* (POST sessions + sendBeacon pause/resume) but is its own route. The session it drives is still `type='review'` (RL1) linked via `artifact_id`.
- **Q12 ruling — migration conflict check**: at lane start, the impl lane re-confirms `main`'s `learning_session` column set (the current branch `codex-docs-merge-main` may have in-flight schema.ts edits). **Action**: `git -C /tmp/u5 log --oneline -5 -- src/db/schema.ts drizzle/` at lane start; if a conflicting `learning_session` or `answer` migration exists, rebase and renumber the U5 migration. Low risk (verified `learning_session` has 16 cols, `answer` has 9, both stable at `1c7bb30b`), but checked before generating the migration.
- **Q13 ruling — no new judge capability**: U5 reuses the six registered judge runners (exact/keyword/semantic/steps/unit_dimension/multimodal_direct — `judges/index.ts:10-33`). Paper submit routes through the existing `createDefaultJudgeInvoker()` path (`submit/route.ts:125`); no new `judgeCapability` registration, no `validateProfile`/`audit:profile` change. Delayed-batch judging (a hypothetical new route) is DEFER (Q2 killed delayed-reveal). **`audit:profile` stays zero-delta.**
- **Acceptance**: `GET /api/practice` returns today/past papers with derived pos/score/gen; a paper with a U4 `session_meta`-only plan and one with a U5 top-level plan both appear; the Coach read variant sees hidden judgements.

---

## 5. L-practice-ui — design-doc pre-flight + file manifest + acceptance

### 5.1 Design-doc pre-flight (mandatory before any component code — CLAUDE.md UI Design Compliance + CO §5.8)

**Verbatim design-source citations** (file + line):

- **Practice page is a hard product requirement** — CO spec `2026-06-03-coach-led-review-engine-design.md:608-614` §5.8:
  > "There must be a **first-class "今日 / 往日练习" page** where the user can find and resume papers. Coach-scheduled papers and user-on-demand quizzes are listed together (one `tool_quiz` container, distinguished by provenance). This is a hard product requirement; the UI build must go through the design-doc pre-flight before any component code."

- **Two-region layout (今日 + 往日)** — `docs/design/loom-prototype/screen-practice.jsx:143-172`:
  > line 144: `<SectionLabel count={P.today.length}>今日</SectionLabel>` … line 154: `<SectionLabel count={P.past.length}>往日</SectionLabel>` … line 155-166 the `status-tabs` source filter (全部 / Coach 排期 / 用户自建 / 笔记小测), line 150/171 `paper-grid stagger` of `PaperCard`.

- **PaperStatusPill four states** — `screen-practice.jsx:5-11`:
  > line 7: `if (p.gen === "generating") return …生成中`; line 8: `if (s === "in_progress") …进行中`; line 9: `if (s === "done") …已完成`; line 10: `未开始`.

- **PaperCard anatomy** — `screen-practice.jsx:13-99`: `paper-top` (icon/title/meta/count, lines 21-33), `paper-know` chips (35-37), conditional `paper-reason` coach note (40-42), `paper-genbar` (45-50), `paper-prog` in-progress position (53-58), `dist-row` done summary (61-75), `paper-foot` action row (78-96).

- **RL1 drift to rewrite** — `screen-practice.jsx:132`:
  > `<div className="eyebrow">…PRACTICE · session(type='paper') · 今日 …</div>` — the literal `session(type='paper')` is **drift**; the implementation renders the real session type (`type='review'`), per RL1. Likewise `data-practice.jsx:2-3` comments. The eyebrow string is rewritten (e.g. drop the `session(type=...)` debug token entirely, or render `成卷练习` — impl lane's call, but it must NOT ship `type='paper'`).

- **Empty / loading / error states** — `screen-practice.jsx:145-151` (`Stateful` with `skeleton`/`empty`/error) + `PracticeEmptyToday` (101-114).

- **CSS scope** — `docs/design/loom-prototype/practice.css:1-75`: the full `practice-loom` vocabulary (`.paper-grid`, `.paper-card`, `.paper-top`, `.paper-src` tone variants, `.paper-know`, `.paper-reason`, `.paper-genbar` + `@keyframes paper-gen`, `.paper-prog`, `.dist-row`/`.dist-bar`/`.dist-seg`/`.dist-score`, `.paper-foot`, `.paper-card.is-past`). Map §C5: tokens are double-tracked 1:1 with `globals.css` :root — no token adaptation; move `practice.css` into a `practice-loom` scope in `globals.css`. **Ruling (Map §C5)**: declare `.dist-bar`/`.status-tabs` independently inside `practice-loom` (do NOT extract to global — avoids regressing coach-loom/sessions-loom which have same-named-but-scoped rules).

- **Answering page** — reuses `docs/design/loom-prototype/screen-review.jsx` (#review hash route): the two-phase `answering → feedback` flow (`screen-review.jsx:18-23`), session banner with pause/resume (73-81), `cmp-split` answer-vs-reference (115-124), `judge-panel` (127-145), `fsrs-row` (148-152), `rating advisor` + `grade-row` (155-171), keyboard contract (38-54). **Note**: the answering page renders judgements through the **derived-visibility** rule (§4.9) — hidden judgements show a "feedback buffered" placeholder, not the judge panel, until the paper is completed.

**Component-type declarations**:
- `/practice` 今日/往日 list = **route page** (`app/(app)/practice/page.tsx`).
- `/practice/[id]` answering page = **route page** (`app/(app)/practice/[id]/page.tsx`).
- `PaperCard` / `PaperStatusPill` / `PracticeEmptyToday` = **components** under `src/ui/practice/` (or co-located — impl lane's call within the design-system primitive rules).

**Reused primitives (Map §C4, zero new primitives)**: `LoomCard` (PaperCard base = `.card.card-pad.card-hover`), `SectionLabel`, `Stateful`/`EmptyState`/`SkLines`, `Badge` (PaperStatusPill base), `Btn`, `LoomIcon` (all needed icons present: layers/target/pencil/doc/bolt/check/clock/refresh/sparkle/history), `.bar` progress bar, `.chip-k`, `.status-tabs`. Answering page reuses `ReviewSessionChrome`/`JudgeResultPanel`/`AttemptTimeline`/`RatingAdvisor` (Map §C4).

**Files — CREATE vs MODIFY**:
- **CREATE** `app/(app)/practice/page.tsx` — 今日/往日 list route page (fetches `GET /api/practice`).
- **CREATE** `app/(app)/practice/[id]/page.tsx` — paper answering route page (reuses review session-lifecycle helpers).
- **CREATE** `src/ui/practice/PaperCard.tsx` + `PaperStatusPill.tsx` + `PracticeEmptyToday.tsx` (or one file) — ported from `screen-practice.jsx`.
- **CREATE** the practice data client (fetch glue for `GET /api/practice` + the answer autosave/submit calls).
- **MODIFY** `src/ui/.../globals.css` — add the `practice-loom` scope (port `practice.css`, independently-scoped `.dist-bar`/`.status-tabs`).
- **MODIFY** `src/.../nav-config.ts` — **4-place sync (R12, verified at plan time)**: `NAV` array (insert `{ id:'practice', label:'练习', icon:'layers' }` in the 织造 section between 复习 and 录入 per app.jsx:6 ordering), `ROUTE_MAP` (`practice: '/practice'`), `PATH_ACTIVE` (`['/practice','practice']` — ordered before `/review`? no — `/practice` and `/review` share no prefix, any order works, but place near `/review`), `TITLES` (`practice: '练习'`). **MOBILE_NAV NOT touched** (prototype `app.jsx` mobile bar omits practice — Map §C6). **Confirm `'layers'` ∈ `LoomIconName`** (Map §C4 says present; impl re-confirms via `LoomIcon` enum).

### 5.2 UI acceptance
- `/practice` renders today (待做/进行中 top) + past (source-filtered tabs) from real `GET /api/practice` data; the four PaperStatusPill states resolve from real generation_status + session.status; pos/score derive correctly (§4.10 Q9).
- `/practice/[id]` drives a `type='review'` session linked via `artifact_id`; autosave persists drafts; submit writes attempt + judge events; hidden judgements show buffered-feedback placeholder until completion.
- Sidebar active highlight works on `/practice` and `/practice/[id]` (PATH_ACTIVE synced).
- **No `type='paper'` string ships anywhere** (RL1 — grep the diff).

---

## 6. Lane partition alternative: 1 PR vs 2 PR (orchestrator Q11)

**Default (this plan): single PR**, two lanes chain-merged into `yuk-203-u5`, matching the U-sequence convention.

**Two-PR alternative considered** (migration-risk isolation): split L-paper-core's DDL (`learning_session.artifact_id` + `answer` revival) into PR-A, land + verify on `main`, then UI in PR-B.
- **Pro**: the DDL migration (the highest-risk artifact — `submitted_at` DROP NOT NULL + partial unique index) lands and bakes alone before UI builds on it; a migration rollback would not entail reverting UI.
- **Con**: PR-A would land an `answer` write path + the 5 allowlist removals with no UI consumer, making the write path browser-untestable until PR-B (R11 — same problem U4 hit with write-only `review_plan`). It also doubles the gate/review/merge cycle for one U-step.
- **Recommendation (not default)**: keep single PR. The migration is additive (one nullable column + nullable answer columns + a DROP NOT NULL on a never-written column + one partial index) — low rollback risk; `pnpm test:migration` covers the DDL in the same gate. **Flag for critic**: if the impl lane finds the `answer.submitted_at` DROP NOT NULL interacts badly with any existing read of `answer` (there are none today — the table is inert), revisit the two-PR split. Marked as **a recommendation, not the default**, per orchestrator instruction.

---

## 7. Risk coverage (Map R1-R13 — each has an action or is accepted/deferred)

| # | Risk | Plan action |
|---|------|-------------|
| R1 | visible_to_user落点未裁 / judge event 不加 optional → 前端 parse strip 隐藏标记 → 全可见 | **Resolved**: independent judge event (§4.6); `visible_to_user` added as `.optional()` to `JudgeOnEvent.payload`; derived-visibility read (§4.9); historical events still parse. |
| R2 | `Artifact.parse()` throws on every tool_quiz row (enum缺 review_plan/quiz_gen/embedded_check) | **Resolved**: enum widen is sub-step 1, precedes all consumers (§4.1). |
| R3 | ToolStateT v2 jsonb 无 audit:schema 保护 → provenance/selection_reason 无声漂移 | **Resolved**: Zod parse barrier at every write point + `Artifact.parse()` defense-in-depth (§4.3, RL4). |
| R4 | ReviewStatus enum缺 'paused' → paper 流走 Zod 校验爆 | **Resolved**: add `'paused'` (§4.2) — fixes pre-existing YUK-57 drift. |
| R5 | answer 复活 migration + audit 双向 fail | **Resolved**: write path (autosave/freeze) + allowlist cleanup same PR, cleanup is last step (§4.5, RL4). |
| R6 | learning_session.artifact_id 多 INSERT 同步遗漏 → Drizzle 类型/test:db fail | **Resolved**: single creation entry `startReviewSession` (verified); nullable default null means conversation/tutor INSERTs need no change; fixtures audited (§4.4). |
| R7 | artifact attempt 中可变，自适应只 bump version 不写 event → 不可追溯 | **Resolved**: adaptation event in same tx as mutation (§4.7, RL5). |
| R8 | paper 多 slot submit judge 超时 block / advisory lock 死锁 | **Resolved by design**: per-slot submit, UI-sequential (§4.6 Q6); no batch judge; natural per-request lock serialization. Batch-submit DEFER. |
| R9 | loom data 用 type='paper'，照抄破坏 union | **Resolved**: RL1; UI rewrites the two drift sites; diff-grep gate (§5.2). |
| R10 | 草稿 autosave upsert 需 unique index | **Resolved**: partial unique index `(session_id, question_id, COALESCE(part_ref,''))  WHERE submitted_at IS NULL` (§4.5). |
| R11 | 无 UI 消费 → write-only 不可测 | **Resolved**: single-PR keeps UI consumer in the same merge; `GET /api/practice` + answering page exercise the write paths end-to-end. Two-PR alt explicitly rejected for this reason (§6). |
| R12 | nav-config 4 处同步漏 PATH_ACTIVE → active 失效 | **Resolved**: 4-place sync enumerated + verified (§5.1); `'layers'` icon confirmed. |
| R13 | U4 flat session_meta tool_quiz 前向迁移 | **Resolved**: read-time promotion + `readPaperSections` shim, NO backfill migration (§4.8). |

---

## 8. Gate checklist (pre-PR, per CLAUDE.md)

This PR has DDL → migration smoke required; it builds a UI page → visual ring required.

- `pnpm typecheck` — green.
- `pnpm lint` (biome) — green; touched-file format.
- `pnpm audit:schema` — **zero-delta**: the 5 `answer.*` allowlist entries removed AND no new debt (new columns have write paths; `learning_session.artifact_id` has write path; jsonb v2 has Zod barrier not allowlist).
- `pnpm audit:partition` — new `*.test.ts` in correct unit/db partition (schema/Zod tests → unit; route/migration/answer-draft tests → db).
- `pnpm audit:profile` — **zero-delta** (Q13: no new judge capability).
- `pnpm test` — full gate (profile audit + unit + DB + migration-smoke).
- `pnpm test:migration` — **required** (DDL: artifact_id column, answer columns, submitted_at DROP NOT NULL, partial unique index).
- `pnpm build` — Next route export validation for the two new route pages + `GET /api/practice` route.
- **Visual ring** — playwright screenshot of `/practice` (today + past + filter tabs + the four PaperStatusPill states) and `/practice/[id]` answering page, compared against `screen-practice.jsx` / `screen-review.jsx` loom sources via visual-verdict. Per the dev-server port note: confirm which process holds :3000 before screenshotting (OrbStack container may serve a stale build on :3000; `pnpm dev` falls to :3001).

---

## 9. Q3-Q13 rulings summary (one line each)

- **Q3** (ToolStateT v2 strategy): single `ToolState` object with optional `sections?` (NOT discriminatedUnion); stays in `business.ts`; Zod barrier at every write point + `Artifact.parse()` defense.
- **Q4** (FK vs loose): loose coupling, no FK on `artifact_id` / answer link columns (matches `event.task_run_id` precedent; FK complicates orphan cron + soft-delete).
- **Q5** (draft grain): per-slot `(session_id, question_id, part_ref)`; `part_ref` a dedicated nullable text column (not jsonb); one draft row per part.
- **Q6** (multi-slot submit): per-slot submit, UI-sequential; no batch judge; sidesteps lock contention; batch-submit DEFER.
- **Q7** (answering route): new `/practice/[id]` route (reuses review session-lifecycle helpers), NOT `/review?paper=`.
- **Q8** (practice data API): dedicated `GET /api/practice` aggregation endpoint, NOT client-side artifacts+sessions assembly.
- **Q9** (pos/gen sources): `pos` = COUNT submitted answer rows; `right/wrong` = latest judge `coarse_outcome` per slot; `gen` = artifact `generation_status` (not pg-boss poll).
- **Q10** (adaptation action): `experimental:adaptation` via the ExperimentalEvent escape hatch (no new KnownEvent schema/migration until shape stabilizes).
- **Q11** (slicing): single PR, two chain-merged lanes (backend → UI); two-PR migration-isolation alternative evaluated and recommended-against (§6).
- **Q12** (migration conflict): lane-start re-check of `main` `learning_session`/`answer` column set before generating the migration; renumber if conflict.
- **Q13** (new capability): none — reuse the six registered judge runners; `audit:profile` zero-delta.

---

## 10. Weakest two spots (for critic focus)

1. **The independent paper judge event vs `JudgeOnEvent.payload.cause` requirement (§4.6).** The orchestrator fixed F1 as "independent judge event", but the verified blocker is that `JudgeOnEvent.payload.cause` is **required** (`known.ts:59`) and the existing `submit/route.ts:290-296` comment explicitly chose embed *to avoid* writing a cause-less judge event ("cause attribution is a downstream agent's job"). My plan says the paper path populates `cause` from the synchronous judge result OR an "unattributed" sentinel — but **I did not verify `CauseSchema` admits an unattributed/null value**, nor whether double-writing cause (paper judge event now + attribution agent later) creates a conflicting-cause race. If `CauseSchema` is a closed enum with no neutral value and the synchronous judge result does not carry a cause, the independent-judge-event design needs either (a) a `CauseSchema` widening (new optional/`unattributed` member — a schema change I have not scoped) or (b) the attribution agent must run synchronously in paper submit (a heavier path). **Critic should verify `CauseSchema` shape and decide whether §4.6's cause-population is feasible without a schema change I have not planned.**

2. **`answer.submitted_at` DROP NOT NULL + the partial unique index interaction with rejudge/reopen (§4.5 + §4.9).** The autosave unique index is `WHERE submitted_at IS NULL` (one live draft per slot). But the reopen→resubmit→rejudge flow (§4.9 reopened ruling) means a slot can go: draft(null) → submit(frozen) → reopen → new draft(null) again. After freeze the old row has `submitted_at` set (excluded from the partial index), so a new draft on the same slot is allowed — **but is the old frozen `answer` row meant to stay as history, or be superseded?** My plan says "submitted rows are append-only history" yet the slot key would then have multiple frozen rows + one live draft, and `pos` = COUNT(submitted_at IS NOT NULL) (§4.10 Q9) would **double-count** a slot that was submitted, reopened, and re-submitted. The COUNT-based `pos` and the append-only-history claim are in tension. **Critic should pin: is `pos` a distinct-slot count (COUNT DISTINCT slot WHERE submitted) or a raw row count, and does rejudge create a new answer row or update the frozen one?** This affects both the migration (index shape) and the practice-list progress accuracy.
