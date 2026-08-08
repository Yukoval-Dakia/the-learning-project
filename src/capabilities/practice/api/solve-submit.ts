// YUK-193 — POST /api/questions/[id]/solve/[sid]/submit
//
// Submit a solution: typed steps/answer OR a handwritten photo (student_image_refs
// = asset ids from a prior POST /api/assets upload). At least one carrier must be
// non-empty (Math MVP constraint). Routes by question.kind to steps@1 / semantic@1
// via the orchestrator's JudgeInvoker, writes an attempt event, transitions the
// session to judged, reveals the worked solution, and enrolls a mistake on a low
// score. Failure-learning follow-up is owned by the practice attempt-event
// subscription; this request path only commits the product fact.
import { SolveError, submitSolveAttempt } from '@/capabilities/practice/server/solve-session';
import { db } from '@/db/client';
import { deprecatedRouteResponse } from '@/kernel/http';
import { ApiError, errorResponse } from '@/kernel/http';
import { SolveSubmissionBodySchema } from './question-solve-contracts';

export async function createSolveSubmission(
  req: Request,
  params: Record<string, string>,
): Promise<Response> {
  try {
    const { id, sid } = params;
    const raw = await req.json().catch(() => null);
    const parsed = SolveSubmissionBodySchema.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError(
        'validation_error',
        parsed.error.issues.map((i) => i.message).join('; '),
        400,
      );
    }

    const result = await submitSolveAttempt({
      db,
      sessionId: sid,
      submission: parsed.data,
      expectedQuestionId: id,
      hintsUsed: parsed.data.hints_used,
      finalHintLevel: parsed.data.final_hint_level,
    });

    return Response.json({
      attempt_event_id: result.attempt_event_id,
      judge: result.judge,
      revealed_solution_md: result.revealed_solution_md,
      ...(result.mistake_id !== undefined ? { mistake_id: result.mistake_id } : {}),
    });
  } catch (err) {
    if (err instanceof SolveError) {
      if (err.code === 'empty_submission') {
        return errorResponse(new ApiError('validation_error', err.message, 400));
      }
      if (err.code === 'session_not_found' || err.code === 'question_not_found') {
        return errorResponse(new ApiError('not_found', err.message, 404));
      }
      if (err.code === 'session_not_active') {
        return errorResponse(new ApiError('conflict', err.message, 409));
      }
      if (err.code === 'question_evidence_unavailable') {
        return errorResponse(new ApiError('question_evidence_unavailable', err.message, 409));
      }
    }
    return errorResponse(err);
  }
}

export async function POST(req: Request, params: Record<string, string>): Promise<Response> {
  const response = await createSolveSubmission(req, params);
  return deprecatedRouteResponse(response, `/api/solve-sessions/${params.sid}/submissions`);
}
