// T-RA — pre-submit RatingAdvisor preview route.
//
// Stores the frozen submission and candidate and returns the derived advisory. When the
// caller sends `commit` and the verdict is automatic and rated, the same request records and
// settles the attempt through createAttempt; otherwise nothing past the candidate is written
// and the learner commits, with their own rating, through createAttempt.
//
// Cause resolution lives in `resolveAdviceCauseForQuestion()` so this route and
// submit share one read policy. It scans a recent-attempt window rather than the
// latest row, so an older labelled failure is not masked by a label-less retry.

import { eq } from 'drizzle-orm';
import { resolveAdviceCauseForQuestion } from '@/capabilities/practice/failure-learning/public';
import {
  normalizeReviewSubmitActivityRef,
  previewFormalAttempt,
  questionKnowledgeIdsForJudge,
  ratingFromCoarseOutcome,
  requestReviewAnswer,
} from '@/capabilities/practice/grading/public';
import { judgeResultToRatingAdvice } from '@/capabilities/practice/scheduling/server/rating-advisor';
import { INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE } from '@/core/schema/intervention';
import type { Db } from '@/db/client';
import { question } from '@/db/schema';
import { ApiError } from '@/kernel/http';
import { resolveSubjectProfileForKnowledgeIds } from '@/kernel/read-models/subject-profile';
import { ReviewAdviceBodySchema } from '../api/review-planning-contracts';

export async function previewReviewAdvice(db: Db, raw: unknown, signal: AbortSignal) {
  const parsed = ReviewAdviceBodySchema.safeParse(raw);
  if (!parsed.success) {
    const message = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
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
  } = await previewFormalAttempt(db, 'advice_preview', questionId, body.assessment, signal);
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

  // The practice page applies the same split: an open answer or one without a suggested rating
  // keeps its learner confidence and rating step.
  const commit =
    body.commit && automatic_commit && suggestedRating !== null
      ? await requestReviewAnswer(
          db,
          async () => ({
            ...body.commit,
            question_id: questionId,
            assessment: body.assessment,
            activation_intent,
            rating: suggestedRating,
            auto_rate: true,
            response_md: body.response_md,
            answer_image_refs: body.answer_image_refs,
          }),
          // No abort signal: the original is already accepted, and a reload that stopped the
          // commit half-way would leave it accepted but never recorded or settled. Every unit is
          // deterministic here, so the durable divert can never apply.
          { durableEnabled: false },
        )
      : null;
  if (commit?.kind === 'pending') {
    throw new ApiError('corrupt_state', 'advice commit was diverted to durable judging', 500);
  }

  return {
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
    ...(commit ? { committed: commit.body } : {}),
  };
}
