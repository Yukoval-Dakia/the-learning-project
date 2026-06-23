import { z } from 'zod';
import { FsrsStateSchema } from './blocks'; // blocks.ts:68 — z.coerce.date()-based, jsonb-roundtrip-safe

// ====================================================================
// StateSnapshotExperimental — A-class snapshot reversibility (YUK-471 Wave 0)
// ====================================================================
//
// ADR-0044 §3 — θ̂/FSRS 快照 event. Appended in the SAME attempt tx as
// (review event + judge event + FSRS upsert + θ̂ update), making it the 6th
// atomic write of the attempt tx. Carries per-KC `before`/`after` θ̂ and
// per-subject `before`/`after` FSRS Card so the revert-restore-snapshot
// primitive can upsert (before≠null) or delete (before=null) each segment
// independently — 守 ADR-0035 三轴正交 R⟂p(L).
//
// HARD REQ 1 (ADR-0044): this dedicated Zod schema is validated by writeEvent's
// parseEvent barrier. The generic ExperimentalEvent fallback REJECTS the
// reserved `experimental:state_snapshot` action (see RESERVED_EXPERIMENTAL_ACTIONS
// in ./experimental.ts) so a malformed payload can never lose schema validation.
//
// HARD REQ 2 (ADR-0044): the snapshot event skips the memory outbox by writing
// `ingest_at: now` (non-NULL opt-out) at INSERT — see w0-PLAN.md §1. The
// outbox poller's `WHERE ingest_at IS NULL` never selects it (internal
// rollback ledger row, not a learner fact — shouldExtractToMemory's user-only
// gate semantics agree).
//
// actor_kind pinned to `'system'` per w0-PLAN.md §6.3: the snapshot is a
// system-emitted rollback ledger row, not an agent action.

// ---------- θ̂ segment ----------
//
// before=null ≡ no mastery_state row ≡ cold-start (revert → DELETE row).
// before MUST distinguish null from 0 (0 is a real prior θ̂; the Elo update at
// mastery/state.ts:560 coerces missing→0 for math, but the snapshot stores the
// raw row presence so revert deletes cold-start rows instead of writing θ̂=0).

export const ThetaSnapshot = z.object({
  kc_id: z.string().min(1),
  before: z.number().nullable(), // logit-scale θ̂; null = cold-start
  after: z.number(),
});
export type ThetaSnapshotT = z.infer<typeof ThetaSnapshot>;

// ---------- FSRS segment ----------
//
// before=null ≡ no material_fsrs_state row ≡ cold-start (revert → DELETE row).
// subject_kind is the FsrsSubjectKind ('question' | 'knowledge').

export const FsrsSnapshot = z.object({
  subject_kind: z.enum(['question', 'knowledge']), // = FsrsSubjectKind
  subject_id: z.string().min(1),
  before: FsrsStateSchema.nullable(), // reuse blocks.ts:68; null = cold-start
  after: FsrsStateSchema,
});
export type FsrsSnapshotT = z.infer<typeof FsrsSnapshot>;

// ---------- StateSnapshotExperimental ----------
//
// Field-level parity with the three existing reserved experimental schemas
// (UserCauseExperimental / RecordCaptureExperimental / MemoryBriefRefreshExperimental):
// actor_kind literal, action literal, subject literals, optional base fields.
// This parity is what lets parseEvent route to this branch deterministically
// and reject malformed payloads instead of falling through to the loose generic.
//
// theta_snapshots[] / fsrs_snapshots[] may be empty (attempt with no KCs /
// degenerate paths) — the restore fn no-ops on empty.

export const StateSnapshotExperimental = z.object({
  actor_kind: z.literal('system'), // snapshot is an internal ledger writer (§6.3)
  actor_ref: z.string().min(1), // e.g. 'attempt_snapshot'
  action: z.literal('experimental:state_snapshot'),
  subject_kind: z.literal('event'), // snapshot hangs off the attempt event
  subject_id: z.string().min(1), // = attempt/review event id
  outcome: z.literal('success').nullable().optional(),
  payload: z.object({
    attempt_event_id: z.string().min(1), // back-link to the review event
    theta_snapshots: z.array(ThetaSnapshot),
    fsrs_snapshots: z.array(FsrsSnapshot),
  }),
  // baseOptionalFields parity (mirror UserCause/RecordCapture/MemoryBriefRefresh):
  caused_by_event_id: z.string().optional(), // = attempt event id (cascade CTE chain edge)
  task_run_id: z.string().optional(),
  cost_micro_usd: z.number().int().optional(),
});
export type StateSnapshotExperimentalT = z.infer<typeof StateSnapshotExperimental>;
