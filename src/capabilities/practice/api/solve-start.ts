// Start a tutor session bound to the already issued assessment snapshot.
import { SolveError, startSolveSession } from '@/capabilities/practice/server/solve-session';
import { db } from '@/db/client';
import { ApiError, deprecatedRouteResponse, errorResponse } from '@/kernel/http';
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

    const result = await startSolveSession({
      db,
      questionId: id,
      issuanceId: parsed.data?.issuance_id,
    });

    return Response.json({
      session_id: result.sessionId,
      ...(parsed.data?.issuance_id
        ? {
            evaluation_group_id: `solve_${result.sessionId}`,
            idempotency_key: `solve_${result.sessionId}`,
          }
        : {}),
      issuance_id: parsed.data?.issuance_id,
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
