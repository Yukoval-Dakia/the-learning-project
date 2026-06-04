# Coach-led Review Engine — dynamic paper, question profiles, knowledge scheduling

> **Status**: design record, 2026-06-03.
> **Context**: product/architecture discussion about replacing the current
> per-question FSRS review flow with a Coach-led, subject-aware adaptive review
> engine.
> **Decision**: 复习不再把题目当单词卡排期。Coach 负责复习编排；系统提供
> question review profile / knowledge coverage / paper 数据层、即时隐藏判分、
> 可追溯 evidence 和安全约束。
>
> **U0 adjudication note (2026-06-04 / YUK-205 / ADR-0029)**: 本 spec 的**数据模型已被
> [ADR-0029](../../adr/0029-review-engine-lands-on-existing-primitives.md) 重定**——
> 引擎落回既有原语（`material_fsrs_state(subject_kind='knowledge')` / `tool_quiz` artifact /
> event 流 / `learning_session(type='review')` / 复活的 `answer` 表），原案 7 张新表砍到 0 必建。
> **产品 intent 不变**（知识点排期、paper UX、judge-now/show-later 缓冲反馈、Coach 主导编排）；
> 仅存储与编排形态重定。裁决依据见可行性审计
> [`docs/audit/2026-06-04-design-feasibility-audit.md`](../../audit/2026-06-04-design-feasibility-audit.md)（29-agent
> 审计 + 对抗验证，30 条高严重度发现全 upheld）。下文被重定的段落就地改写为裁决后形态，并以
> `> **Amended 2026-06-04 (U0 / YUK-205 / ADR-0029)**` 行标注。

## 0. Why This Exists

The current review engine is too close to Anki-style card review:

- `material_fsrs_state` is currently a per-material projection, used today as
  `subject_kind='question'` / `subject_id=question.id`.
- `/api/review/due` and `/api/review/plan` derive queues from due questions plus
  never-reviewed failure attempts.
- `/review` presents one current question, collects one `response_md`, then
  `/api/review/submit` writes a `review` event and updates the question's FSRS
  state.

That is acceptable for word/fact memorization. It is the wrong abstraction for
math, physics, wenyan, reading, and multi-part problems. A problem is usually a
measurement instrument, not the learning object itself.

New framing:

**question is content plus measurement profile, knowledge is the scheduling
object, paper is the user experience.**

## 1. Locked Product Decisions

### 1.1 Review Driver

Chosen direction: **D — knowledge-node scheduling with mixed ranking signals**.

- Knowledge node is the only schedulable review object.
- Ability, failure mode, goal, due pressure, and subject strategy affect ranking
  and question selection; they do not create separate target identities.
- FSRS becomes one pressure signal, not the owner of the user-facing queue.

### 1.2 Coach Freedom

Chosen direction:

- Coach should get materially more freedom than the current `CoachTask`.
- Review arrangement should move toward Coach-led planning.
- Review must be subject-aware. There is one Global Coach, but subject-specific
  skills/policies guide wenyan, math, physics, and later subjects.

Global Coach responsibilities:

- allocate today's subject/time balance;
- decide which knowledge nodes deserve attention;
- pick questions or request profile refresh/generation;
- decide when to stop, continue, switch knowledge focus, or insert variants;
- explain the plan and feedback in user-facing language.

Subject skill responsibilities:

- provide subject-specific knowledge/question-selection policy;
- interpret answer shapes and scoring signals;
- define what counts as diagnostic, transfer, remedial, or mastery evidence.

### 1.3 Plan Adaptivity

Chosen direction: **session-internal dynamic planning**.

Coach planning is not limited to one nightly fixed plan. During a review session,
hidden per-question judgements can change later sections.

Chosen plan semantics: **default strong plan with adaptive checkpoints**.

- The paper executes a Coach plan by default.
- After each knowledge focus or section, Coach may re-evaluate and modify
  upcoming sections.
- User can still skip, pause, resume, and leave; safety constraints prevent
  destructive or silent data changes.

### 1.4 Interface Shape

Chosen direction: **dynamic paper**, not cards.

The review UI should feel like a paper:

- sections;
- grouped questions;
- shared passages/stems;
- answer areas;
- section-level feedback;
- visible progress through a paper-like surface.

It should not feel like a word-card UI where every question interrupts the user
with rating buttons.

### 1.5 Judging and Feedback Rhythm

Chosen direction:

- Internally: **judge each answer as soon as possible** so Coach can observe.
- Externally: **do not necessarily show per-question feedback immediately**.
- Default visible feedback appears at section boundaries.
- Coach may interrupt mid-section only for severe wrong direction, repeated
  failure, empty/invalid answer patterns, or a high-value corrective hint.

Short rule:

**Paper UI is buffered; Coach loop is real-time.**

### 1.6 Review Profile Admission

Chosen direction: **automatic active admission**.

At ingestion, AI-generated review metadata is written under
`question.metadata.review_profile` and enters the Coach candidate pool by
default. Low-confidence metadata is not blocked, but every generated claim must
carry:

- confidence;
- provenance;
- rationale;
- source task/run;
- timestamps.

Coach selection tools must expose this confidence and provenance.

## 2. Core Data Boundaries

### 2.1 Question

Question is content.

It stores:

- prompt/stem/passage;
- reference answer/rubric;
- options;
- figures/images;
- structured shape;
- review profile metadata;
- source and lineage;
- compatibility `knowledge_ids`.

It should not own the scheduling state.

### 2.2 Question Review Profile

The review profile is the measurement profile of a question or part of a
question. It lives under `question.metadata`; it is not a separate durable table
in the first build.

For materialized parts, the profile lives on the child `question` row
(`kind='question_part'`). For structured-only parts, paper assignment and
coverage records use `part_ref` to point at the relevant structured node.

`part_ref` is always a `StructuredQuestion.id`. Do not use array index, ordinal
path, rendered label, or child order as `part_ref`; structure edits and reorders
must not move historical evidence to a different child. This matches the figure
attachment convention, where figure ownership also points at a
`StructuredQuestion.id`.

It answers:

- what can this item measure?
- which knowledge nodes and facets does it cover?
- is it diagnostic, remedial, transfer, original mistake, or challenge?
- how long should it take?
- how reusable is it?
- how likely is answer memorization?
- what answer shape should the paper render?

`review_probe` may remain a runtime/DTO word for "candidate measurement item",
but it is not a durable table in the first build. Its identity is computed from:

```text
question_id
+ optional part_ref
+ resolved review profile
+ coverage rows
```

The durable owner of item-level measurement information is the question row.

### 2.2.1 Probe Identity and Paper Assignment

> **Amended 2026-06-04 (U0 / YUK-205 / ADR-0029)**: 本节的产品规则不变，但持久化形态重定——
> "assignment" 不是 `paper_question_assignment` 表行，而是 `ToolStateT` v2 里 per-assignment
> intent 的一条（`{question_id, part_ref?, primary_knowledge_id, secondary_knowledge_ids,
> selection_reason, review_profile_snapshot}`）；"evidence result" 不是 `paper_evidence_result`
> 表行，而是 judge event 流 + `knowledge_mastery` view 上的派生证据。"coverage rows" 指 DEFER 的
> `question_knowledge_coverage`（未物化前为 `knowledge_ids` + metadata）。详见重写后的 §5。

Do not create one durable probe per covered knowledge node. A question or part
can cover multiple knowledge nodes, but a specific paper occurrence must declare
why this question is being used now.

Rules:

- Static coverage: one question/part may map to multiple knowledge nodes
  (coverage rows once materialized; `knowledge_ids` + metadata until then).
- Runtime intent: each assignment (a `ToolStateT` v2 entry) has exactly one
  `primary_knowledge_id`.
- Secondary signals: the assignment may include `secondary_knowledge_ids`, but
  they do not become independent scheduling objects.
- Evidence writing: one answer/judgement may produce multiple knowledge-level
  evidence signals (via judge events) only when the judgement contains enough
  evidence to support them. One signal should be primary; secondary or blocking
  signals should be lower-confidence and explicitly marked.
- Retargeting: if Coach wants to use the same question/part primarily for a
  different knowledge node, it creates a separate assignment entry. It should not
  split the same static question profile into multiple durable probes.

### 2.3 Knowledge Review Target

Target remains useful product language, but in this design it always means a
knowledge node.

There is no independent `review_target` identity layer and no `target_kind`
switch. The schedulable review object is:

```text
target = active knowledge node
```

Ability, failure mode, question type, difficulty, and original mistake pattern
remain review-profile/result facets. Coach can focus on them by selecting
appropriate questions for a knowledge node, but they should not become separate
target rows.

### 2.4 Knowledge Review State

> **Amended 2026-06-04 (U0 / YUK-205 / ADR-0029)**: 不建独立 `knowledge_review_state` 表。
> 知识级调度压力**复用既有 `material_fsrs_state(subject_kind='knowledge')`**（ADR-0028，
> 随在途 P3 分支 `yuk-203-p3-knowledge-fsrs` 合入——advisory lock + 前向迁移已实现）。复活独立表的唯一条件
> = 真出现第二个**非 FSRS** scheduler policy，届时必须写显式 supersede ADR-0028。

Knowledge-level scheduling pressure hangs from the knowledge node, carried by
`material_fsrs_state(subject_kind='knowledge', subject_id=knowledge_id)`:

- scheduler state = existing `state jsonb` (`FsrsStateT`);
- due pressure = existing `due_at`;
- last evidence = existing `last_review_event_id`;
- subject id = existing column.

`mastery_estimate` / `uncertainty` are **not** storage columns: mastery is a
derived view (`knowledge_mastery`, [ADR-0012](../../adr/0012-mastery-as-derived-view.md)),
computed from the event stream, never persisted on a scheduler row.

Important: **scheduler state belongs to the knowledge review layer, not question
content**. It remains a replayable scheduler projection/cache, not the canonical
definition of mastery.

Derived consumer (2026-06-04 grill addendum, D11): a learning item renders a
read-time **health bar** by aggregating, over its `knowledge_ids`, the
`knowledge_mastery` view plus `material_fsrs_state.due_at` — e.g. "12 knowledge
nodes: 3 due, avg mastery 64%". Read-only aggregation in the ADR-0012 family:
the learning item owns **zero** scheduler state. Learning items were explicitly
considered and rejected as FSRS units (overlapping items would double-schedule
the same memory; item lifecycle would silently retire knowledge; unmounted
knowledge would need a fallback owner — see ADR-0029 / CO §2.3).

### 2.5 Paper

> **Amended 2026-06-04 (U0 / YUK-205 / ADR-0029)**: paper 不是新表，**就是 `tool_quiz`
> artifact**（一个容器，Coach 排期卷与用户按需测验同容器，靠 provenance + plan 引用区分）。
> sections / selected questions / profile 快照 / per-assignment intent 进 `ToolStateT` v2 jsonb；
> hidden judgements + Coach observations + visible feedback checkpoints 走 event 流（judge event +
> `visible_to_user`/`revealed_at`）；答题卡草稿走复活的 `answer` 表。运行中的 attempt =
> `learning_session(type='review')`（新增 nullable `artifact_id` 列链接）。详见重写后的 §5。

Paper is the session interaction artifact, stored as a `tool_quiz` artifact:

- review plan (the ReviewPlanTask output that produced this artifact);
- sections;
- selected questions / profile snapshots (in `ToolStateT` v2);
- answer slots (the revived `answer` table);
- hidden judgements (judge events, gated by `visible_to_user`);
- Coach observations (events);
- visible feedback checkpoints.

Paper is not just a UI layout. It is the runtime container for adaptive review.

## 3. Question Review Profile and Coverage Layer

The review profile and coverage layer is the structured bridge between question
content and Coach review decisions.

Most new item-level information should live under `question.metadata`, because
it describes the question as a measurement instrument.

> **Amended 2026-06-04 (U0 / YUK-205 / ADR-0029)**: `question_knowledge_coverage` 标为
> **DEFER-until-needed**——不在 MVP 建表。首个 Coach loop 若靠 `question.knowledge_ids` + metadata
> 就能 rank 候选，这张 m2m 表永不需要存在；待 Coach candidate-selection 真要 role/strength/part_ref 的
> 可 join 关系（jsonb array 里别扭）时再 materialize（CO § KEEP-but-DEFER）。下方保留它的概念 schema
> 作为按需物化的形状参照，但**当前不落 DDL**。`question.metadata.review_profile` 留在原处不变。

Conceptual schema:

```ts
type ReviewProfile = {
  profile_kind:
    | 'diagnostic'
    | 'remedial'
    | 'transfer'
    | 'challenge'
    | 'original_mistake',
  answer_shape:
    | 'choice'
    | 'multi_choice'
    | 'inline_blank'
    | 'short_answer'
    | 'long_work'
    | 'scratch_image',
  difficulty?: number,
  estimated_minutes?: number,
  cognitive_load?: number,
  repeatability?: 'low' | 'medium' | 'high',
  memorization_risk?: number,
  ability_tags?: string[],
  failure_mode_tags?: string[],
  work_style?: string[],
  confidence: number,
  provenance: Record<string, unknown>
}

question.metadata.review_profile?: ReviewProfile

question.metadata.review_profiles_by_part_ref?: Record<
  StructuredQuestion['id'],
  ReviewProfile
>
```

Resolution rule:

```text
materialized question_part:
  use child_question.metadata.review_profile

structured-only part:
  use parent_question.metadata.review_profiles_by_part_ref[part_ref]
  fallback to parent_question.metadata.review_profile only for whole-question
  assignments
```

A parent question may have a whole-question profile and multiple part profiles.
They are not interchangeable: child parts commonly differ in answer shape,
difficulty, profile kind, and failure-mode tags.

> **Amended 2026-06-04 (U0 / YUK-205 / ADR-0029)**: `review_profile` 仍住 `question.metadata`
> jsonb（不变），但写边界**必须**加 `ReviewProfileSchema` Zod parse barrier（audit CD-4）。
> `question.metadata` 无 DB CHECK/列约束，`audit:schema` 的 regex 看不见 jsonb 内部 key——
> provenance/confidence 会无声漂移、零 drift 保护。barrier 是写点（profile-generation task 的输出
> handler）而非 DB 约束，匹配仓库 "parse at boundary" 纪律。

DEFER-until-needed reference shape (NOT a MVP migration — see the amendment
above; `knowledge_review_state` is removed entirely, replaced by
`material_fsrs_state(subject_kind='knowledge')` per ADR-0029 / ADR-0028):

```sql
-- question_knowledge_coverage: materialize ONLY when Coach candidate-selection
-- needs a joinable m2m with role/strength/part_ref. Until then, rank from
-- question.knowledge_ids + metadata.
question_knowledge_coverage (
  id text primary key,
  question_id text not null references question(id),
  part_ref text,
  knowledge_id text not null references knowledge(id),
  role text not null check (
    role in ('primary', 'secondary', 'prerequisite', 'context')
  ),
  coverage_strength real not null,
  confidence real not null,
  rationale text,
  provenance jsonb not null,
  status text not null default 'active',
  created_at timestamptz not null,
  updated_at timestamptz not null
)

-- Active-row uniqueness (when materialized):
--   unique active (question_id, coalesce(part_ref, ''), knowledge_id, role)
--   where status = 'active'

-- knowledge_review_state: REMOVED. Knowledge-level scheduling reuses
--   material_fsrs_state(subject_kind='knowledge', subject_id=knowledge_id).
--   state jsonb = FsrsStateT; due_at exists; last_evidence = last_review_event_id.
--   mastery_estimate/uncertainty are NOT columns (knowledge_mastery view, ADR-0012).
```

Core rule:

**Question owns item-level measurement metadata. Coverage links question/part to
knowledge. Knowledge is scheduling (`material_fsrs_state(subject_kind='knowledge')`).
Scheduler state only hangs from knowledge.**

## 4. Question Shape Taxonomy

Question shape should describe renderable structure and answer slots. It should
not be reduced to a single flat `kind`.

### 4.1 Atomic Shapes

Supported conceptual atomic shapes:

- `inline_blank`: blank embedded inside prompt text.
- `cloze_options`: blank embedded inside prompt text, with an option pool below
  or beside the passage.
- `choice`: single-choice or multi-choice.
- `short_answer`: one or more text/work slots.

### 4.2 Composite Shape

Reading questions and math/physics multi-part problems are the same structural
idea:

```text
CompositeQuestion
  shared_context: passage / stem / figure / material
  children:
    AtomicQuestion[]
```

Examples:

```text
Reading set
  shared_context: long passage
  children:
    Q1 single_choice
    Q2 short_answer
    Q3 inline_blank

Math problem
  shared_context: function definition / diagram
  children:
    (1) calculation
    (2) proof / reasoning
    (3) transfer / extension
```

Principle:

**Composite question is the context boundary. Child question is the
answer/judge boundary. Knowledge/question-selection is the scheduling
boundary.**

Coach may choose:

- the whole composite;
- selected children while preserving parent context;
- initial children plus later appended children;
- a child as calibration and a generated variant as follow-up.

### 4.3 Relationship to Existing Structure

Current code already has related primitives:

- `question.structured`;
- `question.parent_question_id`;
- `question.part_index`;
- `kind='question_part'`.

The old idea that a part naturally becomes an independently scheduled question
should be retired for this engine. Parts may be answer/judge units, but the
scheduling unit should remain knowledge plus question/profile selection.

> **Amended 2026-06-04 (U0 / YUK-205 / ADR-0029)**: 这条退役与 [ADR-0014](../../adr/0014-generalized-activity-and-capability-registry.md)
> 的 **2026-06-04 update note** 一致——ADR-0014 的 part-独立调度 facet 被本裁决簇 (D2) supersede；
> part 作为独立 question 行的判分/血缘/figures 语义不变（仅退役其调度身份）。知识级调度落在
> `material_fsrs_state(subject_kind='knowledge')`（ADR-0028）。
>
> **part 知识继承规则 (D2)**：**未标注 knowledge 的 part 在 tagging/enroll 时默认继承写实 parent 的
> `knowledge_ids`**（写实标签写进该 part 行，**非读时继承**）。question 级 FSRS fallback 只留给真正无主的
> legacy 题；带继承标签的 part 照常进知识级调度。

## 5. Paper, Answer, and Hidden Judgement Model

> **Amended 2026-06-04 (U0 / YUK-205 / ADR-0029)**: 整节重定为既有原语之上的形态 (D3 + D4)。
> 原案的 6 张 paper 表（`review_plan` / `review_paper_attempt` / `paper_question_assignment` /
> `paper_answer` / `paper_judgement` / `paper_evidence_result`）**全部不建**——它们分别与已 ship 的
> `tool_quiz` artifact、`learning_session(type='review')`、event 流、闲置 `answer` 表三重撞车
> （审计 X2/X4）。下文给出落回原语的模型；产品 intent（答题卡、隐藏判分、缓冲反馈、可追溯证据）不变。

The current `response_md` model is too thin. Dynamic paper needs an answer
sheet, not a single answer string. The U0-adjudicated model lands each concern
on an existing primitive:

### 5.1 Paper container = `tool_quiz` artifact

Paper is a `tool_quiz` artifact (one container — Coach-scheduled papers and
user-on-demand quizzes share it, distinguished by provenance: `intent_source` /
`source` / `source_ref` + the plan reference that produced it).

Sections and per-assignment intent live in `ToolStateT`, extended with a **v2
variant**:

```text
ToolStateT v2 (tool_quiz)
  sections[]
    knowledge_focus
    feedback_policy
    adaptation_policy
    assignments[]                       # per-assignment intent
      question_id
      part_ref?                         # StructuredQuestion.id (see §2.2)
      primary_knowledge_id
      secondary_knowledge_ids[]
      selection_reason
      review_profile_snapshot
  # flat question_ids[] form is retained for embedded_check / existing quizzes
```

The flat `question_ids[]` shape is preserved for `embedded_check` and existing
stored quizzes; v2 is additive. `ToolStateT` is `jsonb`, so its write path
**must** carry a Zod parse barrier (same boundary discipline as the
`review_profile` barrier in §3; `audit:schema` cannot see jsonb-internal keys).

### 5.2 Attempt = `learning_session(type='review')` + `artifact_id`

The runtime attempt reuses `learning_session(type='review')` (free pause /
resume / abandon + the orphan-cleanup cron). One new **nullable column
`learning_session.artifact_id`** links the session to its paper artifact
(follows the table's per-type dedicated-field precedent; one column, not a
table). `session_id` is not invented here — it is the existing
`learning_session.id`.

### 5.3 Draft autosave = the revived `answer` table

Answer-sheet slot storage is the **revived inert `answer` table** (shape already
exists: `input_kind` / `content_md` / `image_refs` / `vision_extracted`). It
gains slot / paper / session link columns and a write path; the schema
allowlist debt for the inert table is cleared in the same migration.

- autosave = mutable working state on the `answer` row (`autosaved_at`);
- submit = freeze (`submitted_at`) + an event referencing the `answer` row.

Iron rule (D4): the `answer` table is revived for exactly this; there is **no
third "left hanging" answer model**.

Answer kinds map to `answer.input_kind`:

- `short_text`;
- `long_work`;
- `choice`;
- `multi_choice`;
- `multi_blank`;
- `scratch_image`;
- future `oral`;
- future `self_check`.

### 5.4 Submitted answer = per-slot attempt/review event

A submitted answer is a per-slot `attempt` / `review` event (the part is the
judge boundary), fed to the same FSRS/mastery path as today — the TDM "不另记"
rule holds (no parallel attempt record).

### 5.5 Judgement = judge event + visibility gate

Judgement is a judge event (`action='judge'`, `caused_by_event_id` → the
triggering attempt event), with payload carrying `judge_route` / `score` /
`coarse_outcome` / `feedback_md`. The single genuinely new need — hidden /
buffered feedback (§1.5) — is met by a **`visible_to_user` boolean** (or
`revealed_at timestamptz`) on the judge event payload, not a table. A judgement
may be hidden from the user but still produce evidence for Coach.

### 5.6 Evidence = event stream + `knowledge_mastery` view

Knowledge-level evidence is the judge/attempt **event stream** plus the derived
`knowledge_mastery` view (ADR-0012), not a `paper_evidence_result` table.
Evidence roles (`primary` / `secondary` / `blocking_prerequisite` /
`context_only`) live on the evidence signals; the scheduler treats primary
evidence as the default update path for `material_fsrs_state(subject_kind='knowledge')`,
while secondary evidence needs confidence/rule checks before it affects
scheduling.

### 5.7 Mid-attempt adaptive change

Session-internal adaptation = **the paper artifact updated in place** (optimistic
concurrency via the artifact `version`) + an `adaptation` event for the audit
trail (`caused_by` chained to the judgement that triggered it). The
"artifact is immutable" intuition yields here; the adaptation event is the trace
that keeps it auditable.

For math/physics, final answer alone is insufficient. The answer model
(`answer.input_kind` = `long_work` / `scratch_image`) must support
reasoning/work signals, units, formulas, intermediate steps, and image uploads
when useful.

Chosen first-product boundary:

- Text input remains available.
- Math/physics should allow or encourage handwritten/scratch-image submission.
- MVP may support text first, but the data model must not block image/workflow
  answers.

### 5.8 Practice surface (hard requirement)

There must be a **first-class "今日 / 往日练习" page** where the user can find
and resume papers. Coach-scheduled papers and user-on-demand quizzes are listed
together (one `tool_quiz` container, distinguished by provenance). This is a
hard product requirement; the UI build must go through the design-doc pre-flight
before any component code.

## 6. Coach Runtime Model

> **Amended 2026-06-04 (U0 / YUK-205 / ADR-0029)**: 复习规划是 **Coach → brief → ReviewPlanTask
> 两级流水线** (D5)，不是单个 Coach agent 直接出卷。
>
> - **Coach 出战略 brief**：科目配比 / 知识焦点 / 时间盒 / intent tags。brief 的家 = TodayPlan 的
>   `review_session_proposal` 字段**扩展**（现 `{count, estimated_minutes}` 养大），**不另立 artifact type**。
> - **ReviewPlanTask 做战术出卷**：独立注册 + 专属窄 surface，按 brief 从候选池选题/探针并写 plan，
>   **输出就是 paper artifact**（§5.1 的 `tool_quiz` + ToolStateT v2，带 §7.1 的 labels/rationale/guardrail
>   契约）。
> - **CoachTask 不进 session 热循环**——session 内 checkpoint 自适应归 ReviewPlanTask（`checkpoint_adapt` mode）。
> - 触发：pg-boss 链 `coach_daily → review_plan` 夜间出卷 + on-demand 重出（无新鲜 brief 时降级为纯
>   due-pressure 出卷）。

Coach is the review orchestrator (strategic layer). ReviewPlanTask is the
tactical planner. Both need structured tools rather than raw access to all
questions; ReviewPlanTask's surface is the narrow one defined in §6.1.

A candidate-selection tool should return a ranked candidate pool:

```text
[
  {
    question_id,
    part_ref,
    review_profile,
    knowledge_coverage,
    estimated_minutes,
    memorization_risk,
    confidence,
    provenance,
    why_candidate,
    alternatives
  }
]
```

Coach does not need to scan the entire raw question table. It chooses from
explainable candidates and can request profile refresh or new generated
questions when the pool is inadequate.

### 6.1 ReviewPlanTask Tool Boundary

`ReviewPlanTask` is a planner, not a general executor. It is independently
registered with a narrow, dedicated surface and runs in two modes: `initial_plan`
(nightly / on-demand paper generation) and `checkpoint_adapt` (session-internal
re-evaluation between knowledge focuses).

> **Amended 2026-06-04 (U0 / YUK-205 / ADR-0029)**: 工具清单删掉 `query_memory_brief` 与
> `search_memory_facts`——**ReviewPlanTask 不读记忆 (D7)**。注意力先验经 Coach brief 单通道下传，
> 读 brief 即可。下方四个工具即专属窄 surface；`write_review_plan` 的输出就是 paper artifact（§5.1）。

Allowed tools:

```text
read_coach_brief(scope_key?)
get_review_knowledge_snapshot(subject_id?)
select_review_question_candidates(knowledge_ids, constraints)
write_review_plan(plan)
```

Tool roles:

- `read_coach_brief` provides the strategic brief (subject mix / knowledge focus
  / time box / intent tags) that Coach wrote into the TodayPlan
  `review_session_proposal` extension — this is the only attention prior the
  planner sees; it does **not** read Mem0 or memory briefs directly;
- `get_review_knowledge_snapshot` provides due, weak, uncertain, recent-failure,
  and goal-relevant knowledge state;
- `select_review_question_candidates` provides an explainable candidate pool;
- `write_review_plan` persists the auditable plan, whose output is the paper
  artifact (`tool_quiz` + ToolStateT v2).

Forbidden direct writes:

- `material_fsrs_state(subject_kind='knowledge')`, FSRS state, or `due_at`;
- `question.metadata.review_profile` or `question_knowledge_coverage`;
- question creation, deletion, or mutation;
- judge events / evidence signals.

If the candidate pool is inadequate, `ReviewPlanTask` should declare needs
rather than performing the work itself:

```ts
needs: Array<
  | { kind: 'question_profile_refresh'; question_id: string; reason: string }
  | { kind: 'question_generation'; knowledge_id: string; reason: string }
>
```

The practical rule: Coach sets strategy, ReviewPlanTask plans the paper. Other
tasks profile, generate, judge, extract evidence, and schedule.

## 7. Dynamic Paper Flow

### 7.1 Plan Creation

> **Amended 2026-06-04 (U0 / YUK-205 / ADR-0029)**: plan 与 paper 合一——`ReviewPlanTask` 的
> `write_review_plan` 输出**就是** paper artifact（§5.1 `tool_quiz` + ToolStateT v2）；下方 `review_plan`
> 结构是该 artifact 的逻辑视图，不是独立 `review_plan` 表（已删）。labels / rationale / guardrail 契约与
> `subject_ids` 不变量**保留不变**——它们是出卷的硬契约。`coverage_snapshot` 在 coverage 表 DEFER 期间
> 由 `knowledge_ids` + metadata 快照充当。

Inputs:

- user context;
- active goals;
- active learning items (pinned / in_progress) — their `knowledge_ids` feed the
  brief's knowledge-focus ranking as **attention pressure only**, never as
  memory bookkeeping (D11: intent biases what gets picked, evidence changes
  scheduler truth);
- subject allocation;
- knowledge review states;
- due pressure;
- mastery/uncertainty (read from the `knowledge_mastery` view — never stored columns, per ADR-0012);
- recent failures;
- available question candidates;
- proposal feedback / user preferences.

Output:

```text
review_plan
  subject_ids[]
  labels
    paper_kind
    time_box
    intent_tags[]
    subject_mix
    adaptation_level
    difficulty_shape
    source
  rationale
  memory_context_used[]
  sections[]
    subject_id
    knowledge_ids[]
    assignments[]
      question_id
      part_ref?
      primary_knowledge_id
      secondary_knowledge_ids[]
      review_profile_snapshot
      coverage_snapshot
      selection_reason
    feedback_policy
    adaptation_policy
  guardrail_checks
    within_time_budget
    candidate_pool_only
    every_assignment_has_primary_knowledge
    no_direct_scheduler_mutation
```

`review_plan.subject_ids` is the plan-level subject summary. Each section also
has a `subject_id`, which drives rendering, subject profile selection, memory
scope, and judgement policy. Invariant:

```text
review_plan.subject_ids = unique(review_plan.sections[].subject_id)
```

The first product may generate single-subject papers, but the plan contract
should support multi-subject daily papers from the start.

`ReviewPlanTask` should plan heuristically, not by applying a fixed paper mix.
The hard requirements are its output contract, candidate-pool guardrails,
structured labels, and rationale. Labels make daily auto-generated papers
explainable, debuggable, reviewable in history, and available to future memory
briefs.

### 7.2 Execution

User sees a paper-like surface:

- section header;
- knowledge/context summary;
- one or more questions;
- answer slots;
- timer/progress;
- optional scratch/upload.

Internally:

- each answer slot autosaves;
- each submitted slot can trigger hidden judgement;
- hidden judgement writes paper evidence;
- Coach observes the result before deciding later sections.

### 7.3 Feedback

Default:

- no per-question interruption;
- section-end feedback;
- final paper feedback.

Allowed interruption:

- repeated severe misunderstanding;
- answer shape invalid/empty;
- Coach detects the current section no longer serves the knowledge focus;
- user explicitly asks for help.

## 8. Knowledge Review State Update

> **Amended 2026-06-04 (U0 / YUK-205 / ADR-0029)**: 证据更新落在
> `material_fsrs_state(subject_kind='knowledge')`（不是已删的 `knowledge_review_state`，也不是 question
> 态）。evidence 本身是 event 流 + `knowledge_mastery` view（§5.6）。

Paper evidence (event-stream signals) should update the knowledge-level scheduler
projection `material_fsrs_state(subject_kind='knowledge')`, not question state.

Evidence dimensions:

- correctness;
- partial correctness;
- confidence;
- time spent;
- answer completeness;
- repeated failure mode;
- original-question memorization risk;
- transfer success/failure;
- child-question pattern in composites.

The scheduler policy is deliberately not fully specified here. The first
implementation can use an FSRS-like state for knowledge-level due pressure, but
the data model must permit alternatives such as mastery bands, uncertainty
sampling, or subject-specific policies.

## 9. Compatibility with Existing Review

Current engine should remain as compatibility while the new engine lands.

Compatibility facts:

- existing `question.knowledge_ids` can seed first question-knowledge coverage
  links;
- existing `material_fsrs_state(subject_kind='question')` can remain as legacy
  queue pressure;
- existing `question_part` rows and their question-level FSRS projections can
  remain for compatibility, but they are legacy pressure/evidence only. They are
  not the new review truth;
- existing `/api/review/submit` can inspire judge/write behavior but should not
  stay the central paper answer model;
- existing `ReviewIntentTask` can be replaced or subsumed by Coach plan text;
- existing `question.structured` and part fields should be reused rather than
  discarded.

> **Amended 2026-06-04 (U0 / YUK-205 / ADR-0029)**: 删去"`knowledge_review_state` 不许被
> `material_fsrs_state` 当第二所有者竞争"一句——因为两者本就是**同一个表**了。兼容关系改为与 ADR-0028
> 的前向迁移对齐：legacy `material_fsrs_state(subject_kind='question')` 行作为兼容压力保留，知识级调度
> re-key 到 `(subject_kind='knowledge', subject_id=知识点)`；ADR-0028 决策 #5 前向迁移并 DELETE 旧
> question 行，未标注 legacy 题 fallback 到 question 级投影。这是 re-key（同表泛化），不是两个竞争所有者。

Migration principle:

**Do not delete the old queue first. Introduce question review profiles,
the knowledge-level `material_fsrs_state(subject_kind='knowledge')` re-key
(ADR-0028), and paper artifacts alongside it; then move `/review` to consume
Coach plans once the new path has enough data.**

## 10. Memory Governance

> **Amended 2026-06-04 (U0 / YUK-205 / ADR-0029)**: 记忆治理的新家是
> [AF spec §3 (Tool Permission Model)](../specs/2026-06-04-agent-framework-design.md)（工具权限 owner）；
> 本节缩为引用。

Memory is an attention prior, not review truth (ADR-0017: SoT = event +
`knowledge_mastery` view). The full allow/deny matrix lives in AF spec §3. The
points specific to this engine:

- **Coach** reads memory (Mem0 fact layer + brief layer) and folds it into the
  strategic brief; the attention prior reaches the planner only through that
  single channel.
- **`ReviewPlanTask` does not read memory (D7)** — neither Mem0 nor briefs. Nor
  do `QuizGenTask`, `KnowledgeReviewTask`, or any evaluator/operator task
  (judge / tagging / structure / attribution / verification). Memory reads are
  limited to the orchestrator roles `coach` / `dreaming` / `copilot`.
- Memory may change attention and explanation; it must never directly update
  `due_at` / mastery / FSRS state, replace SQL reads from event/knowledge/
  scheduler state, or bias judge scoring.

## 11. Safety and Governance

> **Amended 2026-06-04 (U0 / YUK-205 / ADR-0029)**: proposal-only 不变量的正主是
> [ADR-0025 ND-5](../../adr/0025-north-star-goal-entity-and-coach-coexistence.md)（+ADR-0004）；
> 本节的"restructure knowledge without proposal/accept flow"即 ND-5 的本引擎应用，不再独立复述。下面的
> may-not 清单是本 spec 特有的运行期约束，**保留**——其中"permanently suppress overdue/weak knowledge
> nodes"是 ND-5 原文条款在复习编排上的直接落地。

Coach can arrange review freely inside safe boundaries.

Coach may:

- choose subject allocation;
- choose knowledge order;
- choose questions/profile candidates;
- append variants;
- stop or continue a knowledge focus;
- request question profile refresh or generated variants;
- hide or reveal feedback according to policy.

Coach may not silently:

- delete questions;
- delete knowledge;
- permanently suppress overdue/weak knowledge nodes;
- mark long-term mastery from one easy success;
- rewrite historical answer/judge events;
- restructure knowledge without proposal/accept flow.

Every Coach decision should be traceable to:

- knowledge snapshot;
- question candidate list;
- hidden judgement;
- paper attempt;
- user context;
- goal/subject policy.

## 12. Suggested Implementation Slices

> **Amended 2026-06-04 (U0 / YUK-205 / ADR-0029)**: slices 按裁决重排。Slice 1 现在是 judge event
> version stamping（D6，与 PS spec 共享、只造一次）+ `ToolStateT` v2 + coverage DEFER 注记；Slice 5
> 是 ADR-0028 知识级 FSRS 复用（随 P3 分支合入）；Slice 2 是 question shape + 复活的 `answer` 表；
> Slice 4 仍排最后并含一级练习页面。

### Slice 1 — Version stamping + ToolStateT v2 foundation (D6)

- **judge event version stamping (D6)**: add optional `profile_version` /
  `capability_ref` / `judge_route` to the judge event payload; stop hard-coding
  `capability_ref.version` `'1.0.0'`, read `SubjectProfile.version` instead.
  This is the **first foundation slice, shared with the PS spec — built once**,
  ahead of any Studio/paper UI. rejudge = a new event, never rewriting old
  results.
- Add the `ToolStateT` v2 variant (sections + per-assignment intent), additive
  over the flat `question_ids[]` form; carry a Zod parse barrier on its write
  path.
- Extend `question.metadata` with whole-question `review_profile` and
  per-structured-part `review_profiles_by_part_ref` (+ `ReviewProfileSchema`
  Zod barrier, CD-4).
- `question_knowledge_coverage` is **DEFER-until-needed** (not built here);
  rank from `question.knowledge_ids` + metadata until a joinable m2m is proven
  necessary.
- Auto-activate AI-generated review profile metadata with confidence/provenance.

### Slice 2 — Question shape and answer slots

- Upgrade structured question shape to cover atomic/composite forms.
- **Revive the inert `answer` table** as answer-sheet slot storage (add slot /
  paper / session link columns + write path; clear the schema allowlist debt).
- Keep compatibility rendering for existing markdown-only questions.

### Slice 3 — Coach planning tools

- Add read tools for knowledge snapshots and question candidates.
- Add the plan/write path whose output is the paper artifact (`tool_quiz` +
  ToolStateT v2).
- Give `ReviewPlanTask` only `read_coach_brief`, knowledge snapshot, candidate
  selection, and plan-write tools — **no memory reads** (D7).
- Make pool gaps explicit via `needs[]` instead of letting the planner profile,
  generate, judge, or schedule directly.
- Add `ReviewPlanTask` with `initial_plan` and `checkpoint_adapt` modes.
- Require `ReviewPlanTask` output to include plan-level `subject_ids`, paper
  labels, rationale, section-level `subject_id`, assignment-level selection
  reasons, and guardrail checks.
- Do not hard-code a fixed paper mix; plan heuristically from the Coach brief,
  due pressure, knowledge state, subject context, and candidate questions.
- Keep plan writes auditable and replayable.

### Slice 4 — Dynamic paper UI + practice surface

- Replace card-like `/review` primary surface with paper sections.
- Keep hidden per-answer judgement.
- Show section-level feedback by default.
- Build the first-class "今日 / 往日练习" page (Coach papers + user quizzes
  unified; §5.8). UI build goes through the design-doc pre-flight.
- Stays **last** (most expensive, lowest near-term value; conflicts with the
  in-flight YUK-169 redraw on the `/review` surface).

### Slice 5 — Knowledge-state scheduler (ADR-0028 reuse)

- Move scheduling pressure to `material_fsrs_state(subject_kind='knowledge')`
  — **reuse via the ADR-0028 re-key, merged with the P3 branch
  `yuk-203-p3-knowledge-fsrs`**, not a new table.
- Keep existing question FSRS as compatibility/evidence.
- Stop treating question as the primary due object.

## 13. Non-goals for the First Build

- Fully autonomous knowledge restructuring.
- Perfect scheduler theory.
- Replacing every old review route at once.
- Building all subject-specific policies before the first subject works.
- Forcing every question into a polished structured shape before compatibility
  fallback exists.

## 14. Design Summary

The new review engine should be Coach-led, subject-aware, and paper-shaped.

> **Amended 2026-06-04 (U0 / YUK-205 / ADR-0029)**: durable model 落回既有原语——下图为裁决后形态
> （0 必建新表；coverage 表 DEFER）。

The durable model is:

```text
question.metadata.review_profile  (+ ReviewProfileSchema Zod barrier)
question -> knowledge_ids / [question_knowledge_coverage DEFER]
         -> material_fsrs_state(subject_kind='knowledge')   # scheduling (ADR-0028)
         \
          -> tool_quiz artifact (ToolStateT v2: sections + per-assignment intent)
               <- learning_session(type='review').artifact_id   # attempt
               <- answer table (draft slots)                     # autosave
               <- attempt / judge events (+ visible_to_user)     # submit + grading
               -> knowledge_mastery view                         # evidence (ADR-0012)
```

The user experience is a dynamic paper. The internal engine is real-time
judgement plus Coach observation. The scheduling object is knowledge. The
question owns its measurement profile and remains the content/measurement
material.

This is the decisive break from "questions are like words, so use FSRS on
questions."
