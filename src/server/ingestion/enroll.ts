/**
 * Generalized capture enrollment — T-OC slice 1 (YUK-145, OC-3 + OC-5).
 *
 * See ADR-0024 + `docs/superpowers/plans/2026-05-30-yuk145-toc-slice1-lane.md`.
 *
 * PREVIOUSLY: `app/api/ingestion/[id]/import` hardcoded, for every imported
 * block, an `attempt(outcome='failure')` event + a `learning_record(kind=
 * 'mistake')` — i.e. the import model assumed "capture == mistake".
 *
 * NOW: the capture's `outcome` is a SIGNAL and this module routes it into the
 * generalized `LearningRecord` (mirrors /api/records 泛化录入):
 *   - failure    → attempt(outcome='failure') + LearningRecord(kind='mistake')
 *                  + needsAttribution=true (existing attribution→variant chain).
 *   - success    → attempt(outcome='success') + LearningRecord(kind='worked_example').
 *                  Feeds the knowledge_mastery derived view (ADR-0012) as
 *                  positive mastery evidence. Does NOT write a `review` event,
 *                  so FSRS schedule is NOT advanced (conservative semantics —
 *                  ADR-0024 §"ADR-0012 正向 signal 语义").
 *   - partial    → attempt(outcome='partial') + LearningRecord(kind='worked_example').
 *   - unanswered → NO attempt event; LearningRecord(kind='open_question')
 *                  (item bank / to-practice) + a capture provenance event.
 *
 * OC-5 evidence-first: every enrolled item's event payload carries a
 * `generated_by` provenance marker so the action is traceable + reversible.
 * Slice 1 captures are user-reviewed → `generated_by='ingestion_capture'`.
 * Slice 3's WorkflowJudge auto-enroll path passes `generatedBy='workflow_judge'`
 * (the `generatedBy` input below is now WIRED — see
 * `src/server/ingestion/auto-enroll.ts`). The DEFERRED "AI auto-enrolled N items"
 * review surface (slice 3b) reads this marker to show what the judge auto-enrolled
 * — see `docs/superpowers/plans/2026-05-30-yuk145-toc-slice3-lane.md` §DEFERRED.
 */
import { createId } from '@paralleldrive/cuid2';

import type { Tx } from '@/db/client';
import { writeEvent } from '@/server/events/queries';
import { createLearningRecord } from '@/server/records/queries';

/** The capture outcome signal. `unanswered` = item/material (no attempt). */
export type EnrollOutcome = 'failure' | 'success' | 'partial' | 'unanswered';

/**
 * Provenance marker (OC-5). `ingestion_capture` = user-reviewed capture (slice 1,
 * the default). `workflow_judge` = WorkflowJudge auto-enrolled this block without
 * human review (slice 3, `src/server/ingestion/auto-enroll.ts`). The marker lands
 * in the event payload so the action is traceable + reversible.
 */
export type EnrollProvenance = 'ingestion_capture' | 'workflow_judge';

export interface EnrollCapturedBlockInput {
  /** The question row this capture enrolls against. */
  questionId: string;
  /** The capture outcome signal (OC-3). */
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
  /** Wall-clock timestamp shared with the route's batch. */
  now: Date;
  /**
   * OC-5 provenance marker written into the event payload. Defaults to
   * `'ingestion_capture'` (user-reviewed capture) so existing callers (the human
   * import route) are byte-for-byte unchanged. The slice-3 auto-enroll path
   * passes `'workflow_judge'`. See `EnrollProvenance` + ADR-0026.
   */
  generatedBy?: EnrollProvenance;
}

export interface EnrollCapturedBlockResult {
  /**
   * The attempt event id for failure/success/partial captures, or null for
   * `unanswered` (no attempt event written). For failure captures this is the
   * opaque back-compat `mistake_id` token the route returns to clients.
   */
  attemptEventId: string | null;
  /** The learning_record id created for this capture. */
  recordId: string;
  /**
   * True only for failure captures — the route should queue the existing
   * attribution_followup for these. Never queued for success/partial/unanswered
   * (no failure cause to attribute).
   */
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
 * Enrolls one captured block. Must run inside the import route's transaction so
 * the writes commit atomically with the question / question_block writes.
 */
export async function enrollCapturedBlock(
  tx: Tx,
  input: EnrollCapturedBlockInput,
): Promise<EnrollCapturedBlockResult> {
  const recordKind = RECORD_KIND_BY_OUTCOME[input.outcome];
  // OC-5 provenance (WIRED in slice 3). Default 'ingestion_capture' = the
  // human import route (user-reviewed). The auto-enroll path
  // (src/server/ingestion/auto-enroll.ts) passes 'workflow_judge' so its
  // events are distinguishable + reversible. See ADR-0026 + lane plan §6.
  const generatedBy: EnrollProvenance = input.generatedBy ?? 'ingestion_capture';

  // ---- unanswered: question/material, no attempt event ----
  if (input.outcome === 'unanswered') {
    const recordId = createId();
    // Capture provenance event (OC-5): subject is the record itself; mirrors
    // the /api/records experimental:record_capture path so the item-bank
    // capture is traceable + reversible without fabricating an attempt.
    const captureEventId = createId();
    await writeEvent(tx, {
      id: captureEventId,
      session_id: null,
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
      },
    });

    return { attemptEventId: null, recordId, needsAttribution: false };
  }

  // ---- failure / success / partial: real attempt event on the question ----
  // AttemptOnQuestion already allows outcome ∈ {success, failure, partial}
  // (src/core/schema/event/known.ts) — we simply stop hardcoding 'failure'.
  // A success attempt feeds the knowledge_mastery view (ADR-0012); it does NOT
  // advance FSRS (no `review` event written) — see ADR-0024.
  const attemptEventId = createId();
  await writeEvent(tx, {
    id: attemptEventId,
    session_id: null,
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
      generated_by: generatedBy,
    },
    caused_by_event_id: null,
    task_run_id: null,
    cost_micro_usd: null,
    created_at: input.now,
  });

  // Mirror the /api/mistakes write path so the enrolled capture is visible via
  // GET /api/mistakes (failure) / the records list (success/partial). The
  // attempt event id doubles as the record's origin_event_id + attempt_event_id.
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
