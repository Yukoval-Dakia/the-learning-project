// Create-event seam for `question_block`. Every creation path also emits a complete
// canonical create event in the same transaction so the fold can rebuild the row. The
// payload carries the full row snapshot because the fold cannot rebuild from an
// id-only source payload. The snapshot must come from the real `.returning()` row; a
// malformed payload throws inside the caller's transaction and rolls back the write.

import { newId } from '@/core/ids';
import type { QuestionBlockRowSnapshotT } from '@/core/schema/event/genesis';
import type { Db, Tx } from '@/db/client';
import type { question_block } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { resolveSessionDerivationPolicy } from '@/kernel/read-models/usage-policy';

type QuestionBlockRow = typeof question_block.$inferSelect;

/**
 * Map a live row to the create-event snapshot. Excludes `extracted_prompt_md` (legacy;
 * markdown derives from `structured`) and `ordinal` (positional metadata the fold does
 * not own), so the strict snapshot parse accepts the payload.
 */
export function questionBlockRowToSnapshot(row: QuestionBlockRow): QuestionBlockRowSnapshotT {
  const { extracted_prompt_md: _legacy, ordinal: _ordinal, ...snapshot } = row;
  return snapshot as unknown as QuestionBlockRowSnapshotT;
}

export interface WriteQuestionBlockCreateEventParams {
  /** The freshly inserted/overwritten row, from `.returning()`. */
  row: QuestionBlockRow;
  /** Creation provenance; `rescue` overwrites an existing blockId. */
  origin: 'ocr' | 'rescue' | 'docx' | 'import' | 'edit_draft';
  actorKind: 'agent' | 'user' | 'system';
  actorRef: string;
  /** The same `now` the imperative writer used, so the event clock matches the row. */
  now: Date;
  causedByEventId?: string | null;
}

/**
 * Emit the canonical create event for one freshly created row in the caller's transaction.
 * `ingest_at = now` opts the row out of the memory outbox.
 */
export async function writeQuestionBlockCreateEvent(
  tx: Db | Tx,
  params: WriteQuestionBlockCreateEventParams,
): Promise<void> {
  // The snapshot carries extracted document text, so the event inherits the session's
  // usage policy. 'answer_only' keeps it out of memory/brief reads; ingest_at already
  // opts the row out of the outbox.
  const derivationPolicy = params.row.ingestion_session_id
    ? await resolveSessionDerivationPolicy(tx, params.row.ingestion_session_id)
    : 'allow';
  await writeEvent(tx, {
    id: newId(),
    // Bind the event to the ingestion session so reads resolve the live usage policy;
    // consent withdrawal applies retroactively via the session→document join.
    session_id: params.row.ingestion_session_id,
    actor_kind: params.actorKind,
    actor_ref: params.actorRef,
    action: 'experimental:question_block_create',
    subject_kind: 'question_block',
    subject_id: params.row.id,
    outcome: 'success',
    payload: {
      row: questionBlockRowToSnapshot(params.row),
      origin: params.origin,
      ...(derivationPolicy === 'allow' ? {} : { derivation_policy: derivationPolicy }),
    },
    caused_by_event_id: params.causedByEventId ?? undefined,
    created_at: params.now,
    ingest_at: params.now,
  });
}
