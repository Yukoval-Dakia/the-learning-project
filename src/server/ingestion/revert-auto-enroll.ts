/**
 * Revert an auto-enrolled block — T-OC slice B1b (YUK-164, OC-5 / D2=A).
 *
 * The OC-5 "AI auto-enrolled N items" surface lets the user undo a WorkflowJudge
 * auto-enrollment. Revert is append-only + evidence-first (ADR-0019/0024): it does
 * NOT hard-delete. In one transaction it
 *   1. asserts the block is `status='auto_enrolled'` (else 404/409),
 *   2. writes one `CorrectEvent(correction_kind='retract')` against the enroll's
 *      origin event (the attempt event for an answered capture, or the
 *      `record_capture` event for an unanswered one) — the retract IS the audit
 *      record,
 *   3. archives the `learning_record` (mirrors `retractAiProposal`),
 *   4. resets the `question_block` → `status='draft'`, NULL `imported_*`,
 * and leaves the `question` row in place (harmless item-bank content, reusable;
 * matches the proposal-retract "set dormant, never hard-delete" posture).
 */
import { createId } from '@paralleldrive/cuid2';
import { and, eq, isNull, sql } from 'drizzle-orm';

import { questionRef } from '@/core/schema/activity';
import type { Db } from '@/db/client';
import { learning_record, question_block } from '@/db/schema';
import { writeEvent } from '@/server/events/queries';
import { ApiError } from '@/server/http/errors';
import { archiveLearningRecord } from '@/server/records/queries';

export interface RevertAutoEnrolledBlockParams {
  blockId: string;
  /** Stored on the retract event (CorrectEvent.reason_md, required, 1-2000 chars). */
  reasonMd?: string;
}

export interface RevertAutoEnrolledBlockResult {
  questionId: string;
  recordId: string;
  retractEventId: string;
  /** The event the retract targets (attempt event, or capture event for unanswered). */
  retractedEventId: string;
}

export async function revertAutoEnrolledBlock(
  db: Db,
  params: RevertAutoEnrolledBlockParams,
): Promise<RevertAutoEnrolledBlockResult> {
  return db.transaction(async (tx) => {
    const now = new Date();

    const [block] = await tx
      .select()
      .from(question_block)
      .where(eq(question_block.id, params.blockId))
      .limit(1);
    if (!block) {
      throw new ApiError('not_found', `question_block ${params.blockId} not found`, 404);
    }
    if (block.status !== 'auto_enrolled') {
      throw new ApiError(
        'conflict',
        `question_block ${params.blockId} is '${block.status}'; only 'auto_enrolled' can be reverted`,
        409,
      );
    }
    const questionId = block.imported_question_id;
    if (!questionId) {
      throw new ApiError(
        'conflict',
        `auto_enrolled block ${params.blockId} has no imported_question_id`,
        409,
      );
    }

    // The auto-enroll path created exactly one active learning_record for this
    // fresh question; find it to locate the origin event + archive it.
    const [record] = await tx
      .select()
      .from(learning_record)
      .where(and(eq(learning_record.question_id, questionId), isNull(learning_record.archived_at)))
      .limit(1);
    if (!record) {
      throw new ApiError(
        'not_found',
        `no active learning_record for auto_enrolled question ${questionId}`,
        404,
      );
    }
    // origin_event_id = the attempt event (answered) or the record_capture event
    // (unanswered) — both are valid retract targets.
    const retractedEventId = record.origin_event_id;
    if (!retractedEventId) {
      throw new ApiError(
        'conflict',
        `learning_record ${record.id} has no origin_event_id to retract`,
        409,
      );
    }

    const retractEventId = createId();
    await writeEvent(tx, {
      id: retractEventId,
      session_id: null,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'correct',
      subject_kind: 'event',
      subject_id: retractedEventId,
      outcome: 'success',
      payload: {
        correction_kind: 'retract',
        reason_md: params.reasonMd ?? 'AI 自动录入项已撤回',
        affected_refs: [questionRef(questionId)],
      },
      caused_by_event_id: retractedEventId,
      task_run_id: null,
      cost_micro_usd: null,
      created_at: now,
    });

    await archiveLearningRecord(tx, record.id);

    await tx
      .update(question_block)
      .set({
        status: 'draft',
        imported_question_id: null,
        imported_attempt_event_id: null,
        updated_at: now,
        version: sql`${question_block.version} + 1`,
      })
      .where(eq(question_block.id, params.blockId));

    return { questionId, recordId: record.id, retractEventId, retractedEventId };
  });
}
