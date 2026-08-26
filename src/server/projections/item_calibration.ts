// YUK-496 — projectItemCalibration: the IO shell around the PURE item_calibration fold
// (ADR-0044 §7 item_calibration 例外, 方案 A — B-class genesis backfill).
//
// The read→fold→write-through shell the registry exposes for item_calibration, mirroring the W2/W3
// shells. It:
//   1. GATHERS the superset of `event` rows that can affect `rowId` (Q1-only — see gather.ts),
//   2. maps each DB row → the flat FoldEvent envelope,
//   3. calls foldItemCalibration(rowId, foldEvents) (PURE, anchor-only),
//   4. WRITE-THROUGH: null → DELETE the row (guarded variant: only when anchored); else upsert the
//      projected columns (every column is fold truth — the full-row snapshot).
//
// ── NOT a live-path writer (方案 A) ─────────────────────────────────────────────────────────────
// item_calibration's LIVE writers stay the B1 single-owner primitives in src/server/mastery/
// (applyItemPrior / fixed-anchor / applyKtEstimate / recalibrateQuestion — untouched by YUK-496).
// This shell exists for the OFFLINE registry surfaces only: rebuild:projection / the B3 gate
// (clone-only) and the audit's shared gather. The per-entity SoT flag
// (projectionIsWriter('item_calibration')) is default OFF and NO flip is planned under 方案 A —
// a future canonical-event route (方案 B) is the prerequisite for ever flipping it. Until then the
// step9 single-writer audit allowlists THIS file as the one offline projection shell.
//
// Db|Tx polymorphic.

import { eq } from 'drizzle-orm';

import type { ItemCalibrationRowSnapshotT } from '@/core/schema/event/genesis';
import type { Db, Tx } from '@/db/client';
import { item_calibration } from '@/db/schema';
import { gatherAndFoldItemCalibration } from './gather';
import { hasItemCalibrationGenesisAnchor } from './parity';

type DbLike = Db | Tx;

/**
 * Project the current state of a single `item_calibration` row from the event log and write it
 * through to the live table. READ→FOLD→WRITE-THROUGH:
 *   - null  → DELETE FROM item_calibration WHERE id=rowId (row never anchored / fully reverted),
 *   - row   → upsert (insert … onConflictDoUpdate target item_calibration.id) the projected columns.
 *
 * OFFLINE-only under 方案 A (no live write site calls it). Db|Tx polymorphic.
 *
 * @param db     Db or Tx (polymorphic).
 * @param rowId  the item_calibration row id to project.
 */
export async function projectItemCalibration(db: DbLike, rowId: string): Promise<void> {
  const projected = await gatherAndFoldItemCalibration(db, rowId);
  if (projected === null) {
    await db.delete(item_calibration).where(eq(item_calibration.id, rowId));
    return;
  }
  await upsertProjectedItemCalibration(db, projected);
}

/**
 * The GUARDED item_calibration write-through (the registry SoT-flip row writer). Identical to
 * projectItemCalibration EXCEPT the null branch: a fold of null DELETEs the live row ONLY when the
 * row HAS a genesis anchor (a genuine revert of an anchored row). A fold-null on an UN-anchored
 * row — a pre-backfill row the anchor-only fold is blind to (its only writers are the imperative
 * B1 paths, which never append events) — must NOT delete the live row; that would destroy
 * calibration truth the log cannot reproduce. Mirrors projectQuestionBlockGuarded /
 * projectGoalGuarded.
 */
export async function projectItemCalibrationGuarded(db: DbLike, rowId: string): Promise<void> {
  const projected = await gatherAndFoldItemCalibration(db, rowId);
  if (projected === null) {
    if (await hasItemCalibrationGenesisAnchor(db, rowId)) {
      // Genuine revert — the row was anchored and every anchor event is gone.
      await db.delete(item_calibration).where(eq(item_calibration.id, rowId));
    }
    // else: fold-blind pre-backfill row — keep the imperative row (NEVER delete).
    return;
  }
  await upsertProjectedItemCalibration(db, projected);
}

// Shared upsert of the projected item_calibration columns. The snapshot is the FULL row (every
// column is fold truth — the full-row 方案 A contract), so the SET covers the entire table except
// the PK (handled by the insert values + conflict target).
async function upsertProjectedItemCalibration(
  db: DbLike,
  projected: ItemCalibrationRowSnapshotT,
): Promise<void> {
  const set = {
    question_id: projected.question_id,
    b: projected.b,
    confidence: projected.confidence,
    track: projected.track,
    source: projected.source,
    b_anchor: projected.b_anchor,
    b_calib: projected.b_calib,
    calibration_n: projected.calibration_n,
    calibration_weight: projected.calibration_weight,
    last_calibrated_at: projected.last_calibrated_at,
    irt_a: projected.irt_a,
    irt_c: projected.irt_c,
    cdm_json: projected.cdm_json,
    kt_json: projected.kt_json,
    created_at: projected.created_at,
    updated_at: projected.updated_at,
  } satisfies Partial<typeof item_calibration.$inferInsert>;
  await db
    .insert(item_calibration)
    .values({ id: projected.id, ...set } as typeof item_calibration.$inferInsert)
    .onConflictDoUpdate({
      target: item_calibration.id,
      set,
    });
}
