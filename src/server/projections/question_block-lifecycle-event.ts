// YUK-471 W3-D — the question_block LIFECYCLE-event writer seam (additive double-write).
//
// The 5 previously-eventless `question_block` fold-truth mutators ALSO emit a self-sufficient
// canonical `experimental:question_block_lifecycle` event in the SAME transaction so the W3-B2 fold
// (foldQuestionBlock) can reproduce the row from the event log — closing the LAST qb fold-visibility
// gap (the C3 review's question_block flip prerequisite):
//   - reassignFigure          (block-structured-edit.ts) → op='reassign_figures' (figures re-pointed)
//   - runAutoEnrollForSession (auto-enroll.ts)           → op='set_status' (status + imported_*)
//   - import POST (enroll)     (ingestion/api/import.ts)  → op='set_status' (status + imported_*)
//   - import POST (ignore)     (ingestion/api/import.ts)  → op='set_status' (status; imports untouched)
//   - revertAutoEnrolledBlock (revert-auto-enroll.ts)    → op='set_status' (status + imported_* = null)
//
// ADDITIVE: the imperative UPDATE stays the row writer (the per-entity projectionIsWriter('question_block')
// flag stays OFF in this lane); this only appends the lifecycle event carrying the AFTER-values of the
// columns the UPDATE touched. Mirrors writeQuestionBlockCreateEvent (the create-event seam).
//
// PRESENCE-BASED payload (mirror artifact_lifecycle): carry EXACTLY the columns the UPDATE touched. The
// imported_* params distinguish OMITTED (leave the column — the ignore sweep) from an explicit `null`
// (clear — revert); they are placed in the payload only when the caller passes them (incl. null).
//
// SAME-TX ROLLBACK NOTE: writeEvent() runs parseEvent() → QuestionBlockLifecycleExperimental, which
// THROWS on a malformed payload INSIDE the caller's tx (rolling back the imperative write — the
// intended fail-loud barrier, §10 B5). For op='reassign_figures' the carried figures are validated
// against the canonical FigureRef schema (incl. the 0-1 BBox refine), so build them from the SAME array
// the UPDATE set (the `.set({ figures })` value), never a hand-assembled one that could drift.

import { newId } from '@/core/ids';
import type { FigureRefT } from '@/core/schema/structured_question';
import type { Db, Tx } from '@/db/client';
import { writeEvent } from '@/server/events/queries';

export interface WriteQuestionBlockLifecycleEventParams {
  /** The mutated block's id (= the event subject_id). */
  blockId: string;
  /** Which fold-truth columns the UPDATE touched. */
  op: 'reassign_figures' | 'set_status';
  /** op='reassign_figures': the FULL re-pointed figures array (the `.set({ figures })` value). */
  figures?: FigureRefT[];
  /** op='set_status': the new status ('draft' | 'imported' | 'auto_enrolled' | 'ignored' | …). */
  status?: string;
  /**
   * imported_question_id AFTER the UPDATE. Pass a string to set it, `null` to clear it (revert), or
   * OMIT to leave the column unchanged (the ignore sweep). Present (incl. null) ⇒ carried in payload.
   */
  importedQuestionId?: string | null;
  /** imported_attempt_event_id AFTER the UPDATE — same omit/null/string semantics as importedQuestionId. */
  importedAttemptEventId?: string | null;
  /** The version the UPDATE stamped (from `.returning({ version })`) — folded VERBATIM as next_version. */
  nextVersion: number;
  actorKind: 'agent' | 'user' | 'system';
  actorRef: string;
  /** The SAME `now` the imperative writer stamps `updated_at` with (single-clock — the fold sets
   * updated_at = the event's created_at, so they must match for byte-exact parity). */
  now: Date;
  causedByEventId?: string | null;
}

/**
 * Emit the canonical `experimental:question_block_lifecycle` event for one mutated row, in the
 * caller's transaction. `ingest_at = now` opts the row OUT of the memory-ingestion outbox (a
 * structural status/figure mutation is not a memory-worthy activity — mirrors the create seam).
 */
export async function writeQuestionBlockLifecycleEvent(
  tx: Db | Tx,
  params: WriteQuestionBlockLifecycleEventParams,
): Promise<void> {
  const payload: Record<string, unknown> = { op: params.op, next_version: params.nextVersion };
  if (params.figures !== undefined) payload.figures = params.figures;
  if (params.status !== undefined) payload.status = params.status;
  // Present (incl. explicit null) ⇒ carried; absent ⇒ leave the column (the reducer keeps the value).
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
