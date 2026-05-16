import { createId } from '@paralleldrive/cuid2';
import { after } from 'next/server';
import { z } from 'zod';

import { CauseCategory, QuestionKind } from '@/core/schema/business';
import { db } from '@/db/client';
import { knowledge, mistake, question, source_asset } from '@/db/schema';
import { runTask } from '@/server/ai/runner';
import { writeEvent } from '@/server/events/queries';
import { ApiError, errorResponse } from '@/server/http/errors';
import { runAttributionAndWriteJudgeEvent } from '@/server/knowledge/attribute';
import { runProposeAndWrite } from '@/server/knowledge/propose';
import { loadTreeSnapshot } from '@/server/knowledge/tree';
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

    // Validate asset refs
    await assertAssetsExist(body.prompt_image_refs, 'prompt_image_refs');
    await assertAssetsExist(body.wrong_answer_image_refs, 'wrong_answer_image_refs');

    const now = new Date();
    const questionId = createId();
    const mistakeId = createId();

    const causeJson = body.cause
      ? {
          primary_category: body.cause.primary_category,
          secondary_categories: [] as z.infer<typeof CauseCategory>[],
          ai_analysis_md: '',
          user_notes: body.cause.user_notes,
          user_edited: true,
        }
      : null;

    const questionMetadata =
      body.prompt_image_refs.length > 0
        ? {
            prompt_image_refs: body.prompt_image_refs,
            prompt_image_ref_kind: 'source_asset_id' as const,
          }
        : null;

    // Step 4 dual-write: legacy mistake row + new event-stream pair. The mistake
    // row keeps Step 6 (route body rewrite) decoupled from Step 4; Step 9 will
    // remove the legacy insert. The attempt event is the source of truth for
    // mastery view + Step 6 queries.
    const attemptEventId = createId();
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
      await tx.insert(mistake).values({
        id: mistakeId,
        question_id: questionId,
        wrong_answer_md: body.wrong_answer_md,
        knowledge_ids: body.knowledge_ids,
        cause: causeJson,
        wrong_answer_image_refs: body.wrong_answer_image_refs,
        source: 'manual',
        variants: [],
        variants_generated_count: 0,
        variants_max: 3,
        status: 'active',
        created_at: now,
        updated_at: now,
        version: 0,
      });
      // New event-stream write — attempt event (always). AI-attributed cause is
      // written later via runAttributionAndWriteJudgeEvent (below); user-provided
      // cause stays in the legacy mistake.cause column for now — Step 6 will
      // rewrite the route to also project user cause to the event stream.
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
