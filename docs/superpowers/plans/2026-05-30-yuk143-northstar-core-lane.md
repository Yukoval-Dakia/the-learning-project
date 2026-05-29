# Lane plan — North-Star / Learning-Intent CORE (YUK-143, Wave-9)

> Branch `yuk-143-northstar-core` off main `91832bc1`. Spec authority:
> `docs/superpowers/specs/2026-05-29-north-star-learning-intent-design.md`
> (locked decisions ND-1..ND-5). This lane = W9 **core only**; all UI is W10.

## Scope (build)

1. `goal` table + drizzle migration (standalone, per spec §3 / §8 Q1).
2. `GoalScopeTask` AI task (ND-2) — infers `scope_knowledge_ids[]` + `sequence_hint`
   from goal title + knowledge-grid snapshot, routed through the EXISTING
   proposal mode via a new `goal_scope` proposal kind. Accept materializes the
   `goal` row (evidence-logged, reversible). Edit = accept after the UI mutates
   `proposed_change`; dismiss = generic rate event (W10 wires UI affordances).
3. Coach integration (ND-5 coexistence): extend `TodayPlan` so plan items carry
   `serves_goal_id` + `knowledge_ids`, add a plan-level `goal_ids`, feed active
   goals into the Coach input, and ADD one goal-oriented strand WITHOUT touching
   the FSRS-due / review backbone or other capture tasks.
4. ND-5 conservation test — proves the FSRS due-review queue / counts / due
   times are byte-identical with vs without active goals present.

## Deferred to Wave-10 (do NOT build here)

- `/today` goal card; standalone goals view; KG goal-lens highlight subgraph
  render; review soft-bias ranking; Dreaming goal-aware proposals. (Spec §6, §7.)
- No UI components, no `/api/goals` route surface beyond what materialization
  needs. The goal-create entry point + proposal-inbox `goal_scope` rendering are
  W10. Core only exposes server orchestrator + accept/dismiss dispatch + schema.

## Real shapes discovered (pre-flight)

- `AiProposalPayload` (`src/core/schema/proposal.ts`) is a `kind`-discriminated
  union; `writeAiProposal` (`src/server/proposals/writer.ts`) maps unknown kinds
  to `action='experimental:proposal'`, `subject_kind = target.subject_kind`.
- `listProposalInboxRows` (`src/server/proposals/inbox.ts`) `proposalWhere()`
  ALREADY matches `action='experimental:proposal'`; `deriveLegacyAiProposal`
  parses `experimental:proposal` payloads via `parseAiProposalPayload(payload)`.
  → a `goal_scope` proposal with `target.subject_kind='goal'` surfaces with
  ZERO inbox.ts changes. (Confirmed.)
- `acceptAiProposal` / `dismissAiProposal` (`src/server/proposals/actions.ts`)
  switch on `proposal.kind`; default dismiss writes a generic rate event. New
  `goal_scope` accept branch materializes the goal row + rate event in one tx.
- `runCoach` (`src/server/boss/handlers/coach_daily.ts`) ONLY writes proposals +
  a scan event. It never reads `/api/review/due` and never mutates
  `material_fsrs_state`. ND-5 conservation is therefore STRUCTURAL: the goal
  strand is purely additive to the `TodayPlan` payload.
- FSRS due queue (`app/api/review/due/route.ts`) reads `material_fsrs_state` +
  `event(action='attempt', outcome='failure')` only — independent of `goal`.
- `getTaskSystemPrompt` (`src/ai/task-prompts.ts`) is an exhaustive switch with
  `assertNever` — a new task kind MUST add a case (pass-through is fine).
- `loadTreeSnapshot` (`src/server/knowledge/tree.ts`) gives nodes + mastery;
  `knowledge_edge` rows give mesh edges. Mirrors `propose_edge.ts` input shape.

## Files — create vs modify

CREATE:
- `drizzle/0021_yuk143_goal.sql` (migration)
- `src/server/goals/queries.ts` (insertGoal / updateGoalStatus / listActiveGoals)
- `src/server/goals/scope.ts` (GoalScopeTask orchestrator: snapshot → run → write goal_scope proposal)
- `src/server/goals/scope.test.ts` (DB test — real testDb, DI runTaskFn; covers parser + proposal write + accept/dismiss/retract round-trip. NOT in fastTestInclude → runs in db config.)
- `src/server/goals/accept.ts` (acceptGoalScopeProposal materializer)
- `src/server/boss/handlers/coach_daily.northstar.test.ts` (ND-5 conservation — DB)
- `docs/adr/ADR-0025-north-star-goal-entity-and-coach-coexistence.md`

MODIFY:
- `src/db/schema.ts` (append `goal` pgTable)
- `src/core/schema/proposal.ts` (add `goal_scope` kind to union + change schema)
- `src/core/schema/coach.ts` (TodayPlan: add `goal_ids`, plan-item `serves_goal_id` + `knowledge_ids`)
- `src/ai/registry.ts` (append `GoalScopeTask` def)
- `src/ai/task-prompts.ts` (add `GoalScopeTask` switch case + builder)
- `src/server/boss/handlers/coach_daily.ts` (feed active goals into Coach input; objective mentions goal strand)
- `src/server/proposals/actions.ts` (accept/dismiss `goal_scope` dispatch)
- `scripts/audit-schema-allowlist.json` — NOT needed: `queries.ts` gives every
  goal business column both an INSERT (`insertGoal`) and an UPDATE
  (`updateGoalStatus` / `updateGoalScope`) write path, so all 7 columns audit as
  `live`. No stub, no allowlist entry.
- `tests/helpers/db.ts` (add `goal` to ALL_TABLES for hermetic resetDb)
- `app/(app)/today/page.tsx` (1-line: add `goal_scope` to the exhaustive
  KIND_TO_GROUP record so typecheck stays green — no UI behavior; goal card = W10)

## Build order

1. schema `goal` table → `pnpm db:generate` → rename/verify migration 0021.
2. `goal_scope` proposal kind (proposal.ts) + coach.ts TodayPlan extension.
3. registry + task-prompts GoalScopeTask.
4. goals/queries.ts + goals/scope.ts (+ unit test) + goals/accept.ts.
5. actions.ts accept/dismiss dispatch.
6. coach_daily.ts goal-strand input wiring.
7. ND-5 conservation test (DB).
8. audit-schema write-paths / allowlist; partition; profile.
9. Full gate.

## ND-5 conservation contract (the load-bearing invariant)

The goal strand only ADDS `TodayPlan.goal_ids` + per-item `serves_goal_id` /
`knowledge_ids` and biases which NEW content the Coach suggests. It MUST NOT:
suppress FSRS-due reviews, hide non-goal capture tasks, preempt daily quota, or
change due times. Test asserts the `/api/review/due` payload (ids, order, counts,
due_at, fsrs_state) is identical between a fixture with active goals and one
without — for the same FSRS state.

## Multi-goal strand distribution (spec §8 Q2, v0)

`listActiveGoals` returns active goals ordered by `sequence_hint` then
`created_at`. The Coach input carries all active goals (id, title,
scope_knowledge_ids, sequence_hint). v0 distribution = round-robin + weakest-scope
first, expressed as guidance in the Coach objective/prompt (the model picks); the
handler does not hard-partition effort. Tunable later. Documented as a decision.

## learning_session.goal_id stub decision (spec §8 Q1)

Keep `learning_session.goal_id` a STUB (NOT activated as an FK). Rationale: a goal
is a long-lived object spanning many sessions (spec §3); binding it to a single
session is the wrong cardinality. It stays nullable text with its existing
allowlist entry. Standalone `goal` table is the source of truth; optional session
association is a W10+ concern only if a concrete need appears (YAGNI / ADR-0009
"no abstraction until a second instance").
