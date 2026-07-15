// YUK-193 — POST /api/questions/[id]/solve
//
// Start a solve session on a question. If rubric_json.reference_solution is
// missing, lazily generate it (spec §3.2). Creates learning_session(type='tutor',
// status='active'). Returns { session_id, generated }.
import { SolveError, startSolveSession } from '@/capabilities/practice/server/solve-session';
import { db } from '@/db/client';
import { deprecatedRouteResponse } from '@/kernel/http';
import { ApiError, errorResponse } from '@/server/http/errors';
import { StartSolveBodySchema } from './question-solve-contracts';

export async function createSolveSession(
  req: Request,
  params: Record<string, string>,
): Promise<Response> {
  try {
    const { id } = params;
    const raw = await req.json().catch(() => null);
    const parsed = StartSolveBodySchema.safeParse(raw);
    if (!parsed.success) {
      return errorResponse(
        new ApiError(
          'validation_error',
          parsed.error.issues
            .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
            .join('; '),
          400,
        ),
      );
    }
    const regenerate = parsed.data ? parsed.data.regenerate : undefined;

    const result = await startSolveSession({ db, questionId: id, regenerate });

    return Response.json({
      session_id: result.sessionId,
      generated: result.generated,
      generation_error: result.generationError,
    });
  } catch (err) {
    if (err instanceof SolveError && err.code === 'question_not_found') {
      return errorResponse(new ApiError('not_found', err.message, 404));
    }
    return errorResponse(err);
  }
}

export async function POST(req: Request, params: Record<string, string>): Promise<Response> {
  return deprecatedRouteResponse(await createSolveSession(req, params), '/api/solve-sessions');
}
