import type { Db } from '@/db/client';
import { ApiError } from '@/kernel/http';
import {
  CreatePaperSubmissionBodySchema,
  LegacyPaperSubmissionBodySchema,
} from '../api/paper-contracts';
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
  const identity = {
    attempt_event_id: result.attemptEventId,
    judge_event_id: null,
    evaluation_id: result.evaluationId,
    answer_id: result.answerId,
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
