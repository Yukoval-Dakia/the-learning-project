import { createId } from '@paralleldrive/cuid2';
import { after } from 'next/server';
import { z } from 'zod';

import { runProposeAndWrite } from '@/capabilities/knowledge/server/propose';
import {
  assertCauseAllowedForSubjectProfile,
  resolveSubjectProfileForKnowledgeIds,
} from '@/capabilities/knowledge/server/subject-profile';
import { type Cause, CauseCategory, QuestionKind } from '@/core/schema/business';
import { db } from '@/db/client';
import { knowledge, question, source_asset } from '@/db/schema';
import { runTask } from '@/server/ai/runner';
import { getStartedBoss } from '@/server/boss/client';
import { writeEvent } from '@/server/events/queries';
import { ApiError, errorResponse } from '@/server/http/errors';
import { listMistakeProjectionRows } from '@/server/records/mistakes';
import { createLearningRecord } from '@/server/records/queries';
import { shouldEnqueueBackgroundJobs } from '@/server/runtime-env';
import { and, inArray, isNull } from 'drizzle-orm';

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
    const subjectProfile = await resolveSubjectProfileForKnowledgeIds(db, body.knowledge_ids);
    assertCauseAllowedForSubjectProfile(body.cause, subjectProfile);

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
    const recordId = createId();

    const questionMetadata =
      body.prompt_image_refs.length > 0
        ? {
            prompt_image_refs: body.prompt_image_refs,
            prompt_image_ref_kind: 'source_asset_id' as const,
          }
        : null;

    const userCauseEventId = body.cause === null ? null : createId();
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
      await createLearningRecord(tx, {
        id: recordId,
        kind: 'mistake',
        title: null,
        content_md: body.wrong_answer_md,
        source: 'manual',
        capture_mode: body.prompt_image_refs.length > 0 ? 'image' : 'text',
        activity_kind: 'attempt',
        processing_status: 'raw',
        origin_event_id: attemptEventId,
        knowledge_ids: body.knowledge_ids,
        question_id: questionId,
        attempt_event_id: attemptEventId,
        asset_refs: [...body.prompt_image_refs, ...body.wrong_answer_image_refs],
        payload: {
          wrong_answer_md: body.wrong_answer_md,
          wrong_answer_image_refs: body.wrong_answer_image_refs,
        },
      });
      // User-supplied cause → experimental:user_cause event (Phase 1c.2).
      // Lane B JudgeOnEvent requires actor_kind='agent', so user cause cannot
      // ride the judge channel; it lives in the experimental namespace until
      // promoted to a KnownEvent. Lives in the same txn as the attempt so the
      // pair commits atomically.
      if (body.cause !== null && userCauseEventId !== null) {
        await writeEvent(tx, {
          id: userCauseEventId,
          session_id: null,
          actor_kind: 'user',
          actor_ref: 'self',
          action: 'experimental:user_cause',
          subject_kind: 'event',
          subject_id: attemptEventId,
          outcome: null,
          payload: {
            primary_category: body.cause.primary_category,
            user_notes: body.cause.user_notes,
          },
          caused_by_event_id: attemptEventId,
          task_run_id: null,
          cost_micro_usd: null,
          created_at: now,
        });
      }
    });

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
        subjectProfile,
      });
    });

    // Async attribution via pg-boss (Task #16): user-supplied cause skips this,
    // otherwise the worker picks up the job and calls AttributionTask. Durable
    // + retryable + doesn't tie up the web container. Gated by the shared
    // shouldEnqueueBackgroundJobs() (YUK-239) so the test suite doesn't
    // accumulate boss state (same posture as session_summary + note_generate
    // enqueue).
    if (body.cause === null && shouldEnqueueBackgroundJobs()) {
      try {
        const boss = await getStartedBoss();
        await boss.send('attribution_followup', { attempt_event_id: attemptEventId });
      } catch (err) {
        console.warn(`attribution_followup enqueue failed for ${attemptEventId}:`, err);
      }
    }

    return Response.json({
      question_id: questionId,
      mistake_id: mistakeId,
      record_id: recordId,
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

    const rows = await listMistakeProjectionRows(db, { limit, since, questionIds });

    return Response.json({ rows });
  } catch (err) {
    return errorResponse(err);
  }
}
