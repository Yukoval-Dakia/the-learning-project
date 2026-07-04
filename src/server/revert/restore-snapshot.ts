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
// cascade-revert orchestrator (its live caller — cascade-revert.ts) — the primitive
// is a caller-asserted idempotent upsert/delete. Do not add the guard here.
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
 * The restore result. YUK-561 S1: a pre-S1 on-disk snapshot carries a BARE-NUMBER
 * θ̂ `before` (just theta_hat, no counts/precision/rt/grid) — it is NOT verbatim-
 * restorable, so restore REFUSES it (`legacy_snapshot`) WITHOUT mutating any row
 * rather than lossy-restore (never write θ̂ back while zeroing the rest). New
 * snapshots carry the rich ThetaRowSnapshot → { ok: true }.
 */
export type RestoreSnapshotResult =
  | { ok: true }
  | { ok: false; refusal: 'legacy_snapshot'; ref: { kind: 'theta'; kcId: string } };

/**
 * Restore the two A-class imperative state tables from a state_snapshot event
 * payload. MUST be called inside the caller's revert transaction (`tx`).
 *
 * θ̂ segment: before=rich ThetaRowSnapshot → VERBATIM whole-row upsert (YUK-561 S1:
 *   theta_hat + counts + precision + delta + last_outcome_at + rt buffer + grid all
 *   restored, not just θ̂ with zeroed counts); before=null → DELETE the row (cold-
 *   start revert); before=bare number (legacy) → refuse `legacy_snapshot`, mutate
 *   nothing (scan-first, see below).
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
): Promise<RestoreSnapshotResult> {
  // YUK-561 S1 — SCAN-FIRST for a legacy bare-number θ̂ `before` (pre-S1 on-disk
  // snapshot). A bare number can't be verbatim-restored (counts/precision/rt/grid
  // absent), so refuse the WHOLE restore WITHOUT mutating any row — never a partial-
  // or-lossy restore (Lens A F5). Defence-in-depth: legacy rows have no checkpoint,
  // so the orchestrator returns `no_checkpoint` before ever reaching this primitive;
  // this branch bites only a direct caller / synthetic legacy payload (spec §6.6).
  for (const snap of payload.theta_snapshots) {
    if (typeof snap.before === 'number') {
      return { ok: false, refusal: 'legacy_snapshot', ref: { kind: 'theta', kcId: snap.kc_id } };
    }
  }

  // ---------- θ̂ segment (mastery_state) ----------
  for (const snap of payload.theta_snapshots) {
    const before = snap.before;
    if (before === null) {
      // Cold-start revert: the attempt had created this row; restore = remove it.
      await tx
        .delete(mastery_state)
        .where(
          and(
            eq(mastery_state.subject_kind, 'knowledge'),
            eq(mastery_state.subject_id, snap.kc_id),
          ),
        );
      continue;
    }
    if (typeof before === 'number') {
      // Unreachable — the scan above refused any bare-number before. Guard for TS +
      // defence: never lossy-restore even if the scan were bypassed.
      continue;
    }
    // Warm verbatim revert: restore the ENTIRE pre-attempt row (YUK-561 S1). Every
    // column is passed explicitly (incl. null) so the upsert force-writes it back to
    // its captured value — leaving one out would keep the reverted attempt's value on
    // that column (the pre-S1 zeroed-counts / stale-precision bug). rt_correct_ms /
    // theta_grid_json passed as null force the column to NULL (upsert writes when the
    // key is present, even if null); last_theta_delta null likewise.
    await upsertMasteryState(tx, {
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
        // augment review — the before-Card pre-dates the reverted attempt, so it must NOT
        // back-reference that attempt: a downstream reader/audit would be misled into
        // thinking the restored card was last reviewed by the very attempt we just undid.
        // The snapshot's `before` carries only the FSRS Card scalars (not the prior
        // last_review_event_id), so the primitive restores this to null ("unknown prior").
        // Accepted limitation: the FSRS segment is not reverted by the live caller
        // (rejudge reverts θ̂ only — O5), so no live path relies on this back-reference.
        last_review_event_id: null,
      });
    }
  }

  return { ok: true };
}
