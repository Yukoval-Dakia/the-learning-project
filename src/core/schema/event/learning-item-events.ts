import { z } from 'zod';

// Learning-item structural mutations are typed, subject-keyed events gathered by Q1.
// Creation uses one genesis snapshot. Complete/relearn and exact prior-state restore
// increment version; archive and attribution repair retain the historical no-bump policy.
// Status restoration carries the captured pre-accept state instead of synthesizing completion.
// Reserved action names prevent malformed payloads from falling through generic parsing.

// ── experimental:learning_item_complete ──────────────────────────────────────
//
// A completion transition: status→'done', completed_at=event.created_at, version+1. Mirrors
// acceptCompletionProposal's imperative UPDATE (proposal-appliers.ts:292-301). The reducer applies
// it ONLY when the row is pending|in_progress (the imperative writer's status precondition); a
// terminal/other-status row is a no-op (terminal-status guard, design §0 + the mistake_variant
// BLOCKER lesson).
export const LearningItemCompleteExperimental = z.object({
  actor_kind: z.enum(['user', 'agent', 'system']),
  actor_ref: z.string().min(1),
  action: z.literal('experimental:learning_item_complete'),
  subject_kind: z.literal('learning_item'),
  subject_id: z.string().min(1), // = learning_item.id
  outcome: z.literal('success').nullable().optional(),
  // No payload fields needed — completed_at is event.created_at (the reducer stamps it); status
  // is fixed ('done'). `.strict()` so a stray key fails loudly at the barrier.
  payload: z.object({}).strict(),
  caused_by_event_id: z.string().optional(),
  task_run_id: z.string().optional(),
  cost_micro_usd: z.number().int().optional(),
});
export type LearningItemCompleteExperimentalT = z.infer<typeof LearningItemCompleteExperimental>;

// ── experimental:learning_item_relearn ────────────────────────────────────────
//
// A relearn (reopen) transition: status→'in_progress', completed_at=null, version+1. Mirrors
// acceptRelearnProposal's imperative UPDATE (proposal-appliers.ts:376-385). The reducer applies it
// ONLY when the row is done|resting (the imperative writer's status precondition); other-status
// rows are a no-op. completed_at=null is a structural reset (the relearn-retract synthetic clock in
// §7.3 cannot restore the original complete time — the fold accepts null).
export const LearningItemRelearnExperimental = z.object({
  actor_kind: z.enum(['user', 'agent', 'system']),
  actor_ref: z.string().min(1),
  action: z.literal('experimental:learning_item_relearn'),
  subject_kind: z.literal('learning_item'),
  subject_id: z.string().min(1), // = learning_item.id
  outcome: z.literal('success').nullable().optional(),
  payload: z.object({}).strict(),
  caused_by_event_id: z.string().optional(),
  task_run_id: z.string().optional(),
  cost_micro_usd: z.number().int().optional(),
});
export type LearningItemRelearnExperimentalT = z.infer<typeof LearningItemRelearnExperimental>;

// ── experimental:learning_item_archive ────────────────────────────────────────
//
// An archive (tombstone) transition: archived_at=event.created_at, archived_reason=payload.reason,
// updated_at=event.created_at, NO version bump. Mirrors the actions.ts learning_item retract block
// (bare UPDATE archived_at + archived_reason + updated_at; WHERE archived_at IS NULL — already-
// archived rows stay put). The reducer applies it ONLY when archived_at IS NULL (the imperative
// writer's WHERE — terminal-status guard); an already-archived row is a no-op. `reason` is a
// payload field (the imperative path sets 'proposal_retracted') — `.strict()` payload so a stray
// key fails loudly.
export const LearningItemArchiveExperimental = z.object({
  actor_kind: z.enum(['user', 'agent', 'system']),
  actor_ref: z.string().min(1),
  action: z.literal('experimental:learning_item_archive'),
  subject_kind: z.literal('learning_item'),
  subject_id: z.string().min(1), // = learning_item.id
  outcome: z.literal('success').nullable().optional(),
  payload: z
    .object({
      // archived_reason (e.g. 'proposal_retracted'). `.min(1)` mirrors the sibling string fields
      // (actor_ref / subject_id) so a degenerate empty string can't fold into archived_reason=''.
      reason: z.string().min(1),
    })
    .strict(),
  caused_by_event_id: z.string().optional(),
  task_run_id: z.string().optional(),
  cost_micro_usd: z.number().int().optional(),
});
export type LearningItemArchiveExperimentalT = z.infer<typeof LearningItemArchiveExperimental>;

/** Practice-owned attribution repair. Unlike status changes, this preserves version and time. */
export const LearningItemKnowledgeIdsRewriteExperimental = z.object({
  actor_kind: z.literal('system'),
  actor_ref: z.literal('learning-item-attribution-repair'),
  action: z.literal('experimental:learning_item_knowledge_ids_rewrite'),
  subject_kind: z.literal('learning_item'),
  subject_id: z.string().min(1),
  outcome: z.literal('success'),
  payload: z
    .object({ from_id: z.string().min(1), into_id: z.string().min(1) })
    .strict()
    .refine((value) => value.from_id !== value.into_id, 'Rewrite must change the knowledge id'),
});

/** Restore the exact state captured by an accepted completion/relearn proposal. */
export const LearningItemStateRestoreExperimental = z.object({
  actor_kind: z.literal('user'),
  actor_ref: z.literal('self'),
  action: z.literal('experimental:learning_item_state_restore'),
  subject_kind: z.literal('learning_item'),
  subject_id: z.string().min(1),
  outcome: z.literal('success'),
  caused_by_event_id: z.string().min(1),
  payload: z
    .object({
      expected_status: z.enum(['done', 'in_progress']),
      status: z.enum(['pending', 'in_progress', 'done', 'resting']),
      completed_at: z.string().datetime().nullable(),
    })
    .strict(),
});
