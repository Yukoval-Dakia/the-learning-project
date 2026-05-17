// Phase 2B — Learning Intent declaration endpoint.
//
// POST /api/learning-intents { topic: "..." } → 422 if topic node missing /
// no children, else 200 with proposal.

import { z } from 'zod';

import { db } from '@/db/client';
import { ApiError, errorResponse } from '@/server/http/errors';
import { LearningIntentError, planLearningIntent } from '@/server/orchestrator/learning_intent';

export const runtime = 'nodejs';

const Body = z.object({
  topic: z.string().min(1).max(120),
});

async function defaultRunTaskFn(
  kind: string,
  input: unknown,
  ctx: unknown,
): Promise<{ text: string }> {
  const { runTask } = await import('@/server/ai/runner');
  const result = await runTask(kind, input, ctx as Parameters<typeof runTask>[2]);
  return { text: result.text };
}

export async function POST(req: Request): Promise<Response> {
  try {
    const raw = await req.json().catch(() => null);
    const parsed = Body.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError(
        'validation_error',
        parsed.error.issues.map((i) => i.message).join('; '),
        400,
      );
    }

    try {
      const proposal = await planLearningIntent({
        db,
        topic: parsed.data.topic,
        runTaskFn: defaultRunTaskFn,
      });
      return Response.json(proposal);
    } catch (err) {
      if (err instanceof LearningIntentError) {
        const code = err.code;
        const status = code === 'topic_not_found' || code === 'topic_no_children' ? 422 : 500;
        return Response.json({ error: code, message: err.message }, { status });
      }
      throw err;
    }
  } catch (err) {
    return errorResponse(err);
  }
}
