// POST /api/questions/quiz-gen: owner manual trigger for quiz_gen question supply.
//
// The nightly supply dispatcher was previously the only enqueue path, so an owner
// who wanted N questions for a KC had to wait for the nightly scan or generate
// inline via copilot. Contract/wiring decisions:
//   · Enqueue reuses the dispatcher's kernel path (enqueueSupplyDispatchJob) —
//     no new pipeline, no new queue.
//   · trigger='manual' + explicit knowledge_id anchor: resolveTrigger never skips
//     a manual run, so nothing silently drops after this route's own validation.
//   · The knowledge read is a REAL read (id + archived_at IS NULL, mirroring
//     resolveTrigger's guards). An empty read is an honest 404 — never phrased
//     as verified, never enqueued.
//   · two-layer count guardrail: warn watermark (response `warning` field,
//     request still accepted) + hard cap (zod `.max`, 400).
//   · material_grounded without EXA_API_KEY → 409: never enqueue a job that is
//     structurally degraded before it starts.
//
// Auth: the /api/* x-internal-token middleware is applied by the composition
// root (server/app.ts); this handler does not re-check it.

import { and, eq, isNull } from 'drizzle-orm';

import { db } from '@/db/client';
import { knowledge } from '@/db/schema';
import { ApiError, errorResponse } from '@/kernel/http';
import { enqueueSupplyDispatchJob } from '@/kernel/supply-dispatch';
import { supplyDispatchWebSearchAvailable } from '@/kernel/supply-dispatch-web-search';
import { QUIZ_GEN_MANUAL_COUNT_WARN, QuizGenTriggerBodySchema } from './quiz-gen-trigger-contracts';

export async function POST(req: Request): Promise<Response> {
  try {
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      throw new ApiError('validation_error', 'request body must be valid JSON', 400);
    }

    const parsed = QuizGenTriggerBodySchema.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError(
        'validation_error',
        parsed.error.issues[0]?.message ?? 'invalid body',
        400,
      );
    }
    const { knowledge_id: knowledgeId, count, generation_method: generationMethod } = parsed.data;

    // Honest existence read (empty → 404, never "verified"). Same archived guard
    // as resolveTrigger: an archived node is treated as missing so a manual run
    // never mounts drafts onto a dead node.
    const rows = await db
      .select({ id: knowledge.id })
      .from(knowledge)
      .where(and(eq(knowledge.id, knowledgeId), isNull(knowledge.archived_at)))
      .limit(1);
    if (rows.length === 0) {
      throw new ApiError(
        'not_found',
        `knowledge point ${knowledgeId} not found (or archived); nothing was enqueued`,
        404,
      );
    }

    // gate shared with the dispatcher: material_grounded must web_fetch_exa real
    // source material, so without EXA_API_KEY the job is structurally degraded —
    // reject, don't enqueue.
    if (generationMethod === 'material_grounded' && !supplyDispatchWebSearchAvailable()) {
      throw new ApiError(
        'generation_method_unavailable',
        'generation_method=material_grounded requires EXA_API_KEY, which is not configured; use closed_book or configure Exa',
        409,
      );
    }

    // Dispatcher's enqueue path (kernel): queue 'quiz_gen', trigger 'manual',
    // explicit knowledge anchor. A null job id means pg-boss did not create the
    // job — fail loudly instead of faking a 202.
    const jobId = await enqueueSupplyDispatchJob('quiz_gen', {
      trigger: 'manual',
      ref_id: knowledgeId,
      knowledge_id: knowledgeId,
      count,
      ...(generationMethod ? { generation_method: generationMethod } : {}),
    });
    if (jobId === null) {
      throw new ApiError(
        'enqueue_failed',
        'pg-boss accepted no job for the manual quiz_gen request; nothing was enqueued',
        502,
      );
    }

    // warn 水位：零干预只告知 — the request went through; surface the cost
    // watermark (2-3 LLM calls per question at verify time).
    const warning =
      count >= QUIZ_GEN_MANUAL_COUNT_WARN
        ? `count=${count} is at/above the manual warning watermark (${QUIZ_GEN_MANUAL_COUNT_WARN}); each question costs 2-3 LLM calls at verify time — the hard cap is enforced per request, not per day`
        : undefined;

    return Response.json(
      {
        status: 'enqueued',
        queue: 'quiz_gen',
        job_id: jobId,
        trigger: 'manual',
        knowledge_id: knowledgeId,
        count,
        ...(generationMethod ? { generation_method: generationMethod } : {}),
        ...(warning ? { warning } : {}),
      },
      { status: 202 },
    );
  } catch (err) {
    return errorResponse(err);
  }
}
