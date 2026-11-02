// Restores mastery_state and material_fsrs_state from one state_snapshot payload.
// The two segments stay independent. Reverting one must not block or alter the other.
// This function does not compare the live row with snapshot.after. That guard stays in the orchestrator.
// Upserts go through the single writers. A null before deletes the row the attempt created.
// Those writers do not expose delete, so the cold-start delete goes through drizzle
// in this same transaction.

import { and, eq } from 'drizzle-orm';

import type { StateSnapshotExperimentalT } from '@/core/schema/event/state-snapshot';
import type { Tx } from '@/db/client';
import { acquireLearningStateWriteLock } from '@/db/learning-state-lock';
import { mastery_state, material_fsrs_state } from '@/db/schema';
import { upsertMasteryState } from '@/kernel/records/mastery-state';
import { upsertFsrsState } from '@/server/fsrs/state';

/** A bare-number θ̂ before has no other columns, so the call refuses and writes nothing. */
export type RestoreSnapshotResult =
  | { ok: true }
  | { ok: false; refusal: 'legacy_snapshot'; ref: { kind: 'theta'; kcId: string } };

/**
 * Restore both segments inside the caller's transaction.
 * A rich before is written back column by column, including nulls. Omitting a column would keep the attempt's value.
 * A bare-number θ̂ before refuses the whole restore. A null before deletes the row the attempt created.
 */
export async function restoreStateSnapshot(
  tx: Tx,
  payload: StateSnapshotExperimentalT['payload'],
): Promise<RestoreSnapshotResult> {
  // Same transaction lock as the other writers.
  // Acquiring it again in this transaction does not wait.
  // The orchestrator already holds it. A direct caller still needs it.
  await acquireLearningStateWriteLock(tx);
  // Refuse before any write. A bare number has no counts, precision, rt, or grid, so restoring it would invent them.
  for (const snap of payload.theta_snapshots) {
    if (typeof snap.before === 'number') {
      return { ok: false, refusal: 'legacy_snapshot', ref: { kind: 'theta', kcId: snap.kc_id } };
    }
  }

  for (const snap of payload.theta_snapshots) {
    // A payload written before subject_kind existed is a per-KC row.
    const subjectKind = snap.subject_kind ?? 'knowledge';
    const before = snap.before;
    if (before === null) {
      await tx
        .delete(mastery_state)
        .where(
          and(
            eq(mastery_state.subject_kind, subjectKind),
            eq(mastery_state.subject_id, snap.kc_id),
          ),
        );
      continue;
    }
    if (typeof before === 'number') {
      // The scan above already returned. Continuing would restore the other rows and still report success.
      throw new Error(
        'restoreStateSnapshot: bare-number `before` survived the scan-first guard (unreachable)',
      );
    }
    // Pass every column, including null. A missing key would leave the attempt's value on that column.
    await upsertMasteryState(tx, {
      subject_kind: subjectKind,
      subject_id: snap.kc_id,
      theta_hat: before.theta_hat,
      evidence_count: before.evidence_count,
      success_count: before.success_count,
      fail_count: before.fail_count,
      last_outcome_at: before.last_outcome_at,
      theta_precision: before.theta_precision,
      last_theta_delta: before.last_theta_delta,
      theta_grid_json: before.theta_grid_json,
      rt_correct_ms: before.rt_correct_ms,
    });
  }

  for (const snap of payload.fsrs_snapshots) {
    if (snap.before === null) {
      await tx
        .delete(material_fsrs_state)
        .where(
          and(
            eq(material_fsrs_state.subject_kind, snap.subject_kind),
            eq(material_fsrs_state.subject_id, snap.subject_id),
          ),
        );
    } else {
      await upsertFsrsState(tx, {
        subject_kind: snap.subject_kind,
        subject_id: snap.subject_id,
        state: snap.before,
        due_at: snap.before.due,
        // The snapshot card has no prior review event id, so null means that id is unknown.
        // Pointing it at this attempt would say the restored card was last reviewed
        // by the attempt being undone.
        // Settlement replay does revert this FSRS checkpoint, so the missing id
        // is not limited to a theta-only rejudge.
        last_review_event_id: null,
      });
    }
  }

  return { ok: true };
}
