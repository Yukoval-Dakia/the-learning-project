/**
 * Reverts one auto-enrolled block. Revert is append-only (ADR-0019/0024): it checks
 * the block is auto_enrolled, retracts the enrollment's origin event, archives the
 * learning_record, and resets the block to draft with cleared import links. The
 * question row stays as reusable item-bank content; nothing is hard-deleted.
 */
import { createId } from '@paralleldrive/cuid2';
import { and, eq, isNull } from 'drizzle-orm';

import { questionRef } from '@/core/schema/activity';
import type { Db } from '@/db/client';
import { acquireLearningStateWriteLock } from '@/db/learning-state-lock';
import { event, learning_record, question_block } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { ApiError } from '@/kernel/http';
import { withdrawCapturedOccurrence } from '@/kernel/judge';
import { archiveLearningRecord } from '@/kernel/records/queries';
import { applyQuestionBlockTransition } from '@/kernel/records/question-block-transitions';

export interface RevertAutoEnrolledBlockParams {
  blockId: string;
  /** The block MUST belong to this ingestion session (the OC-5 surface is per-session). */
  sessionId: string;
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
    await acquireLearningStateWriteLock(tx);

    // FOR UPDATE serialises concurrent reverts of the same block: the second to
    // acquire the lock re-reads `status='draft'` and cleanly 409s (rather than
    // both passing the guard and writing two retract events).
    const [block] = await tx
      .select()
      .from(question_block)
      .where(eq(question_block.id, params.blockId))
      .for('update')
      .limit(1);
    if (!block) {
      throw new ApiError('not_found', `question_block ${params.blockId} not found`, 404);
    }
    // The OC-5 revert is per-session: the block must belong to the path session,
    // mirroring the import route's source-block ownership check.
    if (block.ingestion_session_id !== params.sessionId) {
      throw new ApiError(
        'not_found',
        `question_block ${params.blockId} not found in session ${params.sessionId}`,
        404,
      );
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
      .where(
        and(
          eq(learning_record.question_id, questionId),
          isNull(learning_record.archived_at),
          block.imported_attempt_event_id
            ? eq(learning_record.attempt_event_id, block.imported_attempt_event_id)
            : undefined,
        ),
      )
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
    const [original] = await tx
      .select({ action: event.action })
      .from(event)
      .where(eq(event.id, retractedEventId));
    if (original?.action === 'experimental:assessment_attempt') {
      await withdrawCapturedOccurrence(tx, {
        originalAttemptEventId: retractedEventId,
        correctionEventId: retractEventId,
        blockId: block.id,
        sessionId: params.sessionId,
        now,
      });
    }
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

    await archiveLearningRecord(tx, record.id, record.version);

    await applyQuestionBlockTransition(
      tx,
      { kind: 'restore_after_revert', blockId: params.blockId },
      now,
    );

    return { questionId, recordId: record.id, retractEventId, retractedEventId };
  });
}
