import { and, eq, gte, sql } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { answer, learning_session } from '@/db/schema';
import { ApiError } from '@/kernel/http';
import { assertSessionMutable, freezeAnswerDraft } from '../answer-draft';
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
  const [session] = await db
    .select()
    .from(learning_session)
    .where(eq(learning_session.id, input.sessionId));
  if (!session || session.started_at.toISOString() !== binding.started_at) {
    throw new ApiError('coordinate_mismatch', 'paper occurrence changed', 409);
  }
  // A completed paper may replay an accepted slot but cannot introduce a new answer.
  if (!['started', 'paused'].includes(session.status)) {
    const [prior] = await db
      .select({ id: answer.id })
      .from(answer)
      .where(
        and(
          eq(answer.session_id, input.sessionId),
          eq(answer.question_id, input.questionId),
          sql`coalesce(${answer.part_ref}, '') = ${input.partRef ?? ''}`,
          gte(answer.submitted_at, session.started_at),
        ),
      );
    if (!prior) throw new ApiError('session_closed', 'paper cannot accept another answer', 409);
  }
  const prepared = await prepareFormalAttemptSubmission(
    db,
    'paper_submit',
    input.questionId,
    input.assessment,
  );
  const submission = prepared.submission;
  const attemptId = `evt_assessment_${submission.submission_id}`;
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
  const answerId = await db.transaction(async (tx) => {
    await tx
      .select({ id: learning_session.id })
      .from(learning_session)
      .where(eq(learning_session.id, input.sessionId))
      .for('update');
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`paper-native:${slot.issuance_id}`}))`,
    );
    const [existing] = await tx
      .select({ id: answer.id })
      .from(answer)
      .where(eq(answer.event_id, attemptId));
    if (existing) return existing.id;
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
    return frozen.answerId;
  });
  // Accepted original and paid-call claim both survive activation failures.
  const committed = await commitFormalAttempt(
    db,
    'paper_submit',
    input.questionId,
    input.assessment,
    {
      capture,
      onActivated: async (tx) => {
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
  const [currentSession] = await db
    .select({ status: learning_session.status })
    .from(learning_session)
    .where(eq(learning_session.id, input.sessionId));
  const visibleToUser =
    slot.feedback_policy !== 'judge_now_show_later' || currentSession?.status === 'completed';
  return {
    attemptEventId: attemptId,
    judgeEventId: null,
    answerId,
    visibleToUser,
    coarseOutcome: committed.candidate.result.coarse_outcome,
    score: committed.candidate.result.score,
    status: committed.status,
    evaluationId: committed.candidate.evaluation.record.evaluation_id,
  };
}
