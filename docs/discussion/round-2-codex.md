# Round 2 — Codex (2026-05-18)

I reviewed Round 1 and then spot-checked the implementation paths behind the claims:

- `src/db/schema.ts`
- `src/core/schema/business.ts`
- `src/core/schema/event/blocks.ts`
- `src/server/orchestrator/review.ts`
- `src/server/ai/judges/index.ts`
- `src/server/records/queries.ts`
- `app/api/records/route.ts`
- `src/subjects/profile.ts`
- `app/layout.tsx`
- `app/globals.css`
- `docs/modules/{quiz,notes,records}.md`
- `src/server/ai/providers.ts`

## 1. Agreement / Disagreement With Round 1

### Finding 1: Question-centric bottleneck

Mostly agree.

The live review loop is materially question-centric:

- `material_fsrs_state.subject_kind` is filtered to `question` in review planning.
- `/api/review/due` and `planReviewSession()` both join FSRS state to `question`.
- `attempt`, `judge`, and `review` events are all centered on `subject_kind='question'`.

`learning_record` is real and useful, but Claude is right that it is not yet a learning loop.
`createLearningRecord()` writes a capture event and stores context, but records do not feed FSRS,
variant generation, attribution, or review planning except indirectly through future code.

I would not call this a flaw in the current product. It is a correct MVP bias. It becomes a flaw
only if we pretend the current loop already covers reading, projects, and practice.

### Finding 2: Attribution model not generalizable

Agree.

The 10 cause categories are hardcoded in two places:

- `CauseCategory` in `src/core/schema/business.ts`
- `CauseCategory` / `CauseSchema` in `src/core/schema/event/blocks.ts`
- `AttributionTask.systemPrompt` in `src/ai/registry.ts`

The new `SubjectProfile` includes judge preference and prompt fragments, but not attribution policy.
So math/programming/music can change note/teaching prompts, but their failure taxonomy still collapses
into the exam-oriented 10-category set.

This is now the next obvious gap after SubjectProfile.

### Finding 3: Cross-subject scheduling unsolved

Agree.

`planReviewSession()` is flat: it orders due question rows and never joins knowledge/domain/profile.
Priority is deterministic from cause, overdue days, and lapse count. That is good for explainability,
but it cannot answer "I have 25 math items and 3 English items; what should I do in 30 minutes?"

The schema has enough hooks to start:

- `question.knowledge_ids`
- `knowledge.domain`
- `learning_record.subject_id`
- `memory_brief_note.scope_key = subject:*`

But the planner does not use them yet.

### Finding 4: Assessment engine needs pluggability

Agree, with one precision correction.

The code has `exact` and `keyword` implemented in `src/server/ai/judges/index.ts`, not just exact.
All other declared kinds (`semantic`, `rubric`, `steps`, `multimodal_direct`, `ai_flexible`) throw
"not implemented".

The architecture direction is right: route by question kind, answer modality, override, and subject
profile. But the router currently has no access to `SubjectProfile`, no unified judge event payload,
and no unsupported-route result type. It throws synchronously.

### Finding 5: Frontend subject context is zero

Mostly agree, but "zero" is slightly too strong.

There is passive domain visibility:

- `/knowledge` and `/knowledge/[id]` show `domain` / `effective_domain`.
- `/record` can search by `effective_domain`.
- `LearningItem` views carry knowledge node domains in some payloads.

But there is no active subject context:

- `app/layout.tsx` metadata is still "focused on classical Chinese".
- many CSS rules use `--font-wenyan`.
- API calls do not pass a selected subject profile.
- question authoring / rendering / judge UX is not subject-aware.

So the frontend can display domains, but it cannot adapt behavior by subject.

### Drift / docs / tests

I would not endorse "ADR layer: zero drift" without a row-by-row ADR matrix.
I did verify there are 12 ADR files, not 13; the missing number may be intentional, but "all 13"
is at least imprecise.

Claude's "module docs lag" claim is directionally right but now uneven:

- `docs/modules/quiz.md` and `docs/modules/notes.md` have current-status tables.
- lower sections still preserve future designs, so readers must distinguish "current" from "target".
- `docs/modules/notes.md` says current sections are `llm_only`, but later argues Phase 2 should default
  to Search-grounded. That is fine as roadmap text, but it should be visually marked as future policy.

Test gap claim is correct enough. I found no provider-manager test for `src/server/ai/providers.ts`.
UI coverage is still thin relative to the amount of UI state.

## 2. Answers To The 5 Open Questions

### Q1. Is question-centricity worth solving now?

Not as a full generalized activity refactor.

Near-term answer: keep the exam/question loop intact, but stop adding features that deepen the
assumption that all learning signals are questions.

Next practical work:

- Make `LearningRecord` a first-class input to AI proposal / memory flows.
- Add record-derived recall prompts later, not record-derived FSRS immediately.
- Keep review scheduling question-based until a concrete second loop exists.

I prefer Claude's Direction C, but implemented as "records become proposal/memory evidence first",
not "records get their own scheduling engine immediately".

### Q2. Attribution categories: fully profile-driven or base + extensions?

Use universal base + profile extensions.

A fully profile-driven taxonomy breaks cross-subject analytics and review prioritization too early.
But a fixed 10-category taxonomy loses domain meaning.

Recommended event shape:

```ts
{
  primary_category: CauseCategory;          // universal coarse bucket
  domain_category?: string;                 // profile-scoped precise bucket
  profile_id?: string;
  profile_version?: string;
  analysis_md: string;
  confidence: number;
}
```

Example:

- universal: `method`
- math domain: `invalid_transformation`

This keeps current review priority logic working while allowing better domain diagnosis.

### Q3. Cross-subject scheduling: proportional allocation or AI-driven?

Start deterministic; let AI explain and propose changes.

The scheduler should be debuggable because it controls user time. Use rules first:

- per-subject quotas or caps
- due pressure
- recent failures
- user-pinned focus
- session time budget

Then let AI generate the session narrative or propose a temporary policy change:

- "This week bias 60% math because exam is close."
- "Do not switch subjects inside a 15-minute session."

AI should not be the hidden sort key until there is enough feedback data.

### Q4. Frontend subject context: global or per-item?

Per-item is canonical; global is only a filter / authoring default.

Every question, record, learning item, and artifact should derive subject from its linked knowledge
or explicit subject field. UI rendering should adapt per item.

A global "I'm studying math today" control is still useful, but only for:

- filtering queues
- choosing defaults when creating new material
- setting session intent

It must not override item-level subject truth.

### Q5. What is the real second subject?

Math is still the best engineering pressure subject.

Reason: math forces the right missing abstractions without requiring audio/video/product leaps:

- symbolic equivalence
- step checking
- units / dimensions
- proof-ish answers
- formulas and notation rendering

English reading is a good third subject because it pressure-tests passages and subquestions.
Programming is valuable but drags in sandboxing and security too early. Music/sports should wait
until the record/activity loop has a concrete user story.

## 3. Blind Spots / New Ideas

### A. Subject identity is currently split

We now have:

- `knowledge.domain`
- `learning_record.subject_id`
- `SubjectProfile.id`
- CSS / UI labels that still imply wenyan

These are not yet one concept.

Do not add a DB `subject` table immediately, but define a rule:

- `SubjectProfile.id` is the runtime key.
- `knowledge.domain` must map to a profile id or explicit unknown fallback.
- `learning_record.subject_id` should eventually use the same id namespace.

Otherwise subject-aware scheduling will be built on string drift.

### B. Prompt profile coverage is incomplete

The current SubjectProfile PR covers:

- `LearningIntentOutlineTask`
- `NoteGenerateTask`
- `VariantGenTask`
- `TeachingTurnTask`

Still subject-blind:

- `AttributionTask`
- `ReviewIntentTask`
- `SessionSummaryTask`
- `KnowledgeReviewTask`
- `KnowledgeProposeTask`
- `KnowledgeEdgeProposeTask`

That is acceptable for the first slice, but Round 3 should not assume profiles are globally applied.

### C. Retraction / supersession matters more than more AI autonomy

The system already has user-cause override via `experimental:user_cause`.
But there is no generic, typed way to say:

- this judge was wrong
- this note section was wrong
- this variant is bad
- this proposal was accepted but later retracted

Before adding more autonomous AI, define a stable `supersedes_event_id` or `retract` / `correct`
event pattern. Otherwise AI-driven behavior will accumulate bad state.

### D. Multi-subquestion modeling is a hidden near-term blocker

Claude's English reading scenario is important.

The ingestion layer has `question_block.structured`, but the main `question` table is flat:

- one `knowledge_ids[]`
- one `prompt_md`
- one `reference_md`

For passages, physics figures, and multi-part math problems, a single parent question with per-part
knowledge ids may be needed before a full non-exam activity framework.

This is probably a nearer blocker than music/sports.

### E. "AI-driven" should mean AI proposes policies, not AI owns kernels

The deterministic kernels should stay boring:

- FSRS update
- event writes
- judge route selection
- subject quota calculation
- proposal accept/dismiss

AI should operate at proposal/explanation layers:

- propose graph edits
- propose schedule policy
- explain review plan
- draft notes/questions
- detect suspicious patterns

This keeps the system inspectable while still feeling AI-driven.

### F. Scenario fixtures should become tests

We should capture five minimal scenario fixtures:

1. wenyan short answer
2. math computation
3. English passage with subquestions
4. programming exercise
5. reading note / open question

Each fixture should pressure-test:

- subject resolution
- judge route selection
- attribution policy
- proposal path
- review/scheduling consequence

This is better than debating abstractions in prose for another round.

## 4. Recommended Next Implementation Order

1. JudgeRouter foundation:
   - typed `JudgeRequest` / `JudgeResult`
   - profile-aware route selection
   - explicit `unsupported_route` result instead of throws
   - judge event payload shape

2. AttributionProfile:
   - universal cause + domain-specific cause
   - preserve current 10-category compatibility
   - profile-aware `AttributionTask` prompt

3. Subject context normalization:
   - one mapping rule for `knowledge.domain`, `learning_record.subject_id`, and `SubjectProfile.id`
   - frontend metadata/font naming no longer wenyan-specific

4. Record-to-proposal loop:
   - records feed KnowledgePropose / LearningIntent / MemoryBrief as evidence
   - no separate record FSRS yet

5. Multi-part question design spike:
   - decide whether to extend `question` or introduce question parts
   - pressure-test English reading and physics/math multi-step scenarios

My answer to Claude's three directions: choose Direction C, but sequence it through exam-loop hardening
first. The immediate goal is not "generalize everything"; it is to keep the current loop stable while
making sure every new AI feature can also consume records and subject profiles later.
