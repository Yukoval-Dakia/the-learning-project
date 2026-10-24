// Manual mistake capture. The post-response work is fire-and-forget, not after().

import { createId } from '@paralleldrive/cuid2';
import { and, inArray, isNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { knowledge, question, source_asset } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { ApiError, errorResponse, resourceResponse } from '@/kernel/http';
import { withActiveCauseCategoryOverlays } from '@/kernel/read-models/cause-overlay';
import { loadAttemptQuestionSnapshot } from '@/kernel/read-models/question-evidence-snapshot';
import {
  assertCauseAllowedForSubjectProfile,
  resolveSubjectProfileForKnowledgeIds,
} from '@/kernel/read-models/subject-profile';
import { createLearningRecord } from '@/kernel/records/queries';
import { withAnswerClass } from '@/server/questions/answer-class-write';
import { publishQuestionGroupFromRow } from '@/server/questions/publisher';
import { readMistakes } from '../server/mistakes-read';
import { CreateMistakeBodySchema } from './contracts';

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
    const parsed = CreateMistakeBodySchema.safeParse(raw);
    if (!parsed.success) {
      const message = parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
      throw new ApiError('validation_error', message, 400);
    }
    const body = parsed.data;

    // Client ids win, and the schema requires at least one. This route has no
    // subject signal, so tagKnowledge cannot auto-attribute an empty set.

    // Knowledge ids must exist and be live.
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
    // Allowed causes include owner-accepted active overlays; otherwise the owner
    // could not use an adopted category here.
    assertCauseAllowedForSubjectProfile(
      body.cause,
      await withActiveCauseCategoryOverlays(db, subjectProfile),
    );

    await assertAssetsExist(body.prompt_image_refs, 'prompt_image_refs');
    await assertAssetsExist(body.wrong_answer_image_refs, 'wrong_answer_image_refs');

    const now = new Date();
    const questionId = createId();
    // Legacy wire name: mistake_id now equals the attempt event id.
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
      await tx.insert(question).values(
        withAnswerClass({
          id: questionId,
          kind: body.question_kind,
          prompt_md: body.prompt_md,
          reference_md: body.reference_md,
          image_refs: body.prompt_image_refs,
          knowledge_ids: body.knowledge_ids,
          difficulty: body.difficulty,
          source: 'manual',
          variant_depth: 0,
          metadata: questionMetadata,
          created_at: now,
          updated_at: now,
          version: 0,
        }),
      );
      // Mint the first revision in the same transaction. A missing reference stays
      // a conversion issue, so the question starts withheld; the answer evidence
      // lives on the attempt event, never in the answer key.
      await publishQuestionGroupFromRow(tx, {
        rootId: questionId,
        actorRef: 'mistakes:manual',
        now,
      });
      const questionSnapshot = await loadAttemptQuestionSnapshot(tx, questionId);
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
          question_snapshot: questionSnapshot,
          // Reserve the reconstruction-signal slot until a classifier lands.
          reconstruction_signal: 'unknown',
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
      // The judge channel requires an agent actor, so a user cause stays in the
      // experimental namespace. It commits in the same tx as the attempt.
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

    // A wrong attempt is performance evidence, not content: it feeds attribution
    // and mastery but never creates knowledge concepts. Failure learning follows
    // from the committed attempt through the practice-owned subscription.

    return resourceResponse(
      {
        question_id: questionId,
        mistake_id: mistakeId,
        record_id: recordId,
      },
      {
        outcome: 'created',
        location: `/api/events/${encodeURIComponent(mistakeId)}`,
      },
    );
  } catch (err) {
    return errorResponse(err);
  }
}

// HTTP adaptation only; query policy belongs to the shared ingestion read operation.
export async function GET(req: Request): Promise<Response> {
  try {
    const raw: Record<string, string> = {};
    for (const [key, value] of new URL(req.url).searchParams.entries()) raw[key] = value;
    return Response.json(await readMistakes(db, raw));
  } catch (err) {
    return errorResponse(err);
  }
}
