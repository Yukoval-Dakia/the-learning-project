// YUK-193 — POST /api/questions/[id]/solve/[sid]/submit
//
// Submit a solution: typed steps/answer OR a handwritten photo (student_image_refs
// = asset ids from a prior POST /api/assets upload). At least one carrier must be
// non-empty (Math MVP constraint). Routes by question.kind to steps@1 / semantic@1
// via the orchestrator's JudgeInvoker, writes an attempt event, transitions the
// session to judged, reveals the worked solution, and enrolls a mistake on a low
// score. On failure, enqueues attribution_followup (gated by the shared
// shouldEnqueueBackgroundJobs(), getStartedBoss).
import { z } from 'zod';

import { SolveError, submitSolveAttempt } from '@/capabilities/practice/server/solve-session';
import { db } from '@/db/client';
import { getStartedBoss } from '@/server/boss/client';
import { ApiError, errorResponse } from '@/server/http/errors';
import { shouldEnqueueBackgroundJobs } from '@/server/runtime-env';

export const runtime = 'nodejs';

const Body = z.object({
  student_text_steps: z.array(z.string()).optional(),
  student_final_answer_text: z.string().optional(),
  student_image_refs: z.array(z.string()).optional(),
});

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string; sid: string }> },
): Promise<Response> {
  try {
    const { id, sid } = await ctx.params;
    const raw = await req.json().catch(() => null);
    const parsed = Body.safeParse(raw);
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
    });

    // Enqueue attribution after the response path commits (failure only). Gated
    // by the shared shouldEnqueueBackgroundJobs() (YUK-239), mirroring
    // /api/mistakes + /api/embedded-check/attempt. Uses getStartedBoss
    // (YUK-192), never createBoss.
    if (result.mistake_id !== undefined && shouldEnqueueBackgroundJobs()) {
      try {
        const boss = await getStartedBoss();
        await boss.send('attribution_followup', { attempt_event_id: result.attempt_event_id });
      } catch (err) {
        console.warn(`attribution_followup enqueue failed for ${result.attempt_event_id}:`, err);
      }
    }

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
    }
    return errorResponse(err);
  }
}
