// YUK-471 W3-C1δ — the question_block CREATE-event writer seam (additive double-write).
//
// Every runtime `question_block` creation site (applyExtractionResult OCR INSERT / applyRescue
// overwrite / docx-ingestion INSERT / import virtual-card INSERT) ALSO emits a self-sufficient
// canonical `experimental:question_block_create` event in the SAME transaction so the W3-B2 fold
// (foldQuestionBlock) can reproduce the row from the event log. ADDITIVE: the imperative INSERT/
// UPDATE stays the row writer (the per-entity projectionIsWriter('question_block') flag stays OFF in
// this lane); this only appends the create event + carries the FULL row snapshot (full-snapshot rule
// — the fold cannot rebuild a row from the id-only ExtractSourceDocument payload).
//
// SAME-TX ROLLBACK NOTE: writeEvent() runs parseEvent() → QuestionBlockCreateExperimental →
// QuestionBlockRowSnapshot.strict(), which THROWS on a malformed payload INSIDE the caller's tx. So
// the snapshot MUST be built from a REAL row (the INSERT/UPDATE `.returning()` result), not a
// hand-assembled object that could drift from DB defaults. A throw here rolls back the imperative
// row write — that is the intended fail-loud barrier (§10 B5), but it means the snapshot's structured
// tree + figure bboxes are now validated against the canonical StructuredQuestion / FigureRef schemas
// (incl. the 0-1 BBox refine) at the write path, where the bare jsonb INSERT did not validate them.

import { newId } from '@/core/ids';
import type { QuestionBlockRowSnapshotT } from '@/core/schema/event/genesis';
import type { Db, Tx } from '@/db/client';
import type { question_block } from '@/db/schema';
import { writeEvent } from '@/server/events/queries';

type QuestionBlockRow = typeof question_block.$inferSelect;

/**
 * Map a LIVE `question_block` row (the `.returning()` shape) → the projected `QuestionBlockRowSnapshot`
 * the create event carries. The ONLY structural difference is the legacy deprecated
 * `extracted_prompt_md` column (DROP deferred to Step 11.5), which the snapshot EXCLUDES (markdown
 * views derive from `structured` at render time, ADR-0002) — every other column is fold truth. Drop
 * it BEFORE the snapshot so `.strict()` (which rejects unknown keys) accepts the payload.
 */
export function questionBlockRowToSnapshot(row: QuestionBlockRow): QuestionBlockRowSnapshotT {
  const { extracted_prompt_md: _legacy, ...snapshot } = row;
  return snapshot as unknown as QuestionBlockRowSnapshotT;
}

export interface WriteQuestionBlockCreateEventParams {
  /** The freshly INSERTed/overwritten row, from `.returning()` (the authoritative after-state). */
  row: QuestionBlockRow;
  /** Creation provenance discriminator (design §3 #6). `rescue` overwrites an existing blockId. */
  origin: 'ocr' | 'rescue' | 'docx' | 'import';
  actorKind: 'agent' | 'user' | 'system';
  actorRef: string;
  /**
   * The SAME `now` the imperative writer stamps `created_at`/`updated_at` with, so the create event's
   * created_at aligns with the row's clock (single-clock model; the fold seeds dates from
   * payload.row, but aligning the event time hardens against a future event-time-reading fold).
   */
  now: Date;
  causedByEventId?: string | null;
}

/**
 * Emit the canonical `experimental:question_block_create` event for one freshly-created row, in the
 * caller's transaction. `ingest_at = now` opts the row OUT of the memory-ingestion outbox (a
 * structural creation is not a memory-worthy activity — mirrors the variant_gen create seam).
 */
export async function writeQuestionBlockCreateEvent(
  tx: Db | Tx,
  params: WriteQuestionBlockCreateEventParams,
): Promise<void> {
  await writeEvent(tx, {
    id: newId(),
    actor_kind: params.actorKind,
    actor_ref: params.actorRef,
    action: 'experimental:question_block_create',
    subject_kind: 'question_block',
    subject_id: params.row.id,
    outcome: 'success',
    payload: { row: questionBlockRowToSnapshot(params.row), origin: params.origin },
    caused_by_event_id: params.causedByEventId ?? undefined,
    created_at: params.now,
    ingest_at: params.now,
  });
}
