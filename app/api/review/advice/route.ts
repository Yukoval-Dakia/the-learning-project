// T-RA — pre-submit RatingAdvisor preview route (YUK-98).
//
// This endpoint runs the same JudgeInvoker path as submit, returns the derived
// advisory, and deliberately avoids event/FSRS writes. The committed review
// rating remains user-controlled through /api/review/submit.
//
// YUK-100 (W-05 follow-up, 2026-05-27): cause SoT wiring.
// Per `src/server/review/rating-advisor.ts` head comments + driver T-RA §1.1,
// callers MUST pass the effective cause category so the partial-credit lean
// (carelessness → 'good' / conceptual_error → 'again') actually fires. We read
// the latest active failure attempt for the same question and resolve cause
// via `effectiveCauseCategoryForFailureAttempt()` (CC-1 single-owner helper —
// active user_cause wins over latest active agent judge). When no prior
// failure attempt exists or no cause is attached, `causeCategory` is null and
// the advisor falls back to the default partial-credit bucket.

import { z } from 'zod';

import { ActivityRef } from '@/core/schema/activity';
import { db } from '@/db/client';
import { question } from '@/db/schema';
import { effectiveCauseCategoryForFailureAttempt } from '@/server/events/cause-policy';
import { getFailureAttempts } from '@/server/events/queries';
import { ApiError, errorResponse } from '@/server/http/errors';
import { createDefaultJudgeInvoker } from '@/server/judge/invoker';
import { resolveSubjectProfileForKnowledgeIds } from '@/server/knowledge/subject-profile';
import { normalizeReviewSubmitActivityRef } from '@/server/review/activity-ref';
import { ratingFromCoarseOutcome } from '@/server/review/judge-rating';
import { judgeResultToRatingAdvice } from '@/server/review/rating-advisor';
import { eq } from 'drizzle-orm';

export const runtime = 'nodejs';

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

    // YUK-100 (W-05) — Resolve effective cause for the latest active failure
    // attempt on this question, then thread it into the advisor so the
    // carelessness/conceptual lean from driver T-RA §1.1 actually fires for
    // partial-credit judge results. `causeCategory = null` is a legal fallback
    // when there's no prior failure attempt or no attached cause; the advisor
    // then keeps the default partial-credit bucket.
    const recentFailures = await getFailureAttempts(db, {
      questionIds: [questionId],
      limit: 1,
    });
    const causeCategory =
      recentFailures.length > 0 ? effectiveCauseCategoryForFailureAttempt(recentFailures[0]) : null;
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
