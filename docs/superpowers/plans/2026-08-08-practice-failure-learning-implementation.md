# Practice-owned Failure Learning — Phase 1 implementation plan

> **Authority**: owner 2026-08-08「认可。写实现计划，全速推进」。
> **Project**: Linear `Architecture Deepening FULL — 语义、成本与运行所有权`.
> **Base**: `origin/main@5815cdfcb050ded36379bf2c1628563ede854248`.
> **Governing decisions**: ADR-0051 and
> `docs/superpowers/plans/2026-08-02-architecture-full-phase-0-1.md` Phase 1.
> **Scope**: implementation + PR/CI evidence. This plan does not authorize production deployment.

## Outcome

Move the complete failure-learning product operation into `practice` while preserving the deployed
modular-monolith topology and the two stable pg-boss queue names. A normal attempt producer writes one
canonical event and knows nothing about queues, model task kinds, prompts, knowledge-tree loading, proposal
storage, or retry policy. The durable event subscription starts the workflow. Jobs and DomainTools become
thin adapters to one capability-owned module.

This phase succeeds only when the old knowledge/central implementations and all producer-side raw sends
are deleted, the exact causal chain is preserved, prompt/provider behavior is characterized, and the
dependency ratchet is tightened. A wrapper around the old code is not delivery.

## Design-it-twice decision

Three independent designs were compared before implementation:

| Design | Strength | Rejected part |
|---|---|---|
| Minimal command-first module | Small caller contract; preserves explicit tool effects | A generic `execute(kind, unknown)` or command bus would hide useful type distinctions without adding leverage |
| Durable event/workflow-first module | Removes producer coupling and closes the post-commit enqueue-loss path | New workflow DSL/events/processes are unnecessary; existing event subscriptions and pg-boss are sufficient |
| Pure decision engine | Makes eligibility, cause priority, depth/cap and causal intent deterministic | Its broad fact algebra is internal implementation detail, not a package-public or network interface |

The selected design combines the useful parts:

```ts
export function requestFailureLearning(
  deps: FailureLearningRequestDeps,
  input: { attemptEventId: string },
): Promise<FailureLearningRequestResult>;

export interface FailureLearning {
  attribute(input: { attemptEventId: string }): Promise<AttributionResult>;
  proposeVariant(input: { attemptEventId: string }): Promise<VariantProposalResult>;
}
```

- `request` performs only eligibility validation and a transactional, deterministic enqueue. It never runs
  an LLM and returns idempotent `accepted | ignored`; a replay returns the same stable job identity.
- `attribute` preserves the existing `attribute_mistake` synchronous effect: attribution only, no implicit
  variant.
- `proposeVariant` preserves `propose_variant` and `author_question(seed_mode='variant')`: proposal only.
- The `attribution_followup` job uses the private automatic composition: attribute (or reuse an existing
  real judge), then enqueue the stable `variant_gen` identity. If that handoff fails, the job fails and a
  redelivery observes the judge before retrying only the handoff.
- Construction binds DB, typed model adapter, bounded knowledge reader, pg-boss sender, IDs/clock, and
  optional request cancellation/deadline. Callers never pass task-kind strings, Drizzle transactions, or
  pg-boss payloads.

The implementation may expose named functions instead of an allocated object where that better matches
current TypeScript composition, but those three typed intentions and result contracts are the interface.

## Module depth and dependency classification

The deep module hides:

- active/effective attempt and cause reads;
- paper-placeholder judge semantics and feedback-field inheritance;
- reasoning-trace omission rules and frozen question evidence fallback;
- bounded knowledge context and SubjectProfile selection;
- retrieve/rerank attribution and variant TaskSpecs;
- model attempt execution, parsing, cost/run provenance and error classification;
- judge/proposal/mistake-variant transactions, causal IDs and idempotency;
- stable queues, deterministic job identity, retry/DLQ policy and adapter result mapping.

Dependency treatment:

| Dependency | Classification | Treatment |
|---|---|---|
| Eligibility, cause priority, candidate retrieval, parse and decision rules | in-process | private pure functions in `practice`; no port |
| Postgres/Drizzle | local-substitutable | real DB + test DB; no repository-per-table layer |
| Knowledge context | cross-capability owned read | one bounded `knowledge/public.ts` query and an in-memory test adapter |
| Central AI runtime | owned runtime | typed `FailureLearningModels`; production adapter projects capability TaskSpecs to `runTask` |
| pg-boss | durable mechanism | private enqueue adapter using stable queue names and Drizzle transaction bridge |
| Model provider | true external system | remains behind the central AI runtime; no second provider abstraction |

The pure decision seam remains private. It can consume normalized facts and return domain-specific stop,
attribute, reuse, or propose decisions, but it must not become a general `Effect[]` interpreter or workflow
language.

## Locked behavior and invariants

### Eligibility

- The automatic lane accepts only an effective-active event with `action='attempt'`,
  `subject_kind='question'`, `outcome='failure'`, and no `payload.unsupported_judge=true`.
- Missing, corrected/inactive, non-failure, unsupported-judge, and missing-question inputs make zero model
  calls.
- The old producers skipped automatic attribution when they wrote an active user cause. The subscription
  must preserve that behavior and ignore such attempts. Explicit tools retain their current semantics.
- A live attempt uses its frozen question evidence when present; historical rows may fall back to the
  current question row. Old learner answers must not silently pair with a mutated question snapshot.

### Attribution

- Knowledge context reads only requested active IDs, returns at most that bounded set in input order, and
  derives the profile from the first valid referenced node rather than SQL/full-tree order.
- The production task remains `AttributionRerankTask`; `AttributionTask` remains the frozen oracle until a
  later explicit deletion decision.
- No reasoning trace means the serialized task input and prompt remain byte-identical to current behavior.
- `attribution_pending=true` is a placeholder, not a completed attribution. The replacement judge inherits
  `visible_to_user`, `coarse_outcome`, and `score`, but never inherits the pending marker.
- A real active judge prevents another model call. The automatic lane still repairs/ensures the variant
  handoff after finding it.
- A written judge has `caused_by_event_id = attemptEventId` and retains task-run/cost provenance.

### Variant proposal

- Effective cause remains user-first, then latest active real judge. The proposal's
  `caused_by_event_id` points to that exact cause event; the automatic AI chain therefore points to the
  attribution judge instead of creating a new root.
- `mistake_variant` sources, parent depth >= 1, non-targetable causes, three draft/active in-flight rows,
  and an existing same-parent/same-attempt proposal stop before a model call.
- `VariantGenTask` prompt/provider/budget and proposal approval remain unchanged.
- Proposal, mistake-variant create event, materialized-ID anchor and draft row/projector commit in one
  transaction. The proposal remains pending; this phase never auto-accepts or materializes a question.
- The mistake-variant create event continues to point to the proposal.

### Delivery and retries

- `practice.failure-learning-attempt@v1` handles only committed attempt events and performs no LLM work
  inside the event-subscription lease.
- Enqueue IDs are deterministic UUIDs derived from queue + attempt ID + contract version. A delivery replay
  either sees the durable job/effect or enqueues the same identity.
- The subscription's eligibility read, effect reservation, and `attribution_followup` send share one DB
  transaction through pg-boss's Drizzle transaction adapter.
- Attribution and `variant_gen` handoff are a resumable two-step durable job, not one long transaction held
  over an LLM call. A send failure is rethrown; redelivery reuses the existing judge and completes the
  stable handoff without another model call.
- Retryable provider/admission/DB/commit/handoff failures return or throw an explicit retryable outcome;
  the job rethrows for pg-boss retry/DLQ. Business skips are normal results.
- A successful model attempt with invalid product output is permanent: persist the current failure/cost
  evidence, acknowledge the job, and do not buy the same deterministic parse failure again.
- Malformed job payload is a permanent adapter error and never triggers a model call.

### Exactly-once claim boundary

Ordered redelivery is at-most-once after the durable judge/proposal/job marker exists and does not increase
model calls. Full product/provider exactly-once is not claimed: a process can die after provider success
but before the local result commits, and concurrent explicit/job callers can cross a pre-call read. This
phase does not create a generic operation table. If real evidence later requires single-flight model calls,
add a narrow capability-owned stage claim/checkpoint rather than a platform framework.

## Target file map

| File | Responsibility |
|---|---|
| `src/capabilities/practice/server/failure-learning.ts` | Typed product operation, orchestration and outcomes |
| `src/capabilities/practice/server/failure-learning-decision.ts` | Private deterministic eligibility/decision rules if extraction improves clarity |
| `src/capabilities/practice/server/failure-learning-subscription.ts` | Attempt-event eligibility + transactional request enqueue |
| `src/capabilities/practice/tasks/attribution.ts` | Attribution input/output, parser, prompt and TaskSpec |
| `src/capabilities/practice/tasks/attribute-retrieve.ts` | Deterministic L1 cause candidate retrieval |
| `src/capabilities/practice/tasks/variant-gen.ts` | Variant input/output, parser, prompt and TaskSpec |
| `src/capabilities/practice/jobs/attribution_followup.ts` | Stable legacy payload adapter + reliable variant handoff |
| `src/capabilities/practice/jobs/variant_gen.ts` | Stable legacy payload adapter |
| `src/capabilities/practice/tools/attribute-mistake.ts` | Existing DomainTool schema/effect mapped to `attribute` |
| `src/capabilities/practice/tools/propose-variant.ts` | Existing DomainTool schema/effect mapped to `proposeVariant` |
| `src/capabilities/practice/manifest.ts` | Own both jobs, both tools, `attempt` action and subscription |
| `src/capabilities/practice/public.ts` | Narrow server contract needed by central `author_question` only |
| `src/capabilities/knowledge/server/failure-learning-context.ts` | Bounded knowledge query implementation |
| `src/capabilities/knowledge/public.ts` | Export only the bounded query/type |
| `src/ai/registry.ts` | Static projection of capability-owned specs; no duplicate prompt/TaskDef truth |
| `src/server/ai/tools/proposal-tools.ts` | Retain unrelated tools; delegate author-question variant mode through practice public surface |
| `src/server/proposals/producers.ts` | Preserve the exact effective-cause causal ID on variant proposal writes |

Tests live beside the new owned modules. Existing characterization may move, but it must not be copied into
a second legacy suite.

## Required deletions

The final Phase 1 diff removes:

- `src/capabilities/knowledge/jobs/attribution_followup.ts` and its DB test;
- failure-learning attribution/retrieve implementation and tests from `knowledge/server` after movement;
- the attribution job declaration from `knowledge/manifest.ts`;
- `src/server/boss/handlers/variant_gen.ts`, its old test, import, queue creation and registrar wiring;
- concrete `attribute_mistake` and `propose_variant` implementations from
  `src/server/ai/tools/proposal-tools.ts`;
- every direct `runVariantGen` import outside `practice`, including author-question variant mode;
- raw `boss.send('attribution_followup')` in solve-submit, ingestion import/mistakes, auto-enroll and the
  lost-attribution script;
- obsolete producer injection seams and assertions that only prove a raw enqueue occurred;
- duplicate registry-owned attribution/variant prompt and task-definition truth after static projection;
- compatibility wrappers that leave either former owner active.

Stable job names and payload `{ attempt_event_id }` remain consumable so already queued work can drain into
the new handlers.

## Implementation sequence and commit gates

### P1/1 — Contract, TaskSpecs and bounded knowledge read

1. Add characterization for current prompt hashes, placeholder inheritance, user-cause precedence,
   unsupported judge, reasoning-trace omission, variant cap/cooldown and exact causal IDs.
2. Add typed attribution/variant specs under `practice/tasks`; move deterministic retrieval and parsers.
3. Project those definitions into the central registry without changing provider/model/budget/prompt bytes.
4. Add the bounded knowledge query and remove whole-tree filtering from the new path.
5. Add the public command/result vocabulary and private error classification.

Commit gate: task/prompt fixtures pass; no production caller moved yet; no new dependency baseline growth.

### P1/2 — Durable operation, subscriptions and jobs

1. Implement attribution and variant operations behind the locked interface.
2. Add stable deterministic queue identity helpers and transactional sends via
   `fromPgBossDrizzleTx`.
3. Move both legacy-compatible job handlers into `practice` and transfer manifest ownership.
4. Add `practice.failure-learning-attempt@v1`; test success, replay, user-cause, unsupported-judge,
   corrected-attempt and rollback cases.
5. Delete the four direct producer sends and the auto-enroll enqueue seam; producers only commit facts.
6. Move the lost-attribution census/backfill to the practice-owned request adapter without raw queue access.

Commit gate: a new committed failure is durably requested once; transient attribution never fans out;
existing judge redelivery ensures the variant job; legacy payloads still run.

### P1/3 — Tool adapters, central deletion and ratchet tightening

1. Move `attribute_mistake` and `propose_variant` DomainTools into practice with identical names, schemas,
   effects, cancellation/deadline and parent task-run propagation.
2. Change `author_question(seed_mode='variant')` to the narrow practice operation rather than importing the
   implementation.
3. Delete old knowledge/central files, implementations, registrars, duplicate prompt/schema truth and old
   shallow tests.
4. Pass exact cause event ID to `writeVariantQuestionProposal` and assert the full causal chain.
5. Run the architecture snapshot, verify every relevant bucket decreased, and tighten the committed
   baseline in the same diff. Baseline growth is forbidden.
6. Update ADR/architecture/PLAN/current-memory status with exact delivered/open boundaries.

Commit gate: deletion grep clean; dependency audit clean/tighter; no old owner or raw send remains.

## Test matrix

### Pure/unit

- every eligibility stop reason before a model call;
- attribution candidate ordering/profile and output parsing;
- variant targetability/depth/cap/cooldown decisions;
- permanent versus retryable classification;
- deterministic job/effect IDs;
- task definition and prompt byte/hash equality.

### DB/integration

- happy path creates at most one judge, one pending proposal and one draft variant;
- non-failure, missing, inactive/corrected, unsupported-judge and user-cause automatic attempts call zero
  models;
- placeholder replacement inherits visibility/verdict fields;
- real judge replay calls zero attribution models but ensures one variant handoff;
- attribution transient error writes no proposal and retries;
- attribution invalid output is permanent and redelivery does not re-spend;
- variant invalid output is permanent;
- proposal cause points to the effective judge/user-cause event;
- transaction failure rolls back judge+handoff or proposal+draft as one unit;
- duplicate/concurrent subscription delivery produces one durable effect/job;
- ordered job redelivery does not duplicate judge/proposal/draft or increase model-call upper bound after a
  durable terminal marker;
- old `{ attempt_event_id }` jobs are accepted by new handlers;
- proposal remains pending and accept/materialize semantics are unchanged.

### Adapter compatibility

- `attribute_mistake`, `propose_variant` and author-question variant input/output schemas and effects remain
  unchanged;
- signal/deadline/parent task-run context reaches the central runner;
- manifest composition loads both new tools/jobs/subscription;
- no event-subscription handler performs an LLM call.

## Verification commands

Do not run the repository-wide local `pnpm test`. Author verification is scoped; the complete gate belongs
to exact-head GitHub CI.

```bash
pnpm vitest run --config vitest.unit.config.ts \
  src/capabilities/practice/tasks/*.test.ts \
  src/capabilities/practice/server/failure-learning*.unit.test.ts \
  src/capabilities/practice/manifest.unit.test.ts \
  src/ai/registry.test.ts src/ai/task-prompts.test.ts

pnpm vitest run --config vitest.db.config.ts \
  src/capabilities/practice/server/failure-learning*.db.test.ts \
  src/capabilities/practice/jobs/*.db.test.ts \
  src/capabilities/practice/tools/*.db.test.ts

pnpm audit:capability-boundaries
pnpm audit:capability-boundaries -- --json
pnpm typecheck
pnpm lint
pnpm build
```

Before commit/PR:

```bash
rg -n "boss\.send\(['\"](attribution_followup|variant_gen)|runVariantGen|knowledge/server/attribute|knowledge/jobs/attribution_followup|server/boss/handlers/variant_gen" src scripts
test ! -e src/capabilities/knowledge/jobs/attribution_followup.ts
test ! -e src/server/boss/handlers/variant_gen.ts
git diff --check
```

An independent reviewer checks architecture and behavior separately from the author. Only unresolved P0/P1
or an exact-head CI failure blocks merge; P2/minor/nit remains advisory under the established review budget.

## Rollout boundary

This implementation stops at a merge-ready PR. A later explicitly authorized deployment must be
worker-first because a new subscriber bootstraps pre-existing events as skipped:

1. deploy/register the new worker jobs and subscription;
2. verify subscriber checkpoint/dispatch health;
3. then deploy the app image that no longer emits raw jobs;
4. census active failures for the transition window and request any missing work through the practice
   adapter;
5. verify attempt → judge → proposal causality and queue/DLQ health before declaring rollout complete.

No deployment, queue drain, write pause, or production backfill is part of this PR without separate owner
authorization.

## Exit report wording

Allowed after merge + exact-head CI:

> Phase 1 code ownership is closed for the Failure Learning vertical: practice owns the operation,
> TaskSpecs, jobs, subscription and tools; old central/knowledge implementations and raw producer sends are
> deleted; the dependency ratchet tightened.

Not allowed without rollout/product evidence:

- “Failure Learning is deployed”;
- “provider calls are exactly-once”;
- “the AI Pipeline is decoupled” or “service extraction is complete”;
- “all product operations now have capability ownership”.
