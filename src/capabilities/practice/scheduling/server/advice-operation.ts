// T-RA — pre-submit RatingAdvisor preview route.
//
// Stores the frozen submission and candidate and returns the derived advisory. When the
// caller sends `commit` and the verdict is automatic and rated, the same request records and
// settles the attempt through createAttempt; otherwise nothing past the candidate is written
// and the learner commits, with their own rating, through createAttempt.
//
// Cause resolution delegates to the kernel's shared current/authorized scan so
// this preview reads the same effective cause facts the settlement commits on.

import { requestReviewAdviceLifecycle } from '@/capabilities/practice/grading/public';
import { judgeResultToRatingAdvice } from '@/capabilities/practice/scheduling/server/rating-advisor';
import type { Db } from '@/db/client';
import { ApiError } from '@/kernel/http';
import { resolveCurrentEffectiveCauseForQuestion } from '@/kernel/read-models/cause-policy';
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

  // Resolve the effective cause via the shared kernel resolver. The same
  // current/authorized scan feeds settlement, so the preview's advice is the
  // rating the commit will actually settle; null keeps the default bucket.
  const causeCategory = await resolveCurrentEffectiveCauseForQuestion(
    db,
    lifecycle.state.question_id,
  );
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
