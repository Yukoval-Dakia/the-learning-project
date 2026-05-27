// T-RA — pre-submit RatingAdvisor preview route (YUK-98).
//
// This endpoint runs the same JudgeInvoker path as submit, returns the derived
// advisory, and deliberately avoids event/FSRS writes. The committed review
// rating remains user-controlled through /api/review/submit.

import { z } from 'zod';

import { ActivityRef } from '@/core/schema/activity';
import { db } from '@/db/client';
import { question } from '@/db/schema';
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
    const advice = judgeResultToRatingAdvice(invoked.result);

    return Response.json({
      activity_ref: identity.activity_ref,
      question_id: questionId,
      judge: {
        route: invoked.route,
        score: invoked.result.score,
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
