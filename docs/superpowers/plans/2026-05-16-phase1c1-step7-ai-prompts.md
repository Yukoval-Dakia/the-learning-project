# Phase 1c.1 Step 7 — AI prompts + registry rewrite (event-stream language + bridge removal)

> Step 7 ("AI prompts + registry 更新") expansion. Parent plan §Step 7.
>
> **Prerequisites**: PR #49 (Step 6) merged or on phase1c1-step6-prep branch. Lane B `ProposeKnowledgeEdge` schema present in `src/core/schema/event/known.ts`.
>
> **Scope**: Rewrite system prompts in `src/ai/registry.ts` to speak event-stream language (without changing user-facing "错题" semantics). Remove Step 4's `ai_analysis_md` → `analysis_md` Zod bridge from `src/server/knowledge/attribute.ts` once `AttributionTask` prompt emits `analysis_md` natively. Add `propose_knowledge_edge` branch to `KnowledgeReviewTask` + `KnowledgeProposeTask`. **No new routes, no schema changes.**

---

## Per-task rewrites

### `AttributionTask` (registry.ts ~line 45-65)

**Current prompt (excerpt)**:
> 输出严格 JSON: `{"primary_category": ..., "secondary_categories": [...], "ai_analysis_md": "...", "confidence": 0-1}`

**New prompt**:
> 输出严格 JSON: `{"primary_category": ..., "secondary_categories": [...], "analysis_md": "...", "confidence": 0-1}` (field renamed `ai_analysis_md` → `analysis_md` per Lane B `CauseSchema`)
> Framing: "你是错题归因助手 → ... 给定一道做错的题 (attempt event with outcome='failure')，用户的错答 (event.payload.answer_md)，参考答案和挂的 knowledge_ids，分析错因。归因结果作为 judge event 写入 (action='judge', subject_kind='event', caused_by_event_id=<attempt event id>)，payload.cause 即此输出。"
> Keep "用户面文案 = 错题" — model-visible entity terminology changes only.

**Downstream cleanup**:
- `src/server/knowledge/attribute.ts`: remove `z.preprocess(... ai_analysis_md → analysis_md ...)` bridge added in Step 4. `AttributionOutputSchema` becomes:
  ```ts
  const AttributionOutputSchema = z.object({
    primary_category: CauseCategory,
    secondary_categories: z.array(CauseCategory).default([]),
    analysis_md: z.string().min(1).max(2000),  // was `ai_analysis_md`
    confidence: z.number().min(0).max(1),
  });
  ```
- Update internal usages of `parsed.ai_analysis_md` → `parsed.analysis_md`.

### `KnowledgeProposeTask`

**Current prompt (excerpt)**:
> 用户录入了一道做错的题，挂的 knowledge_ids 是用户自选。看错题内容 + 当前 tree snapshot...

**New prompt**:
> 用户新写入了一个 attempt event (outcome='failure')，挂的 knowledge_ids 来自 payload.referenced_knowledge_ids（用户自选）。看 attempt event 内容 (payload.answer_md + 关联 question.prompt_md) + 当前 tree snapshot...

Output shape unchanged (already matches Lane B `ProposeKnowledge.payload = {name, parent_id, reasoning}`).

### `KnowledgeReviewTask`

**Current prompt**:
> 看完整 tree（含层级 / archived / merged_from）+ 最近的 mistake 数据，propose 让 tree 更合理的 mutation. 可选 mutation: propose_new / reparent / merge / split / archive. 每 propose 一条，调一次 write_proposal({mutation, payload, reasoning}).

**New prompt** (event-stream language + edge propose branch per ADR-0010 + ADR-0011):
> 看完整 tree + 最近 7 天的 attempt events (filter: action='attempt', outcome='failure'). Propose 让 tree 更合理的 mutation. 
> 可选 mutation:
>   - **Tree-shape**: propose_new (加新子节点) / reparent / merge / split / archive
>   - **Mesh-shape** (per ADR-0010): propose_knowledge_edge ({from_knowledge_id, to_knowledge_id, relation_type, reasoning}). relation_type 是 5 种之一 (prerequisite / related_to / contrasts_with / applied_in / derived_from) 或 experimental:* 命名空间.
> 每 propose 一条，调一次 write_proposal({mutation, payload, reasoning}). 
> reasoning 必须具体 (指向 attempt event id 或 tree 结构).

The `write_proposal` tool dispatches by `mutation`:
- `propose_new` / `reparent` / `merge` / `split` / `archive` → existing `writeDreamingProposal` (unchanged in Step 7)
- `propose_knowledge_edge` → **NEW** — call `writeEvent` with `ProposeKnowledgeEdge` shape (per Lane B); this is the AI write path for mesh proposals

The `write_proposal` tool's allowed mutations enum needs to expand. See `src/server/knowledge/review.ts` (Step 4 rewrote it).

### Other tasks

`VisionExtractTask` + `VisionExtractTaskHeavy`: unchanged (vision extraction, no entity-naming drift).

---

## Implementation details

### `src/server/knowledge/review.ts` — `write_proposal` tool dispatch

After Step 4, `streamReviewTask` registers a `write_proposal` tool. Step 7 expands the tool's logic:

```ts
write_proposal: {
  description: 'Propose tree mutation OR mesh edge. payload.mutation distinguishes.',
  inputSchema: z.object({
    payload: z.unknown(),
    reasoning: z.string(),
  }),
  execute: async ({ payload, reasoning }) => {
    if (isKnowledgeEdgeMutation(payload)) {
      // NEW: write ProposeKnowledgeEdge event via writeEvent
      const eventId = await writeEvent(db, {
        id: newId(),
        actor_kind: 'agent',
        actor_ref: 'dreaming',
        action: 'propose',
        subject_kind: 'knowledge_edge',
        subject_id: <synth or referenced>,
        outcome: 'success',
        payload: {
          from_knowledge_id: payload.from_knowledge_id,
          to_knowledge_id: payload.to_knowledge_id,
          relation_type: payload.relation_type,
          reasoning,
        },
        created_at: new Date(),
      });
      return { event_id: eventId, kind: 'knowledge_edge_propose' };
    }
    // existing: tree mutation
    const id = await writeDreamingProposal(db, { payload, reasoning });
    return { proposal_id: id, kind: 'tree_mutation' };
  },
}
```

Where `isKnowledgeEdgeMutation(p)` discriminates on `p.mutation === 'propose_knowledge_edge'` OR shape match.

### `AgentRefLike` tightening (opportunistic)

Step 6 noted `src/server/knowledge/edges.ts` uses permissive `AgentRefLike` for `created_by`. Step 7 tightens to Lane B's `AgentRef` discriminated union (from `core/schema/business.ts`). Only if no production rows break.

Actually — checking now — `AgentRef` is `{ kind: 'user' } | { kind: 'agent', task: string } | ...`. Current `edges.created_by` JSONB field accepts the looser `AgentRefLike`. Tightening means rewriting `edges.ts` Zod input + breaking any existing row that doesn't match. **Decision (per scope discipline)**: keep `AgentRefLike` permissive in Step 7; revisit when ADR or test reveals concrete need. Don't expand scope.

---

## TDD substep breakdown

6 substeps (smaller than Steps 5/6 — focused prompt + Zod cleanup work).

### 7.A — AttributionTask prompt + Zod cleanup

- **7.A.1** (red): `src/server/knowledge/attribute.test.ts` add cases — feed mock LLM text emitting `analysis_md` (not `ai_analysis_md`); assert `parseAttributionOutput` returns parsed with `analysis_md` field; assert downstream `runAttributionAndWriteJudgeEvent` writes judge event with `payload.cause.analysis_md` (not `ai_analysis_md`)
- **7.A.2** (verify fail): tests fail because Zod still expects `ai_analysis_md` via bridge
- **7.A.3** (green): rewrite `AttributionOutputSchema` to native `analysis_md` (remove `z.preprocess` bridge); update `AttributionTask.systemPrompt` to emit `analysis_md`; update internal field accesses
- **7.A.4** (verify pass)
- **7.A.5** (commit): `refactor(1c.1 Step 7): AttributionTask — emit analysis_md natively (remove Step 4 Zod bridge)`

### 7.B — KnowledgeProposeTask prompt rewrite

- **7.B.1** (red): `src/server/knowledge/propose.test.ts` add case — mock LLM output unchanged shape; assert registry's `systemPrompt` string contains "attempt event" not "mistake" (snapshot or substring match)
- **7.B.5** (commit): `refactor(1c.1 Step 7): KnowledgeProposeTask prompt — event-stream language`

### 7.C — KnowledgeReviewTask prompt rewrite + `propose_knowledge_edge` branch in tool

- **7.C.1** (red): `src/server/knowledge/review.test.ts` add 2 cases:
  - Mock LLM calls `write_proposal({ mutation:'propose_new', name, parent_id, reasoning })` → asserts `writeDreamingProposal` called (existing path unchanged)
  - Mock LLM calls `write_proposal({ mutation:'propose_knowledge_edge', from_knowledge_id, to_knowledge_id, relation_type:'prerequisite', reasoning })` → asserts `writeEvent` called with `ProposeKnowledgeEdge` shape; resulting event parses through Lane B `ProposeKnowledgeEdge` schema
- **7.C.5** (commit): `feat(1c.1 Step 7): KnowledgeReviewTask — propose_knowledge_edge branch (writes event via writeEvent)`

### 7.D — KnowledgeReviewTask prompt text update

- **7.D.1** (red): assert systemPrompt string contains "attempt events" + "propose_knowledge_edge" + "relation_type" terms
- **7.D.5** (commit): `refactor(1c.1 Step 7): KnowledgeReviewTask prompt text — event language + edge branch`

### 7.E — Registry sanity test

- **7.E.1** (red): `src/ai/registry.test.ts` (new or existing) — assert `tasks.AttributionTask.systemPrompt` matches new event-stream framing (substring); same for `KnowledgeProposeTask` + `KnowledgeReviewTask`. Catches accidental prompt regressions.
- **7.E.5** (commit): `test(1c.1 Step 7): registry — prompt content pinned to event-stream framing`

### 7.F — Integration: parseable Lane B output

- **7.F.1** (red): `tests/integration/ai-output-parses-lane-b.test.ts` — feed canned LLM responses through `parseAttributionOutput` and the review write_proposal handler; assert each constructed event passes `parseEvent` end-to-end. (Mock LLM via existing `MockLanguageModelV3` from `ai/test`.)
- **7.F.5** (commit): `test(1c.1 Step 7): integration — AI outputs parse through Lane B Event schema`

---

## Locked contract

- **User-facing "错题" semantics stable**. Model-visible entity terminology changes only.
- **`AttributionOutputSchema` drops the Step 4 `z.preprocess` bridge after Step 7.A**. Any external client still emitting `ai_analysis_md` will fail Zod parse — surface as error, don't silently coerce (regression test would catch).
- **`propose_knowledge_edge` writes go through `writeEvent`** (Step 4 single-owner). NO direct `db.insert(event)` in `review.ts` tool handler.
- **`write_proposal` tool dispatches by mutation kind**; tree mutations still go to `writeDreamingProposal` (Phase 1c.2 will migrate proposals to events too — out of scope here).
- **Don't expand `AgentRefLike` scope** — defer tightening to a focused refactor with concrete trigger.
- 6 separate commits, conventional format. Each ends with `Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>`.

---

## Subagent prompt

```markdown
You are executing Phase 1c.1 Step 7 of the-learning-project. Worktree-isolated.

## BOOTSTRAP

```bash
git fetch origin
git merge origin/phase1c1-step7-prep --ff-only
```

Verify: `ls docs/superpowers/plans/2026-05-16-phase1c1-step7-ai-prompts.md`, `ls src/ai/registry.ts`, `grep "writeEvent" src/server/events/queries.ts`, `grep "ProposeKnowledgeEdge" src/core/schema/event/known.ts`.

If anything missing, STOP and report.

## Authoritative spec

`docs/superpowers/plans/2026-05-16-phase1c1-step7-ai-prompts.md` — read in full.

## Required reading

1. `CLAUDE.md`
2. `docs/superpowers/plans/2026-05-16-phase1c1-step7-ai-prompts.md` (authoritative)
3. `docs/adr/0010-knowledge-mesh.md` — relation_type enums
4. `docs/adr/0011-tool-use-and-edge-event-paths.md` — `ProposeKnowledgeEdge` event path
5. `src/core/schema/event/known.ts` — `ProposeKnowledgeEdge` schema (your event-write target for review propose_knowledge_edge branch)
6. `src/server/events/queries.ts` — `writeEvent` (call this for propose_knowledge_edge)
7. `src/ai/registry.ts` — full registry (you rewrite 3 system prompts)
8. `src/server/knowledge/attribute.ts` — remove Step 4 Zod bridge; rename `ai_analysis_md` → `analysis_md`
9. `src/server/knowledge/review.ts` — expand `write_proposal` tool to handle propose_knowledge_edge mutation
10. Existing tests: `src/server/knowledge/attribute.test.ts`, `propose.test.ts`, `review.test.ts` (mock LLM patterns)

## Locked contract

- **User-facing "错题" terminology preserved** in user-visible copy. Model-visible entity names change.
- **`AttributionOutputSchema` Zod bridge MUST be removed** after 7.A (no `z.preprocess` fallback for `ai_analysis_md`). If a regression test pre-Step-7 fed `ai_analysis_md`, update it to feed `analysis_md`.
- **propose_knowledge_edge writes events via `writeEvent`** (Step 4 single-owner). NEVER `db.insert(event)` direct.
- **Don't tighten `AgentRefLike`** — Step 6 noted it as optional; defer.
- **6 separate commits**, conventional format. Each ends with `Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>`.

## Implementation guidance

- **AttributionTask prompt update**: substring search for `ai_analysis_md` in `src/ai/registry.ts`'s `AttributionTask.systemPrompt`. Replace with `analysis_md`. Reword Chinese surrounding text from "错题" (model-visible entity language) to "attempt event (outcome='failure')". User-visible text stays "错题" semantically (this is the system prompt, not user UI).
- **review.ts `write_proposal` discrimination**: check if payload looks like an edge mutation. Cleanest is having the LLM emit `mutation: 'propose_knowledge_edge'` discriminator explicitly. Document the contract in tool description.
- **propose_knowledge_edge event subject_id**: per Lane B `ProposeKnowledgeEdge`, `subject_kind: 'knowledge_edge'`. The subject_id is the **proposed** edge id (synth if no concrete edge row exists yet, since we're just proposing). Use `newId()` for the synthetic id. Document inline.
- **Don't break existing `write_proposal` tree mutation path** — `writeDreamingProposal` still called for propose_new / reparent / merge / split / archive.
- **Mock LLM in tests**: existing pattern uses `MockLanguageModelV3` from `ai/test`. Mirror that in 7.C / 7.F.

## Out of scope (DO NOT TOUCH)

- DB schema
- Lane B Zod schemas (`src/core/schema/event/**`)
- `src/server/session/`
- `src/server/events/queries.ts` (extend only if absolutely necessary; prefer using existing helpers)
- New routes
- DROP TABLE
- Migration scripts
- `AgentRefLike` tightening (defer)

## Verification gates

- `pnpm typecheck` green
- `pnpm test src/server/knowledge/attribute.test.ts` green (bridge-removed + new analysis_md field)
- `pnpm test src/server/knowledge/propose.test.ts` green (prompt content assertion)
- `pnpm test src/server/knowledge/review.test.ts` green (new propose_knowledge_edge case + tree mutation still works)
- `pnpm test src/ai/registry.test.ts` green (registry sanity)
- `pnpm test tests/integration/ai-output-parses-lane-b.test.ts` green
- `pnpm test` full suite green (Step 6 baseline 644)
- `pnpm lint` no new errors
- `pnpm audit:schema` green
- 6 commits, conventional format

## Return (under 800 words)

1. Branch name
2. 6 commit hashes + subjects
3. Verification gate outputs (final lines)
4. Sample JSON: a `ProposeKnowledgeEdge` event constructed by the review handler from a mocked LLM call (paste)
5. Edge cases (bullets)
6. Out-of-scope discoveries
7. Outstanding risks for Step 8/9
```

---

## Risks

- **Prompt drift**: snapshot-style tests for prompt content (substring match) can be brittle. Use coarse substring assertions (e.g., "analysis_md", "attempt event", "propose_knowledge_edge") rather than full-string regex.
- **`write_proposal` mutation discrimination ambiguity**: if LLM emits a malformed payload (no `mutation` field), default to tree mutation (current behavior) — log warning. Add test for this fallback.
- **Removing Zod bridge breaks any cached LLM output**: prod won't hit this (each request is fresh), but if any test fixture has cached `ai_analysis_md` output text, it'll fail. Acceptable — Step 7 is a contract change.

---

## Next-step planning

Step 8 (data migration prod run + mastery view smoke) draft after Step 7 lands. Step 8 will wire `runMigration` into `tests/global-setup.ts` and add deploy runbook documentation.
