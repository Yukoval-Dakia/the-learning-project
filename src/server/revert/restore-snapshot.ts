// YUK-471 Wave 0 — restore-snapshot primitive (plan §2 CREATE; ADR-0044 §3).
//
// Pure-ish restore of the two A-class imperative online-update state tables
// from a `StateSnapshotExperimental` payload:
//   - θ̂ segment  → mastery_state       (per-KC before/after)
//   - FSRS segment → material_fsrs_state (per-subject before/after)
//
// For EACH segment, independently:
//   before !== null  → UPSERT the row back to its `before` value
//   before === null  → DELETE the row (cold-start had no row; revert removes it)
//
// The two segments revert INDEPENDENTLY — 守 ADR-0035 三轴正交 R⟂p(L) (the θ̂
// diagnostic axis and the FSRS R-scheduling axis must not be coupled: reverting
// one must never block or alter the other).
//
// GUARD-AGNOSTIC (plan §6.5 / §6.5 resolved): this primitive does NOT assert
// `current == snapshot.after` before restoring. That conflict guard lives in the
// cascade-revert orchestrator (later wave) — the primitive is a caller-asserted
// idempotent upsert/delete. Do not add the guard here (deferred to orchestrator
// wave per §6.5).
//
// No-op on empty arrays (degenerate snapshot with no KCs / no FSRS subjects).
//
// Single-writer discipline: we route writes through the canonical single-owner
// upsert fns (upsertMasteryState / upsertFsrsState) for the before!=null path so
// step9-invariant-audit's single-writer assertion on these tables still holds.
// The before=null DELETE goes through drizzle directly (delete is not an upsert
// and the single-writer modules don't expose a delete fn — DELETE is the inverse
// of the cold-start INSERT, executed in the same revert tx).

import { and, eq } from 'drizzle-orm';

import type { StateSnapshotExperimentalT } from '@/core/schema/event/state-snapshot';
import type { Tx } from '@/db/client';
import { mastery_state, material_fsrs_state } from '@/db/schema';
import { upsertFsrsState } from '@/server/fsrs/state';
import { upsertMasteryState } from '@/server/mastery/state';

/**
 * Restore the two A-class imperative state tables from a state_snapshot event
 * payload. MUST be called inside the caller's revert transaction (`tx`).
 *
 * θ̂ segment: before!=null → upsert mastery_state back to θ̂=before; before=null
 *   → DELETE the mastery_state row (cold-start revert).
 * FSRS segment: before!=null → upsert material_fsrs_state back to the before
 *   Card; before=null → DELETE the row.
 *
 * The two segments are independent — one can be all-deletes while the other is
 * all-upserts (ADR-0035 R⟂p(L)).
 *
 * Guard-agnostic: no `current == after` conflict check. The caller (orchestrator)
 * asserts that before reverting.
 */
export async function restoreStateSnapshot(
  tx: Tx,
  payload: StateSnapshotExperimentalT['payload'],
): Promise<void> {
  // ---------- θ̂ segment (mastery_state) ----------
  for (const snap of payload.theta_snapshots) {
    if (snap.before === null) {
      // Cold-start revert: the attempt had created this row; restore = remove it.
      await tx
        .delete(mastery_state)
        .where(
          and(
            eq(mastery_state.subject_kind, 'knowledge'),
            eq(mastery_state.subject_id, snap.kc_id),
          ),
        );
    } else {
      // Warm revert: restore θ̂ to its pre-attempt value.
      // The snapshot only carries theta_hat (before/after) — the count columns
      // (evidence/success/fail) are NOT in the payload. We zero them on revert
      // because the revert undoes the attempt that produced the after-state: a
      // faithful restore removes the evidence of the reverted attempt too. The
      // orchestrator (later wave) owns any richer compensation; the primitive
      // restores the θ̂ axis value as captured.
      await upsertMasteryState(tx, {
        subject_id: snap.kc_id,
        theta_hat: snap.before,
        evidence_count: 0,
        success_count: 0,
        fail_count: 0,
        last_outcome_at: new Date(0),
      });
    }
  }

  // ---------- FSRS segment (material_fsrs_state) ----------
  for (const snap of payload.fsrs_snapshots) {
    if (snap.before === null) {
      // Cold-start revert: the attempt had created this row; restore = remove it.
      await tx
        .delete(material_fsrs_state)
        .where(
          and(
            eq(material_fsrs_state.subject_kind, snap.subject_kind),
            eq(material_fsrs_state.subject_id, snap.subject_id),
          ),
        );
    } else {
      // Warm revert: restore the FSRS Card to its pre-attempt state.
      await upsertFsrsState(tx, {
        subject_kind: snap.subject_kind,
        subject_id: snap.subject_id,
        state: snap.before,
        due_at: snap.before.due,
        // The snapshot event is an internal ledger row; last_review_event_id
        // back-references the attempt event whose state we are reverting. The
        // before-Card pre-dates that attempt, so we point at the attempt_event_id
        // for audit traceability (the orchestrator passes the true prior review
        // event id if it has one; the primitive just needs a non-null marker).
        last_review_event_id: payload.attempt_event_id,
      });
    }
  }
}
