// YUK-193 — POST /api/questions/[id]/solve/[sid]/hint
//
// Request an escalating Socratic hint for an active solve session. Reuses the
// teaching orchestrator's TeachingTurnTask, seeded with the worked solution, to
// return the minimal next step WITHOUT revealing the full solution (spec §3.2).
import { z } from 'zod';

import { db } from '@/db/client';
import { ApiError, errorResponse } from '@/server/http/errors';
import { SolveError, planSolveHint } from '@/server/orchestrator/solve';

export const runtime = 'nodejs';

const Body = z.object({ hint_index: z.number().int().min(0).max(20).default(0) }).nullable();

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string; sid: string }> },
): Promise<Response> {
  try {
    const { id, sid } = await ctx.params;
    const raw = await req.json().catch(() => null);
    const parsed = Body.safeParse(raw);
    const hintIndex = parsed.success && parsed.data ? parsed.data.hint_index : 0;

    const hint = await planSolveHint({ db, sessionId: sid, hintIndex, expectedQuestionId: id });
    return Response.json({ text_md: hint.text_md });
  } catch (err) {
    if (err instanceof SolveError) {
      if (err.code === 'session_not_found' || err.code === 'question_not_found') {
        return errorResponse(new ApiError('not_found', err.message, 404));
      }
      if (err.code === 'session_not_active') {
        return errorResponse(new ApiError('conflict', err.message, 409));
      }
      if (err.code === 'llm_parse_failed') {
        return errorResponse(new ApiError('upstream_error', err.message, 502));
      }
    }
    return errorResponse(err);
  }
}
