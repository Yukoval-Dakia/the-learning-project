# YUK-262 — Copilot Quiz Skill (lane plan)

Branch: `yuk-262-copilot-quiz-skill`
Worktree: `/Users/yukoval/yukoval-projects/the-learning-project/.claude/worktrees/yuk262-quiz-skill`
Linear: YUK-262 (Copilot 求卷只会文本喷卷 → 第三个 Copilot skill)

## 0. The problem (owner finding) + the locked direction

Owner observed: when a user asks Copilot for a paper/quiz ("给我出套题"), the free-form
`CopilotTask` loop just **emits quiz text inline** instead of producing a runnable
`tool_quiz` paper the user can practice in `/practice/[id]`.

Locked fix = a **third Copilot skill** (`quiz`) that mirrors the existing
`teaching` / `solve` skill pattern, with the **U6 red line** held verbatim:

> R5: skill ≠ surface. The skill composes existing SERVICE-layer functions; it does
> NOT add tools to `COPILOT_TOOLS`, does NOT construct the budget tracker / mcp / tool
> allowlist, and the surface stays `'copilot'`.
> (`src/server/copilot/chat.ts:349-356` comment, load-bearing.)

The quiz skill: detect intent via `skill_context.skill==='quiz'` (NOT LLM
classification), call the S2 找题次序 (`runSourcingSequence`) at the service layer,
assemble a `tool_quiz` artifact from the returned pool hits, persist it, and reply with
**short text + a `/practice/[artifact_id]` markdown link**. When the pool can't satisfy
the request, **explicitly degrade with a stated reason — never silently fall back to
text-spraying a quiz**.

## 1. Map evidence the plan rests on (file:line)

- **Skill routing seam** `src/server/copilot/chat.ts`
  - `COPILOT_SKILL_KINDS = ['teaching','solve']` (`:79`), `CopilotSkillContext` Zod (`:82-88`),
    `CopilotChatRequest.skill_context` optional (`:99-101`).
  - Skill dispatch block `if (req.skill_context) { ... }` (`:356-497`) — runs BEFORE the
    free-form budget/mcp/tool construction (`:499-585`). Teaching branch wraps reply-event
    + question materialization in `db.transaction` (`:382-438`); solve branch writes a
    single reply event (`:445-483`). Both return early (`:485-496`).
  - `CopilotSkillTurn` carrier (`:110-120`), `CopilotChatResult.skill_turn?` (`:136`).
  - Route `app/api/copilot/chat/route.ts` only does `CopilotChatRequest.parse` + `runCopilotChat`
    → widening `COPILOT_SKILL_KINDS` flows through with **zero route change**.
- **Skill templates** `src/server/copilot/skills/{teaching,solve}-skill.ts`
  - `RunAgentTaskFn` DI seam (`teaching-skill.ts:38-42`), `allowedTools:[]` service call
    (`:115-120`), early-return result shape, `task_run_id` passthrough.
  - solve = simpler shape (no pendingQuestion, no skill_turn) — **the quiz skill is closest
    to solve's shape** (one-shot, no continuity ref to restore).
- **Skill tests** `src/server/copilot/skills/{teaching,solve}-skill.test.ts`
  - DB tests (import `tests/helpers/db`, `@/db/schema`), `resetDb()` in `beforeEach`, seed
    helpers, `runAgentTaskFn: vi.fn(...)` DI stub. **→ db partition.**
- **chat.test.ts skill-routing block** (`:629-...`)
  - `baseDeps` = `{ findOrCreateConversationFn, loadProposalFeedbackFn, now }`, db is a `{}`/
    `{transaction}` stub, `writeEventFn`/`runTeachingSkillFn`/`runSolveSkillFn`/
    `materializeAskCheckFn`/`buildMcpServerFn` injected. **→ unit partition** (no real DB).
- **S2 找题次序** `src/server/quiz/sourcing-sequence.ts`
  - `runSourcingSequence(params): Promise<SourcingSequenceResult>` (`:405`).
  - Params: `{ db, knowledgeId, trigger?, refId?, count?, kind?, domain?, ... }` (`:357-378`).
  - Result: `{ existing: ExistingPoolHit[], satisfiedFromPool, enqueued, needs, knowledgeNodeMissing? }` (`:380-394`).
  - `ExistingPoolHit = { question_id, source, tier }` (`:59-63`), tier-sorted high-first.
  - Step 1 SYNC pool query; steps 2-4 ASYNC enqueue (NOT awaited). **The quiz skill consumes
    `result.existing` synchronously; it does NOT wait for background production.**
- **tool_quiz artifact insert precedent (pool-sourced, non-ingestion)**
  `src/server/ai/tools/review-plan-tools.ts:815-838` — `tx.insert(artifact).values({ type:'tool_quiz',
  intent_source:'review_plan', source:'ai_generated', tool_kind:'review_plan', tool_state, generation_status:'ready',
  verification_status:'not_required', ... })`. **This is the canonical shape the quiz skill mirrors**,
  NOT `make-paper.ts` (which is ingestion-session-bound with an advisory lock on sessionId).
- **ToolState builder** `src/server/ingestion/make-paper.ts:47-93` `buildIngestionPaperToolState`
  + `src/core/schema/business.ts` `ToolState`/`ToolStateSection` Zod — `{ question_ids[], sections:[{
  knowledge_focus[], feedback_policy:'immediate', adaptation_policy:'none', assignments:[{ question_id,
  primary_knowledge_id, secondary_knowledge_ids, selection_reason, review_profile_snapshot }] }] }`.
- **Practice consumption whitelist (LOAD-BEARING for §3 decision)**
  - POST `/api/practice` gates `intent_source IN (review_plan, quiz_gen, embedded_check, ingestion_paper)`
    (`app/api/practice/route.ts:49-54`).
  - `getPracticeList` same whitelist (`src/server/review/practice-read.ts:157-163`).
  - `readPaperSections` (`src/server/review/paper-sections.ts`) reads U5 `sections[]` — provenance-agnostic.
- **Artifact enums** `src/core/schema/index.ts:137-153` — `intent_source` enum + `tool_kind` enum
  (both already include `quiz_gen` + `quiz`). artifact-u5 enum-widen test precedent at
  `src/core/schema/artifact-u5.test.ts`.
- **Turns replay** `src/server/copilot/turns.ts:93-139` (`replySkillTurn`/`replySkillContext`),
  `src/ui/copilot/CopilotDock.tsx` send (`:238-265`) + replay (`:174-203`) + render (`:479-523`).

## 2. Skill file design — `src/server/copilot/skills/quiz-skill.ts` (NEW)

### 2.1 Intent / trigger / parameter extraction
- Trigger: `skill_context.skill === 'quiz'` (explicit field, **no LLM classification** — mirrors
  `chat.ts:356`). Widen `COPILOT_SKILL_KINDS` to `['teaching','solve','quiz']` (`chat.ts:79`).
- Param extraction: `skill_context.ref` stays the minimal `{ kind, id }` envelope (forward-compat
  with AF S2b `active_ref`, per `chat.ts:70-78`). For quiz, `ref.kind==='knowledge'` and
  `ref.id` = the knowledge node id to source questions for. Map `ref.id → knowledgeId` at the
  dispatch point (mirrors teaching `ref.id→learningItemId` at `chat.ts:370-376`, solve
  `ref.id→questionId` at `:450-453`).
- Optional tunables ride on the skill params from chat.ts defaults (NOT new request fields this
  lane — keep `CopilotChatRequest` minimal): `count` (default `SOURCING_DEFAULT_COUNT`=3), `kind`
  (题型 hint, default null). `user_message` is forwarded for evidence/title only — it does NOT
  drive sourcing (sourcing keys off `knowledgeId`, the structured ref).

### 2.2 Service composition (the body)

```text
runQuizSkill({ db, sessionId, knowledgeId, userMessage, count?, kind?, domain? }, deps)
  1. seq = runSourcingSequenceFn({ db, knowledgeId, trigger:'manual', count, kind, domain })
        // DI seam: deps.runSourcingSequenceFn defaults to runSourcingSequence
  2. if seq.knowledgeNodeMissing → return DEGRADED result (reason:'knowledge_not_found'),
        NO artifact, text explains the node wasn't found. (no throw — graceful, §2.4)
  3. hits = seq.existing                      // tier-sorted, ≤ count
  4. if hits.length === 0 → return DEGRADED result (reason:'pool_empty', enqueued:seq.enqueued),
        text states "题库暂时没有现成题，已在后台生成 (external_sourcing/material_grounded/closed_book)，
        稍后再来" — explicit degradation, references seq.enqueued for evidence. NO text-sprayed quiz.
  5. build tool_state from hits via a SHARED builder (see §2.3):
        question_ids = hits.map(h=>h.question_id)
        load each question's knowledge_ids (one `inArray` select on `question`) to fill
        per-assignment primary/secondary knowledge (same field discipline as
        buildIngestionPaperToolState; review-plan validates this too).
  6. INSERT artifact (type:'tool_quiz') — see §3 for intent_source/tool_kind decision.
        generation_status:'ready', verification_status:'not_required', source:'ai_generated'.
  7. return { artifactId, questionCount, text_md (with /practice/<id> link), provenance }.
```
- **No tool loop, no LLM call on the happy path.** Unlike teaching/solve (which call
  `TeachingTurnTask`), the quiz skill is pure service orchestration — sourcing + assemble + persist.
  The reply text is **templated** (deterministic), not model-generated. This means **no
  `task_run_id` from an LLM run** on this path. Cost/evidence: §6.
- `allowedTools` / budget tracker: N/A — the skill never enters the SDK loop (R5/OQ5 satisfied
  trivially; even stronger than teaching/solve since there is no `TeachingTurnTask` call).

### 2.3 tool_state builder — reuse vs new
- `buildIngestionPaperToolState` (`make-paper.ts:47`) is **not exported as a generic** and is
  semantically ingestion-stamped (`session_meta.ingestion_session_id`). Do NOT call it directly.
- Decision: add a small builder **local to quiz-skill.ts** (`buildQuizSkillToolState(hits, knowledgeRows)`)
  that produces the SAME `ToolState`-parsed shape (`sections[]` + `question_ids`), with
  `selection_reason:'copilot_quiz_skill'` and `session_meta.tool_context_task_run_id: null`
  (not an LLM product). Passes the `ToolState.parse` Zod barrier (RL4 discipline). This is the
  "second concrete instance" that does NOT yet justify hoisting a shared builder — keep it local,
  leave a comment pointing at `buildIngestionPaperToolState` + `write_review_plan`'s `toToolStateSections`
  as the two sibling shapes (deferred consolidation note → §9 follow-up).

### 2.4 Degradation paths (explicit, never silent text-spray)

| condition | result.kind/reason | artifact | reply text |
|---|---|---|---|
| node missing/archived (`knowledgeNodeMissing`) | `degraded`, `knowledge_not_found` | none | "没找到这个知识点，换一个再试" |
| pool empty (`existing.length===0`) | `degraded`, `pool_empty` | none | "题库暂时没有现成题，已在后台按 外检索/素材生成/闭卷 三线生成，稍后再来" |
| pool short (`0 < existing.length < count`) | `ok`, partial | built (n<count) | link + "先给你 n 道，其余在后台补" |
| pool ok (`existing.length>=count`) | `ok` | built | link + short framing |

- The degraded branches return a structured result the chat.ts layer renders as plain reply text;
  **the free-form `CopilotTask` loop is never invoked** (early-return preserved). This is the whole
  point: the user gets an honest "couldn't" instead of a hallucinated paper.

### 2.5 Result shape (exported interface)
```ts
export interface QuizSkillResult {
  text_md: string;                 // reply body incl. /practice/<id> link OR degradation notice
  artifact_id?: string;            // present only when a paper was built
  question_count: number;          // 0 on degraded
  status: 'ok' | 'degraded';
  degrade_reason?: 'knowledge_not_found' | 'pool_empty';
  enqueued?: SourcingSequenceStep[]; // background lines triggered (evidence)
}
```
- No `task_run_id` field (no LLM run). chat.ts will mint a synthetic `task_run_id` for the
  reply event id/cost row continuity — see §4 + §6.

## 3. tool_quiz 落库路径定案 (LOAD-BEARING)

The artifact MUST be consumable by `/practice/[id]` and appear in the practice list. Both gate on
`intent_source IN (review_plan, quiz_gen, embedded_check, ingestion_paper)` (route.ts:49-54,
practice-read.ts:157-163).

**Decision: reuse `intent_source:'quiz_gen'` + `tool_kind:'quiz_gen'`.**
- Rationale: the quiz skill produces a pool-sourced, AI-assembled practice paper — semantically a
  "quiz generation" product, already a first-class paper provenance in BOTH whitelists and BOTH
  enums (`index.ts:143/152`). Reusing it means **zero whitelist edits, zero enum widen, zero new
  migration, zero practice-route change** — the paper is immediately runnable.
- Distinguish-ability: stamp `attrs.origin:'copilot_quiz_skill'` + `session_meta.copilot_session_id`
  so this paper is traceable/queryable as Copilot-origin without a new intent_source. (The
  `quiz_gen` background handler stamps its own provenance; the attrs marker disambiguates.)
- **Rejected alt** — a new `intent_source:'copilot_quiz'`: would force 4 edits in lock-step
  (index.ts enum ×2, route.ts whitelist, practice-read.ts whitelist) + an artifact-u5-style enum
  test, for no consumption benefit. Violates anti-overengineering; deferred unless owner wants
  Copilot papers visually segregated in the practice list (→ §9 follow-up note, not this lane).
- `audit:schema`: `intent_source` / `tool_kind` / `tool_state` already have write paths
  (review-plan + ingestion writers); adding a third writer to the SAME columns introduces no new
  unwritten field → **no allowlist entry needed**. Verify in gate.

Artifact insert (mirrors review-plan-tools.ts:815-838, adapted):
```ts
tx.insert(artifact).values({
  id, type:'tool_quiz', title: `练习卷 · ${knowledgeTitle}`,
  parent_artifact_id:null, knowledge_ids:[knowledgeId, ...derived],
  intent_source:'quiz_gen', source:'ai_generated', source_ref:null,
  body_blocks:null,
  attrs:{ origin:'copilot_quiz_skill', copilot_session_id:sessionId } as never,
  tool_kind:'quiz_gen', tool_state: builtToolState as never,
  generation_status:'ready', verification_status:'not_required',
  history:[], created_at:now, updated_at:now, version:0,
});
```

## 4. chat.ts 最小注册点 (minimize streaming-lane collision)

Streaming lane will touch `chat.ts` in the free-form path. **Keep quiz changes confined to the
skill-dispatch block + the kind enum** — do NOT touch the free-form path (`:499-632`).

Edits (all additive, localized):
1. `COPILOT_SKILL_KINDS` (`:79`): `['teaching','solve']` → `['teaching','solve','quiz']`.
   (`CopilotSkillContext` Zod auto-picks it up via `z.enum`.)
2. Import `runQuizSkill` + `QuizSkillResult` (`:42-43` neighbourhood).
3. DI seam: add `runQuizSkillFn?: typeof runQuizSkill` to `CopilotChatDeps` (`:177-197`),
   default-resolve it in the body (`:271` neighbourhood) next to the teaching/solve resolvers.
4. **Inside the existing `if (req.skill_context)` block** (`:356-497`): change the
   `if teaching {} else {}` into `if teaching {} else if solve {} else { /* quiz */ }`
   (currently the `else` is solve — split it). The quiz branch:
   - call `runQuizSkillFn({ db, sessionId, knowledgeId: req.skill_context.ref.id, userMessage: req.user_message })`.
   - `replyMd = result.text_md`.
   - `realTaskRunId`: quiz has no LLM run → reuse the pre-generated `copilot_task_${createId()}`
     `taskRunId` (already minted at `:277`) as the synthetic run id for the reply event + cost row.
     (Document inline: "quiz skill is pure service orchestration, no LLM run; the synthetic run id
     keeps the reply-event/cost-ledger continuity uniform with teaching/solve.")
   - write ONE reply event (no question materialization → no `db.transaction` needed; mirror the
     solve branch `:459-482` exactly): payload `{ surface:'copilot', session_id, reply_md,
     task_run_id, in_reply_to_event_id, skill_context }`. **No `turn_kind`, no `skill_turn`** (quiz
     is one-shot; the link is in the text, there is no structured-question card to replay).
   - return shape: `{ task_run_id: realTaskRunId, reply, surface, triggered_by, session_id,
     reply_event_id, ...(userAskEventId?...), }` — **no `skill_turn`** (so the existing
     `CopilotChatResult.skill_turn?` consumers + Dock render are byte-for-byte unaffected; the
     reply renders as plain markdown with a clickable `/practice/<id>` link).
5. **No new `CopilotSkillTurn` kind, no `CopilotChatResult` field, no turns.ts change, no Dock
   change.** The markdown link rides in `reply_md`, which the Dock already renders. ← key
   simplification: quiz needs ZERO UI/replay plumbing (unlike teaching's ask_check card).

Collision surface with streaming lane = the 1-line enum + the skill-block `else`-split + 1 DI
field. All in the skill region (`:79`, `:177-197`, `:356-497`), none in the free-form region.

## 5. 回复文案合同 (reply text contract)

- **Success**: `已为你组好一套练习（共 N 道）。点这里开始练习：[去练习](/practice/<artifact_id>)`
  - Markdown link to `/practice/<artifact_id>` (the Dock renders markdown; `/practice/[id]` is the
    existing practice route — verified at `app/api/practice` + `/practice/[id]` page). **No new UI
    component** (red-line item 3).
  - Keep it SHORT (1-2 lines). No quiz body in the text (the whole point — questions live in the
    artifact, rendered by `/practice/[id]`).
- **Degraded (pool_empty)**: `题库里暂时没有现成的题。我已经在后台按「外部检索 → 素材生成 → 闭卷兜底」
  三条线生成新题，稍后再来求卷就能命中。` — explicit, references the enqueued lines, NO quiz text.
- **Degraded (knowledge_not_found)**: `没找到这个知识点对应的内容，换一个知识点再试试。`
- Text is produced by a `formatQuizReply(result)` pure helper in quiz-skill.ts (unit-testable
  without DB).

## 6. provenance / tier / cost / evidence

- **Tier/provenance**: the quiz skill does NOT re-derive tier — it consumes `ExistingPoolHit.tier`
  already computed by `runSourcingSequence` via `deriveSourceTier` (合约 per S2). The selected
  question ids + their tiers are recorded in `tool_state.session_meta` (`selected_tiers`) for
  evidence留痕 (mirrors S2 contract: provenance is read, not invented).
- **Cost/evidence**: no LLM run, so no cost-ledger row from a model call. The reply event
  (`experimental:copilot_reply`) carries `task_run_id` = the synthetic `taskRunId`; this keeps the
  evidence chain (`copilot_user_ask → copilot_reply`) intact and traceable (same shape as
  teaching/solve). The `attrs.origin:'copilot_quiz_skill'` + `session_meta.copilot_session_id` on
  the artifact close the artifact→session evidence link. Background production (steps 2-4) logs its
  own runs through the existing boss handlers (unchanged).
- **skill_context turn 形态 / 触发日志**: the reply event persists `payload.skill_context`
  (`{skill:'quiz', ref}`) exactly like teaching/solve (`chat.ts:431/477`), so replay restores the
  Copilot turn context. The user-ask event is written by the shared chat.ts path (unchanged).

## 7. 测试清单

### 7.1 `src/server/copilot/skills/quiz-skill.test.ts` (NEW, **DB partition**)
Imports `tests/helpers/db` + `@/db/schema` → db config. `resetDb()` in `beforeEach`. Seed helpers
for knowledge node + N active questions + a Copilot session. DI: inject `runSourcingSequenceFn`
fixture (so we control `existing`/`knowledgeNodeMissing` without enqueuing real jobs).
- `pool ok`: seed ≥count active questions → stub seq returns them → asserts artifact row written
  (`type='tool_quiz'`, `intent_source='quiz_gen'`, `tool_kind='quiz_gen'`,
  `attrs.origin='copilot_quiz_skill'`, `generation_status='ready'`), `tool_state` parses & has
  `sections[].assignments` with primary_knowledge_id, result.text_md contains `/practice/<id>`,
  `status:'ok'`.
- `pool short`: seq returns < count → artifact built with n questions, text mentions partial.
- `pool empty`: seq returns `existing:[]`, `enqueued:[...]` → NO artifact row, `status:'degraded'`,
  `degrade_reason:'pool_empty'`, text references background lines (no quiz body).
- `knowledge missing`: seq returns `knowledgeNodeMissing:true` → NO artifact, `status:'degraded'`,
  `degrade_reason:'knowledge_not_found'`.
- `tool_state assignment validity`: every assignment has primary_knowledge_id from the question's
  knowledge_ids (the field invariant write-paths depend on).
- `runSourcingSequenceFn called with the right params` (trigger:'manual', knowledgeId, count).

### 7.2 `quiz-skill.test.ts` pure-helper cases (can live in the same file, no-DB sections via the
DB file is fine; OR a `formatQuizReply` micro-test in unit partition if isolated — prefer keeping
one file in db partition to match teaching/solve siblings).
- `formatQuizReply` link/degradation text shapes (deterministic).

### 7.3 `src/server/copilot/chat.test.ts` — extend the skill-routing describe block (**unit
partition**, no real DB — follow `baseDeps` + `{}`-stub pattern at `:633-...`):
- `quiz skill: builds paper, returns reply with link, NO skill_turn`: inject
  `runQuizSkillFn: vi.fn(async()=>({ text_md:'... /practice/art_x', artifact_id:'art_x',
  question_count:3, status:'ok' }))`, `runAgentTaskFn` that throws (free-form must not run),
  `writeEventFn`. Assert: `result.surface==='copilot'`, `result.reply` contains `/practice/art_x`,
  `result.skill_turn===undefined`, `runAgentTaskFn` not called, ONE reply event with
  `payload.skill_context={skill:'quiz',...}` and NO `turn_kind`/`skill_turn`,
  `result.task_run_id===taskRunId-synthetic` (assert it equals the reply event's task_run_id).
- `quiz skill degraded: returns degradation text, NO artifact link, NO free-form fallback`:
  `runQuizSkillFn` returns `status:'degraded'` → reply is the degradation notice, `runAgentTaskFn`
  not called.
- `no skill_context: unchanged free-form path` already covered (`:805`) — confirm quiz doesn't
  regress it.

### 7.4 partition audit
- **CRITICAL — partition mechanism (plan-critic fix):** `vitest.shared.ts` exports ONLY a
  `fastTestInclude` **unit** allowlist (the no-DB list). The **db partition is the COMPLEMENT** —
  `vitest.db.config.ts:20-21` is `include: allTestInclude, exclude: [...sharedExclude,
  ...fastTestInclude, ...migrationSmokeInclude]`, and `scripts/audit-test-partition.ts:134-138`
  classifies a file as `'db'` precisely when it matches `allTestInclude` but NOT `fastTestInclude`.
  `teaching-skill.test.ts` / `solve-skill.test.ts` are **NOT listed anywhere** in `vitest.shared.ts`
  — they fall through to db automatically. So:
  - **DO NOT add `quiz-skill.test.ts` to `fastTestInclude`** (or any vitest.shared list). It imports
    `tests/helpers/db` + `@/db/schema`, both matched by the auditor's `DB_PATH_PATTERNS`
    (`tests/helpers/db` → line 49, `@/db/schema` → line 47). Adding it to `fastTestInclude` would
    make `classify()` return `'unit'` while it has unmocked DB imports → **P0 audit:partition ERROR
    (`audit-test-partition.ts:150` + `process.exit(1)`)** AND a `pnpm test:unit` runtime crash.
  - The correct action is **ZERO `vitest.shared.ts` edits** — `quiz-skill.test.ts` lands in db by
    fall-through, exactly like its teaching/solve siblings.
  - To avoid a P1 WARN (db file with no file-level DB import, `audit-test-partition.ts:151`), the
    test MUST keep a DIRECT (value, non-type-only) import of `tests/helpers/db` and/or `@/db/schema`
    — which §7.1 already specifies.
- Run `pnpm audit:partition`: quiz-skill.test.ts must classify as `db` (it imports DB), chat.test.ts
  additions stay `unit` (chat.test.ts is already in `fastTestInclude:68`; add NO new DB import to it
  — keep the `{}`-stub db + DI fixtures, mirroring the existing solve test at chat.test.ts:762).

## 8. commit 切分 (2-3 atomic, 末位 Closes YUK-262)

1. **`feat(copilot): quiz-skill service — source pool → assemble tool_quiz → reply link (Refs YUK-262)`**
   - NEW `src/server/copilot/skills/quiz-skill.ts` (runQuizSkill + buildQuizSkillToolState +
     formatQuizReply) + NEW `quiz-skill.test.ts` (db partition, **NO vitest.shared edit** — falls
     through to db by complement, per §7.4 plan-critic fix; adding it to `fastTestInclude` is a P0).
   - Self-contained, no chat.ts wiring yet (skill importable + db-tested in isolation).
2. **`feat(copilot): register quiz skill on the chat skill-dispatch path (Refs YUK-262)`**
   - chat.ts: widen `COPILOT_SKILL_KINDS`, add `runQuizSkillFn` DI, split the skill-block `else`
     into solve/quiz branches, write the quiz reply event. chat.test.ts skill-routing additions.
3. **`docs(copilot): YUK-262 quiz-skill plan + deferred-consolidation note (Closes YUK-262)`**
   - This plan doc + any inline TODO/phase-deferred comments (ToolState builder consolidation,
     optional dedicated intent_source). **末位 commit carries `Closes YUK-262`.**
   - (If gate fixes are needed, fold them into commit 1/2 rather than a 4th commit.)

Each commit ends with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

## 9. gate 七步 + follow-ups

Pre-PR gate (CLAUDE.md): `pnpm typecheck`, `pnpm lint`, `pnpm audit:schema`, `pnpm audit:partition`,
`pnpm audit:profile`, `pnpm test`, `pnpm build` (build with a `DATABASE_URL` placeholder — bare
build fails at page-data without it; compile-time validation passes before that, per project memory).
Tests fully mocked/DI — **no real AI API calls** (runSourcingSequence is injected in the skill test;
chat.test.ts uses `{}`-stub db + fixtures).

Deferred (record as inline comments + Linear follow-up note, NOT this lane):
- ToolState builder consolidation (3rd sibling: ingestion / review-plan / quiz-skill) — wait for a
  4th instance before hoisting a shared `buildPaperToolState` (anti-overengineering / "second
  instance" rule).
- Optional dedicated `intent_source:'copilot_quiz'` if owner later wants Copilot papers segregated
  in the practice list (needs the 4-edit lock-step + enum test).
- Multi-knowledge / 组合卷 sourcing (current MVP = single knowledge node per ref) — defer until UI
  surfaces a multi-node quiz request.

## 10. streaming-lane交集最小化 (summary)

Quiz-lane chat.ts footprint = enum widen (`:79`) + 1 DI field (`:177-197`) + skill-block
`else`-split (`:356-497`). The free-form region (`:499-632`) the streaming lane will rework is
**untouched**. If streaming lands first, this lane rebases onto its chat.ts cleanly (different
regions). If this lands first, streaming sees an added quiz branch in the early skill block it
won't touch. No shared-line conflict expected. yuk-261 (practice UI) has no file overlap.
