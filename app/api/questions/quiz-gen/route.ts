// Q4 — POST /api/questions/quiz-gen.
//
// docs/superpowers/specs/2026-06-02-quizgen-search-grounded-design.md §4.
//
// Thin trigger endpoint behind the x-internal-token middleware (middleware.ts
// rejects every /api/* without the internal token — single-user tool, no
// per-user auth here). Validates the body, enqueues a `quiz_gen` pg-boss job,
// and returns 202 Accepted. Manual-first: auto-trigger on weak-cause is a later
// slice (§4 / §6). The expensive tool-calling QuizGenTask agent runs in the
// worker process, not in this request.

import { z } from 'zod';

import { getStartedBoss } from '@/server/boss/client';
import { QUIZ_GEN_TRIGGERS } from '@/server/boss/handlers/quiz_gen';
import { ApiError, errorResponse } from '@/server/http/errors';

export const runtime = 'nodejs';

const Body = z.object({
  trigger: z.enum(QUIZ_GEN_TRIGGERS),
  ref_id: z.string().min(1, 'ref_id is required'),
  // §4 — optional; the handler defaults to QUIZ_GEN_DEFAULT_COUNT (3) when
  // absent. Upper bound mirrors the QuizGenOutput.questions max (10).
  count: z.number().int().min(1).max(10).optional(),
});

export async function POST(req: Request): Promise<Response> {
  try {
    const raw = await req.json().catch(() => null);
    const parsed = Body.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError(
        'validation_error',
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        400,
      );
    }
    const { trigger, ref_id, count } = parsed.data;

    // getStartedBoss: pg-boss v12 requires start() before send() (YUK-192).
    const boss = await getStartedBoss();
    const jobId = await boss.send('quiz_gen', {
      trigger,
      ref_id,
      // Only forward count when provided so the handler applies its own default.
      ...(count !== undefined ? { count } : {}),
    });

    return Response.json({ enqueued: true, job_id: jobId }, { status: 202 });
  } catch (err) {
    return errorResponse(err);
  }
}
