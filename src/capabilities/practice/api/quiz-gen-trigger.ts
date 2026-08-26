// YUK-605 ① + YUK-555 — POST /api/questions/quiz-gen: owner manual trigger for
// quiz_gen question supply.
//
// Until this route the ONLY enqueue path was the nightly supply dispatcher
// (question-supply/dispatcher.ts) — an owner who wanted N questions for a KC had
// to wait for the nightly scan or generate inline via copilot. This is the thin
// consumption entry the codebase already referenced in three comments + ADR-0038.
//
// Design: docs/superpowers/specs/2026-06-02-quizgen-search-grounded-design.md §4/Q4
// — validate → enqueue `quiz_gen` → 202. Contract/wiring decisions:
//   · Enqueue reuses the dispatcher's kernel path (enqueueSupplyDispatchJob,
//     src/kernel/supply-dispatch.ts) — no new pipeline, no new queue.
//   · trigger='manual' + explicit knowledge_id anchor: the quiz_gen handler's
//     resolveTrigger never skips a manual run, so nothing silently drops after
//     this route's own validation.
//   · The knowledge read is a REAL read (id + archived_at IS NULL, mirroring
//     resolveTrigger's guards). An empty read is an honest 404 — never phrased
//     as verified, never enqueued.
//   · YUK-555 two-layer count guardrail: warn watermark (response `warning`
//     field, request still accepted) + hard cap (zod `.max`, 400).
//   · material_grounded without TAVILY_API_KEY → 409 (dispatcher FINDING #5:
//     never enqueue a job that is structurally degraded before it starts).
//
// Auth: the /api/* x-internal-token middleware is applied by the composition
// root (server/app.ts); this handler does not re-check it.

import { and, eq, isNull } from 'drizzle-orm';

import { db } from '@/db/client';
import { knowledge } from '@/db/schema';
import { ApiError, errorResponse } from '@/kernel/http';
import { enqueueSupplyDispatchJob } from '@/kernel/supply-dispatch';
import { supplyDispatchTavilyAvailable } from '@/kernel/supply-dispatch-tavily';
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
    // as resolveTrigger (jobs/quiz_gen.ts F2): an archived node is treated as
    // missing so a manual run never mounts drafts onto a dead node.
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

    // FINDING #5 gate (single-truth predicate shared with the dispatcher):
    // material_grounded must tavily_extract real source material, so without
    // TAVILY_API_KEY the job is structurally degraded — reject, don't enqueue.
    if (generationMethod === 'material_grounded' && !supplyDispatchTavilyAvailable()) {
      throw new ApiError(
        'generation_method_unavailable',
        'generation_method=material_grounded requires TAVILY_API_KEY, which is not configured; use closed_book or configure Tavily',
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

    // YUK-555 warn 水位：零干预只告知 — the request went through; surface the
    // cost watermark (2-3 LLM calls per question at verify time after YUK-554).
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
