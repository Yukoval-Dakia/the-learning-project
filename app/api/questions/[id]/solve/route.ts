// YUK-193 — POST /api/questions/[id]/solve
//
// Start a solve session on a question. If rubric_json.reference_solution is
// missing, lazily generate it (spec §3.2). Creates learning_session(type='tutor',
// status='active'). Returns { session_id, generated }.
import { z } from 'zod';

import { SolveError, startSolveSession } from '@/capabilities/practice/server/solve-session';
import { db } from '@/db/client';
import { ApiError, errorResponse } from '@/server/http/errors';

export const runtime = 'nodejs';

const Body = z.object({ regenerate: z.boolean().optional() }).nullable();

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await ctx.params;
    const raw = await req.json().catch(() => null);
    const parsed = Body.safeParse(raw);
    const regenerate = parsed.success && parsed.data ? parsed.data.regenerate : undefined;

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
