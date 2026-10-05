import { and, eq, gte, sql } from 'drizzle-orm';
import { EvaluationRecord } from '@/core/schema/assessment';
import type { Db } from '@/db/client';
import { acquireLearningStateWriteLock } from '@/db/learning-state-lock';
import { answer, learning_session } from '@/db/schema';
import { ApiError } from '@/kernel/http';
import { resolveVerdictForGroup } from '@/kernel/read-models/assessment-verdict';
import { assertSessionMutable, freezeAnswerDraft } from '../answer-draft';
import { projectEvaluationToJudgeResult } from '../judge/evaluation-authority';
import {
  commitFormalAttempt,
  prepareFormalAttemptSubmission,
  recordFormalAttemptCapture,
} from './attempt';
import { readPaperAssessmentBinding } from './paper-issuance';
import type { SaveSubmissionRequest } from './submit';

export interface NativePaperAttemptInput {
  sessionId: string;
  paperArtifactId: string;
  questionId: string;
  partRef?: string | null;
  assessment: SaveSubmissionRequest;
  answerMd: string;
  answerImageRefs?: string[];
  latencyMs?: number | null;
  reasoningTrace?: string | null;
  selfConfidence?: number | null;
}

/** Only the opening receipt selects the slot, its identity and feedback policy. */
export async function submitNativePaperAttempt(db: Db, input: NativePaperAttemptInput) {
  const binding = await readPaperAssessmentBinding(db, input.sessionId);
  if (!binding || binding.paper_id !== input.paperArtifactId) {
    throw new ApiError(
      'historical_unknown',
      'paper session has no original assessment binding',
      409,
    );
  }
  const slot = binding.slots.find(
    (slot) => slot.question_id === input.questionId && slot.part_ref === (input.partRef ?? null),
  );
  if (
    !slot ||
    input.assessment.issuance_id !== slot.issuance_id ||
    input.assessment.evaluation_group_id !== slot.evaluation_group_id ||
    input.assessment.idempotency_key !== slot.idempotency_key
  ) {
    throw new ApiError('coordinate_mismatch', 'submission differs from the issued paper slot', 409);
  }
  const capture = {
    session_id: input.sessionId,
    paper_artifact_id: input.paperArtifactId,
    paper_feedback_policy: slot.feedback_policy,
    paper_started_at: binding.started_at,
    part_ref: input.partRef ?? null,
    response_md: input.answerMd,
    latency_ms: input.latencyMs,
    reasoning_trace: input.reasoningTrace,
    self_confidence: input.selfConfidence,
  };
  const { prepared, answerId } = await db.transaction(async (tx) => {
    await acquireLearningStateWriteLock(tx);
    const [lockedSession] = await tx
      .select({
        id: learning_session.id,
        started_at: learning_session.started_at,
        status: learning_session.status,
      })
      .from(learning_session)
      .where(eq(learning_session.id, input.sessionId))
      .for('update');
    if (lockedSession?.started_at.toISOString() !== binding.started_at) {
      throw new ApiError('stale_occurrence', 'paper was reopened before capture', 409);
    }
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`paper-native:${slot.issuance_id}`}))`,
    );
    const [prior] = await tx
      .select({ id: answer.id })
      .from(answer)
      .where(
        and(
          eq(answer.session_id, input.sessionId),
          eq(answer.question_id, input.questionId),
          sql`coalesce(${answer.part_ref}, '') = ${input.partRef ?? ''}`,
          gte(answer.submitted_at, lockedSession.started_at),
        ),
      );
    if (!prior) {
      if (!['started', 'paused'].includes(lockedSession.status)) {
        throw new ApiError('session_closed', 'paper cannot accept another answer', 409);
      }
      await assertSessionMutable(tx, input.sessionId, input.paperArtifactId);
    }
    // Learning writes -> session occurrence -> paper slot -> submission group -> issuance -> draft.
    // No evaluation/model work runs while these locks are held.
    const prepared = await prepareFormalAttemptSubmission(
      tx,
      'paper_submit',
      input.questionId,
      input.assessment,
    );
    const submission = prepared.submission;
    const attemptId = `evt_assessment_${submission.submission_id}`;
    const [existing] = await tx
      .select({ id: answer.id })
      .from(answer)
      .where(eq(answer.event_id, attemptId));
    if (existing) return { prepared, answerId: existing.id };
    await assertSessionMutable(tx, input.sessionId, input.paperArtifactId);
    await recordFormalAttemptCapture(
      tx,
      'paper_submit',
      input.questionId,
      submission,
      null,
      capture,
    );
    const frozen = await freezeAnswerDraft(tx, {
      sessionId: input.sessionId,
      paperArtifactId: input.paperArtifactId,
      questionId: input.questionId,
      partRef: input.partRef,
      eventId: attemptId,
      submittedAt: new Date(submission.submitted_at),
      inputKind: (input.answerImageRefs?.length ?? 0) ? 'image' : 'text',
      contentMd: input.answerMd,
      imageRefs: input.answerImageRefs ?? [],
    });
    return { prepared, answerId: frozen.answerId };
  });
  const submission = prepared.submission;
  const attemptId = `evt_assessment_${submission.submission_id}`;
  // Validate the immutable original before replaying the current head. A later
  // correction (or retraction) must never reactivate the original candidate.
  const currentVerdict = await resolveVerdictForGroup(db, slot.evaluation_group_id);
  let receipt: {
    coarseOutcome: 'correct' | 'partial' | 'incorrect' | 'unsupported';
    score: number | null;
    status: 'effective' | 'review_required';
    evaluationId?: string;
  };
  if (currentVerdict.head && currentVerdict.head.generation > 0) {
    const effective = currentVerdict.effective;
    const result = effective?.scoring_basis
      ? projectEvaluationToJudgeResult(
          EvaluationRecord.parse(effective.row),
          effective.scoring_basis,
        )
      : null;
    receipt = {
      coarseOutcome: result?.coarse_outcome ?? 'unsupported',
      score: result?.score ?? null,
      status: result ? 'effective' : 'review_required',
      evaluationId: effective?.evaluation_id,
    };
  } else {
    // Accepted original and paid-call claim both survive activation failures.
    const committed = await commitFormalAttempt(
      db,
      'paper_submit',
      input.questionId,
      input.assessment,
      {
        capture,
        beforeActivate: async (tx) => {
          const [current] = await tx
            .select({ started_at: learning_session.started_at })
            .from(learning_session)
            .where(eq(learning_session.id, input.sessionId))
            .for('update');
          if (current?.started_at.toISOString() !== binding.started_at) {
            throw new ApiError(
              'stale_occurrence',
              'paper was reopened before this evaluation committed',
              409,
            );
          }
        },
      },
    );
    receipt = {
      coarseOutcome: committed.candidate.result.coarse_outcome,
      score: committed.candidate.result.score,
      status: committed.status,
      evaluationId: committed.candidate.evaluation.record.evaluation_id,
    };
  }
  const [currentSession] = await db
    .select({ status: learning_session.status, started_at: learning_session.started_at })
    .from(learning_session)
    .where(eq(learning_session.id, input.sessionId));
  if (currentSession?.started_at.toISOString() !== binding.started_at) {
    throw new ApiError('stale_occurrence', 'paper was reopened before acknowledgement', 409);
  }
  const visibleToUser =
    slot.feedback_policy !== 'judge_now_show_later' || currentSession?.status === 'completed';
  return {
    attemptEventId: attemptId,
    judgeEventId: null,
    answerId,
    visibleToUser,
    ...receipt,
  };
}
