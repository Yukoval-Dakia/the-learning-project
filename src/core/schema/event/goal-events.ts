import { z } from 'zod';

// ====================================================================
// Goal action events — YUK-471 Wave 2 (goal fold)
// ====================================================================
//
// goal is a WEAK event-sourced entity (design §0): its proposal/accept/retract chain is
// event-logged (experimental:proposal → rate(accept) → correct(retract)), but its
// `updateGoalStatus` / `updateGoalScope` helpers (server/goals/queries.ts) are BARE imperative
// UPDATEs with NO corresponding event — so a status/scope change is invisible to the fold.
// W2 closes that gap with two dedicated typed action events so a status/scope change is
// fold-visible. They are reserved experimental actions (see RESERVED_EXPERIMENTAL_ACTIONS in
// ./experimental.ts) so a malformed payload is rejected at the parseEvent barrier instead of
// falling through to the loose generic ExperimentalEvent.
//
// DEFER-FLIP-NOT-BUILD (per the goal A1 decision): `updateGoalStatus`/`updateGoalScope` have
// no live caller TODAY. W2 wires the helpers to write these events + a guarded write-through
// so the moment a caller appears the path is already fold-complete (the event log + reducer
// already model the transition). Defining the event contract now is the build half; the only
// thing deferred is who writes the ROW (the per-entity PROJECTION_IS_WRITER_GOAL flag).
//
// Dedicated FILE (not known.ts) to minimise merge conflict with the in-flight retract lane
// (PR #592) which is touching known.ts's RateEvent enum.

// ── experimental:goal_status_update ──────────────────────────────────────────
//
// A qualitative status transition (active | dormant | done — ND-4, never a progress %).
// Mirrors updateGoalStatus: the imperative path bumps `version` (+1) and stamps `updated_at`.
// The reducer applies status→payload.status, version+1, updated_at=event.created_at.
export const GoalStatusUpdateExperimental = z.object({
  actor_kind: z.enum(['user', 'agent', 'system']),
  actor_ref: z.string().min(1),
  action: z.literal('experimental:goal_status_update'),
  subject_kind: z.literal('goal'),
  subject_id: z.string().min(1), // = goal.id
  outcome: z.literal('success').nullable().optional(),
  payload: z.object({
    status: z.enum(['active', 'dormant', 'done']),
  }),
  caused_by_event_id: z.string().optional(),
  task_run_id: z.string().optional(),
  cost_micro_usd: z.number().int().optional(),
});
export type GoalStatusUpdateExperimentalT = z.infer<typeof GoalStatusUpdateExperimental>;

// ── experimental:goal_scope_update ───────────────────────────────────────────
//
// A re-scope (title / scope_knowledge_ids / sequence_hint). Mirrors updateGoalScope: the
// imperative path applies only the provided fields, bumps `version` (+1) and stamps
// `updated_at`. `source` / `subject_id` are set-once provenance and intentionally NOT mutable
// here. Each patch field is OPTIONAL (the helper applies only what's present); the reducer
// applies the provided fields, version+1, updated_at=event.created_at. `.strict()` on the
// payload so an unknown patch key (e.g. a typo'd `subject_id`) fails loudly at the barrier
// rather than silently dropping.
export const GoalScopeUpdateExperimental = z.object({
  actor_kind: z.enum(['user', 'agent', 'system']),
  actor_ref: z.string().min(1),
  action: z.literal('experimental:goal_scope_update'),
  subject_kind: z.literal('goal'),
  subject_id: z.string().min(1), // = goal.id
  outcome: z.literal('success').nullable().optional(),
  payload: z
    .object({
      title: z.string().optional(),
      scope_knowledge_ids: z.array(z.string()).optional(),
      sequence_hint: z.number().int().optional(),
    })
    .strict(),
  caused_by_event_id: z.string().optional(),
  task_run_id: z.string().optional(),
  cost_micro_usd: z.number().int().optional(),
});
export type GoalScopeUpdateExperimentalT = z.infer<typeof GoalScopeUpdateExperimental>;
