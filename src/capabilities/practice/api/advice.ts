// T-RA — pre-submit RatingAdvisor preview route (YUK-98).
//
// This endpoint stores the frozen submission and candidate, returns the derived
// advisory, and deliberately avoids activation/FSRS writes. The committed review
// rating remains user-controlled through /api/review/submit.
//
// YUK-100 (W-05 follow-up, 2026-05-27): cause SoT wiring.
// YUK-101 (iter2 fix F8 / F13): cause resolution lives in
// `resolveAdviceCauseForQuestion()` (src/server/review/cause-context.ts) so
// this route and `submit/route.ts` share one read policy. F8 changed the
// scan from limit:1 to a recent-attempt window so a user who labelled an
// older failure isn't silently masked by a label-less re-failure.

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

    // YUK-100 (W-05) + YUK-101 (iter2 F8 / F13) — Resolve effective cause via
    // the shared `resolveAdviceCauseForQuestion` helper. It scans the recent
    // failure-attempt window and folds `effectiveCauseCategoryForFailureAttempt`
    // (CC-1 single-owner helper — active user_cause wins over latest active
    // agent judge) until it finds a non-null cause. Returns null when no
    // recent failure carries any cause; the advisor then keeps the default
    // partial-credit bucket.
    const causeCategory = await resolveAdviceCauseForQuestion(db, questionId);
    const advice = judgeResultToRatingAdvice(invoked.result, {
      causeCategory,
      // YUK-739 — lean/anchors resolve through the subject's own rating_lean /
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
