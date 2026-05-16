# Phase 1c.1 Step 3 — TDD substeps + subagent prompt

> Step 3 ("数据迁移脚本") expansion. Parent plan: `2026-05-14-phase1c1-encounter-session-ui-scaffold.md`.
>
> **Prerequisites**: PR #35 (prep) + #36 (Lane A schema) + #37 (Lane B Zod) must be merged. PR #38 (Lane C1) is independent — can defer.
>
> **Scope**: Build a one-shot, idempotent migration script that maps 4 legacy tables to the new event-driven shape. Does NOT execute against production data (that's Step 8); only writes the script + fixture tests.

---

## Mapping reference (source → target)

> **Source column names verified against `src/db/schema.ts` as of 2026-05-16** (post Lane A — legacy tables not yet DROP'd). Confirm with `Read` of schema.ts ranges shown below before implementing.

### `mistake` (schema.ts:190-213) → `event` (action='attempt') + optional `event` (action='judge')

**Lane B contract** (src/core/schema/event/known.ts:24-61): `AttemptOnQuestion.payload = { answer_md, answer_image_refs, duration_ms?, referenced_knowledge_ids }`；`JudgeOnEvent.payload = { cause: CauseSchema, referenced_knowledge_ids }`，其中 `CauseSchema = { primary_category, secondary_categories[], analysis_md, confidence }`。

**Legacy bridge**：`mistake.cause` 是 `src/core/schema/business.ts::Cause` 形态 `{ primary_category, secondary_categories[], ai_analysis_md, user_notes?, partial?, confidence?, user_edited }`——与 Lane B 的 `CauseSchema` 有 3 处差异：(1) `ai_analysis_md` → `analysis_md`（重命名）；(2) `confidence` 在 legacy 是 nullable 而 Lane B 必填——缺失时默认 `0.5`（unknown）；(3) `user_notes / partial / user_edited` 是 legacy-only 字段，drop。

**Forensic note**：legacy 表（`mistake` / `review_event` / `dreaming_proposal`）在 Step 3 不 DROP（Step 9 才 drop），所以 `legacy_source / legacy_source_ref / legacy_mistake_id` 等 forensic 字段**不**写入 event payload——需要时 JOIN legacy 表即可。这保持 event 表只承载 KnownEvent 严格契约。

```ts
// 1. Write attempt event (always)
const attemptEvent = {
  id: deterministicId('evt_mistake', mistake.id),  // see §"Idempotency"
  session_id: null,                       // legacy mistakes had no session linkage
  actor_kind: 'user',
  actor_ref: 'self',
  action: 'attempt',
  subject_kind: 'question',
  subject_id: mistake.question_id,
  outcome: 'failure',
  payload: {
    answer_md: mistake.wrong_answer_md ?? null,
    answer_image_refs: mistake.wrong_answer_image_refs ?? [],
    referenced_knowledge_ids: mistake.knowledge_ids ?? [],   // feeds mastery view (ADR-0012)
  },
  caused_by_event_id: null,
  task_run_id: null,
  cost_micro_usd: null,
  created_at: mistake.created_at,
};

// 2. If mistake.cause is non-null jsonb: write judge event chained to attempt
if (mistake.cause !== null) {
  const legacyCause = mistake.cause;   // jsonb<CauseT> from business.ts
  const bridgedCause = {
    primary_category: legacyCause.primary_category,
    secondary_categories: legacyCause.secondary_categories ?? [],
    analysis_md: legacyCause.ai_analysis_md,           // rename ai_analysis_md → analysis_md
    confidence: legacyCause.confidence ?? 0.5,         // default if legacy null
  };
  const judgeEvent = {
    id: deterministicId('evt_judge', mistake.id),
    session_id: null,
    actor_kind: 'agent',
    actor_ref: 'legacy_attribution',      // marker — pre-v2 attribution
    action: 'judge',
    subject_kind: 'event',
    subject_id: attemptEvent.id,
    outcome: 'success',
    payload: {
      cause: bridgedCause,
      referenced_knowledge_ids: mistake.knowledge_ids ?? [],   // judge references same knowledge
    },
    caused_by_event_id: attemptEvent.id,
    task_run_id: null,                    // legacy data lost task_run linkage
    cost_micro_usd: null,
    created_at: mistake.updated_at,       // best proxy — original attribution timestamp lost
  };
}
```

### `review_event` (schema.ts:215-226) → `event` (action='review') + `material_fsrs_state` projection

**Key gotcha**: `review_event.mistake_id` (not question_id). Migration must JOIN mistake to get `question_id`.

**Lane B contract** (known.ts:68-95): `ReviewOnQuestion.payload = { fsrs_rating, fsrs_state_after, user_response_md, referenced_knowledge_ids }`，且有 invariant `fsrs_rating='again' ↔ outcome='failure'`（其余 → 'success'）。Lane B **deliberately dropped** `fsrs_state_before / due_at_before / due_at_next / latency_ms`——它们可从 prior event 的 `fsrs_state_after.due` 推导或属于 instrumentation 范畴，不进 KnownEvent contract。

```ts
// For each review_event, joined with mistake:
const reviewEvent = {
  id: deterministicId('evt_review', review_event.id),
  session_id: null,
  actor_kind: 'user',
  actor_ref: 'self',
  action: 'review',
  subject_kind: 'question',
  subject_id: mistake.question_id,        // from JOIN
  outcome: review_event.rating === 'again' ? 'failure' : 'success',
  payload: {
    fsrs_rating: review_event.rating,                  // 'again' | 'hard' | 'good'
    fsrs_state_after: review_event.fsrs_state_after,   // FsrsStateSchema
    user_response_md: review_event.response_md ?? null,
    referenced_knowledge_ids: mistake.knowledge_ids ?? [],  // from joined mistake
  },
  caused_by_event_id: null,
  created_at: review_event.created_at,
};
```

**Forensic note**：`fsrs_state_before / due_at_before / due_at_next / latency_ms` 不进 payload——`fsrs_state_before` 由 prior review event 的 `fsrs_state_after` 推导；`due_at_before/next` 由 `fsrs_state.due` 推导；`latency_ms` 不进 KnownEvent。需要 forensic 时 JOIN `review_event` 表（Step 3 不 DROP）。

After processing ALL review_events per (question, mistake), write the LATEST as `material_fsrs_state`:

```ts
// Group: by mistake.question_id, take MAX(created_at) review_event
// (rationale: review_event PK is per-mistake; one question may have multiple mistakes if user repeated; deduplicate at question grain)
const fsrsState = {
  id: deterministicId('fsrs', question_id),
  subject_kind: 'question',
  subject_id: question_id,
  state: latestReviewEvent.fsrs_state_after,
  due_at: latestReviewEvent.due_at_next,
  last_review_event_id: deterministicId('evt_review', latestReviewEvent.id),
  updated_at: latestReviewEvent.created_at,
};
```

**Fallback**: For mistakes with `mistake.fsrs_state IS NOT NULL` but ZERO review_events (early-stage FSRS state on mistake creation), use `mistake.fsrs_state` directly — write `material_fsrs_state` with `last_review_event_id: null`. Add to Step 3.C tests.

### `dreaming_proposal` (schema.ts:353-361) → `event` (action='propose')

**Lane B contract** (known.ts:103-117): `ProposeKnowledge.payload = { name, parent_id, reasoning }`——3 字段严格。Lane B 把 propose-knowledge 限定为 `subject_kind='knowledge'` 单一路径。propose 其他 subject_kind（knowledge_edge / chip 等）走各自的 KnownEvent 分支（`ProposeKnowledgeEdge` 等）。

**Legacy bridge**：`dreaming_proposal.payload` 是 jsonb，里面**应当**含 `proposed_knowledge.name` + `proposed_knowledge.parent_id`（per parent plan Step 3 §"读 dreaming_proposal"）；`name / parent_id` 必须从 jsonb 中提取。`outcome` 由 legacy `status` 派生：accepted→success / rejected→failure / pending→partial。

**Edge cases**：
- 若 legacy `payload` 缺 `name` 或 `parent_id` → 该行不 emit event，记 warning（数据假设违反）；这是合理保守策略——KnownEvent contract 严格，不容拼凑数据。
- 若 legacy `kind` 不是 knowledge-node 形态（例如 edge proposal）→ 在 Phase 1c.1 不处理，emit warning。Phase 1c.1 边图谱新建，无 legacy edge proposals。

```ts
// proposal.payload 形如：{ proposed_knowledge: { name, parent_id, ... }, ... }
// 不同 dreaming_proposal kind 可能有不同 jsonb shape——see "Pre-dispatch investigation #1"。
const name = proposal.payload?.proposed_knowledge?.name
          ?? proposal.payload?.name
          ?? null;
const parentId = proposal.payload?.proposed_knowledge?.parent_id
              ?? proposal.payload?.parent_id
              ?? null;
const subjectId = proposal.payload?.proposed_knowledge?.id
               ?? deterministicId('k_legacy', proposal.id);   // synthetic id if jsonb lacks

if (name === null || parentId === null) {
  logger.warn({ proposal_id: proposal.id, kind: proposal.kind }, 'skipping: missing name/parent_id in payload');
  return;   // skip — don't construct invalid event
}

const proposeEvent = {
  id: deterministicId('evt_propose', proposal.id),
  session_id: null,
  actor_kind: 'agent',
  actor_ref: 'dreaming',
  action: 'propose',
  subject_kind: 'knowledge',
  subject_id: subjectId,
  outcome:
    proposal.status === 'accepted' ? 'success' :
    proposal.status === 'rejected' ? 'failure' :    // Lane B propose outcome 不含 failure；见下
    'partial',                                       // pending → partial
  payload: {
    name,
    parent_id: parentId,
    reasoning: proposal.reasoning ?? '(legacy: reasoning missing)',
  },
  caused_by_event_id: null,
  created_at: proposal.proposed_at,
};
```

**⚠️ outcome 约束差异**：Lane B `ProposeKnowledge.outcome = z.enum(['success', 'partial'])`——**不**含 `failure`。legacy 中 `status='rejected'` 的 proposal 需要决策：
- (a) 映射到 `'partial'`（与 'pending' 合并语义）→ 信息丢失
- (b) 用 ExperimentalEvent 路径走 `experimental:propose_rejected` → 单点特殊处理
- (c) 在 payload 加 `legacy_rejected: true`（被 strip，但表 schema 留住——不行，event.payload 走 parseEvent，strip 真的发生）
- **决策**：rejected proposals 不再有意义（dreaming agent 早期实验产物，rejected 表示当时被拒），统一映射到 `outcome='partial'` + 在 reasoning 前缀加 `'[legacy rejected] '`。Forensic 数据保留在 legacy `dreaming_proposal` 表（Step 9 才 DROP）。

### `ingestion_session` (schema.ts:100-111) → `learning_session` (type='ingestion')

```ts
const session = {
  id: ingestion_session.id,                // preserve ID for FK reference continuity
  type: 'ingestion',
  status: ingestion_session.status,        // status enum is preserved verbatim
  source_document_id: ingestion_session.source_document_id,
  source_asset_ids: ingestion_session.source_asset_ids,  // already []-defaulted
  entrypoint: ingestion_session.entrypoint,
  warnings: ingestion_session.warnings,    // already []-defaulted
  error_message: ingestion_session.error_message,
  summary_md: null,                        // ingestion didn't have summaries
  goal_id: null,
  started_at: ingestion_session.created_at,
  ended_at: ingestion_session.status === 'imported' || ingestion_session.status === 'failed'
    ? ingestion_session.updated_at        // terminal status — updated_at is the end time
    : null,
  version: ingestion_session.version,
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

- **3.A.1** (red): insert fixture mistake with no cause; run migration helper `migrateMistakes(db)`; expect 1 event row with action='attempt' / subject_kind='question' / outcome='failure' / payload contains `answer_md` (Lane B field name, NOT `user_answer_md`); the constructed event must pass `parseEvent` from `src/core/schema/event`
- **3.A.2** (verify fail): test fails — `migrateMistakes` doesn't exist
- **3.A.3** (green): create `scripts/migrate-phase1c1.ts` with `migrateMistakes` writing attempt events; **每个 event 构造完毕后必须先 `parseEvent(eventObj)`，再 INSERT**——parse 失败即抛错（防止 schema drift 静默通过）
- **3.A.4** (verify pass): test passes; `pnpm typecheck` green
- **3.A.5** (commit): `feat(1c.1 Step 3): migrate mistake → attempt event (no-cause path)`

### 3.B — mistake with cause → attempt + judge chain

- **3.B.1** (red): fixture mistake with full legacy `cause = { primary_category:'concept', secondary_categories:[], ai_analysis_md:'...', user_notes:null, partial:false, confidence:0.85, user_edited:false }`; expect 2 events; judge.caused_by_event_id = attempt.id; judge.actor_ref='legacy_attribution'; **judge.payload.cause.analysis_md** = legacy `ai_analysis_md` value (rename verified); judge.payload.cause.confidence = 0.85; `user_notes / partial / user_edited` 不在 judge.payload.cause 里（被 strip）；judge.payload.referenced_knowledge_ids 来自 mistake.knowledge_ids
- **3.B.2** (verify fail)
- **3.B.3** (green): extend `migrateMistakes` to emit chained judge event with bridged cause (see mapping §"mistake → event")
- **3.B.4** (verify pass)
- **3.B.5** (commit): `feat(1c.1 Step 3): migrate mistake.cause → judge event chained on attempt`

### 3.C — review_event → review event + fsrs_state projection

- **3.C.1** (red): fixture 3 review_events on same question over 3 days, ratings [good, hard, again]; expect 3 events (action='review'); each event payload contains `fsrs_rating` (Lane B field name, NOT `rating`)、`fsrs_state_after`、`user_response_md`、`referenced_knowledge_ids`；outcome 由 invariant 推出（again→failure, hard/good→success）；expect 1 material_fsrs_state row for that question with state = latest review's fsrs_state_after, due_at = `latestState.due`, last_review_event_id = deterministic id of latest review event
- **3.C.2** (verify fail)
- **3.C.3** (green): add `migrateReviewEvents`. 算法：(a) per-review-event parseEvent + INSERT；(b) GROUP BY mistake.question_id → MAX(created_at) → write material_fsrs_state；(c) **fallback**：若 mistake.fsrs_state IS NOT NULL 但 ZERO review_events → 用 mistake.fsrs_state 写 material_fsrs_state（last_review_event_id=null）
- **3.C.4** (verify pass)
- **3.C.5** (commit): `feat(1c.1 Step 3): migrate review_event → review events + material_fsrs_state projection`

### 3.D — dreaming_proposal → propose event

- **3.D.1** (red): 3 fixtures：
  - `status='pending'` + payload `{ proposed_knowledge: { name:'x', parent_id:'k_xxx' }, ... }` → 1 event with outcome='partial', payload `{ name:'x', parent_id:'k_xxx', reasoning:... }`
  - `status='accepted'` + 同 payload → outcome='success'
  - `status='rejected'` + 同 payload → outcome='partial' + reasoning prefix `'[legacy rejected] '`
  - 第 4 fixture：缺 name 的 payload → 不 emit event，logger.warn 调用过（subagent 实测 logger 用 mock 或 spy 验证）
- **3.D.2** (verify fail)
- **3.D.3** (green): add `migrateDreamingProposals` with defensive payload extraction (per mapping §"dreaming_proposal → event")
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
2. `docs/superpowers/plans/2026-05-16-phase1c1-step3-migration.md` — **this doc is THE authoritative Step 3 spec**. Mapping sections at top + TDD substep breakdown both supersede any conflicting text in the parent plan
3. `docs/superpowers/plans/2026-05-14-phase1c1-encounter-session-ui-scaffold.md` — Step 3 body (high-level context only; **本文的 mapping section 在字段名 / 形态层面与 Lane B 对齐，是权威**——parent body 写在 Lane B 落地之前，字段名已过时)
4. `docs/adr/0006-encounter-replaces-mistake.md` (v2) — event payload Zod守护策略 (narrative; Lane B src/core/schema/event/ is the locked contract)
5. `docs/adr/0008-learning-session-multi-type-envelope.md` — per-type state machines
6. `src/db/schema.ts` — current schema (read mistake / review_event / dreaming_proposal / ingestion_session columns to know source shape; event / learning_session / material_fsrs_state for target)
7. `src/core/schema/event/known.ts` — **11 KnownEvent shapes — LOCKED CONTRACT**. Read carefully for `AttemptOnQuestion / JudgeOnEvent / ReviewOnQuestion / ProposeKnowledge` payload exact fields
8. `src/core/schema/event/blocks.ts` — `CauseSchema`, `FsrsStateSchema` (payload sub-blocks)
9. `src/core/schema/event/index.ts` — `parseEvent` entry (must call on every constructed event)
10. `src/core/schema/business.ts` — legacy `Cause` shape (for understanding bridge logic in mistake.cause → judge.payload.cause)
11. `src/core/ids.ts` — `newId` + `deterministicId(prefix, sourceId)` (helper already added in Step 3 prep commit; **use this, do not re-implement**)
12. Existing test patterns: `tests/global-setup.ts` + `tests/helpers/db.ts` + `tests/integration/migration-smoke.test.ts` — testcontainer + drizzle test convention

# Tasks (TDD discipline)

Follow the TDD substeps in `2026-05-16-phase1c1-step3-migration.md` exactly. **Each substep = its own commit** (3.A.5 / 3.B.5 / ... / 3.H.5). Do NOT batch commits; the discipline is "red → fail → green → pass → commit" per cycle. This produces 8 focused commits.

The end state:
- `scripts/migrate-phase1c1.ts` — orchestrator + 4 migrate fns + assertJudgmentEmpty
- `scripts/migrate-phase1c1.test.ts` — unit tests per migrate fn
- `tests/integration/migrate-phase1c1.integration.test.ts` — realistic 50-row fixture

# Locked contract

- **MANDATORY**: every constructed event MUST pass `parseEvent(eventObj)` from `src/core/schema/event` before INSERT. If parseEvent throws, fix the mapping until it passes — this is the schema drift guard. Each migrate fn returns parsed events; INSERT uses those parsed values.
- Field names follow Lane B exactly: `answer_md` (not `user_answer_md`), `fsrs_rating` (not `rating`), `user_response_md` (not `response_md`), `analysis_md` (not `ai_analysis_md` — rename when bridging legacy Cause).
- Lane B intentionally drops `fsrs_state_before / due_at_before / due_at_next / latency_ms` from review payload; do NOT add them back.
- Lane B intentionally drops `legacy_*` forensic fields from all payloads; legacy tables remain queryable for forensics (Step 9 drops them).
- Migration is **additive** — never UPDATE / DELETE legacy tables (Step 9 drops them later)
- Migration is **idempotent** — running 2x produces same end state (use deterministic IDs + INSERT ON CONFLICT DO NOTHING)
- Use Drizzle ORM for writes, NOT raw SQL (consistency with rest of codebase)
- Event IDs: use `deterministicId(prefix, sourceId)` from `src/core/ids.ts` (already added in Step 3 prep commit; do NOT re-implement). New rows requiring synthetic IDs (e.g., synthetic knowledge id for dreaming_proposal lacking payload subject_id) also use deterministicId for traceability.

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

## Idempotency: deterministic IDs (decided)

Use **deterministic event IDs** keyed off legacy source PKs: `deterministicId(prefix, sourceId)` produces e.g., `evt_mistake_<mistake.id>`, `evt_judge_<mistake.id>`, `evt_review_<review_event.id>`, `evt_propose_<dreaming_proposal.id>`.

Benefits:
- Re-running migration is a no-op (INSERT ON CONFLICT DO NOTHING is sufficient guard)
- Debugging: any event in target table traces back to legacy row by id pattern
- Safer than UUID + dedup probe (probe is racy if scaled)

Decision: **commit to deterministic IDs**. The subagent must implement `deterministicId(prefix, sourceId)` helper (likely `${prefix}_${sourceId}` since legacy IDs already CUID-shaped); add to `src/core/id.ts` if not already there.

## Pre-dispatch investigation tasks

> **Status (2026-05-16)**: 1-4 已完成（结果记录在下面）；只剩生产数据相关的 1/2 由 Step 8（actual prod migration）兜底，subagent 工作不依赖它们。

### 已完成的核验

1. **`src/core/ids.ts` 形态**：仅导出 `newId = createId` (`@paralleldrive/cuid2`)。已**在 Step 3 prep commit 中补加** `deterministicId(prefix, sourceId): string`——实现为 `${prefix}_${sourceId}`（legacy IDs 已是 CUID2 形态，拼接产生唯一且可逆向追溯的 ID）。

2. **Lane B 与 legacy `mistake.cause` 兼容性**：**不**直接兼容，必须 bridge。差异 3 处（`ai_analysis_md → analysis_md`、`confidence` legacy nullable vs Lane B required、3 个 legacy-only 字段被 drop）——已写入 mistake → judge 映射段。

3. **`mistake.cause` 10-enum 完备性**：legacy `CauseCategory`（business.ts:5）与 Lane B `CauseCategory`（event/blocks.ts:55）**枚举完全相同**——10 个值一对一匹配。无需 enum bridge。

4. **dreaming_proposal.payload jsonb 形态**：legacy schema 未约束内部结构。Defensive 提取（`payload?.proposed_knowledge?.name ?? payload?.name`）+ 缺字段时 skip + warning。生产数据中实际 shape 由 Step 8 验证；fixtures 按 parent plan §"读 dreaming_proposal" 描述的 `{ proposed_knowledge, parent_id, reasoning }` 形态构造。

### 留给 Step 8（actual prod migration）的检查

- 实际 `dreaming_proposal.kind` distinct 值分布
- `mistake.cause.primary_category` 值分布（确认未越界 10-enum）
- 缺字段 propose 行的数量（决定 warning 是否需要升级为 error）

---

## Risk register (Step 3-specific)

- **Legacy data shape drift** — if production has mistakes with null fields the schema didn't anticipate (e.g., `knowledge_ids = NULL` vs `[]`), handler must coalesce
- **`mistake.cause` enum** — if legacy data has cause values outside the ADR-0006 v2 10-enum, log warning + map to 'other'. Do NOT crash migration.
- **`dreaming_proposal.parent_knowledge_id` may reference now-deleted knowledge** — handler must defensive-check FK existence; if missing, skip with warning
- **Migration runtime** — fixture tests will be fast (<10s); production data could be 10k+ rows. Add progress logging every 1000 rows.

---

## Next-step planning (after Step 3 merges)

Step 4 (server read-path rewrite) is the next big phase. Its subagent prompt should be planned separately — see future doc `2026-05-XX-phase1c1-step4-server-rewrite.md`.
