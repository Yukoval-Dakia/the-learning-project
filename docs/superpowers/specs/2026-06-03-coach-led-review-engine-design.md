# Coach-led Review Engine — dynamic paper, question profiles, knowledge scheduling

> **Status**: design record, 2026-06-03.
> **Context**: product/architecture discussion about replacing the current
> per-question FSRS review flow with a Coach-led, subject-aware adaptive review
> engine.
> **Decision**: 复习不再把题目当单词卡排期。Coach 负责复习编排；系统提供
> question review profile / knowledge coverage / paper 数据层、即时隐藏判分、
> 可追溯 evidence 和安全约束。

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

Do not create one durable probe per covered knowledge node. A question or part
can cover multiple knowledge nodes through `question_knowledge_coverage`, but a
specific paper occurrence must declare why this question is being used now.

Rules:

- Static coverage: one question/part may have multiple coverage rows.
- Runtime intent: each `paper_question_assignment` has exactly one
  `primary_knowledge_id`.
- Secondary signals: the assignment may include `secondary_knowledge_ids`, but
  they do not become independent scheduling objects.
- Evidence writing: one answer/judgement may create multiple
  `paper_evidence_result` rows only when the judgement contains enough evidence
  to support them. One row should be primary; secondary or blocking rows should
  be lower-confidence and explicitly marked.
- Retargeting: if Coach wants to use the same question/part primarily for a
  different knowledge node, it creates a separate paper assignment. It should not
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

Knowledge review state owns scheduling pressure and mastery estimate for a
knowledge node.

It stores:

- scheduler policy and state;
- due pressure;
- mastery estimate;
- uncertainty;
- last evidence;
- stale/risk markers;
- subject id.

Important: **state belongs to the knowledge review layer, not question content**.
It is a replayable scheduler projection/cache, not the canonical definition of
mastery.

### 2.5 Paper

Paper is the session interaction artifact.

It stores:

- review plan;
- sections;
- selected questions/profile snapshots;
- answer slots;
- hidden judgements;
- Coach observations;
- visible feedback checkpoints.

Paper is not just a UI layout. It is the runtime container for adaptive review.

## 3. Question Review Profile and Coverage Layer

The review profile and coverage layer is the structured bridge between question
content and Coach review decisions.

Most new item-level information should live under `question.metadata`, because
it describes the question as a measurement instrument. The first-class table is
only for the queryable many-to-many relationship between questions and knowledge
nodes.

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

```sql
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

knowledge_review_state (
  knowledge_id text primary key references knowledge(id),
  subject_id text not null,
  scheduler_policy text not null,
  scheduler_state jsonb not null,
  mastery_estimate real,
  uncertainty real,
  due_at timestamptz,
  last_evidence_event_id text,
  model_version text not null,
  updated_at timestamptz not null
)

-- Active-row uniqueness:
--   unique active (question_id, coalesce(part_ref, ''), knowledge_id, role)
--   where status = 'active'
```

Core rule:

**Question owns item-level measurement metadata. Coverage links question/part to
knowledge. Knowledge is scheduling. Review state only hangs from knowledge.**

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

## 5. Paper, Answer, and Hidden Judgement Model

The current `response_md` model is too thin. Dynamic paper needs an answer
sheet, not a single answer string.

Conceptual schema:

```sql
review_plan (
  id text primary key,
  actor_kind text not null,
  actor_ref text not null,
  subject_ids jsonb not null,
  status text not null,
  plan_json jsonb not null,
  evidence_json jsonb not null,
  created_at timestamptz not null,
  updated_at timestamptz not null
)

review_paper_attempt (
  id text primary key,
  review_plan_id text not null references review_plan(id),
  session_id text,
  subject_id text,
  status text not null,
  started_at timestamptz not null,
  submitted_at timestamptz,
  created_at timestamptz not null,
  updated_at timestamptz not null
)

paper_question_assignment (
  id text primary key,
  paper_attempt_id text not null references review_paper_attempt(id),
  question_id text not null references question(id),
  part_ref text,
  primary_knowledge_id text not null references knowledge(id),
  secondary_knowledge_ids jsonb not null default '[]'::jsonb,
  review_profile_snapshot jsonb not null,
  coverage_snapshot jsonb not null,
  selection_reason text,
  created_at timestamptz not null
)

paper_answer (
  id text primary key,
  paper_attempt_id text not null references review_paper_attempt(id),
  assignment_id text not null references paper_question_assignment(id),
  slot_id text not null,
  answer_kind text not null,
  answer_payload jsonb not null,
  autosaved_at timestamptz,
  submitted_at timestamptz,
  judge_status text not null default 'pending',
  visible_to_user boolean not null default false,
  created_at timestamptz not null,
  updated_at timestamptz not null
)

paper_judgement (
  id text primary key,
  paper_answer_id text not null references paper_answer(id),
  judge_route text not null,
  score real,
  coarse_outcome text not null,
  feedback_md text,
  evidence_json jsonb not null,
  visible_to_user boolean not null default false,
  created_at timestamptz not null
)

paper_evidence_result (
  id text primary key,
  knowledge_id text references knowledge(id),
  assignment_id text not null references paper_question_assignment(id),
  paper_answer_id text not null references paper_answer(id),
  judgement_id text references paper_judgement(id),
  evidence_role text not null,
  result_kind text not null,
  confidence real not null,
  signals_json jsonb not null,
  created_at timestamptz not null
)
```

Answer kinds:

- `short_text`;
- `long_work`;
- `choice`;
- `multi_choice`;
- `multi_blank`;
- `scratch_image`;
- future `oral`;
- future `self_check`.

`paper_question_assignment` records why this question/part was placed in this
paper and which knowledge node it primarily serves. `paper_judgement` is the
hidden/visible grading record. `paper_evidence_result` is the normalized
evidence that Coach and the knowledge scheduler consume. A judgement may be
hidden from the user but still create evidence for Coach.

`evidence_role` distinguishes `primary`, `secondary`, `blocking_prerequisite`,
and `context_only` evidence. The scheduler should treat primary evidence as the
default update path for `knowledge_review_state`; secondary evidence needs
confidence/rule checks before it affects scheduling.

For math/physics, final answer alone is insufficient. The answer model must
support reasoning/work signals, units, formulas, intermediate steps, and image
uploads when useful.

Chosen first-product boundary:

- Text input remains available.
- Math/physics should allow or encourage handwritten/scratch-image submission.
- MVP may support text first, but the data model must not block image/workflow
  answers.

## 6. Coach Runtime Model

Coach is the review orchestrator.

It needs structured tools rather than raw access to all questions:

```text
get_review_knowledge_snapshot(subject_id?)
select_review_question_candidates(knowledge_ids, constraints)
write_review_plan(plan)
observe_paper_attempt(attempt_id)
record_paper_evidence_result(...)
request_question_profile_refresh(...)
```

`select_review_question_candidates` should return a ranked candidate pool:

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

`ReviewPlanTask` is a planner, not a general executor.

Allowed tools:

```text
query_memory_brief(scope_key)
search_memory_facts(query, scope_key?, top_k?)
get_review_knowledge_snapshot(subject_id?)
select_review_question_candidates(knowledge_ids, constraints)
write_review_plan(plan)
```

Tool roles:

- `query_memory_brief` and `search_memory_facts` provide attention prior;
- `get_review_knowledge_snapshot` provides due, weak, uncertain, recent-failure,
  and goal-relevant knowledge state;
- `select_review_question_candidates` provides an explainable candidate pool;
- `write_review_plan` persists the auditable plan artifact.

Forbidden direct writes:

- `knowledge_review_state`, FSRS state, or `due_at`;
- `question.metadata.review_profile` or `question_knowledge_coverage`;
- question creation, deletion, or mutation;
- `paper_judgement` or `paper_evidence_result`.

If the candidate pool is inadequate, `ReviewPlanTask` should declare needs
rather than performing the work itself:

```ts
needs: Array<
  | { kind: 'question_profile_refresh'; question_id: string; reason: string }
  | { kind: 'question_generation'; knowledge_id: string; reason: string }
>
```

The practical rule: Coach plans the review. Other tasks profile, generate,
judge, extract evidence, and schedule.

## 7. Dynamic Paper Flow

### 7.1 Plan Creation

Inputs:

- user context;
- active goals;
- subject allocation;
- knowledge review states;
- due pressure;
- mastery/uncertainty;
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

Paper evidence results should update `knowledge_review_state`, not question
state.

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
  not the new review truth and must not compete with `knowledge_review_state` as
  a second scheduler owner;
- existing `/api/review/submit` can inspire judge/write behavior but should not
  stay the central paper answer model;
- existing `ReviewIntentTask` can be replaced or subsumed by Coach plan text;
- existing `question.structured` and part fields should be reused rather than
  discarded.

Migration principle:

**Do not delete the old queue first. Introduce question review profiles,
question-knowledge coverage, knowledge review state, and paper attempts
alongside it; then move `/review` to consume Coach plans once the new path has
enough data.**

## 10. Memory Governance

Memory is available to review planning as an attention prior, not as review
truth.

Daily Coach planning should read memory in two layers:

- `memory_brief_note` for broad orientation;
- Mem0 fact search for scoped detail when the agent has a specific reason to
  look up prior preferences, habits, or recurring patterns.

Active subjects are not durable state. They are a reader-computed scope list
used to decide which subject briefs are relevant for a planning turn.

Inputs that may make a subject active:

- recent learning, attempt, review, or capture events for that subject;
- due pressure or weak knowledge in that subject;
- active goals that mention the subject;
- recent Coach or Dreaming attention to that subject.

Default daily review memory scopes:

```text
global
subject:<active_subject_id>[]
meta:orchestrator_self, when the agent is reasoning about user preferences or
conversation style
```

Mem0 should be broadly available to product agents, including `CoachTask`,
`ReviewPlanTask`, `DreamingTask`, `CopilotTask`, `KnowledgeReviewTask`, and
`QuizGenTask`.

Evaluator/operator tasks should not read Mem0 by default:

- `TaggingTask`;
- judge tasks;
- structure tasks;
- attribution tasks;
- verification tasks.

Those tasks should rely on question content, answers, knowledge, rubrics, and
explicit task inputs. User memory should not leak into judgement or extraction.

Allowed memory effects:

- choose what context the Coach inspects next;
- adjust paper labels, time box, and explanation style;
- suggest which subject or knowledge state should be checked in SoT;
- personalize Coach language and pacing.

Forbidden memory effects:

- directly update `due_at`, mastery, FSRS state, or `knowledge_review_state`;
- replace `paper_evidence_result`;
- replace SQL reads from event, knowledge, question, or scheduler state;
- bias judge scoring because memory says the user is weak or strong.

Core rule:

**Memory can change attention and explanation. Evidence and scheduler state
change review truth.**

## 11. Safety and Governance

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

### Slice 1 — Schema and read model

- Add `question_knowledge_coverage` and `knowledge_review_state`.
- Extend `question.metadata` with whole-question `review_profile` and
  per-structured-part `review_profiles_by_part_ref`.
- Seed coverage from existing `question.knowledge_ids`.
- Auto-activate AI-generated review profile metadata with confidence/provenance.

### Slice 2 — Question shape and answer slots

- Upgrade structured question shape to cover atomic/composite forms.
- Add answer slot schema and paper answer persistence.
- Keep compatibility rendering for existing markdown-only questions.

### Slice 3 — Coach planning tools

- Add read tools for knowledge snapshots and question candidates.
- Add a plan artifact/write path.
- Give `ReviewPlanTask` only memory read, knowledge snapshot, candidate
  selection, and plan-write tools.
- Make pool gaps explicit via `needs[]` instead of letting the planner profile,
  generate, judge, or schedule directly.
- Add `ReviewPlanTask` with `initial_plan` and `checkpoint_adapt` modes.
- Require `ReviewPlanTask` output to include plan-level `subject_ids`, paper
  labels, rationale, optional memory-use summary, section-level `subject_id`,
  assignment-level selection reasons, and guardrail checks.
- Do not hard-code a fixed paper mix; Coach should plan heuristically from
  active goals, memory attention, due pressure, knowledge state, subject
  context, and candidate questions.
- Keep plan writes auditable and replayable.

### Slice 4 — Dynamic paper UI

- Replace card-like `/review` primary surface with paper sections.
- Keep hidden per-answer judgement.
- Show section-level feedback by default.

### Slice 5 — Knowledge-state scheduler

- Move scheduling pressure to `knowledge_review_state`.
- Use existing question FSRS as compatibility/evidence.
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

The durable model is:

```text
question.metadata.review_profile
question -> question_knowledge_coverage -> knowledge_review_state
         \
          -> review_plan -> paper_attempt -> paper_question_assignment -> paper_answer
```

The user experience is a dynamic paper. The internal engine is real-time
judgement plus Coach observation. The scheduling object is knowledge. The
question owns its measurement profile and remains the content/measurement
material.

This is the decisive break from "questions are like words, so use FSRS on
questions."
