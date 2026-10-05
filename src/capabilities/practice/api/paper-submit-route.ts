// Submit one slot using its original issuance and server-frozen feedback policy.
// Accepted responses are immutable; only a native effective evaluation settles learning.
// Buffered replies expose receipt identities without grading feedback.

import { db } from '@/db/client';
import { ApiError, deprecatedRouteResponse, errorResponse } from '@/kernel/http';
import { submitPaperSlot } from '../server/paper-submit';
import { LegacyPaperSubmissionBodySchema } from './paper-contracts';

export async function createPaperSubmission(
  req: Request,
  params: Record<string, string>,
): Promise<Response> {
  try {
    const { id: paperArtifactId } = params;
    const raw = await req.json().catch(() => null);
    const parsed = LegacyPaperSubmissionBodySchema.safeParse(raw);
    if (!parsed.success) {
      const message = parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
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
    return Response.json(
      result.visibleToUser
        ? {
            ...identity,
            status: result.status,
            visible_to_user: true,
            coarse_outcome: result.coarseOutcome,
            score: result.score,
          }
        : { ...identity, visible_to_user: false, feedback_buffered: true },
    );
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: Request, params: Record<string, string>): Promise<Response> {
  const body = (await req
    .clone()
    .json()
    .catch(() => null)) as { session_id?: unknown } | null;
  const successor =
    typeof body?.session_id === 'string' && body.session_id.length > 0
      ? `/api/review-sessions/${body.session_id}/submissions`
      : '/api/review-sessions';
  return deprecatedRouteResponse(await createPaperSubmission(req, params), successor);
}
