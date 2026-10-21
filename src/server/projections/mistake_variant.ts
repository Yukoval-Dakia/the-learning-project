// Write-through shell for the pure `mistake_variant` fold: gather the event superset,
// fold it, then delete or upsert the live row. The table has no derived or version
// columns, so the upsert covers the full row. The shared gather lives in gather.ts.

import { eq } from 'drizzle-orm';

import type { MistakeVariantRowSnapshotT } from '@/core/schema/event/genesis';
import type { Db, Tx } from '@/db/client';
import { mistake_variant } from '@/db/schema';
import { gatherAndFoldMistakeVariant } from './gather';
import { hasMistakeVariantGenesisAnchor } from './parity';

type DbLike = Db | Tx;

/**
 * Re-project one `mistake_variant`. A fold of null deletes the row; otherwise upsert the
 * full row.
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
 * Guarded write-through: a fold of null deletes only when the row has a genesis anchor.
 * Without one the fold is blind to a pre-event row, so deleting would lose data.
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

// Upsert the full row. cause_category is fold-blind, so it comes from the base event.
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
