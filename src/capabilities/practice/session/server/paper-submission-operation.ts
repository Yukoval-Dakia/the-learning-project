import { buildCrisisReferral } from '@/core/crisis/referral';
import type { Db } from '@/db/client';
import { ApiError } from '@/kernel/http';
import {
  CreatePaperSubmissionBodySchema,
  LegacyPaperSubmissionBodySchema,
} from '../../api/paper-contracts';
import { readAttemptCrisisMark } from '../../grading/public';
import { submitPaperSlot } from './paper-submit';

export async function createPracticePaperSubmission(db: Db, sessionId: string, raw: unknown) {
  const parsed = CreatePaperSubmissionBodySchema.safeParse(raw);
  if (!parsed.success) {
    throw new ApiError(
      'validation_error',
      parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
      400,
    );
  }
  const { paper_id: paperId, ...body } = parsed.data;
  // Preserve the resource adapter's original JSON forwarding normalization.
  const legacyBody = JSON.parse(JSON.stringify({ ...body, session_id: sessionId }));
  return submitLegacyPaperSubmission(db, paperId, legacyBody);
}

export async function submitLegacyPaperSubmission(db: Db, paperArtifactId: string, raw: unknown) {
  const parsed = LegacyPaperSubmissionBodySchema.safeParse(raw);
  if (!parsed.success) {
    const message = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new ApiError('validation_error', message, 400);
  }
  const body = parsed.data;

  const result = await submitPaperSlot(
    {
      sessionId: body.session_id,
      paperArtifactId,
      questionId: body.question_id,
      partRef: body.part_ref,
      assessment: body.assessment,
      answerMd: body.answer_md,
      answerImageRefs: body.image_refs,
      latencyMs: body.latency_ms,
      reasoningTrace: body.reasoning_trace,
      selfConfidence: body.self_confidence,
    },
    db,
  );
  // Same persisted mark as the review-answer response — read, never re-classify.
  // Additive on a committed attempt: a mark-read failure omits the referral,
  // it must not turn the successful submission into a 500.
  let crisisMark: Awaited<ReturnType<typeof readAttemptCrisisMark>>;
  try {
    crisisMark = await readAttemptCrisisMark(db, result.attemptEventId);
  } catch (error) {
    console.error('[paper-submission] crisis mark read failed; submission kept', error);
    crisisMark = null;
  }
  const crisis_referral = crisisMark ? buildCrisisReferral(crisisMark) : undefined;
  const identity = {
    attempt_event_id: result.attemptEventId,
    judge_event_id: null,
    evaluation_id: result.evaluationId,
    answer_id: result.answerId,
    ...(crisis_referral ? { crisis_referral } : {}),
  };
  return result.visibleToUser
    ? {
        ...identity,
        status: result.status,
        visible_to_user: true,
        coarse_outcome: result.coarseOutcome,
        score: result.score,
        ...(result.partialUnits ? { partial_units: result.partialUnits } : {}),
      }
    : { ...identity, visible_to_user: false, feedback_buffered: true };
}
