/**
 * Generalized capture enrollment.
 *
 * The capture outcome is a signal routed into LearningRecord (ADR-0024): failure
 * creates a mistake and needs attribution; success/partial create worked-example
 * mastery evidence but no review event, so FSRS does not advance; unanswered creates
 * an open-question item with no attempt. Every payload carries a generated_by
 * provenance marker so the action is traceable and reversible.
 */
import { createId } from '@paralleldrive/cuid2';

import type { Tx } from '@/db/client';
import { writeEvent } from '@/kernel/events';
import { loadAttemptQuestionSnapshot } from '@/kernel/read-models/question-evidence-snapshot';
import { type DocumentUsage, resolveDocumentUsage } from '@/kernel/read-models/usage-policy';
import { createLearningRecord } from '@/kernel/records/queries';

/** The capture outcome signal. `unanswered` = item/material (no attempt). */
export type EnrollOutcome = 'failure' | 'success' | 'partial' | 'unanswered';

/** `ingestion_capture` is user-reviewed; `workflow_judge` is auto-enrolled. */
export type EnrollProvenance = 'ingestion_capture' | 'workflow_judge';

export interface EnrollCapturedBlockInput {
  /** The question row this capture enrolls against. */
  questionId: string;
  /** The capture outcome signal. */
  outcome: EnrollOutcome;
  /** Markdown of the visible/handwritten answer. Empty/"" for unanswered. */
  answerMd: string;
  /** Answer-area asset ids derived from page_spans(role='answer_area'). */
  answerImageRefs: string[];
  /** Knowledge ids picked for this block. */
  knowledgeIds: string[];
  /** All image refs for the block (for the record's asset_refs). */
  imageRefs: string[];
  /** Capture mode for the LearningRecord. */
  captureMode: 'text' | 'image' | 'paper' | 'voice' | 'url' | 'mixed';
  /** Source document the capture came from. */
  sourceDocumentId: string;
  /**
   * Resolved document usage per session. Batch callers should resolve once and pass
   * it down; the fallback lookup costs one unindexed session read per block.
   */
  docUsage?: DocumentUsage;
  /** Wall-clock timestamp shared with the route's batch. */
  now: Date;
  /** Provenance marker written into the event payload; defaults to user-reviewed. */
  generatedBy?: EnrollProvenance;
  /** Native activation already owns this immutable participation anchor. */
  nativeAttemptEventId?: string;
}

export interface EnrollCapturedBlockResult {
  /**
   * Null for unanswered captures. For failures this is the legacy `mistake_id`
   * token returned to clients.
   */
  attemptEventId: string | null;
  /** The learning_record id created for this capture. */
  recordId: string;
  /** Only failures need attribution_followup; others have no cause to attribute. */
  needsAttribution: boolean;
}

const RECORD_KIND_BY_OUTCOME: Record<
  EnrollOutcome,
  'mistake' | 'worked_example' | 'open_question'
> = {
  failure: 'mistake',
  success: 'worked_example',
  partial: 'worked_example',
  unanswered: 'open_question',
};

/**
 * Enrolls one captured block inside the caller's transaction so writes stay atomic
 * with the question and block updates.
 */
export async function enrollCapturedBlock(
  tx: Tx,
  input: EnrollCapturedBlockInput,
): Promise<EnrollCapturedBlockResult> {
  const recordKind = RECORD_KIND_BY_OUTCOME[input.outcome];
  // Provenance separates human-reviewed captures from workflow-judge enrollments.
  const generatedBy: EnrollProvenance = input.generatedBy ?? 'ingestion_capture';

  // Capture events carry document-derived text, so they inherit the document's
  // usage. The write-time policy covers payload reads, and the session id lets the
  // shared filter apply a later consent withdrawal.
  const docUsage = input.docUsage ?? (await resolveDocumentUsage(tx, input.sourceDocumentId));
  const derivationPolicy = docUsage.policy;
  const policyField = derivationPolicy === 'allow' ? {} : { derivation_policy: derivationPolicy };

  // Unanswered: material only, no attempt event.
  if (input.outcome === 'unanswered') {
    const recordId = createId();
    // Trace the item-bank capture without fabricating an attempt.
    const captureEventId = createId();
    await writeEvent(tx, {
      id: captureEventId,
      session_id: docUsage.sessionId,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'experimental:record_capture',
      subject_kind: 'record',
      subject_id: recordId,
      outcome: 'success',
      payload: {
        record_kind: recordKind,
        activity_kind: 'import',
        capture_mode: input.captureMode,
        summary_md: input.answerMd.slice(0, 500),
        generated_by: generatedBy,
        enroll_outcome: input.outcome,
        ...policyField,
      },
      caused_by_event_id: null,
      task_run_id: null,
      cost_micro_usd: null,
      created_at: input.now,
    });

    await createLearningRecord(tx, {
      id: recordId,
      kind: recordKind,
      title: null,
      content_md: input.answerMd.length > 0 ? input.answerMd : '(captured question — no answer)',
      source: 'import',
      capture_mode: input.captureMode,
      activity_kind: 'import',
      processing_status: 'raw',
      origin_event_id: captureEventId,
      knowledge_ids: input.knowledgeIds,
      question_id: input.questionId,
      attempt_event_id: null,
      source_document_id: input.sourceDocumentId,
      asset_refs: [...input.imageRefs, ...input.answerImageRefs],
      payload: {
        enroll_outcome: input.outcome,
        generated_by: generatedBy,
        ...policyField,
      },
    });

    return { attemptEventId: null, recordId, needsAttribution: false };
  }

  // Failure / success / partial: a real attempt event. Success feeds mastery but
  // does not advance FSRS because no review event is written (ADR-0024).
  const attemptEventId = input.nativeAttemptEventId ?? createId();
  if (!input.nativeAttemptEventId) {
    const questionSnapshot = await loadAttemptQuestionSnapshot(tx, input.questionId);
    await writeEvent(tx, {
      id: attemptEventId,
      session_id: docUsage.sessionId,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'attempt',
      subject_kind: 'question',
      subject_id: input.questionId,
      outcome: input.outcome,
      payload: {
        answer_md: input.answerMd,
        answer_image_refs: input.answerImageRefs,
        referenced_knowledge_ids: input.knowledgeIds,
        question_snapshot: questionSnapshot,
        generated_by: generatedBy,
        ...policyField,
      },
      caused_by_event_id: null,
      task_run_id: null,
      cost_micro_usd: null,
      created_at: input.now,
    });
  }

  // Mirror the mistakes write path so the capture is visible in mistakes or
  // records. The attempt event id is also the record's origin and attempt link.
  const recordId = createId();
  await createLearningRecord(tx, {
    id: recordId,
    kind: recordKind,
    title: null,
    content_md: input.answerMd,
    source: 'import',
    capture_mode: input.captureMode,
    activity_kind: 'attempt',
    processing_status: 'raw',
    origin_event_id: attemptEventId,
    knowledge_ids: input.knowledgeIds,
    question_id: input.questionId,
    attempt_event_id: attemptEventId,
    source_document_id: input.sourceDocumentId,
    asset_refs: [...input.imageRefs, ...input.answerImageRefs],
    payload:
      input.outcome === 'failure'
        ? {
            wrong_answer_md: input.answerMd,
            wrong_answer_image_refs: input.answerImageRefs,
            enroll_outcome: input.outcome,
            generated_by: generatedBy,
          }
        : {
            answer_md: input.answerMd,
            answer_image_refs: input.answerImageRefs,
            enroll_outcome: input.outcome,
            generated_by: generatedBy,
          },
  });

  return {
    attemptEventId,
    recordId,
    needsAttribution: input.outcome === 'failure',
  };
}
