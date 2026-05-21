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

**User decision 2026-05-21**: M1 仍按计划走。math 没触发 ≠ 不该做——技术债收口，提前清理；不希望 phase 序列出现"deferred forward"导致后续多 phase 并行。

### Revised M1 scope（foundation cleanup ahead of M2）

M1 不再是"沿 math 路径迁移"——math 路径已无对象。M1 重新定义为：**在 M2 vision judge 引入前把 Foundation 层的债务收口**。

具体 scope：

1. **§A 处理**（dead-code wenyan-hardcoded prompts in `src/ai/registry.ts`）
   - 给 NoteGenerateTask / VariantGenTask / TeachingTurnTask / KnowledgeReviewTask 的 `systemPrompt` 字段加强 deprecation 注释（明文 "do not edit here; runtime uses task-prompts.ts"），或将字段类型改为 optional 以反映非 source-of-truth。
   - 决策点（M1 开始前确认）：(a) 加强注释 vs (b) 字段改 optional vs (c) 字段直接删除。建议 (a) 最小破坏。

2. **§B 处理**（`getTaskSystemPrompt` default branch）
   - `task-prompts.ts:303-304` 的 default 分支：把 `tasks[task].systemPrompt` fallback 替换为 (a) `assertNever(task)` 编译期检查，或 (b) 显式 throw with warning。
   - 当前 12 个 task 全在 switch 内，default 不应被命中——TypeScript 端补强即可。

3. **§C 子集处理**（可在 M1 内做的 question_id 重构）
   - `semanticInput()` (`src/server/ai/judges/question-contract.ts:140`) 改为 profile-aware（接收 `subjectProfile` 参数，用于 M2 vision judge 可以直接消费同接口）—— 这是 M2 prep 的真正价值。
   - 其它 §C 表里的 question_id 引用大多是 DB schema-layer / 合法用法，**不动**（留 M3 sweep / 后续 ADR 决定）。

4. **顺手处理**（2026-05-20 drift audit 的 2 条 finding）：
   - ADR-0015（`learning_record` + `memory_brief_note` 无 ADR）—— 起草并 merge。
   - registry.ts 死代码 deprecated 注释（与 §A 合并处理）。

### M1 exit criteria

- `src/ai/registry.ts` 所有未迁移 task 的 `systemPrompt` 字段有强 deprecation 注释，或字段类型重构。
- `getTaskSystemPrompt` default 分支不再悄默 fallback 到 registry 字符串（switch exhaustive 或 throw）。
- `semanticInput()` 接受 subjectProfile 参数（M2 prep）。
- ADR-0015 merged。
- `/audit-drift` 报告中 2026-05-20 的 2 条 finding 清零。

### 投入估计

约 1-2 day。比原计划 M1（2-3 day "沿路径迁移"）小，因为 math 没触发的 question_id 引用大多是合法的——不需要全部迁移。

### M3 后续

M3 仍保留为最终 sweep phase，处理 M1 没收口的 (a) 非 math 非 M2 路径的 question_id refactor、(b) `EmbeddedCheckSection.tsx` 的 UI 层 question_id（math 引入 embedded check 后才有对象）。M3 可能因 M1 提前清理而 scope 进一步缩小。
