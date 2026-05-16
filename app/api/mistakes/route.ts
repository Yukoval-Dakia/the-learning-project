import { createId } from '@paralleldrive/cuid2';
import { after } from 'next/server';
import { z } from 'zod';

import { type Cause, CauseCategory, QuestionKind } from '@/core/schema/business';
import { db } from '@/db/client';
import { knowledge, question, source_asset } from '@/db/schema';
import { runTask } from '@/server/ai/runner';
import { getFailureAttempts, writeEvent } from '@/server/events/queries';
import { ApiError, errorResponse } from '@/server/http/errors';
import { runAttributionAndWriteJudgeEvent } from '@/server/knowledge/attribute';
import { runProposeAndWrite } from '@/server/knowledge/propose';
import { loadTreeSnapshot } from '@/server/knowledge/tree';
import { and, desc, inArray, isNull } from 'drizzle-orm';

export const runtime = 'nodejs';

const Body = z.object({
  prompt_md: z.string().min(1, 'prompt_md is required'),
  reference_md: z.string().nullable(),
  wrong_answer_md: z.string().min(1, 'wrong_answer_md is required'),
  knowledge_ids: z.array(z.string().min(1)).min(1, 'at least one knowledge_id is required'),
  cause: z
    .object({
      primary_category: CauseCategory,
      user_notes: z.string().nullable(),
    })
    .nullable(),
  difficulty: z.number().int().min(1).max(5),
  question_kind: QuestionKind,
  prompt_image_refs: z.array(z.string().min(1)).default([]),
  wrong_answer_image_refs: z.array(z.string().min(1)).default([]),
});

async function assertAssetsExist(
  ids: string[],
  field: 'prompt_image_refs' | 'wrong_answer_image_refs',
): Promise<void> {
  if (ids.length === 0) return;
  const found = await db
    .select({ id: source_asset.id })
    .from(source_asset)
    .where(inArray(source_asset.id, ids));
  const foundIds = new Set(found.map((r) => r.id));
  const missing = ids.filter((id) => !foundIds.has(id));
  if (missing.length > 0) {
    throw new ApiError('validation_error', `unknown ${field}: ${missing.join(', ')}`, 400);
  }
}

export async function POST(req: Request): Promise<Response> {
  try {
    const raw = await req.json().catch(() => null);
    const parsed = Body.safeParse(raw);
    if (!parsed.success) {
      const message = parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
      throw new ApiError('validation_error', message, 400);
    }
    const body = parsed.data;

    // Validate knowledge_ids exist and are not archived
    const foundKnowledge = await db
      .select({ id: knowledge.id })
      .from(knowledge)
      .where(and(inArray(knowledge.id, body.knowledge_ids), isNull(knowledge.archived_at)));
    const foundKnowledgeIds = new Set(foundKnowledge.map((r) => r.id));
    const missingKnowledge = body.knowledge_ids.filter((id) => !foundKnowledgeIds.has(id));
    if (missingKnowledge.length > 0) {
      throw new ApiError(
        'validation_error',
        `unknown or archived knowledge_ids: ${missingKnowledge.join(', ')}`,
        400,
      );
    }

    // Validate asset refs
    await assertAssetsExist(body.prompt_image_refs, 'prompt_image_refs');
    await assertAssetsExist(body.wrong_answer_image_refs, 'wrong_answer_image_refs');

    const now = new Date();
    const questionId = createId();
    // mistake_id is preserved on the wire for client back-compat; post-Step-9
    // it semantically equals the attempt event id (the legacy mistake row is
    // gone — the attempt event IS the mistake from the read-path's perspective).
    const attemptEventId = createId();
    const mistakeId = attemptEventId;

    const questionMetadata =
      body.prompt_image_refs.length > 0
        ? {
            prompt_image_refs: body.prompt_image_refs,
            prompt_image_ref_kind: 'source_asset_id' as const,
          }
        : null;

    await db.transaction(async (tx) => {
      await tx.insert(question).values({
        id: questionId,
        kind: body.question_kind,
        prompt_md: body.prompt_md,
        reference_md: body.reference_md,
        knowledge_ids: body.knowledge_ids,
        difficulty: body.difficulty,
        source: 'manual',
        variant_depth: 0,
        metadata: questionMetadata,
        created_at: now,
        updated_at: now,
        version: 0,
      });
      await writeEvent(tx, {
        id: attemptEventId,
        session_id: null,
        actor_kind: 'user',
        actor_ref: 'self',
        action: 'attempt',
        subject_kind: 'question',
        subject_id: questionId,
        outcome: 'failure',
        payload: {
          answer_md: body.wrong_answer_md,
          answer_image_refs: body.wrong_answer_image_refs,
          referenced_knowledge_ids: body.knowledge_ids,
        },
        caused_by_event_id: null,
        task_run_id: null,
        cost_micro_usd: null,
        created_at: now,
      });
    });
    // User-provided cause: Lane B JudgeOnEvent requires actor_kind='agent', so
    // the cause cannot be written as a user judge event. Pre-Step-9 it landed
    // on mistake.cause; that column is gone. The data is dropped post-Step-9
    // — feature gap for Phase 1c.2 (likely as experimental:user_cause event).
    // AI-attributed cause still flows through runAttributionAndWriteJudgeEvent
    // below when body.cause is null.

    // Queue background tasks (runs after response is sent)
    after(async () => {
      await runProposeAndWrite({
        db,
        mistakeContent: {
          prompt_md: body.prompt_md,
          reference_md: body.reference_md,
          wrong_answer_md: body.wrong_answer_md,
          knowledge_ids_picked: body.knowledge_ids,
        },
        runTaskFn: async (kind, input, ctx) => {
          const result = await runTask(kind, input, ctx as Parameters<typeof runTask>[2]);
          return { text: result.text };
        },
      });
    });

    if (body.cause === null) {
      after(async () => {
        try {
          const tree = await loadTreeSnapshot(db);
          const pickedNodes = tree.filter((n) => body.knowledge_ids.includes(n.id));
          await runAttributionAndWriteJudgeEvent({
            db,
            attemptEventId,
            input: {
              prompt_md: body.prompt_md,
              reference_md: body.reference_md,
              wrong_answer_md: body.wrong_answer_md,
              knowledge_context: pickedNodes.map((n) => ({
                id: n.id,
                name: n.name,
                effective_domain: n.effective_domain,
              })),
            },
            referencedKnowledgeIds: body.knowledge_ids,
            runTaskFn: async (kind, input, ctx) => {
              const result = await runTask(kind, input, ctx as Parameters<typeof runTask>[2]);
              return { text: result.text };
            },
          });
        } catch (err) {
          console.error('attribution prep failed (mistake unaffected)', err);
        }
      });
    }

    return Response.json({
      question_id: questionId,
      mistake_id: mistakeId,
      propose_task: 'queued' as const,
    });
  } catch (err) {
    return errorResponse(err);
  }
}

// ----- Phase 1c.1 Step 6.G — GET (event-stream projection) -----
//
// GET /api/mistakes?limit=N&since=ISO&question_id=X
//   → { rows: [{ id, question_id, prompt_md, wrong_answer_md, knowledge_ids,
//                cause, created_at }] }
//
// Same projection / back-compat shape as `/api/mistakes/recent`. Filters:
//   - limit: default 50, clamped [1, 200]
//   - since: ISO-8601 timestamp (created_at >= since)
//   - question_id: restrict to one question's failure attempts

const GetQuerySchema = z.object({
  limit: z
    .string()
    .optional()
    .refine((s) => s === undefined || /^\d+$/.test(s), {
      message: 'limit must be a positive integer',
    }),
  since: z
    .string()
    .optional()
    .refine((s) => s === undefined || !Number.isNaN(new Date(s).getTime()), {
      message: 'since must be an ISO-8601 timestamp',
    }),
  question_id: z.string().min(1).optional(),
});

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export async function GET(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const raw: Record<string, string> = {};
    for (const [key, value] of url.searchParams.entries()) raw[key] = value;
    const parsed = GetQuerySchema.safeParse(raw);
    if (!parsed.success) {
      const message = parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
      throw new ApiError('validation_error', message, 400);
    }
    const limit = Math.min(
      Math.max(parsed.data.limit ? Number.parseInt(parsed.data.limit, 10) : DEFAULT_LIMIT, 1),
      MAX_LIMIT,
    );
    const since = parsed.data.since ? new Date(parsed.data.since) : undefined;
    const questionIds = parsed.data.question_id ? [parsed.data.question_id] : undefined;

    const fails = await getFailureAttempts(db, { limit, since, questionIds });
    if (fails.length === 0) return Response.json({ rows: [] });

    const uniqueQids = [...new Set(fails.map((f) => f.question_id))];
    const questions = await db
      .select({ id: question.id, prompt_md: question.prompt_md })
      .from(question)
      .where(inArray(question.id, uniqueQids));
    const promptByQid = new Map(questions.map((q) => [q.id, q.prompt_md]));

    // Codex P1-B fix retired in Step 9 — the legacy `mistake` table was
    // DROPped, so the fallback no longer applies. User-supplied causes
    // (from POST /api/mistakes with body.cause !== null) are not currently
    // recoverable from the event stream; Phase 1c.2 will introduce an
    // `experimental:user_cause` event path.
    const rows = fails.map((f) => {
      const cause = f.judge
        ? { primary_category: f.judge.cause.primary_category, user_notes: null }
        : null;
      return {
        id: f.attempt_event_id,
        question_id: f.question_id,
        prompt_md: (promptByQid.get(f.question_id) ?? '').slice(0, 200),
        wrong_answer_md: (f.answer_md ?? '').slice(0, 200),
        knowledge_ids: f.referenced_knowledge_ids,
        cause,
        created_at: Math.floor(f.created_at.getTime() / 1000),
      };
    });

    return Response.json({ rows });
  } catch (err) {
    return errorResponse(err);
  }
}
