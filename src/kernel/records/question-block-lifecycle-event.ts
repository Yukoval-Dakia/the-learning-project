// question_block lifecycle-event writer (additive double-write).
//
// The imperative UPDATE stays the row writer; this appends the AFTER-values of
// only the touched columns so foldQuestionBlock can reproduce the row. The payload
// is presence-based: omitted leaves a column unchanged, explicit null clears it.
// writeEvent parses inside the caller's transaction, so a malformed payload rolls
// back the paired UPDATE; build figures from the same array the UPDATE set.

import { newId } from '@/core/ids';
import type { FigureRefT } from '@/core/schema/structured_question';
import type { Db, Tx } from '@/db/client';
import { writeEvent } from '@/kernel/events';

export interface WriteQuestionBlockLifecycleEventParams {
  /** Mutated block id (= event subject_id). */
  blockId: string;
  /** Which fold-truth columns the UPDATE touched. */
  op: 'reassign_figures' | 'set_status';
  /** op='reassign_figures': the FULL re-pointed figures array (the `.set({ figures })` value). */
  figures?: FigureRefT[];
  /** op='set_status': the new status ('draft' | 'imported' | 'auto_enrolled' | 'ignored' | …). */
  status?: string;
  /** After UPDATE. Omit to leave unchanged; explicit null clears it. */
  importedQuestionId?: string | null;
  /** After UPDATE; same omit/null/string semantics as importedQuestionId. */
  importedAttemptEventId?: string | null;
  /** Version stamped by the UPDATE; folded verbatim as next_version. */
  nextVersion: number;
  actorKind: 'agent' | 'user' | 'system';
  actorRef: string;
  /** Same `now` the UPDATE writes to updated_at; the fold uses the event's created_at,
   * so they must match for byte-exact parity. */
  now: Date;
  causedByEventId?: string | null;
}

/**
 * Emit the lifecycle event in the caller's transaction. `ingest_at = now` keeps
 * structural status/figure mutations out of memory ingestion.
 */
export async function writeQuestionBlockLifecycleEvent(
  tx: Db | Tx,
  params: WriteQuestionBlockLifecycleEventParams,
): Promise<void> {
  const payload: Record<string, unknown> = { op: params.op, next_version: params.nextVersion };
  if (params.figures !== undefined) payload.figures = params.figures;
  if (params.status !== undefined) payload.status = params.status;
  if (params.importedQuestionId !== undefined)
    payload.imported_question_id = params.importedQuestionId;
  if (params.importedAttemptEventId !== undefined) {
    payload.imported_attempt_event_id = params.importedAttemptEventId;
  }

  await writeEvent(tx, {
    id: newId(),
    actor_kind: params.actorKind,
    actor_ref: params.actorRef,
    action: 'experimental:question_block_lifecycle',
    subject_kind: 'question_block',
    subject_id: params.blockId,
    outcome: 'success',
    payload,
    caused_by_event_id: params.causedByEventId ?? undefined,
    created_at: params.now,
    ingest_at: params.now,
  });
}
