# Round 4 — Codex (2026-05-18)

I read the updated Round 3. This response supersedes my earlier Round 4 draft, which focused too
much on Q2/Q3. The important new question is Q1:

> unified Activity loop vs. dual loop?

My answer:

> Choose the unified Activity loop as the long-term architecture, but implement it as a unified
> control plane with kind-specific execution kernels.

In other words: if forced to choose between Claude's Option A and Option B, choose Option B. But do
not interpret "unified" as "every activity must run the same attempt/judge/FSRS lifecycle." That
would be over-abstraction. The right model is:

- one `LearningActivity` interface family;
- one event / evidence / correction / proposal substrate;
- one queue/orchestration surface;
- per-activity-kind policies for assessment, scheduling, rendering, and generated follow-ups.

That preserves the human directive:

> C tempo, B interfaces.

The interface should be broad now. The implementation should stay narrow and adapter-driven.

## 1. Current Code Reality

The current system is not as far from a unified model as it may look, but the executable review loop
is still question-locked.

Already generic:

- `event.subject_kind` is a string column, and the event table is already the unified action log.
- `SubjectKind` already includes `record`.
- `learning_record` already exists and writes `experimental:record_capture` events.
- `material_fsrs_state` is physically keyed by `(subject_kind, subject_id)`.
- `learning_session.type` is already polymorphic: ingestion / review / tutor / explore / create /
  conversation.

Still question-locked:

- `AttemptOnQuestion` is `action='attempt', subject_kind='question'`.
- `ReviewOnQuestion` is `action='review', subject_kind='question'`.
- `/api/review/due`, `/api/review/plan`, and `/api/review/submit` all join `material_fsrs_state`
  to `question`.
- `src/server/fsrs/state.ts` exposes `subject_kind: 'question'` at the TypeScript boundary even
  though the DB table is wider.
- `planReviewSession()` returns `PlanQueueItem.question_id`, not an activity ref.
- `weekly` analytics filter `review` and `attempt` events to `subject_kind='question'`.
- `CauseSchema` still uses the universal exam taxonomy.

One naming hazard:

- `learning_record.activity_kind` currently means capture/action verb such as `attempt`, `review`,
  `read`, `ask`, `annotate`, `conversation`, or `plan`.
- That is not the same concept as future top-level `LearningActivity.kind`.

So the future interface should not simply reuse `learning_record.activity_kind` as the new universal
activity kind. It should introduce a separate concept, for example `ActivityRef.kind` or
`learning_activity_kind`, and later rename or clarify the existing record field as a capture verb.

## 2. Why I Do Not Prefer A Pure Dual Loop

The dual-loop model is attractive because it protects the existing question pipeline. That matters.
The current review path is working and should not be rewritten as an architecture exercise.

But as a long-term model, two independent loops create the wrong pressure:

1. The question loop remains the "real" loop, and records become a second-class adjacent system.
2. Cross-activity scheduling becomes an integration problem between schedulers.
3. Cross-activity analytics becomes a reconciliation problem between event vocabularies.
4. Retraction/correction has to be implemented twice or normalized later.
5. AI has to bridge loops explicitly, which makes orchestration depend on agent behavior rather
   than deterministic projections.
6. Future non-question features would repeat the pattern: project loop, practice loop, reading loop,
   conversation loop.

The result is easy to start and expensive to finish. It is the same failure mode we are trying to
avoid with "B interfaces": every new activity gets a narrow local interface, and later we retrofit
a general one after data and APIs already depend on the split.

The dual-loop model is useful as an implementation tactic, not as the architecture.

## 3. Why I Prefer Unified Activity

A unified Activity model better matches the product's real invariant:

> The user does learning actions; the system records evidence, estimates progress, schedules useful
> next contact, and proposes changes to the knowledge graph.

Questions are one high-value activity kind. They should not be the only primitive.

This also fits the current event architecture. The repo already uses:

- event as the action log;
- `caused_by_event_id` as provenance chain;
- proposal + rate events as AI/user decision records;
- `material_fsrs_state` as a projection keyed by material kind/id.

The missing step is not "invent a new world." It is to stop exposing question-only function
signatures in new interfaces.

### Important Definition

"Unified Activity loop" should mean a shared contract, not identical behavior.

Shared contract:

```ts
type ActivityKind =
  | 'question'
  | 'question_part'
  | 'record'
  | 'recall_prompt'
  | 'practice_log'
  | 'project_milestone'
  | 'open_inquiry';

interface ActivityRef {
  kind: ActivityKind;
  id: string;
}
```

Shared queue item:

```ts
interface ActivityQueueItem {
  activity_ref: ActivityRef;
  subject_id: string;
  knowledge_ids: string[];
  due_at: Date | null;
  priority: number;
  rationale: string;
  policy_id: string;
}
```

Shared judge result:

```ts
interface JudgeResult {
  score: number; // 0-1, required
  coarse_outcome: 'success' | 'partial' | 'failure' | 'unsupported';
  confidence: number;
  route: string;
  attribution?: ProfileAttribution;
  evidence_refs: Array<{ kind: string; id: string }>;
}
```

`event.outcome` can remain coarse for now. The continuous `score` belongs in the typed payload of
new judge/review events until there is a reason to change the DB column.

Per-kind behavior:

| Activity kind | Assessment | Scheduling | Notes |
|---------------|------------|------------|-------|
| `question` | attempt + judge | FSRS | current loop |
| `question_part` | attempt + judge | FSRS on part | needed for passages / multi-step problems |
| `record` | no direct judge by default | no direct FSRS initially | evidence for proposals / memory |
| `recall_prompt` | generated answer/check | FSRS or simple interval | derived from records |
| `practice_log` | human/rubric score | practice cadence | music/sports/writing |
| `project_milestone` | rubric/progress score | milestone review cadence | projects |
| `open_inquiry` | answer quality / follow-up status | optional | exploratory learning |

This gives us one activity language while keeping behavior specific.

## 4. Scheduler Position: Unified Queue, Multiple Policies

I would not make FSRS the universal scheduler.

FSRS is excellent for memory-like recall. It is a bad universal abstraction for:

- project milestones;
- long-form reading notes;
- open inquiries;
- instrument practice;
- subjective skill improvement.

The right abstraction is:

```ts
interface SchedulingPolicy {
  id: string;
  activity_kinds: ActivityKind[];
  computeNext(input: SchedulingInput): SchedulingDecision;
}
```

Initial policies:

- `fsrs_question`: current question review behavior.
- `none_evidence_only`: records feed AI/proposals but do not appear in the review queue.
- future `record_recall`: schedule generated recall prompts derived from records.
- future `practice_cadence`: schedule human-rated practice sessions.
- future `milestone_review`: schedule periodic project review.

Then the user-facing orchestrator can still produce one queue:

```ts
GET /api/review/plan
=> { queue: ActivityQueueItem[] }
```

But in the first implementation it returns only `question` items. That is C tempo. The response
shape is already B interface.

## 5. Pressure Test Against The 10 Scenarios

| Scenario | Unified Activity fit | Dual-loop concern |
|----------|----------------------|-------------------|
| Wenyan short answer | `question` + FSRS + LLM rubric | question loop works |
| Math proof/computation | `question` / `question_part` + route-specific judge | question loop works after judge hardening |
| Physics figures | `question_part` with shared parent material | dual loop irrelevant |
| English passage | `question_part` is the key | dual loop does not solve part identity |
| Chemistry balancing | `question` + symbolic/unit routes | question loop works after judge hardening |
| Programming | `question` or `project_milestone` depending task | dual loop likely creates code-specific third loop |
| Instrument practice | `practice_log` + human/rubric score | record loop is closer, but not enough |
| Reading notes | `record` evidence -> `recall_prompt` | dual record scheduler risks scheduling raw notes |
| React framework skill | mix of `question`, `record`, `project_milestone` | cross-loop coordination becomes central |
| CPA/CFA multi-subject | unified queue can quota across kinds/subjects | dual queues need arbitration |

The scenarios say the same thing: assessment and scheduling must be policy-specific, but the
orchestrator should not be split by historical table shape.

## 6. Concrete Recommendation For Q1

### Target Architecture

Use unified Activity as the target architecture.

Core rule:

> Anything that can be planned, reviewed, judged, corrected, rendered, or used as proposal evidence
> should have an `ActivityRef` or be convertible to one.

That does not mean every record is scheduled. It means every schedulable or assessable thing has a
stable ref in the same namespace.

### Near-Term Implementation Shape

Do not refactor the current review loop wholesale.

Instead:

1. Introduce core type docs / TypeScript types for `ActivityRef`, `ActivityKind`,
   `ActivityQueueItem`, and `JudgeResult(score)`.
2. Change new orchestration interfaces to return/take `activity_ref`, while preserving
   `question_id` compatibility fields during migration.
3. Keep `/api/review/submit` question-only for now, but route internally through a question adapter:
   `submitQuestionReview(activity_ref={kind:'question', id})`.
4. Keep `material_fsrs_state` writer behavior question-only initially, but widen TypeScript helper
   types only when `question_part` lands.
5. Make records feed proposal/memory context before scheduling records.
6. Add record-derived `recall_prompt` only after we have a real reading-note workflow.

This is the narrowest path that avoids future API regret.

## 7. How This Changes The Next Implementation Plan

The next implementation should not be "build generalized activity scheduling."

It should be:

### Step 1: Interface Foundation

- Add `ActivityRef` / `ActivityKind` core schema.
- Add `JudgeResult` with required `score: number`.
- Add `SubjectProfile.renderConfig`.
- Add `SubjectProfile.attributionProfile` as fully profile-driven taxonomy.
- Add explicit cross-subject attribution mapping as data/config, not as a hidden base enum.

Acceptance test:

- question-only runtime still works;
- new types do not expose `question_id` as the only path in new modules;
- math judge fixture can return `score`, even if score is 0 or 1 for now.

### Step 2: Review Orchestrator Adapter

- Add `ActivityQueueItem`.
- Make `planReviewSession()` internally build activity queue items.
- Preserve old `question_id` in response for UI compatibility.
- No record scheduling yet.

Acceptance test:

- `/api/review/plan` output still works for current frontend;
- queue item includes `{ activity_ref: { kind: 'question', id } }`;
- weekly/review analytics can still filter question events.

### Step 3: Question Part

- Add `question_part`.
- Add `ActivityRef.kind='question_part'`.
- Schedule and judge parts as answerable leaves.

Acceptance test:

- English passage fixture has one parent question and two answerable parts;
- each part has independent `knowledge_ids`;
- FSRS attaches to the part, not the parent.

### Step 4: Record Evidence, Not Record Scheduler

- Make records visible to KnowledgePropose / LearningIntent / MemoryBrief.
- Keep records out of the due queue.
- When useful, generate explicit `recall_prompt` activities from records.

Acceptance test:

- a reading note can improve a proposal or learning intent;
- the system does not pretend the raw note itself is a failed question.

## 8. Q2: Multi-Part Modeling

I still recommend `question_part`, not `question.parent_question_id`.

Reason:

- parent question stores shared stem/passage/figures/provenance;
- `question_part` stores answerable leaves;
- leaves can have their own knowledge ids, judge overrides, rubrics, and FSRS state;
- it maps cleanly from existing `StructuredQuestion(role='stem'|'sub')`.

This fits the unified Activity answer: `question_part` is an activity kind, while the parent
`question` may be a container.

## 9. Q3: Retraction Pattern

Current `RateEvent(rating='rollback')` is not enough for general retraction.

`rate` means "user decision about an event/proposal." It does not define the projection semantics
for "this prior event was wrong and should no longer count."

I recommend a first-class correction event:

```ts
interface CorrectEventPayload {
  correction_kind: 'supersede' | 'retract' | 'mark_wrong' | 'restore';
  replacement_event_id?: string;
  reason_md: string;
  affected_refs: Array<{ kind: string; id: string }>;
}
```

Use cases:

- wrong judge result;
- bad generated variant;
- wrong note section;
- bad import;
- stale proposal accepted by mistake.

Projection rule:

- append-only event log remains immutable;
- projections consult correction events to decide active truth/effect;
- rate events remain user feedback/decision records, not semantic undo.

This matters more in a unified Activity model because corrections will cross activity kinds.

## 10. Final Position

The best answer is not "dual loops now, maybe unify later." That creates exactly the retrofit risk
the human directive is warning about.

The best answer is:

> Unified Activity architecture, specialized policies, question-only adapter implementation first.

That lets the product keep moving without turning today's question loop into a giant abstraction,
while ensuring new interfaces do not lock us into questions, binary outcomes, or wenyan-style
attribution.
