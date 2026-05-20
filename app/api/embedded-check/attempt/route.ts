// POST /api/embedded-check/attempt
//
// Accepts an answer to an embedded check question, judges it (exact/keyword
// judge), writes an attempt event, and — on failure — creates a learning_record
// (kind='mistake') and enqueues attribution_followup via pg-boss.
//
// Design invariants:
//   - Does NOT write material_fsrs_state. Embedded checks stay out of FSRS.
//   - Each call creates a new event row + (on failure) a new learning_record row.
//     No de-dup; UI shows latest verdict per question from event history.
//   - attribution_followup enqueue happens AFTER the DB transaction, not inside it.
//   - VITEST guard on boss.send mirrors /api/mistakes/route.ts:213.

import { eq } from 'drizzle-orm';
import { z } from 'zod';

import { newId } from '@/core/ids';
import { db } from '@/db/client';
import { question } from '@/db/schema';
import { judgeRouterV2 } from '@/server/ai/judges';
import type { JudgeKind } from '@/server/ai/judges';
import { getStartedBoss } from '@/server/boss/client';
import { writeEvent } from '@/server/events/queries';
import { ApiError, errorResponse } from '@/server/http/errors';
import { resolveSubjectProfileForKnowledgeIds } from '@/server/knowledge/subject-profile';
import { createLearningRecord } from '@/server/records/queries';

export const runtime = 'nodejs';

const Body = z.object({
  question_id: z.string().min(1),
  answer_md: z.string().min(1).max(2000),
  latency_ms: z.number().int().min(0).max(3_600_000).nullable().optional(),
});

function resolveJudgeKind(
  q: {
    kind: string;
    judge_kind_override: string | null | undefined;
    reference_md: string | null | undefined;
  },
  preferredRoutes: readonly string[],
): JudgeKind {
  if (q.judge_kind_override) {
    return q.judge_kind_override as JudgeKind;
  }

  // Registry-backed routes today: exact, keyword. Embedded questions currently
  // persist reference_md but not a dedicated keywords field, so exact is the
  // deterministic default. Keep profile resolution in the call path so future
  // subject policies can opt into keyword / ai_flexible once those inputs exist.
  const preferredLocalRoute = preferredRoutes.find(
    (route) => route === 'exact' || route === 'keyword',
  );
  return (preferredLocalRoute as JudgeKind | undefined) ?? 'exact';
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

    // Load the question row
    const qRows = await db
      .select()
      .from(question)
      .where(eq(question.id, body.question_id))
      .limit(1);
    const q = qRows[0];
    if (!q) {
      throw new ApiError('not_found', `question ${body.question_id} not found`, 404);
    }
    if (q.source !== 'embedded') {
      throw new ApiError(
        'question_not_embedded',
        'this endpoint only accepts embedded check questions',
        422,
      );
    }

    // Judge the answer
    const subjectProfile = await resolveSubjectProfileForKnowledgeIds(db, q.knowledge_ids);
    const judgeKind = resolveJudgeKind(q, subjectProfile.judgePolicy.preferredRoutes);
    const judgeResult = judgeRouterV2({
      kind: judgeKind,
      question: {
        reference: q.reference_md ?? '',
        keywords: [],
      },
      answer: { content: body.answer_md },
    });

    // Map judge coarse_outcome → event outcome
    const outcome: 'success' | 'failure' =
      judgeResult.coarse_outcome === 'correct' ? 'success' : 'failure';
    const responseJudge = {
      route: judgeKind,
      score: judgeResult.score,
      reason_md: judgeResult.feedback_md,
    };

    const now = new Date();
    const attemptEventId = newId();
    let recordId: string | undefined;

    await db.transaction(async (tx) => {
      // Write the attempt event. Payload must satisfy AttemptOnQuestion schema:
      // answer_md, answer_image_refs, referenced_knowledge_ids are required.
      // Extra keys (source, latency_ms, judge_route, judge_score) are stored
      // in the DB via jsonb — Zod strips them on parse but the raw payload
      // is what gets inserted (writeEvent inserts input.payload directly).
      await writeEvent(tx, {
        id: attemptEventId,
        session_id: null,
        actor_kind: 'user',
        actor_ref: 'self',
        action: 'attempt',
        subject_kind: 'question',
        subject_id: q.id,
        outcome,
        payload: {
          answer_md: body.answer_md,
          answer_image_refs: [],
          referenced_knowledge_ids: q.knowledge_ids,
          // Extra provenance fields — stored in jsonb, not part of Zod contract
          source: 'embedded_check',
          latency_ms: body.latency_ms ?? null,
          judge_route: judgeKind,
          judge_score: judgeResult.score,
          judge: responseJudge,
        },
        caused_by_event_id: null,
        task_run_id: null,
        cost_micro_usd: null,
        created_at: now,
      });

      if (outcome === 'failure') {
        recordId = newId();
        await createLearningRecord(tx, {
          id: recordId,
          kind: 'mistake',
          title: null,
          content_md: body.answer_md,
          source: 'manual', // user-driven attempt — same provenance class as /api/mistakes POST
          capture_mode: 'text',
          activity_kind: 'attempt',
          processing_status: 'raw',
          origin_event_id: attemptEventId,
          knowledge_ids: q.knowledge_ids,
          question_id: q.id,
          attempt_event_id: attemptEventId,
          asset_refs: [],
          payload: {
            from: 'embedded_check',
            wrong_answer_md: body.answer_md,
            judge_route: judgeKind,
            judge_score: judgeResult.score,
            judge: responseJudge,
          },
        });
      }
    });

    // Enqueue attribution after the transaction commits.
    // VITEST guard: mirrors /api/mistakes/route.ts:210-217 to prevent boss state
    // accumulation in the test suite.
    if (outcome === 'failure' && !process.env.VITEST) {
      try {
        const boss = await getStartedBoss();
        await boss.send('attribution_followup', { attempt_event_id: attemptEventId });
      } catch (err) {
        console.warn(`attribution_followup enqueue failed for ${attemptEventId}:`, err);
      }
    }

    return Response.json({
      outcome,
      judge: responseJudge,
      ...(recordId !== undefined ? { mistake_id: recordId } : {}),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
