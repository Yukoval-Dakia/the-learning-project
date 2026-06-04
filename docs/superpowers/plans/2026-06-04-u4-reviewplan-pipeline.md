# U4 — ReviewPlan Pipeline Implementation Plan

> Authority chain: `docs/design/2026-06-04-u0-decisions.md` D5/D6/D7/D11 + `docs/adr/0029-review-engine-lands-on-existing-primitives.md` + CO spec §6/§6.1/§7.1/§10 (`docs/superpowers/specs/2026-06-03-coach-led-review-engine-design.md`).
> Snapshot: `/tmp/u4` = main@6ef92efe (deps installed). All assertions carry file:line into the snapshot.
> Scope guard: **zero new tables, zero new columns**, `pnpm audit:schema` stays zero-delta, **ReviewPlanTask reads no memory** (Mem0 or brief).

> **Cross-统合 修订记录（2026-06-04）** — 全局视角统合 + 否决权 pass。Critic 意见**未送达**（编排模板变量未注入，/tmp 无 critic 产物）——故本 pass 未裁决具体 critic NEEDS_CHANGES 项，仅做跨 lane / 锁决一致性 + Map completeness 复核。三处就地修订：
> 1. **L-pipeline §④ `read_coach_brief`** —— 原文写 `getLatestCoachPlan` "returns parsed `TodayPlanT`" 不准确：该函数返回 `CoachPlanView`（`coach-plan.ts:20-29,54`，字段 `daily_plan`/`weekly_reflection`），`review_session_proposal` 住在 `view.daily_plan.review_session_proposal`，不是顶层。已改 §④ 该 bullet。
> 2. **L-pipeline 链触发位置歧义裁定** —— 原文给了 `runCoach` 内部 (~342) 与 factory `buildCoachDailyHandler` (402) 两个候选。**裁定：必须在 factory，禁止在 `runCoach` 内部**。`runCoach` 是 DI-pure 单测载体（`coach_daily.test.ts` 用 `db={}`、`coach_daily.northstar.test.ts` 真 DB 但不 stub boss）；把 `boss.send` 塞进 `runCoach` 会逼这两个测试新增 boss seam 或触真 boss，破坏 R9 已识别的注入面收敛目标。链送留在 factory 包裹层（`runCoach` 返回成功后），`runCoach` 保持 boss-free。已改 §④ 链触发 bullet + 风险表 R5。
> 3. 新增 §④ `read_coach_brief` 降级语义注记（无新鲜 brief → 纯 due-pressure，D5:29）——原文 plan 缺失，补一句使 on-demand/降级路径不漏实现。
> 其余 lane 形与 critic-less 复核下未发现需否决项；Map 缺口清单见文末「Cross-统合 Map 缺口」。

---

## 0. Lane partition + sequencing rationale

Three lanes. Verdict after recon:

- **L-stamp [D6]** — judge-event version stamping. Touches `src/core/schema/event/known.ts`, `src/server/judge/invoker.ts`, `src/server/knowledge/attribute.ts`, and 8 hardcoded `'1.0.0'` sites. **Fully independent** of coach/memory/pipeline code — zero shared files with the other two lanes. Ships first as the PS/CO shared foundation (D6: "排在一切 Studio UI 之前").
- **L-memtool [②]** — `search_memory_facts` DomainTool + allowlist grant to `coach`/`dreaming`/`copilot` + bootstrap registration. Touches `src/server/ai/tools/` (new file + `allowlists.ts` + `bootstrap.ts`) and a new tool test. **Independent of L-stamp** (different subtree). Shares `allowlists.ts` + `bootstrap.ts` with L-pipeline → those two files are the only chain-merge conflict surface, both append-only.
- **L-pipeline [③+④ combined]** — Coach brief expansion (③) + ReviewPlanTask (④) + pg-boss chain. **Merged into one lane** because the brief schema (`ReviewSessionProposal` extension in `coach.ts:20-24`) is the *exact contract* `read_coach_brief` consumes (CO §6.1:679-681) — splitting them creates a stub-then-rework cycle where the brief shape and the planner's first tool are co-designed. The map's "brief 与 ReviewPlanTask 强耦合" judgment holds.

Sequencing: **L-stamp → L-memtool → L-pipeline**. L-stamp first (foundation, no deps). L-memtool before L-pipeline so the append-only edits to `allowlists.ts`/`bootstrap.ts` land in a known order (L-pipeline adds the `review_plan` surface + 4 tools on top of L-memtool's `search_memory_facts` addition; chain-merge replays cleanly).

Crucial **non-dependency**: `search_memory_facts` (L-memtool) is **NOT** a ReviewPlanTask tool (CO §6.1:664-666 deletes it from the surface; D7: ReviewPlanTask 不读记忆). L-memtool exists purely to satisfy D7② (grant to coach/dreaming/copilot). L-pipeline must NOT reference it. They share files but not behavior.

---

## L-stamp [D6] — judge event version pinning

### Goal
Add 3 optional fields to `JudgeOnEvent.payload` (`profile_version` / `capability_ref` / `judge_route`); stop hardcoding `capability_ref.version='1.0.0'` by sourcing it from `SubjectProfile.version` (`profile-schema.ts:40`) at the invoker layer; thread `profile_version` through telemetry into the attribution write. `rejudge = new event, never rewrites old` (D6).

### Touch files
- **MODIFY** `src/core/schema/event/known.ts:56-59` — extend `JudgeOnEvent.payload` object with `profile_version: z.string().optional()`, `capability_ref: CapabilityRef.optional()` (import from `@/core/schema/capability` — `CapabilityRef` at `capability.ts:35-39`), `judge_route: JudgeKind.optional()` (the same `JudgeKindSchema` used in `invoker.ts:3`). All optional → additive, parses every historical event in the 25-event scan window (tests map bullet 8).
- **MODIFY** `src/server/judge/invoker.ts:53-61,94-105` — add `profile_version: z.string().min(1)` to `JudgeInvocationTelemetrySchema`; in `invoke()` **override the version in BOTH places**: ① `result.capability_ref = { ...result.capability_ref, version: input.subjectProfile.version }` **before** `JudgeInvokerOutputSchema.parse({route, result, telemetry})` returns（critic-R2 HIGH：review/submit 在 `submit/route.ts:133` 读的是 `invoked.result`、:306 嵌的是 `judgeResult.capability_ref` —— 只改 telemetry 则事件 payload 仍是 1.0.0）② telemetry 同步带 `capability_ref`（同值）+ `profile_version: input.subjectProfile.version`。措辞修正：版本来源有**两个**而非单 chokepoint —— invoker 覆盖 embedded judge 路径；attribution 路径（不走 invoker）由下一条的 `subjectProfile.version` 直接供给。
- **MODIFY** `src/server/knowledge/attribute.ts:106-128` — this is the *only* `action='judge'` write point (judge map bullet 2). Thread the invoker telemetry's `profile_version` / `capability_ref` / `judge_route` into `payload`. NOTE: attribution currently does NOT call the invoker (it runs `AttributionTask` directly, lines 96-103) — so the *source* of these three values for the attribution path is the resolved `subjectProfile` already in scope (`attribute.ts:97-102` passes `subjectProfile`). Set `profile_version = subjectProfile.version`; leave `capability_ref` / `judge_route` `undefined` for the pure-attribution path (attribution is not a routed judge) — they remain optional. **Decision point for impl lane**: confirm whether attribution should emit `judge_route` at all; if not, only `profile_version` is added here and the `capability_ref`/`judge_route` fields are populated only by `/api/review/submit` (which embeds `judgeResult.capability_ref` at `submit/route.ts:306` — judge map bullet 7 — **该路径拿到正确版本的前提是上一条 ① 的 result-side 覆盖已实现**，critic-R2 HIGH 确认仅 telemetry 覆盖时此处仍发 1.0.0).
- **MODIFY (version-source only, no signature change)** — do NOT touch the 8 module-level `'1.0.0'` constants (`steps-judge.ts:10`, `multimodal-direct-judge.ts:12`, `question-contract.ts:92,239`, `core/capability/judges/{exact,keyword,semantic,unit_dimension,steps,multimodal_direct}.ts`). The invoker override (judge map bullet 6) makes them irrelevant for emitted telemetry. Leaving them is intentional: they are the fallback `id` source; only `.version` is overridden downstream.

### New tests
- `tests/schema/event.test.ts` (unit partition, tests map bullet 8) — add `.safeParse` cases: JudgeOnEvent with the 3 new fields present parses; JudgeOnEvent *without* them still parses (back-compat).
- `src/server/judge/invoker.test.ts` (existing file) — assert telemetry `profile_version` equals the input `subjectProfile.version` **and** `capability_ref.version` equals it too. **Use a profile with `version: '2.0.0'`** (NOT `'1.0.0'`) so the test proves the read path actually switched (judge map bullet 9 — same-value test passes silently while still on the old path).
- `src/server/knowledge/attribute.test.ts` (if exists; else DB test) — assert written judge payload carries `profile_version` from the resolved profile.

### Red lines
- Zero new tables, zero new columns — `event.payload` is `jsonb`, widening it adds no schema column (tests map bullet 7). `pnpm audit:schema` zero-delta.
- Old judge results are never rewritten (D6) — this lane only changes *new* event writes + telemetry.
- Do not make any of the 3 payload fields required — historical events in the scan window must still parse.

---

## L-memtool [②] — `search_memory_facts` DomainTool

### Goal
First agent-layer tool wrapping `MemoryClient.search()` (`memory/client.ts:179-186`). Grant to `coach` / `dreaming` / `copilot` only (D7②). This is the fact layer (Mem0/pgvector); orthogonal to the existing `query_memory_brief` brief layer (`context-readers.ts:1277`, memory map bullet 11).

### Touch files
- **CREATE** `src/server/ai/tools/search-memory-facts.ts` — new `DomainTool` (template = `getReviewDueTool`, `context-readers.ts:1247-1260`). Spec:
  - `effect: 'read'`; `costClass: 'cheap_llm'` (triggers OpenAI embedding API — memory map bullet 4); `mirrorEvent: 'never'` (internal planner-style retrieval, not user-visible — memory map bullet 4).
  - `inputSchema`: `{ query: z.string().min(1), topK: z.number().int().positive().max(20).optional(), scopeKey: z.string().optional() }`. Doc the 5 fixed scope prefixes on `scopeKey` (`global` / `subject:*` / `topic:*` / `mistake_cluster:*` / `meta:orchestrator_self`, ADR-0017 — memory map bullet 7). **Document the `subject:*` trap** (memory map bullet 8): attempt/review-derived facts only carry `global`+`topic:*`, never `subject:X` — a `scope_key:'subject:wenyan'` filter silently drops most learning facts. Comment this on the field.
  - `outputSchema`: Mem0 `SearchResult` has no project Zod schema (memory map bullet 1) — define a minimal `z.object({ facts: z.array(z.object({ id: z.string().optional(), memory: z.string().optional(), score: z.number().optional() }).passthrough()), count: z.number() })` and map the raw result into it. Avoid `z.unknown()` so the output is summarizable + typed.
  - `execute`: module-level `createMemoryClient()` closure (memory client construction needs env, not in `ToolContext` — types.ts:38-44 carries no `memoryClient`; memory map bullet 3). Mirror the self-construction pattern. **Inject seam**: export an internal `buildSearchMemoryFactsTool({ memoryFactory? })` or accept a module-level override so tests inject a stub (client DI seam at `client.ts:143-161`, tests map bullet 10) — DO NOT hit real env in unit tests.
  - `summarize`: e.g. `` `memory facts · "${input.query.slice(0,24)}" · ${output.count} hits` ``.
- **MODIFY** `src/server/ai/tools/allowlists.ts`:
  - `READ_TOOLS` (line 10-24): append `'search_memory_facts'` (tests map bullet 2 — two `allowlists.test.ts` `toEqual` assertions pin the exact READ_TOOLS list; co-update them).
  - `COPILOT_TOOLS` (75-87), `DREAMING_TOOLS` (89-100), `COACH_TOOLS` (114-127): append `'search_memory_facts'` to each. Do NOT add to `KNOWLEDGE_REVIEW_TOOLS`, `MAINTENANCE_TOOLS`, `INGESTION_BLOCK_EDIT_TOOLS` (D7③ deny-from-wide; these are evaluator/operator surfaces).
- **MODIFY** `src/server/ai/tools/bootstrap.ts:49-80` — append `searchMemoryFactsTool` to `CORE_TOOLS`. Idempotent guard at line 84-91 protects HMR (memory map bullet 12 / runtime map bullet 3).

### New tests
- `src/server/ai/tools/search-memory-facts.test.ts` (unit partition — DI-pure with injected `memoryFactory`, tests map bullet 10) — assert `user_id` forced to `'self'` (via the client wrapper), `scopeKey` → `affected_scopes:{contains}` filter shape (`client.ts:180-185`), query string pass-through, output mapping. No live pgvector.
- `src/server/ai/tools/allowlists.test.ts` (existing) — update the two `READ_TOOLS` `toEqual` lists; add `.toContain('search_memory_facts')` for coach/dreaming/copilot and `.not.toContain` for knowledge_review/maintenance/ingestion_block_edit (tests map bullet 11 — additive surfaces use `.toContain`, safe).

### Red lines
- Granted to exactly `coach`/`dreaming`/`copilot` (D7②) — no other surface, especially **not** `review_plan` (L-pipeline).
- Zero new tables/columns (it only reads Mem0/pgvector which already exists). audit:schema zero-delta.
- `mirrorEvent: 'never'` — internal retrieval must not pollute the event stream.

---

## L-pipeline [③+④] — Coach brief expansion + ReviewPlanTask + chain

### ③ Coach brief expansion

#### Goal
Grow `TodayPlan.review_session_proposal` from `{count, estimated_minutes}` into a strategic brief (CO §6:621-622 — extend in place, **no new artifact type**). Feed active learning items (pinned / `in_progress`) `knowledge_ids` into the Coach input as attention pressure (D11① / CO §7.1:723-726).

#### Touch files
- **MODIFY** `src/core/schema/coach.ts:20-24` — `.extend()` `ReviewSessionProposal` (or add fields to the object) with **all new fields optional/defaulted** (coach map bullets 1+6, runtime map bullet 8): `knowledge_focus: z.array(z.string()).default([])`, `subject_mix: z.array(z.object({ subject_id: z.string(), weight: z.number() })).default([])` (or a simpler `z.record(z.number())`), `time_box_minutes: z.number().int().nonnegative().optional()`, `intent_tags: z.array(z.string()).default([])`. Keep `count` / `estimated_minutes` required as today. **Why optional/defaulted**: `getLatestCoachPlan` (`coach-plan.ts:31-35`) and `parseCoachOutputSafely` (`coach_daily.ts:380-396`) re-parse full `TodayPlanT` over the 25-event window; existing emitted plans lack the new fields (coach map bullet 6).
- **MODIFY** `src/server/coach.../` active-items reader — **CREATE** a `listActiveLearningItems(db)` query modeled on `listActiveGoals` (`goals/queries.ts:114-133` — coach map bullet 3 template). Filter `learning_item.status = 'in_progress'` OR `user_pinned = true`. **Confirmed (coach map bullet 10)**: `learning_item.status` is plain `text` default `'pending'` (`schema.ts:221`), `user_pinned boolean` default false (`schema.ts:222`) — neither is a pgEnum. `'in_progress'` is the live status string (verified `proposal-tools.ts:975,1288`: `status !== 'pending' && status !== 'in_progress'`). Return `{ id, knowledge_ids, status, user_pinned }`.
- **MODIFY** `src/server/boss/handlers/coach_daily.ts`:
  - `buildCoachInput` (148-217): add `active_items` field (parallel to `active_goals` at 165-170) carrying the pinned/in_progress items' `knowledge_ids`. Add a `ListActiveItemsFn` dep + default (mirror `ListActiveGoalsFn` at 119 + the `listGoals` default at 229) so northstar DB test (tests map bullet 12) still gets a default and doesn't break.
  - `output_schema.hint` (line 214): **must** be updated to describe the new brief fields (coach map bullet 9) — else the model emits the old `{count, estimated_minutes}` shape and the brief is empty. Add a clause: brief should set `knowledge_focus` (ranked from due/weak + active_items attention pressure), `subject_mix`, `time_box_minutes`, `intent_tags`.
  - Add a `COACH_BRIEF_GUIDANCE` const appended to the objective (mirror `COACH_GOAL_STRAND_GUIDANCE` at 55-56) stating brief is the only attention prior handed to ReviewPlanTask (CO §6.1:679-681) and that active_items are attention pressure only, never bookkeeping (D11).

#### New tests
- `src/core/schema/coach.test.ts` / wherever `TodayPlan` is tested — old flat `{count, estimated_minutes}` proposal still parses (defaults fill the rest); new full brief parses.
- `coach_daily.test.ts:18-22` (`VALID_TODAY_PLAN`) + `coach-plan.test.ts:10-19` (`plan()`) — these construct the flat shape (tests map bullet 3); they keep passing because new fields default. Add one case exercising a full brief through `buildCoachInput` with injected `listActiveItemsFn`.

### ④ ReviewPlanTask

#### Goal
Independently-registered tactical planner with a narrow surface (CO §6.1:668-675), two modes (`initial_plan` / `checkpoint_adapt`), `needs[]` output, **reads no memory**. `write_review_plan` produces a `tool_quiz` paper artifact (CO §7.1:713-717).

#### Touch files
- **MODIFY** `src/ai/registry.ts` (tail of the `tasks satisfies` record, near CoachTask at 445-464) — add `ReviewPlanTask` `TaskDef`: `needsToolCall: true`, `allowedTools: []` (handler supplies surface at runtime per runtime map bullet 1 — same as CoachTask 461 / Dreaming 441), `budget: { ...DEFAULT_BUDGET, maxIterations: 8, timeout: 120_000 }` (spec gives no value; planner choice — mirrors Coach's 12/120s but tighter iterations since the surface is 4 tools; runtime map bullet 1 suggests 6-8). `isMultimodal: false`, `defaultModel: 'mimo-v2.5-pro'`. systemPrompt: planner role, two modes, must emit plan with `subject_ids` invariant + guardrail_checks + `needs[]`.
- **MODIFY** `src/server/ai/tools/allowlists.ts` (on top of L-memtool):
  - Add `'review_plan'` to the `DomainToolSurface` union (line 53-63, runtime map bullet 3).
  - Define `REVIEW_PLAN_TOOLS = ['read_coach_brief', 'get_review_knowledge_snapshot', 'select_review_question_candidates', 'write_review_plan'] as const satisfies ...` and add to `DOMAIN_TOOL_ALLOWLISTS` (155-163). **Red line: NO `search_memory_facts`, NO `query_memory_brief`** in this surface (CO §6.1:664-666 / D7).
- **CREATE** the 4 ReviewPlanTask DomainTools (new file `src/server/ai/tools/review-plan-tools.ts`):
  - `read_coach_brief(scopeKey?)` — reads the latest `experimental:coach_scan` event's brief via `getLatestCoachPlan` (`coach-plan.ts:54`). **Cross-统合 correction**: `getLatestCoachPlan` returns a `CoachPlanView` (`coach-plan.ts:20-29`), NOT a bare `TodayPlanT` — the brief lives at `view.daily_plan?.review_session_proposal` (the `daily_plan` strand, which is itself the parsed `TodayPlanT`). Read that nested path; do not treat the function's return as the plan. Returns the `review_session_proposal` brief object (or `null` if no daily plan in the 25-event window). `effect:'read'`, `costClass:'local'`, `mirrorEvent:'never'`. This is the single attention-prior channel (CO §6.1:679-681). **Degrade semantics (D5:29)**: 降级触发是**两个不同条件**（critic-R2 #3：`TodayPlan.review_session_proposal` 是 required 字段（`coach.ts:60`），daily_plan 存在时 brief 永不为 `null`）—— ① `null`（25-event 窗口内无 coach run）② **empty-brief 显式谓词**：proposal 存在但新字段全空（`knowledge_focus.length===0 && subject_mix.length===0`）。两种都 fall back 到纯 due-pressure（drive `get_review_knowledge_snapshot` + `select_review_question_candidates` off the due queue alone, no attention prior）。State both predicates in the systemPrompt + tool 返回里区分 `reason: 'no_plan' | 'empty_brief'`。
  - `get_review_knowledge_snapshot(subject_id?)` — due/weak/uncertain/recent-failure/goal-relevant knowledge state (CO §6.1:683-684). Reuse `knowledge_mastery` view reads (ADR-0012 — never stored columns, CO §7.1:730) + due reads. `effect:'read'`, `costClass:'local'`.
  - `select_review_question_candidates(knowledge_ids, constraints)` — **call through the existing `get_review_due` DomainTool path / `due-list.ts`** rather than raw-querying `pickQuestionForKnowledge` (NOT exported, `due-list.ts:194`; runtime map bullet 6). This auto-inherits the Guard-B invariant `draft_status != 'draft'` (`due-list.ts:280`). Return the ranked candidate pool shape from CO §6:636-651 (`{question_id, part_ref?, review_profile, knowledge_coverage, estimated_minutes, memorization_risk, confidence, provenance, why_candidate, alternatives}` — populate what's cheaply available; `review_profile`/`coverage` from `question.metadata` since coverage table is DEFER, CO §7.1:716-717). `effect:'read'`, `costClass:'local'`.
  - `write_review_plan(plan)` — `effect:'write'`, `costClass:'local'`. **Output = `tool_quiz` artifact** (see §④-boundary below). Validates the `review_plan` contract (CO §7.1:737-768): `subject_ids = unique(sections[].subject_id)` invariant (CO §7.1:775), `guardrail_checks`, every assignment has `primary_knowledge_id`. Emits `needs[]` (CO §6.1:700-704) on the plan output (not a side effect).
- **CREATE** `src/server/boss/handlers/review_plan.ts` — handler running `ReviewPlanTask` via `runTask`/`runAgentTask` (`runner.ts:272,415`). Builds the MCP bridge with `resolveDomainToolNames('review_plan')` + `resolveMcpAllowedTools('review_plan')` (mirror `coach_daily.ts:275-304`). Input: mode (`initial_plan`), the brief (read by the task via `read_coach_brief`), now. Writes an `experimental:review_plan` scan event for traceability (mirror `coach_daily.ts:320-342`).
- **MODIFY** `src/server/ai/tools/bootstrap.ts` — append the 4 new tools to `CORE_TOOLS` (on top of L-memtool's edit).
- **MODIFY** `src/server/boss/handlers.ts`:
  - Register the `review_plan` queue (`createQueue` + `work`) **BEFORE** `coach_daily` (currently 112-126) so the worker is ready before the first chained send arrives (runtime map bullet 4). No `schedule` — it is chain-triggered, not cron (D5:29 — "不要另开独立 cron").
- **MODIFY** `src/server/boss/handlers/coach_daily.ts` (chain trigger) — **Cross-统合 裁定: the chain send MUST live in the factory `buildCoachDailyHandler` (402-406), NOT inside `runCoach`.** `runCoach` is the DI-pure unit-test target (`coach_daily.test.ts` runs it with `db={}`; `coach_daily.northstar.test.ts` runs it with a real DB but does NOT stub a boss seam). Injecting `boss.send` into `runCoach` would force both tests to grow a boss stub or hit a live boss, breaking the R9 injection-surface convergence goal. Keep `runCoach` boss-free; in the factory, after `runCoach(...)` resolves successfully, call `boss.send('review_plan', { run_kind, mode: 'initial_plan' })` via dynamic `getStartedBoss()` import. **Wrap in try/catch, log-and-swallow, do NOT rethrow** (runtime map bullet 4+5; precedent `attribution_followup.ts:156-162` — a failed enqueue must not undo the succeeded coach run nor trigger pg-boss redelivery + duplicate LLM run). Timing: coach_daily fires 03:45, prune at 04:00 — the chained run must finish in that window (coach map bullet 5); the chain `send` is fire-and-forget so it does not extend coach_daily's own job. Test impact: assert the send in `handlers.test.ts` / a factory-level test, NOT in the `runCoach` DI unit test.

#### ④ U4/U5 boundary — `write_review_plan` artifact shape (planner ruling)
- **ToolStateT v2** (the `sections[]` shape with per-assignment intent: `primary_knowledge_id` / `secondary_knowledge_ids` / `review_profile_snapshot` / `selection_reason`) is **U5's** owner (D3 §4-delta ①; task brief explicitly: "ToolStateT v2 形状属 U5"). The current `ToolState` Zod is flat: `{ question_ids: string[], session_meta?: record }` (`business.ts:292-295`, runtime map bullet 7).
- **U4 ruling**: `write_review_plan` writes a `tool_quiz` artifact using the **existing flat `ToolState`** (`question_ids` from the plan's assignment order + the full structured plan encoded in `session_meta`). Mirror the proven `quiz_gen.ts:399-431` artifact insert (`type='tool_quiz'`, `tool_kind='review_plan'`). **Confirmed**: `artifact.tool_kind` is `text('tool_kind')` nullable free text (`schema.ts:335`) — a new `'review_plan'` literal needs no schema change. The full `review_plan` contract (labels / rationale / sections / guardrail_checks / needs) goes into `session_meta` as a **transition shape** — readable now, promotable to ToolStateT v2 columns in U5 with no data loss.
- **Do NOT add new required Zod fields to `ToolState`** (runtime map bullet 7 — U5 coordination). The v2 variant is U5's.
- **Acceptable alternative the impl lane may choose** (task brief grants planner discretion): leave the artifact *persistence* a documented stub (write only the `experimental:review_plan` scan event with the plan JSON in payload, defer the `tool_quiz` artifact row to U5). Pick the artifact-write path if `artifact.tool_kind`/`ToolState` accept the flat encoding without schema change (they do — both are existing columns); pick the stub only if the flat encoding proves lossy. **Default recommendation: write the flat `tool_quiz` artifact** — it is zero-schema-change and exercises the full chain end to end.

#### New tests
- `src/server/boss/handlers.test.ts:6-18` (tests map bullet 5) — add `expect(boss.createQueue).toHaveBeenCalledWith('review_plan')` + `work` assertion; assert `review_plan` queue created before `coach_daily` (ordering). PgBoss is fully mocked here.
- `src/server/boss/handlers/review_plan.test.ts` (DB partition or DI-pure like `coach_daily.test.ts` — tests map bullet 4: coach_daily lands in db config despite being DI-pure; follow that convention or justify a `fastTestInclude` entry). Assert: surface resolves to exactly the 4 tools; `subject_ids` invariant enforced; `needs[]` round-trips; **assert the task is NOT granted any memory tool** (regression guard for D7).
- `src/server/ai/tools/review-plan-tools.test.ts` — `write_review_plan` validates the contract; `select_review_question_candidates` test co-locates a `seedReviewFixture` helper modeled on `quiz_verify.test.ts:50-113` (`seedKnowledge` + `seedDraftQuestion` + `material_fsrs_state`, tests map bullet 9) and asserts draft questions (`draft_status='draft'`) are excluded.
- `src/server/coach.../active-items.test.ts` — `listActiveLearningItems` returns only pinned/in_progress.

#### Red lines
- **Zero new tables, zero new columns.** `learning_session.artifact_id` (D3) and ToolStateT v2 are **U5/other-unit scope — out of bounds here**. audit:schema zero-delta (tests map bullet 7 — jsonb widening + artifact reuse add no columns).
- **ReviewPlanTask reads NO memory** — surface has no `search_memory_facts` / `query_memory_brief` (CO §6.1:664-666, D7). Enforce with an explicit allowlist test.
- **ReviewPlanTask does no forbidden writes** (CO §6.1:689-694): no FSRS/`due_at`, no `question.metadata.review_profile`/coverage, no question CRUD, no judge events. Its only write is `write_review_plan` → artifact.
- Chain `send` is best-effort, no rethrow (no duplicate-LLM redelivery).
- Brief fields stay optional/defaulted (back-compat over the 25-event scan window).

---

## 1. Chain-merge order, integration gate, risks

### Chain-merge order
`L-stamp → L-memtool → L-pipeline`. Each lane rebases on the prior merged result.
- L-stamp ↔ others: **no file overlap** → trivial.
- L-memtool ↔ L-pipeline: overlap only in `allowlists.ts` + `bootstrap.ts`, both **append-only** (L-memtool adds `search_memory_facts` to READ_TOOLS + 3 surfaces + CORE_TOOLS; L-pipeline adds the `review_plan` surface + 4 tools + CORE_TOOLS entries). Replaying L-pipeline after L-memtool is conflict-free if both append at the documented anchors.

### Integration gate (per CLAUDE.md pre-PR)
`pnpm typecheck && pnpm lint && pnpm audit:schema && pnpm audit:partition && pnpm audit:profile && pnpm test && pnpm build`. Specifically verify:
- `audit:schema` zero-delta (no new columns introduced by any lane).
- `audit:partition` — new `*.test.ts` land in the correct unit/db partition (search-memory-facts → unit with stub; review_plan handler → db, mirroring coach_daily).
- `pnpm build` — catches Next route export validation (the new handler is server-only, not a route, so low risk, but the gate stays).

### Risk table

| # | Risk | Likelihood | Mitigation | Anchor |
|---|------|-----------|------------|--------|
| R1 | New required field on JudgeOnEvent/ToolState/ReviewSessionProposal breaks 25-event re-parse or U5 | Med | All new fields `.optional()`/`.default()`; ToolState untouched (flat) | coach_daily.ts:380-396; business.ts:292; runtime map 7,8 |
| R2 | D6 version test passes silently while still reading hardcoded `'1.0.0'` | High | Test profile uses `version:'2.0.0'`, assert telemetry == that **且 submit route 的 review event `payload.judge.capability_ref.version` == that**（result-side 覆盖的端到端证明，critic-R2 HIGH） | judge map 9 |
| R3 | `listActiveLearningItems` WHERE matches zero rows (wrong status string) | Med | grep `'in_progress'`/`user_pinned` usage in src/server before writing filter | coach map 10; schema.ts:221-222 |
| R4 | ReviewPlanTask accidentally granted a memory tool | Low | Explicit `.not.toContain` allowlist test + surface = exactly 4 tools | CO §6.1:664-666; D7 |
| R5 | Chain send rethrows → pg-boss redelivery → duplicate LLM run | Med | try/catch log-and-swallow, no rethrow (attribution precedent); send lives in **factory not `runCoach`** so DI unit/northstar tests need no boss stub | attribution_followup.ts:156-162; runtime 5; 统合裁定 |
| R6 | `select_review_question_candidates` raw-queries due-list, drops Guard-B draft filter | Med | Route through `get_review_due` / `due-list` public path；**已确认**（critic-R2 #4）`GetReviewDueInputSchema` 仅 `{limit, knowledgeIds, causes, includeReason}`（context-readers.ts:683-687）无 constraints —— 候选塑形/排序层必须建在其上，不扩共享工具入参 | due-list.ts:194,280; runtime 6 |
| R7 | `write_review_plan` artifact encoding is lossy vs ToolStateT v2 | Low | Flat `session_meta` transition shape; full plan JSON preserved; stub fallback documented | D3 §4-①; runtime 7 |
| R8 | `allowlists.test.ts` `toEqual` lists not co-updated when adding tools | High | Co-update both READ_TOOLS `toEqual` assertions in same commit | tests map 2,11 |
| R9 | northstar DB test breaks when new `listActiveItemsFn` injection slot added | Med | Handler supplies default; verify northstar still green | coach_daily.northstar.test.ts:194-213; tests 12 |
| R10 | `search_memory_facts` unit test hits real Mem0 env (no XIAOMI/OPENAI key) | Med | Inject stub `memoryFactory`; never construct real client in unit tests | client.ts:143-161; runtime 10 |

### Out-of-U4 (explicit, do not build)
- `learning_session.artifact_id` column, `answer` table revival, `ToolStateT v2` variant, paper attempt/draft autosave, practice-surface UI (D3 §4-②③④ — U5+ / other units).
- `knowledge_review_state` table (D1 — uses `material_fsrs_state(subject_kind='knowledge')`, not built here).
- `subject_profile_*` tables, Studio UI, ProfileCriticTask (D9 — PS, separate units).

---

## Cross-统合 Map 缺口（5 区之外 U4 还依赖、未勘察的角落）

5 张 map（judge/memory/coach/runtime/tests）覆盖了主路径，但以下 U4 实依赖的角落**无 map 覆盖**，impl lane 须当场勘察，不得凭 map 推断：

1. **`task-prompts.ts` `getTaskSystemPrompt` pass-through 分组（统合已勘察，确证）** —— `CoachTask`/`DreamingTask` 命中 `task-prompts.ts:765-774` 的 pass-through `case` 组（`return tasks[task].systemPrompt`，即直接用 registry 内联 systemPrompt）。`ReviewPlanTask` 用同样的 registry-inline systemPrompt 形态（§④），故**必须把 `'ReviewPlanTask'` 加进 `task-prompts.ts:765-774` 的 pass-through `case` 列表**，否则 `getTaskSystemPrompt('ReviewPlanTask')` 落到 default 分支取不到 prompt。这是 registry 注册之外的第二处必改点，原 plan §④ 漏列。**impl lane 在 §④ registry 改动同 commit 内加此 case。**
2. **`mcp-bridge.ts` 的 `createSdkMcpServer` 工具数上限 / 命名碰撞** —— runtime map 只说 `buildMcpServerFromRegistry` 在 L138+ 按名解析。`review_plan` surface 新增 4 工具 + L-memtool 的 `search_memory_facts`，但 bridge 是否对 surface 工具数、或对 `read_*`/`write_*` 命名前缀有隐式约束未勘察。低风险但未证。
3. **`runner.ts` budget / `buildQueryOptions`（runtime map bullet 提到 L243 centralises maxTurns）对 `maxIterations:8` 的实际生效路径** —— plan 给了 `maxIterations:8` 但未证 `buildQueryOptions` 是否真把 registry budget 透传成 SDK `maxTurns`，还是另有 override。impl 落 budget 前核 L243 透传链。
4. **`get_review_knowledge_snapshot` 的 `knowledge_mastery` view 读路径（统合已定位入口）** —— 存在专门的 `src/server/ai/tools/knowledge-readers.ts`（与 `context-readers.ts` 平行的 knowledge 读侧工具集），另有 `src/server/knowledge/node-page.ts`/`tree.ts` 读 mastery view。**§④ `get_review_knowledge_snapshot` 应复用 `knowledge-readers.ts` 的现有 mastery 读封装，不要现写 view SQL**（避免漏 ADR-0012 派生语义 + 重复查询）。5 张 map 均未勘察这层 —— impl lane 必须先读 `knowledge-readers.ts` 确认可复用的 helper 形状，再决定 snapshot 工具的组装方式。这是 §④ 最大的未被 map 覆盖的实现面。
5. **`getProposalFeedbackDigest` / `readAgentNotes` 是否会被 ReviewPlanTask 的 `needs[]` 通道波及（D10 B8 双通道）** —— D10 定 `needs[]` 留 plan artifact、`leave_agent_note` 带过期 hint，共享 `signal_kind` 词汇。U4 只产 `needs[]`，但 U4 是否需读/写 agent_note 通道无 map 覆盖。按 D5 应为否（U4 不碰 note 通道），但未明证。低风险，记录待 impl 确认不越界。
6. **`pickQuestionForKnowledge` 不导出（runtime map bullet 5）已点名，但 `get_review_due` DomainTool 当前是否已是 review_plan 可复用形态** —— plan 选「route through get_review_due」，但 `get_review_due` 现注册在 COACH_TOOLS，其 input/output 是否覆盖 `select_review_question_candidates` 所需的 `knowledge_ids + constraints` 入参未勘察。若 `get_review_due` 入参不够，impl 要么扩它（碰共享工具，需协调）要么提取私有 helper（R6 已记 blast-radius）。**impl 落 §④ candidate 工具前核 `get_review_due` 的 inputSchema。**
