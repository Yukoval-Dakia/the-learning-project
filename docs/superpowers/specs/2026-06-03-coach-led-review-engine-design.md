# Coach-led Review Engine — dynamic paper, normalized probes, knowledge scheduling

> **Status**: design record, 2026-06-03.
> **Context**: product/architecture discussion about replacing the current
> per-question FSRS review flow with a Coach-led, subject-aware adaptive review
> engine.
> **Decision**: 复习不再把题目当单词卡排期。Coach 负责复习编排；系统提供
> knowledge/probe/paper 数据层、即时隐藏判分、可追溯 evidence 和安全约束。

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

**question is content, probe is measurement purpose, knowledge is the scheduling
object, paper is the user experience.**

## 1. Locked Product Decisions

### 1.1 Review Driver

Chosen direction: **D — knowledge-node scheduling with mixed ranking signals**.

- Knowledge node is the only schedulable review object.
- Ability, failure mode, goal, due pressure, and subject strategy affect ranking
  and probe selection; they do not create separate target identities.
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
- pick or request probes;
- decide when to stop, continue, switch knowledge focus, or insert variants;
- explain the plan and feedback in user-facing language.

Subject skill responsibilities:

- provide subject-specific knowledge/probe policy;
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

### 1.6 Probe Admission

Chosen direction: **automatic active admission**.

At ingestion, AI-generated probe metadata enters the Coach candidate pool by
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
- source and lineage;
- compatibility `knowledge_ids`.

It should not own the scheduling state.

### 2.2 Probe

Probe is the measurement profile of a question or part of a question.

It answers:

- what can this item measure?
- which knowledge nodes and facets does it cover?
- is it diagnostic, remedial, transfer, original mistake, or challenge?
- how long should it take?
- how reusable is it?
- how likely is answer memorization?
- what answer shape should the paper render?

Probe is a child of question, but it is not the same thing as question.

### 2.3 Knowledge Review Target

Target remains useful product language, but in this design it always means a
knowledge node.

There is no independent `review_target` identity layer and no `target_kind`
switch. The schedulable review object is:

```text
target = active knowledge node
```

Ability, failure mode, question type, difficulty, and original mistake pattern
remain probe/result facets. Coach can focus on them by selecting appropriate
probes for a knowledge node, but they should not become separate target rows.

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
- selected probes;
- answer slots;
- hidden judgements;
- Coach observations;
- visible feedback checkpoints.

Paper is not just a UI layout. It is the runtime container for adaptive review.

## 3. Normalized Probe Layer

The normalized probe layer is the structured bridge between question content
and Coach review decisions.

Do not put all probe metadata into a large `question.metadata` blob. Use
first-class records so Coach tools, analytics, and future maintenance jobs can
query and repair them.

Conceptual schema:

```sql
review_probe (
  id text primary key,
  question_id text not null references question(id),
  subject_id text not null,
  probe_kind text not null,
  difficulty int,
  estimated_minutes int,
  cognitive_load int,
  repeatability text,
  memorization_risk real,
  confidence real not null,
  provenance jsonb not null,
  status text not null default 'active',
  created_at timestamptz not null,
  updated_at timestamptz not null
)

review_probe_knowledge (
  id text primary key,
  probe_id text not null references review_probe(id),
  knowledge_id text not null references knowledge(id),
  role text not null,
  coverage_strength real not null,
  confidence real not null,
  rationale text,
  provenance jsonb not null
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
```

Core rule:

**Question is content. Probe is measurement purpose. Knowledge is scheduling.
Review state only hangs from knowledge.**

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
answer/judge boundary. Knowledge/probe is the scheduling boundary.**

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
scheduling unit should remain knowledge/probe.

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

paper_answer (
  id text primary key,
  paper_attempt_id text not null references review_paper_attempt(id),
  probe_id text not null references review_probe(id),
  question_id text not null references question(id),
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

probe_result (
  id text primary key,
  probe_id text not null references review_probe(id),
  knowledge_id text references knowledge(id),
  paper_answer_id text not null references paper_answer(id),
  judgement_id text references paper_judgement(id),
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

`paper_judgement` is the hidden/visible grading record. `probe_result` is the
normalized evidence that Coach and the knowledge scheduler consume. A judgement
may be hidden from the user but still create a probe result for Coach.

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
select_review_probes(knowledge_ids, constraints)
write_review_plan(plan)
observe_paper_attempt(attempt_id)
record_probe_result(...)
request_probe_generation(...)
```

`select_review_probes` should return a ranked candidate pool:

```text
[
  {
    probe_id,
    question_id,
    knowledge_coverage,
    probe_kind,
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
explainable candidates and can request new probes when the pool is inadequate.

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
- available probes;
- proposal feedback / user preferences.

Output:

```text
review_plan
  sections[]
    subject_id
    knowledge_ids[]
    probe_ids[]
    feedback_policy
    adaptation_policy
```

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
- hidden judgement writes probe evidence;
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

Probe results should update `knowledge_review_state`, not question state.

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

- existing `question.knowledge_ids` can seed first probe-knowledge links;
- existing `material_fsrs_state(subject_kind='question')` can remain as legacy
  queue pressure;
- existing `/api/review/submit` can inspire judge/write behavior but should not
  stay the central paper answer model;
- existing `ReviewIntentTask` can be replaced or subsumed by Coach plan text;
- existing `question.structured` and part fields should be reused rather than
  discarded.

Migration principle:

**Do not delete the old queue first. Introduce knowledge/probe/paper alongside it,
then move `/review` to consume Coach plans once the new path has enough data.**

## 10. Safety and Governance

Coach can arrange review freely inside safe boundaries.

Coach may:

- choose subject allocation;
- choose knowledge order;
- choose probes;
- append variants;
- stop or continue a knowledge focus;
- request new probes;
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
- probe candidate list;
- hidden judgement;
- paper attempt;
- user context;
- goal/subject policy.

## 11. Suggested Implementation Slices

### Slice 1 — Schema and read model

- Add `review_probe`, `review_probe_knowledge`, and `knowledge_review_state`.
- Seed from existing `question.knowledge_ids`.
- Auto-activate AI-generated probe metadata with confidence/provenance.

### Slice 2 — Question shape and answer slots

- Upgrade structured question shape to cover atomic/composite forms.
- Add answer slot schema and paper answer persistence.
- Keep compatibility rendering for existing markdown-only questions.

### Slice 3 — Coach planning tools

- Add read tools for knowledge snapshots and probe candidates.
- Add a plan artifact/write path.
- Keep plan writes auditable and replayable.

### Slice 4 — Dynamic paper UI

- Replace card-like `/review` primary surface with paper sections.
- Keep hidden per-answer judgement.
- Show section-level feedback by default.

### Slice 5 — Knowledge-state scheduler

- Move scheduling pressure to `knowledge_review_state`.
- Use existing question FSRS as compatibility/evidence.
- Stop treating question as the primary due object.

## 12. Non-goals for the First Build

- Fully autonomous knowledge restructuring.
- Perfect scheduler theory.
- Replacing every old review route at once.
- Building all subject-specific policies before the first subject works.
- Forcing every question into a polished structured shape before compatibility
  fallback exists.

## 13. Design Summary

The new review engine should be Coach-led, subject-aware, and paper-shaped.

The durable model is:

```text
question -> review_probe -> review_probe_knowledge -> knowledge_review_state
                         \
                          -> review_plan -> paper_attempt -> paper_answer
```

The user experience is a dynamic paper. The internal engine is real-time
judgement plus Coach observation. The scheduling object is knowledge. The
question is only content and probe material.

This is the decisive break from "questions are like words, so use FSRS on
questions."
