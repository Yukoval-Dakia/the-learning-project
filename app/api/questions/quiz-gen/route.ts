// Q4 — POST /api/questions/quiz-gen.
//
// docs/superpowers/specs/2026-06-02-quizgen-search-grounded-design.md §4.
// docs/superpowers/specs/2026-06-05-question-source-expansion-design.md §3.2 (sequence mode).
//
// Thin trigger endpoint behind the x-internal-token middleware (middleware.ts
// rejects every /api/* without the internal token — single-user tool, no
// per-user auth here). Validates the body, enqueues a `quiz_gen` pg-boss job,
// and returns 202 Accepted. Manual-first: auto-trigger on weak-cause is a later
// slice (§4 / §6). The expensive tool-calling QuizGenTask agent runs in the
// worker process, not in this request.
//
// YUK-226 S2-5b — OPT-IN sequence mode (`sequence: true`): instead of the bare
// manual quiz_gen trigger, route the request through the unified §3.2 找题次序
// (runSourcingSequence). Step 1 (existing pool, high tier first) runs SYNC; if it
// satisfies `count` the route returns the existing hits and enqueues NOTHING
// (「能找到人出的题就不自产」). Otherwise it enqueues the tiered background
// production次序 (sourcing → quiz_gen → quiz_gen) per the subject profile's
// per-题型偏好 and returns needs[] markers. The DEFAULT (sequence absent/false)
// keeps the original manual quiz_gen contract verbatim — back-compat preserved.

import { z } from 'zod';

import { getStartedBoss } from '@/server/boss/client';
import { QUIZ_GEN_TRIGGERS } from '@/server/boss/handlers/quiz_gen';
import { ApiError, errorResponse } from '@/server/http/errors';
import { normalizeToCanonicalKind } from '@/subjects/question-kind';

export const runtime = 'nodejs';

const Body = z.object({
  trigger: z.enum(QUIZ_GEN_TRIGGERS),
  ref_id: z.string().min(1, 'ref_id is required'),
  // §4 — optional; the handler defaults to QUIZ_GEN_DEFAULT_COUNT (3) when
  // absent. Upper bound mirrors the QuizGenOutput.questions max (10).
  count: z.number().int().min(1).max(10).optional(),
  // YUK-226 S2-5b — opt into the unified §3.2 找题次序 orchestration. Requires a
  // knowledge_id to query the existing pool (step 1). Subject domain optionally
  // refines the profile route preference. Default false → original quiz_gen trigger.
  sequence: z.boolean().optional(),
  knowledge_id: z.string().min(1).optional(),
  // YUK-226 S2-5b (验证轮 A1) — 接受**两套词表**的合法 kind（持久 QuestionKind 或
  // profile/skill SubjectQuestionKind），规范化到 canonical 后下发。typo / 无效值 → 400
  // 在入口拒掉（而非透传到 worker 永败 job）。
  kind: z
    .string()
    .min(1)
    .refine((v) => normalizeToCanonicalKind(v) !== null, {
      message: 'kind must be a known question kind (QuestionKind or SubjectQuestionKind)',
    })
    .optional(),
  domain: z.string().min(1).optional(),
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
    const { trigger, ref_id, count, sequence, knowledge_id, kind, domain } = parsed.data;

    // ── §3.2 sequence mode ────────────────────────────────────────────────────
    if (sequence) {
      // The unified次序 keys off a knowledge node (step 1 queries the existing pool
      // by knowledge_id). For a 'knowledge' trigger the ref_id IS that node.
      const knowledgeId = knowledge_id ?? (trigger === 'knowledge' ? ref_id : undefined);
      if (!knowledgeId) {
        throw new ApiError(
          'validation_error',
          'sequence mode requires knowledge_id (or trigger=knowledge so ref_id is the knowledge node)',
          400,
        );
      }
      // Lazy import keeps the DB client out of the non-sequence (mock-only) path so
      // the route test's pg-boss mock still satisfies audit-partition.
      const { db } = await import('@/db/client');
      const { runSourcingSequence } = await import('@/server/quiz/sourcing-sequence');
      const result = await runSourcingSequence({
        db,
        knowledgeId,
        trigger,
        refId: ref_id,
        ...(count !== undefined ? { count } : {}),
        // Validated above; normalize to canonical so the sequence + pinned jobs all
        // carry one vocabulary (the persisted QuestionKind).
        kind: kind ? normalizeToCanonicalKind(kind) : null,
        domain: domain ?? null,
      });
      // 验证轮 B — the orchestrator refused to enqueue because the knowledge node is
      // missing/archived. Surface a 4xx instead of a misleading 202 enqueued:[] (the
      // request named a node that can't anchor production).
      if (result.knowledgeNodeMissing) {
        throw new ApiError(
          'validation_error',
          `knowledge node '${knowledgeId}' does not exist or is archived`,
          404,
        );
      }
      return Response.json(
        {
          mode: 'sequence',
          satisfied_from_pool: result.satisfiedFromPool,
          existing: result.existing,
          enqueued: result.enqueued,
          needs: result.needs,
        },
        { status: 202 },
      );
    }

    // ── default: original manual quiz_gen trigger (back-compat) ────────────────
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
