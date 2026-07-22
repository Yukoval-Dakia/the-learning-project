// YUK-561 S2 (revert-bracket §4.1 / O2 dual-sibling) — shared attempt-snapshot writer.
//
// Both the solo /api/review/submit and the paper per-slot submit brackets EACH axis
// (θ̂ / FSRS) it just moved with an INDEPENDENT sibling checkpoint + snapshot so a
// judge-overturn can revert the θ̂ transition ALONE (register F8 fix). This helper is
// the single owner of that write shape so the two attempt writers can't drift.
//
// Per segment (θ̂ / FSRS), written iff that axis moved (its snapshot array non-empty):
//   C_seg = `${E}:checkpoint:${seg}` — grading_checkpoint anchor (caused_by = E)
//   S_seg = `${E}:snapshot:${seg}`   — state_snapshot carrying ONLY this segment
//                                       (caused_by = C_seg; the OTHER array is empty)
// revert(C_seg) closes over {S_seg} only (E is C_seg's parent, the reverse-CTE never
// climbs up), so the two segments revert ORTHOGONALLY (ADR-0035 R⟂p(L)) — the O2
// "which checkpoint you revert IS the segment selector" design.
//
// SAME-CONDITION WRITE INVARIANT (spec §4.1, Lens A F6): per segment, C_seg and S_seg
// are BOTH-or-NEITHER (gated on the same non-empty array) — there is no FK on
// caused_by (schema.ts:814), so a dangling snapshot with no checkpoint would be
// permanently unrevertable with no DB backstop. This helper is the invariant.
//
// Idempotency (§6.7): deterministic ids + writeEvent's PK-conflict-do-nothing make a
// retried/redelivered attempt tx a no-op (never a duplicate ledger row). ingest_at:now
// opts every row out of the memory outbox (internal rollback ledger, not a learner fact).

import type { StateSnapshotExperimentalT } from '@/core/schema/event/state-snapshot';
import type { Tx } from '@/db/client';
import { writeEvent } from '@/kernel/events';
import type { ThetaSnapshotEntry } from '@/server/mastery/state';

type FsrsSnapshotEntry = StateSnapshotExperimentalT['payload']['fsrs_snapshots'][number];
type Segment = 'theta' | 'fsrs';

export interface AttemptSnapshotBracketsInput {
  /** the attempt/review event id these snapshots bracket. */
  attemptEventId: string;
  sessionId: string | null;
  now: Date;
  /** the θ̂ transition this attempt performed (empty → θ̂ segment not written). */
  thetaSnapshots: ThetaSnapshotEntry[];
  /** the FSRS transition this attempt performed (empty → FSRS segment not written). */
  fsrsSnapshots: FsrsSnapshotEntry[];
}

/**
 * Write the θ̂ and FSRS revert brackets for one attempt (each segment iff it moved).
 * MUST be called inside the attempt's OUTER tx (a HARD invariant of the attempt — the
 * brackets die with it on rollback, never half-committed).
 */
export async function writeAttemptSnapshotBrackets(
  tx: Tx,
  input: AttemptSnapshotBracketsInput,
): Promise<void> {
  if (input.thetaSnapshots.length > 0) {
    await writeSegmentBracket(tx, input, 'theta');
  }
  if (input.fsrsSnapshots.length > 0) {
    await writeSegmentBracket(tx, input, 'fsrs');
  }
}

async function writeSegmentBracket(
  tx: Tx,
  input: AttemptSnapshotBracketsInput,
  segment: Segment,
): Promise<void> {
  const { attemptEventId, sessionId, now } = input;

  // (1) checkpoint anchor — the reversible parent (event_layer). Write FIRST so the
  // snapshot's caused_by always resolves to an existing row (good habit; caused_by has
  // no FK so it's not enforced, but keeps the topology clean).
  await writeEvent(tx, {
    id: `${attemptEventId}:checkpoint:${segment}`,
    session_id: sessionId,
    actor_kind: 'system',
    actor_ref: 'attempt_snapshot',
    action: 'experimental:grading_checkpoint',
    subject_kind: 'event',
    subject_id: attemptEventId,
    outcome: 'success',
    payload: { attempt_event_id: attemptEventId, segment },
    caused_by_event_id: attemptEventId,
    task_run_id: null,
    cost_micro_usd: null,
    ingest_at: now,
    created_at: now,
  });

  // (2) snapshot — the A-class state carrying ONLY this segment (the other array is
  // empty). caused_by = the checkpoint (NOT the attempt), so revert(checkpoint) closes
  // over exactly this snapshot.
  await writeEvent(tx, {
    id: `${attemptEventId}:snapshot:${segment}`,
    session_id: sessionId,
    actor_kind: 'system',
    actor_ref: 'attempt_snapshot',
    action: 'experimental:state_snapshot',
    subject_kind: 'event',
    subject_id: attemptEventId,
    outcome: 'success',
    payload: {
      attempt_event_id: attemptEventId,
      theta_snapshots: segment === 'theta' ? input.thetaSnapshots : [],
      fsrs_snapshots: segment === 'fsrs' ? input.fsrsSnapshots : [],
    },
    caused_by_event_id: `${attemptEventId}:checkpoint:${segment}`,
    task_run_id: null,
    cost_micro_usd: null,
    ingest_at: now,
    created_at: now,
  });
}
