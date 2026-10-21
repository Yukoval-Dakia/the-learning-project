// Write-through shell for the pure `question_block` fold: gather the event superset,
// fold it, then delete or upsert. `extracted_prompt_md` is legacy and not fold truth,
// so it is neither in the snapshot nor written. The shared gather lives in gather.ts.

import { eq } from 'drizzle-orm';

import type { QuestionBlockRowSnapshotT } from '@/core/schema/event/genesis';
import type { Db, Tx } from '@/db/client';
import { question_block } from '@/db/schema';
import { gatherAndFoldQuestionBlock } from './gather';
import { hasQuestionBlockGenesisAnchor } from './parity';

type DbLike = Db | Tx;

/**
 * Re-project one `question_block`. A fold of null deletes the row; otherwise upsert the
 * projected columns.
 */
export async function projectQuestionBlock(db: DbLike, blockId: string): Promise<void> {
  const projected = await gatherAndFoldQuestionBlock(db, blockId);
  if (projected === null) {
    await db.delete(question_block).where(eq(question_block.id, blockId));
    return;
  }
  await upsertProjectedQuestionBlock(db, projected);
}

/**
 * Guarded write-through: a fold of null deletes only when the block has a genesis anchor.
 * Without one the fold is blind to a pre-event row, so deleting would lose data.
 */
export async function projectQuestionBlockGuarded(db: DbLike, blockId: string): Promise<void> {
  const projected = await gatherAndFoldQuestionBlock(db, blockId);
  if (projected === null) {
    if (await hasQuestionBlockGenesisAnchor(db, blockId)) {
      // Genuine revert — the block was event-sourced and every creating event un-applied.
      await db.delete(question_block).where(eq(question_block.id, blockId));
    }
    // else: fold-blind pre-event-sourced block — keep the imperative row (NEVER delete).
    return;
  }
  await upsertProjectedQuestionBlock(db, projected);
}

// Upsert every fold-truth column except the legacy `extracted_prompt_md`, which stays
// untouched on conflict.
async function upsertProjectedQuestionBlock(
  db: DbLike,
  projected: QuestionBlockRowSnapshotT,
): Promise<void> {
  const set = {
    ingestion_session_id: projected.ingestion_session_id,
    source_document_id: projected.source_document_id,
    source_asset_ids: projected.source_asset_ids,
    page_spans: projected.page_spans,
    // 快照可能仍是 legacy|v2 联合；列运行时存 JSONB，TS 窄类型经 cast 透传。
    structured: projected.structured as typeof question_block.$inferInsert.structured,
    figures: projected.figures,
    layout_quality: projected.layout_quality,
    reference_md: projected.reference_md,
    wrong_answer_md: projected.wrong_answer_md,
    image_refs: projected.image_refs,
    crop_refs: projected.crop_refs,
    visual_complexity: projected.visual_complexity,
    extraction_confidence: projected.extraction_confidence,
    status: projected.status,
    knowledge_hint: projected.knowledge_hint,
    merged_from_block_ids: projected.merged_from_block_ids,
    imported_question_id: projected.imported_question_id,
    imported_attempt_event_id: projected.imported_attempt_event_id,
    created_at: projected.created_at,
    updated_at: projected.updated_at,
    version: projected.version,
  } satisfies Partial<typeof question_block.$inferInsert>;
  await db
    .insert(question_block)
    .values({ id: projected.id, ...set } as typeof question_block.$inferInsert)
    .onConflictDoUpdate({
      target: question_block.id,
      set,
    });
}
