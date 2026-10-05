// Native solve input; legacy endpoint delegates to the same issued-snapshot contract.
import { SolveError, submitSolveAttempt } from '@/capabilities/practice/server/solve-session';
import { db } from '@/db/client';
import { ApiError, deprecatedRouteResponse, errorResponse } from '@/kernel/http';
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
      ...(result.status ? { status: result.status, assessment: result.assessment } : {}),
      attempt_event_id: result.attempt_event_id,
      judge: result.judge,
      revealed_solution_md: result.revealed_solution_md,
      ...(result.mistake_id !== undefined ? { mistake_id: result.mistake_id } : {}),
    });
  } catch (err) {
    if (err instanceof SolveError) {
      if (err.code === 'session_not_found' || err.code === 'question_not_found') {
        return errorResponse(new ApiError('not_found', err.message, 404));
      }
      if (err.code === 'session_not_active') {
        return errorResponse(new ApiError('conflict', err.message, 409));
      }
    }
    return errorResponse(err);
  }
}

export async function POST(req: Request, params: Record<string, string>): Promise<Response> {
  const response = await createSolveSubmission(req, params);
  return deprecatedRouteResponse(response, `/api/solve-sessions/${params.sid}/submissions`);
}
