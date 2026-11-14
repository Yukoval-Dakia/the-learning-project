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

import { resolveAdviceCauseForQuestion } from '@/capabilities/practice/failure-learning/public';
import { requestReviewAdviceLifecycle } from '@/capabilities/practice/grading/public';
import { judgeResultToRatingAdvice } from '@/capabilities/practice/scheduling/server/rating-advisor';
import type { Db } from '@/db/client';
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
  const lifecycle = await requestReviewAdviceLifecycle(
    db,
    {
      activity_ref: body.activity_ref,
      question_id: body.question_id,
      mistake_id: body.mistake_id,
      assessment: body.assessment,
      response_md: body.response_md,
      answer_image_refs: body.answer_image_refs,
      commit: body.commit,
      accept_pending: body.accept_pending,
    },
    { signal },
  );
  if (lifecycle.kind === 'pending') return lifecycle.pending;

  const subjectProfile = await resolveSubjectProfileForKnowledgeIds(
    db,
    lifecycle.state.knowledge_ids,
  );

  // Resolve effective cause via the shared `resolveAdviceCauseForQuestion`
  // helper. It folds `effectiveCauseCategoryForFailureAttempt` over a
  // recent-attempt window (active user_cause wins over the latest active agent
  // judge) until it finds a cause; null keeps the default partial-credit bucket.
  const causeCategory = await resolveAdviceCauseForQuestion(db, lifecycle.state.question_id);
  const advice = judgeResultToRatingAdvice(lifecycle.state.judge, {
    causeCategory,
    // lean/anchors resolve through the subject's own rating_lean /
    // ratingPolicy declarations.
    subjectProfile,
  });

  return {
    activity_ref: lifecycle.state.activity_ref,
    question_id: lifecycle.state.question_id,
    submission_id: lifecycle.state.submission_id,
    evaluation_group_id: lifecycle.state.evaluation_group_id,
    candidate_id: lifecycle.state.candidate_id,
    activation_intent: lifecycle.state.activation_intent,
    automatic_commit: lifecycle.state.automatic_commit,
    judge: lifecycle.state.judge,
    advice,
    evidence: lifecycle.state.evidence,
    ...(lifecycle.kind === 'committed' ? { committed: lifecycle.committed } : {}),
  };
}
