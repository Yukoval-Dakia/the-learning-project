import { z } from 'zod';

// ====================================================================
// learning_item action events — YUK-471 Wave 2 (learning_item fold)
// ====================================================================
//
// learning_item is a WEAK event-sourced entity (design §0). Its status transitions are currently
// bare imperative UPDATEs whose effect leaks through a `rate` event's payload side-channel
// (materialized_learning_item_id) rather than a subject_kind='learning_item' action event — so a
// complete/relearn/archive is INVISIBLE to a Q1 subject-keyed fold. W2 closes that gap with three
// dedicated typed action events so each transition is fold-visible via Q1 (the recommended route,
// design §3③ — no fragile payload reverse-lookup). They are reserved experimental actions (see
// RESERVED_EXPERIMENTAL_ACTIONS in ./experimental.ts) so a malformed payload is rejected at the
// parseEvent barrier instead of falling through to the loose generic ExperimentalEvent.
//
// CREATION uses experimental:genesis directly (design §3②/§3⑥): unlike mistake_variant (whose
// runtime creation needs a dedicated create event to carry the fold-blind cause_category, critic
// A4), learning_item has NO fold-blind field — the genesis snapshot fully seeds the row, so the
// INSERT sites write a per-id genesis as the BASE event. These three action events are ONLY the
// post-creation status mutations.
//
// RETRACT-LANE INTERFACE (design §7): the in-flight retract lane (PR #592) consumes THESE event
// shapes — completion-retract reopens via learning_item_relearn, relearn-retract re-completes via
// learning_item_complete, learning_item-proposal retract archives via learning_item_archive. The
// shapes are defined cleanly here so the retract lane writes W2 events (not its own invented ones).
//
// VERSION SEMANTICS (critic B1 — MIRROR the historical imperative writes EXACTLY, per-site):
//   - genesis seed (INSERT sites): version carried VERBATIM from the snapshot (the INSERT default 0).
//   - complete (proposal-appliers.ts:298): version +1.
//   - relearn  (proposal-appliers.ts:382): version +1.
//   - archive/retract (actions.ts learning_item block): the bare UPDATE does NOT bump version
//     (archived_at + archived_reason + updated_at only) — the reducer MIRRORS that (NO bump),
//     behaviour-preserving (§7.7 flags a version-unification question as a follow-up; NOT changed
//     in this lane).
//
// Dedicated FILE (not known.ts) to minimise merge conflict with the in-flight retract lane (PR
// #592), mirroring goal-events.ts / mistake-variant-events.ts.

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
