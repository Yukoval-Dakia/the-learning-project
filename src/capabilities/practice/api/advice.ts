// T-RA — pre-submit RatingAdvisor preview route.
//
// Stores the frozen submission and candidate, returns the derived advisory, and
// deliberately avoids activation/FSRS writes: the committed review rating stays
// user-controlled through /api/review/submit.
//
// Cause resolution lives in `resolveAdviceCauseForQuestion()` so this route and
// submit share one read policy. It scans a recent-attempt window rather than the
// latest row, so an older labelled failure is not masked by a label-less retry.

import { eq } from 'drizzle-orm';
import { normalizeReviewSubmitActivityRef } from '@/capabilities/practice/server/activity-ref';
import { resolveAdviceCauseForQuestion } from '@/capabilities/practice/server/cause-context';
import { questionKnowledgeIdsForJudge } from '@/capabilities/practice/server/intervention-diagnostics';
import { ratingFromCoarseOutcome } from '@/capabilities/practice/server/judge-rating';
import { judgeResultToRatingAdvice } from '@/capabilities/practice/server/rating-advisor';
import { INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE } from '@/core/schema/intervention';
import { db } from '@/db/client';
import { question } from '@/db/schema';
import { ApiError, errorResponse } from '@/kernel/http';
import { resolveSubjectProfileForKnowledgeIds } from '@/kernel/read-models/subject-profile';
import { previewFormalAttempt } from '../server/assessment/attempt';
import { ReviewAdviceBodySchema } from './review-planning-contracts';

export async function POST(req: Request): Promise<Response> {
  try {
    const raw = await req.json().catch(() => null);
    const parsed = ReviewAdviceBodySchema.safeParse(raw);
    if (!parsed.success) {
      const message = parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
      throw new ApiError('validation_error', message, 400);
    }

    const body = parsed.data;
    const identity = normalizeReviewSubmitActivityRef(body);
    const questionId = identity.question_id;
    const qRows = await db.select().from(question).where(eq(question.id, questionId)).limit(1);
    const q = qRows[0];
    if (!q) {
      throw new ApiError('not_found', `question ${questionId} not found`, 404);
    }
    if (q.source === INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE) {
      throw new ApiError(
        'conflict',
        `intervention diagnostic ${questionId} must be judged by its one-shot submission`,
        409,
      );
    }

    const subjectProfile = await resolveSubjectProfileForKnowledgeIds(
      db,
      questionKnowledgeIdsForJudge(q),
    );
    const {
      candidate: invoked,
      submission,
      activation_intent,
      automatic_commit,
    } = await previewFormalAttempt(db, 'advice_preview', questionId, body.assessment, req.signal);
    const suggestedRating = ratingFromCoarseOutcome(invoked.result.coarse_outcome);

    // Resolve effective cause via the shared `resolveAdviceCauseForQuestion`
    // helper. It folds `effectiveCauseCategoryForFailureAttempt` over a
    // recent-attempt window (active user_cause wins over the latest active agent
    // judge) until it finds a cause; null keeps the default partial-credit bucket.
    const causeCategory = await resolveAdviceCauseForQuestion(db, questionId);
    const advice = judgeResultToRatingAdvice(invoked.result, {
      causeCategory,
      // lean/anchors resolve through the subject's own rating_lean /
      // ratingPolicy declarations.
      subjectProfile,
    });

    return Response.json({
      activity_ref: identity.activity_ref,
      question_id: questionId,
      submission_id: submission.submission_id,
      evaluation_group_id: submission.evaluation_group_id,
      candidate_id: invoked.evaluation.record.evaluation_id,
      activation_intent,
      automatic_commit,
      judge: {
        route: 'evaluate_submission',
        score: invoked.result.score,
        score_meaning: invoked.result.score_meaning,
        coarse_outcome: invoked.result.coarse_outcome,
        ...(invoked.result.coarse_outcome === 'partial_unknown'
          ? { partial_units: invoked.result.partial_units }
          : {}),
        confidence: invoked.result.confidence,
        feedback_md: invoked.result.feedback_md,
        evidence_json: invoked.result.evidence_json,
        capability_ref: invoked.result.capability_ref,
        suggested_rating: suggestedRating,
      },
      advice,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
