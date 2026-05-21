# Math M1 — Drift Migration Targets

**Generated**: 2026-05-21 (M0 exit gate output)
**Trigger**: M0 e2e smoke ran math choice + fill_blank end-to-end. Positions math actually touched but still using `question_id` / wenyan-coupled prompts / legacy patterns are listed here for M1 migration. Out-of-path positions are listed under M3 sweep.

**Key insight**: M0 fixture path is **deterministic-judge only** (exact + keyword). No LLM tasks (Attribution / NoteGenerate / VariantGen / TeachingTurn / Semantic) are called. So the math-path drift list is **mostly empty** — wenyan-coupled prompts don't fire on M0. The bulk goes to M3.

This will change in **M2** when vision judge (`steps@1`) is introduced — that will exercise LLM tasks against math profile and surface real path issues.

---

## In math path (M0-touched) — must migrate in M1

### 1. None for the deterministic path

Math fixture e2e walked through:
- `app/api/_/seed/math/route.ts` — new code, profile-blind by design
- `src/db/schema.ts` `question` table — schema layer, no profile awareness needed
- `src/server/ai/judges/question-contract.ts` `resolveQuestionJudgeRoute` + `judgeAnswer` — profile-aware; routes correctly for both `single_choice` and `fill_blank`
- `src/server/ai/judges/exact.ts` + `keyword.ts` — pure deterministic, profile-blind

Result: **no ActivityRef migration is required for M1 from the M0-exercised path**. The shim at `src/server/review/activity-ref.ts` already handles legacy `question_id` ↔ `ActivityRef` bridging.

**M1 takeaway**: M1's planned ActivityRef migration work is **deferred forward** to M2/M3 where real LLM-path coupling will surface.

---

## Not in M0 path — defer to M3 (or M2 vision judge exposes a subset)

These will fire when M2 introduces vision judge and when math wrong-answer attempts trigger AttributionTask. Many are dead-code drift (registry.ts) — runtime is profile-aware via `getTaskSystemPrompt`, but the legacy `systemPrompt` strings remain misleading.

### A. Dead-code wenyan-hardcoded prompts in `src/ai/registry.ts`

These are **not used at runtime** (runner routes through `getTaskSystemPrompt(kind, profile)` at `src/server/ai/runner.ts:223`; registry strings are kept as fallback only with `// fallback only` comments at lines 55/97/111/126/140/156/170).

| Task | Line | Wenyan-coupled content |
|---|---|---|
| `NoteGenerateTask.systemPrompt` | `src/ai/registry.ts:158` | "文言文示例首选经典原文（《师说》《伶官传序》之类）" |
| `VariantGenTask.systemPrompt` | `src/ai/registry.ts:216` | "文言文示例首选经典原文，不自创" |
| `TeachingTurnTask.systemPrompt` | `src/ai/registry.ts:231` | "你是文言文学习教练" + "用文言文经典原文示例（《师说》《伶官传序》之类）" |
| `KnowledgeReviewTask.systemPrompt` | `src/ai/registry.ts:262` | "Phase 1a 单 domain wenyan：禁止 propose_new / reparent / split..." |

**Action (M3)**: per 2026-05-20 drift audit ADR-0014 finding, either annotate each with stronger deprecation comment ("// deprecated: runtime uses task-prompts.ts; do not edit here") or drop the field entirely.

### B. `getTaskSystemPrompt` default branch

`src/ai/task-prompts.ts:303-304`:

```ts
default:
  return tasks[task].systemPrompt;  // falls back to registry's hardcoded string
```

If a future task is added to registry but not added to the switch, it silently picks up registry's wenyan-hardcoded prompt. No current task hits this default (all 12 are switched).

**Action (M3 or sooner if new task added)**: add a `warn` log + replace `tasks[task].systemPrompt` with a generic neutral fallback, or `assertNever(task)` for type-level enforcement.

### C. `question_id` usages — most are legitimate schema-layer references

Inventory of `question_id` / `questionId` occurrences (excluding tests):

| File | Line | Role | Migration needed? |
|---|---|---|---|
| `src/db/schema.ts` | (learning_record fk) | DB column | No — schema field name |
| `src/core/schema/business.ts:199` | Z type | Type def | No — payload schema |
| `src/core/schema/activity.ts:21-22` | `questionRef()` helper | Bridge | No — by design |
| `src/server/review/activity-ref.ts:6,12,29,36,41,42,51,52` | Shim layer | Bridge | No — Foundation A's existing bridge |
| `src/server/records/types.ts:32,53` + `queries.ts:87,112` + `mistakes.ts:17,29,71,72` | learning_record API | Hub | No — `learning_record.question_id` is the canonical hub field |
| `src/server/boss/handlers/knowledge_propose_nightly.ts:48,64,69` | Attempt aggregation | Reader | Defer to M3 — when math attempts feed this, evaluate |
| `src/server/boss/handlers/variant_gen.ts:91,153,221,238,250` | Variant lineage | Tree | No — `root_question_id` is a question-tree concept, not legacy alias |
| `src/server/knowledge/review.ts:52` | KnowledgeReviewTask payload | LLM input | Defer to M3 — pure data extraction |
| `src/server/ai/judges/question-contract.ts:140` | `semanticInput` | LLM input | Defer to M2 (vision judge will use SemanticJudgeTask) |
| `src/server/events/queries.ts:174,352` | Event projection | Read model | No — `subject_id → question_id` in projections is the documented pattern |
| `src/server/orchestrator/review.ts:34,225,230,245` | FSRS state read | Hub | No — `material_fsrs_state.subject_id` aliased as `question_id` for backwards compat |
| `src/ui/components/EmbeddedCheckSection.tsx:78` | UI POST body | API call | Defer to M3 — math doesn't have embedded check yet |

**Math path will surface this in M2**: when vision judge runs SemanticJudgeTask via `semanticInput()`, that path will need profile-aware identification. Not blocking for M1.

---

## Concrete M1 plan

Given the empty in-math-path list, **M1 scope as originally written is no-op**. Recommend:

1. **Re-scope M1**: skip M1 phase entirely; M0 drift inventory shows nothing needs migration for deterministic judge math.
2. **Or repurpose M1** as a "M2 prep" phase: refactor `semanticInput()` to be profile-aware (currently hardcoded subject-blind) so M2's vision steps@1 can drop in cleanly.
3. **Or defer everything to M3** sweep + treat M2 as the trigger for real profile-driven prompt work.

User decision needed before kicking off M1 / M2.

**Recommendation**: skip M1 as separate phase; jump directly to **M2 (vision judge + steps@1 capability)**. Drift items B + C above naturally surface during M2 implementation. Treat M3 as a dedicated cleanup of registry dead-code + non-path question_id refactors.
