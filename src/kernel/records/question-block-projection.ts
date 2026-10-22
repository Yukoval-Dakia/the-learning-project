// Write-through shell for the pure `question_block` fold: gather the event superset,
// fold it, then delete or upsert. `extracted_prompt_md` is legacy and not fold truth,
// so it is neither in the snapshot nor written. The shared gather is defined below.

import { and, eq, inArray, sql } from 'drizzle-orm';

import { foldQuestionBlock } from '@/core/projections/question_block';
import type { QuestionBlockRowSnapshotT } from '@/core/schema/event/genesis';
import type { Db, Tx } from '@/db/client';
import { event, question_block } from '@/db/schema';
import { rowToFoldEvent } from '@/kernel/records/projection-events';

type DbLike = Db | Tx;
type EventRow = typeof event.$inferSelect;

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

/**
 * Gather the events affecting `blockId` and run the pure question_block fold. Besides the
 * subject-keyed events, it finds edit events that name this block as an absorbed
 * merged_source; that payload containment form is the one the GIN index accelerates.
 * Returns the projected row or null.
 */
export async function gatherAndFoldQuestionBlock(
  db: DbLike,
  blockId: string,
): Promise<QuestionBlockRowSnapshotT | null> {
  // Q1: events whose subject_id is blockId.
  const q1 = await db
    .select()
    .from(event)
    .where(and(eq(event.subject_kind, 'question_block'), eq(event.subject_id, blockId)));

  // Q2: edits keyed on another primary block that absorbed this block as a merged_source.
  const q2 = await db
    .select()
    .from(event)
    .where(
      and(
        eq(event.action, 'experimental:edit_question_block_structured'),
        sql`${event.payload} @> ${JSON.stringify({ affected_blocks: [{ block_id: blockId }] })}::jsonb`,
      ),
    );

  // Dedup by event id (Q1/Q2 overlap when blockId is the primary of one edit and a merged_source of
  // another).
  const byId = new Map<string, EventRow>();
  for (const r of [...q1, ...q2]) byId.set(r.id, r);

  const foldEvents = [...byId.values()].map(rowToFoldEvent);
  return foldQuestionBlock(blockId, foldEvents);
}

// ── question_block genesis-anchor helpers ─────────────────────────────────────────────────────
//
// A block is event-sourced when it has a create/genesis event. It has no index anchor: the
// row id is always the subject id, so the event leg is complete.

const QUESTION_BLOCK_ANCHOR_ACTIONS = [
  'experimental:genesis',
  'experimental:question_block_create',
] as const;

/** Whether a block has an anchor the fold can reproduce. */
export async function hasQuestionBlockGenesisAnchor(db: DbLike, blockId: string): Promise<boolean> {
  const ev = await db
    .select({ id: event.id })
    .from(event)
    .where(
      and(
        eq(event.subject_kind, 'question_block'),
        eq(event.subject_id, blockId),
        inArray(event.action, [...QUESTION_BLOCK_ANCHOR_ACTIONS]),
      ),
    )
    .limit(1);
  return ev.length > 0;
}

/** Batch form (event leg only); also serves as the idempotency pre-scan. */
export async function questionBlocksWithGenesisAnchor(
  db: DbLike,
  blockIds: string[],
): Promise<Set<string>> {
  const out = new Set<string>();
  if (blockIds.length === 0) return out;
  const evRows = await db
    .select({ subject_id: event.subject_id })
    .from(event)
    .where(
      and(
        eq(event.subject_kind, 'question_block'),
        inArray(event.subject_id, blockIds),
        inArray(event.action, [...QUESTION_BLOCK_ANCHOR_ACTIONS]),
      ),
    );
  for (const r of evRows) out.add(r.subject_id);
  return out;
}
