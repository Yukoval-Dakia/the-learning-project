// projectItemCalibration: the IO shell around the pure item_calibration fold.
//
// The shell gathers the event rows that can affect rowId, maps them to the flat
// FoldEvent envelope, folds, and writes the result through. It never writes on a
// live path: item_calibration's live writers stay the single-owner primitives in
// src/server/mastery/ (applyItemPrior / fixed-anchor / recalibrateQuestion). This
// shell exists for the offline registry surfaces only (rebuild:projection, the B3
// gate and the audit's shared gather). The per-entity projectionIsWriter flag is
// off and no flip is planned while the table is anchor-only backfilled.
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
 * Project one item_calibration row from the event log and write it through:
 *   - null → DELETE the row,
 *   - row  → upsert the projected columns.
 *
 * Offline-only; Db|Tx polymorphic.
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
 * Guarded write-through (the registry SoT-flip row writer). Identical to
 * projectItemCalibration except the null branch: delete only when the row has a
 * genesis anchor (a genuine revert). A fold-null on an un-anchored pre-backfill row
 * must not delete live calibration truth the log cannot reproduce. Mirrors
 * projectQuestionBlockGuarded / projectGoalGuarded.
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

// Shared upsert of the projected item_calibration columns. The snapshot is the full
// row (every column is fold truth), so the SET covers the whole table except the PK.
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
    // Posterior columns: historical anchors lack the keys, so undefined keeps the column.
    b_post: projected.b_post ?? undefined,
    posterior_variance: projected.posterior_variance ?? undefined,
    calibration_source: projected.calibration_source ?? undefined,
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
