// YUK-471 W2 — projectMistakeVariant: the IO shell around the PURE mistake_variant fold.
//
// The read→fold→write-through shell the variant_gen creation / accept / verify / dismiss / retract
// sites flip to as the SOLE writer of a `mistake_variant` row WHEN the per-entity flag
// projectionIsWriter('mistake_variant') is ON (critic A1). It:
//   1. GATHERS the superset of `event` rows that can affect `mvId` (the pure reducer filters
//      internally, but the shell over-collects — a missed event silently drops a mutation),
//   2. maps each DB row → the flat FoldEvent envelope (inside gather.ts),
//   3. calls foldMistakeVariant(mvId, foldEvents) (PURE),
//   4. WRITE-THROUGH: null → DELETE the row; else upsert the projected columns.
//
// mistake_variant has NO derived/excluded columns (unlike knowledge's embed_*) and NO version
// column (like knowledge_edge), so the upsert covers the full row — every column is fold truth.
//
// The read→fold half lives in the SHARED gather.ts (gatherAndFoldMistakeVariant) so this shell and
// scripts/audit-projection.ts reconstruct a mistake_variant IDENTICALLY — a single gather
// implementation means the drift auditor can never be blind to a gather bug in the SoT path. This
// shell adds only the WRITE-THROUGH on top of that shared read→fold (mirrors projectGoal).
//
// Db|Tx polymorphic.

import { eq } from 'drizzle-orm';

import type { MistakeVariantRowSnapshotT } from '@/core/schema/event/genesis';
import type { Db, Tx } from '@/db/client';
import { mistake_variant } from '@/db/schema';
import { gatherAndFoldMistakeVariant } from './gather';
import { hasMistakeVariantGenesisAnchor } from './parity';

type DbLike = Db | Tx;

/**
 * Project the current structural state of a single `mistake_variant` from the event log and write
 * it through to the live table. READ→FOLD→WRITE-THROUGH:
 *   - null  → DELETE FROM mistake_variant WHERE id=mvId (row never existed / fully reverted),
 *   - row   → upsert (insert … onConflictDoUpdate target mistake_variant.id) the projected columns.
 *
 * @param db   Db or Tx (polymorphic — wired sites call it inside the creation/accept/verify tx).
 * @param mvId the mistake_variant row id to project.
 */
export async function projectMistakeVariant(db: DbLike, mvId: string): Promise<void> {
  const projected = await gatherAndFoldMistakeVariant(db, mvId);
  if (projected === null) {
    await db.delete(mistake_variant).where(eq(mistake_variant.id, mvId));
    return;
  }
  await upsertProjectedMistakeVariant(db, projected);
}

/**
 * The GUARDED mistake_variant write-through (the SoT-flip row writer). Identical to
 * projectMistakeVariant EXCEPT the null branch: a fold of null DELETEs the live row ONLY when the
 * row HAS a genesis anchor (a genuine revert of an event-sourced variant). A fold-null on an
 * UN-anchored row — a pre-event-sourced row the fold is blind to — must NOT delete the live row.
 * Mirrors projectGoalGuarded: lets the flip be activated before every variant is backfilled.
 */
export async function projectMistakeVariantGuarded(db: DbLike, mvId: string): Promise<void> {
  const projected = await gatherAndFoldMistakeVariant(db, mvId);
  if (projected === null) {
    if (await hasMistakeVariantGenesisAnchor(db, mvId)) {
      await db.delete(mistake_variant).where(eq(mistake_variant.id, mvId));
    }
    // else: fold-blind pre-event-sourced variant — keep the imperative row (NEVER delete).
    return;
  }
  await upsertProjectedMistakeVariant(db, projected);
}

// Shared upsert of the projected mistake_variant columns (the FULL row — no derived/excluded/version
// columns). cause_category is the FOLD-BLIND field reproduced from the base event (critic A4).
async function upsertProjectedMistakeVariant(
  db: DbLike,
  projected: MistakeVariantRowSnapshotT,
): Promise<void> {
  await db
    .insert(mistake_variant)
    .values({
      id: projected.id,
      parent_question_id: projected.parent_question_id,
      variant_question_id: projected.variant_question_id,
      proposal_event_id: projected.proposal_event_id,
      status: projected.status,
      failure_reasons: projected.failure_reasons,
      cause_category: projected.cause_category,
      created_at: projected.created_at,
      updated_at: projected.updated_at,
    })
    .onConflictDoUpdate({
      target: mistake_variant.id,
      set: {
        parent_question_id: projected.parent_question_id,
        variant_question_id: projected.variant_question_id,
        proposal_event_id: projected.proposal_event_id,
        status: projected.status,
        failure_reasons: projected.failure_reasons,
        cause_category: projected.cause_category,
        created_at: projected.created_at,
        updated_at: projected.updated_at,
      },
    });
}
