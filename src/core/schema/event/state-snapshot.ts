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

// YUK-561 S1 — jsonb-roundtrip-safe zod mirrors of the two persisted shadow
// columns (core/theta.ts RtCorrectBuffer, core/theta-grid.ts ThetaGridPosterior).
// Kept local (not imported from those modules — they export TS interfaces, no zod)
// so the parse barrier validates the FULL restored row, not a loose record.
const RtCorrectBufferSnapshot = z.object({
  samples: z.array(z.number()),
});
const ThetaGridPosteriorSnapshot = z.object({
  probs: z.array(z.number()),
  evidence: z.number().int(),
});

// YUK-561 S1 (revert-bracket) — the FULL pre-attempt mastery_state row snapshot.
// `before` must capture EVERY column an attempt writes so revert = VERBATIM whole-
// row restore (not just θ̂ + zeroed counts). SRT_ENABLED is LIVE (theta.ts:259) so
// `rt_correct_ms` is written on every SRT-eligible correct attempt TODAY — a θ̂-only
// restore would leave a post-attempt RT sample behind (non-verbatim). `theta_grid_json`
// is A4-dark (THETA_GRID_ENABLED=false) but captured anyway so the flag flip never
// silently loses verbatim fidelity. Column set is drift-guarded against mastery_state
// (tests/schema/theta-snapshot-column-drift.test.ts).
export const ThetaRowSnapshot = z.object({
  theta_hat: z.number(),
  evidence_count: z.number().int(),
  success_count: z.number().int(),
  fail_count: z.number().int(),
  theta_precision: z.number(),
  last_theta_delta: z.number().nullable(),
  last_outcome_at: z.coerce.date().nullable(), // jsonb → ISO string coerced back to Date
  rt_correct_ms: RtCorrectBufferSnapshot.nullable(), // SRT live column (theta.ts:259)
  theta_grid_json: ThetaGridPosteriorSnapshot.nullable(), // A4 dark (theta-grid.ts:54)
});
export type ThetaRowSnapshotT = z.infer<typeof ThetaRowSnapshot>;

export const ThetaSnapshot = z.object({
  kc_id: z.string().min(1),
  // YUK-561 S1 union (rollback-compat, Lens B F9): the rich ThetaRowSnapshot (new
  // writers) | a bare number (pre-S1 on-disk snapshots) | null (cold-start). Both
  // legacy shapes parse through the barrier so a code rollback never breaks the read
  // side; the RESTORE primitive refuses a bare-number `before` (typed `legacy_snapshot`
  // refusal) rather than lossy-restore. z.union tries ThetaRowSnapshot first: a bare
  // number fails the object and falls to z.number(); a rich object matches.
  before: z.union([ThetaRowSnapshot, z.number()]).nullable(),
  // `after` stays the θ̂ scalar (logit-scale): the conflict guard only needs
  // theta_hat, and every on-disk `after` is a bare number — keeping it scalar avoids
  // a lossy schema flip + a guard rewrite (see spec §4.3 reconciled deviation).
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
  caused_by_event_id: z.string().optional(), // = grading checkpoint id (cascade CTE chain edge)
  task_run_id: z.string().optional(),
  cost_micro_usd: z.number().int().optional(),
});
export type StateSnapshotExperimentalT = z.infer<typeof StateSnapshotExperimental>;

// ---------- GradingCheckpointExperimental (YUK-561 S2 / O2 dual-sibling) ----------
//
// The reversible ANCHOR a state_snapshot hangs off (revert-bracket §4.1). Pre-S2 the
// snapshot hung directly off the attempt event E (caused_by=E); E has caused_by=null
// so it can only ever be a cascade ROOT, and classifyRow(E)='irreversible' → the
// snapshot's success path was structurally UNREACHABLE (register F8). S2 inserts a
// grading_checkpoint C between E and the snapshot: revert(C) closes over {snapshot}
// only (E is C's PARENT, the reverse-CTE never climbs up), so the snapshot is now
// reachable + reversible.
//
// O2 completeness (owner 2026-07-04): ONE checkpoint action carries BOTH the θ̂ and
// FSRS segments as two SIBLING instances, discriminated by `payload.segment`:
//   C_θ = `${E}:checkpoint:theta` anchors `${E}:snapshot:theta` (θ̂ segment)
//   C_f = `${E}:checkpoint:fsrs`  anchors `${E}:snapshot:fsrs`  (FSRS segment)
// Reverting a segment = reverting ITS checkpoint (no revertSegments filter) — the two
// segments close over disjoint snapshots so they revert orthogonally (ADR-0035 R⟂p(L)).
//
// classifyRow maps this action to EVENT_LAYER (cascade-revert.ts): the checkpoint has
// NO independent live SoT row (the A-class state lives in the snapshot it anchors), so
// a `correct`(retract) event IS its complete reversal — same shape as the
// copilot_user_ask / chip_trigger anchors. ingest_at:now (internal ledger row, not a
// learner fact). Reserved + this dedicated schema so a malformed checkpoint payload
// can't lose validation (parse barrier) — MUST land with the writer (spec §4.2 red-flag).
export const GradingCheckpointExperimental = z.object({
  actor_kind: z.literal('system'),
  actor_ref: z.string().min(1), // e.g. 'attempt_snapshot'
  action: z.literal('experimental:grading_checkpoint'),
  subject_kind: z.literal('event'), // hangs off the attempt/review event
  subject_id: z.string().min(1), // = attempt/review event id
  outcome: z.literal('success').nullable().optional(),
  payload: z.object({
    attempt_event_id: z.string().min(1),
    segment: z.enum(['theta', 'fsrs']), // which axis this checkpoint brackets
  }),
  caused_by_event_id: z.string().optional(), // = attempt event id (E is the parent)
  task_run_id: z.string().optional(),
  cost_micro_usd: z.number().int().optional(),
});
export type GradingCheckpointExperimentalT = z.infer<typeof GradingCheckpointExperimental>;
