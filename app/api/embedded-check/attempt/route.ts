// POST /api/embedded-check/attempt
//
// Accepts an answer to an embedded check question, judges it through the Judge v2
// light service, writes an attempt event, and — on failure — creates a learning_record
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
import { getStartedBoss } from '@/server/boss/client';
import { writeEvent } from '@/server/events/queries';
import { ApiError, errorResponse } from '@/server/http/errors';
import { createDefaultJudgeInvoker } from '@/server/judge/invoker';
import { resolveSubjectProfileForKnowledgeIds } from '@/server/knowledge/subject-profile';
import { createLearningRecord } from '@/server/records/queries';

export const runtime = 'nodejs';

const Body = z.object({
  question_id: z.string().min(1),
  answer_md: z.string().min(1).max(2000),
  latency_ms: z.number().int().min(0).max(3_600_000).nullable().optional(),
});

function eventOutcomeForJudge(
  coarseOutcome: 'correct' | 'partial' | 'incorrect' | 'unsupported',
): 'success' | 'partial' | 'failure' {
  if (coarseOutcome === 'correct') return 'success';
  if (coarseOutcome === 'incorrect') return 'failure';
  return 'partial';
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
    const judged = await createDefaultJudgeInvoker().invoke({
      db,
      question: q,
      answer_md: body.answer_md,
      subjectProfile,
    });
    const judgeKind = judged.route;
    const judgeResult = judged.result;

    // Map judge coarse_outcome → event outcome
    const outcome = eventOutcomeForJudge(judgeResult.coarse_outcome);
    const responseJudge = {
      route: judgeKind,
      score: judgeResult.score,
      coarse_outcome: judgeResult.coarse_outcome,
      confidence: judgeResult.confidence,
      reason_md: judgeResult.feedback_md,
      evidence_json: judgeResult.evidence_json,
      telemetry: judged.telemetry,
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
          judge_elapsed_ms: judged.telemetry.elapsed_ms,
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
            judge_elapsed_ms: judged.telemetry.elapsed_ms,
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
      // M2.3: surface attempt event id so the UI can wire appeals
      // (POST /api/review/appeal with judge_event_id = attempt_event_id;
      // embedded-check flow embeds judge result inside the attempt event's
      // payload rather than writing a separate judge event).
      attempt_event_id: attemptEventId,
      ...(recordId !== undefined ? { mistake_id: recordId } : {}),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
