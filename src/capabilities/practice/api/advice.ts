// T-RA — pre-submit RatingAdvisor preview route (YUK-98).
//
// This endpoint runs the same JudgeInvoker path as submit, returns the derived
// advisory, and deliberately avoids event/FSRS writes. The committed review
// rating remains user-controlled through /api/review/submit.
//
// YUK-100 (W-05 follow-up, 2026-05-27): cause SoT wiring.
// YUK-101 (iter2 fix F8 / F13): cause resolution lives in
// `resolveAdviceCauseForQuestion()` (src/server/review/cause-context.ts) so
// this route and `submit/route.ts` share one read policy. F8 changed the
// scan from limit:1 to a recent-attempt window so a user who labelled an
// older failure isn't silently masked by a label-less re-failure.

import { z } from 'zod';

import { normalizeReviewSubmitActivityRef } from '@/capabilities/practice/server/activity-ref';
import { resolveAdviceCauseForQuestion } from '@/capabilities/practice/server/cause-context';
import { ratingFromCoarseOutcome } from '@/capabilities/practice/server/judge-rating';
import { judgeResultToRatingAdvice } from '@/capabilities/practice/server/rating-advisor';
import { ActivityRef } from '@/core/schema/activity';
import { db } from '@/db/client';
import { question } from '@/db/schema';
import { ApiError, errorResponse } from '@/server/http/errors';
import { createDefaultJudgeInvoker } from '@/server/judge/invoker';
import { resolveSubjectProfileForKnowledgeIds } from '@/capabilities/knowledge/server/subject-profile';
import { eq } from 'drizzle-orm';

const AdviceBody = z.object({
  activity_ref: ActivityRef.optional(),
  question_id: z.string().min(1).optional(),
  mistake_id: z.string().min(1).optional(),
  response_md: z.string(),
});

export async function POST(req: Request): Promise<Response> {
  try {
    const raw = await req.json().catch(() => null);
    const parsed = AdviceBody.safeParse(raw);
    if (!parsed.success) {
      const message = parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
      throw new ApiError('validation_error', message, 400);
    }

    const body = parsed.data;
    const answerMd = body.response_md.trim();
    if (answerMd.length === 0) {
      throw new ApiError(
        'missing_answer',
        'rating advice requires response_md to be non-empty',
        422,
      );
    }

    const identity = normalizeReviewSubmitActivityRef(body);
    const questionId = identity.question_id;
    const qRows = await db.select().from(question).where(eq(question.id, questionId)).limit(1);
    const q = qRows[0];
    if (!q) {
      throw new ApiError('not_found', `question ${questionId} not found`, 404);
    }

    const subjectProfile = await resolveSubjectProfileForKnowledgeIds(db, q.knowledge_ids);
    const invoked = await createDefaultJudgeInvoker().invoke({
      db,
      question: q,
      answer_md: answerMd,
      subjectProfile,
    });
    const suggestedRating = ratingFromCoarseOutcome(invoked.result.coarse_outcome);

    // YUK-100 (W-05) + YUK-101 (iter2 F8 / F13) — Resolve effective cause via
    // the shared `resolveAdviceCauseForQuestion` helper. It scans the recent
    // failure-attempt window and folds `effectiveCauseCategoryForFailureAttempt`
    // (CC-1 single-owner helper — active user_cause wins over latest active
    // agent judge) until it finds a non-null cause. Returns null when no
    // recent failure carries any cause; the advisor then keeps the default
    // partial-credit bucket.
    const causeCategory = await resolveAdviceCauseForQuestion(db, questionId);
    const advice = judgeResultToRatingAdvice(invoked.result, { causeCategory });

    return Response.json({
      activity_ref: identity.activity_ref,
      question_id: questionId,
      judge: {
        route: invoked.route,
        score: invoked.result.score,
        score_meaning: invoked.result.score_meaning,
        coarse_outcome: invoked.result.coarse_outcome,
        confidence: invoked.result.confidence,
        feedback_md: invoked.result.feedback_md,
        evidence_json: invoked.result.evidence_json,
        capability_ref: invoked.result.capability_ref,
        suggested_rating: suggestedRating,
        telemetry: invoked.telemetry,
      },
      advice,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
