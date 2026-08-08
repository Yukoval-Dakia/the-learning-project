import type { Db, Tx } from '@/db/client';
import { event, question } from '@/db/schema';
import { resolveSubjectProfile } from '@/subjects/profile';
import { eq } from 'drizzle-orm';
import {
  getFailureAttemptById,
  getFailureAttemptWithReasoningTraceById,
  getJudgeForAttempt,
} from './attempt-events';
import {
  type AttributionOutcome,
  runAttributionAndWriteJudgeEvent,
} from './failure-learning-attribution';
import { type RunVariantGenResult, runVariantGen } from './failure-learning-variant';
import { loadFailureLearningKnowledgeContext } from './knowledge-runtime';
import type { PracticeTaskRunFn } from './task-runtime';

export type FailureLearningSkipReason =
  | 'attempt_not_found'
  | 'not_failure_attempt'
  | 'attempt_not_active'
  | 'unsupported_judge'
  | 'user_cause_present'
  | 'question_not_found';

export type AttributionResult =
  | {
      status: 'written';
      judgeEventId: string;
      modelInvoked: boolean;
    }
  | {
      status: 'existing';
      judgeEventId: string;
      modelInvoked: boolean;
    }
  | { status: 'skipped'; reason: FailureLearningSkipReason; modelInvoked: false }
  | { status: 'failed_permanent'; error: unknown; modelInvoked: boolean }
  | { status: 'failed_retryable'; error: unknown; modelInvoked: boolean };

export type VariantProposalResult = RunVariantGenResult;

export type FailureLearningRequestResult =
  | { status: 'accepted'; attributionJobId: string }
  | {
      status: 'ignored';
      reason:
        | 'attempt_not_found'
        | 'not_failure_attempt'
        | 'attempt_not_active'
        | 'unsupported_judge'
        | 'user_cause_present';
    };

export interface FailureLearningRequestDeps {
  db: Db | Tx;
  enqueueAttribution(attemptEventId: string): Promise<string>;
}

export type FailureLearningFollowUpResult =
  | {
      status: 'handed_off';
      attribution: Extract<AttributionResult, { status: 'written' | 'existing' }>;
    }
  | Exclude<AttributionResult, { status: 'written' | 'existing' }>;

export interface FailureLearning {
  attribute(input: { attemptEventId: string }): Promise<AttributionResult>;
  proposeVariant(input: { attemptEventId: string }): Promise<VariantProposalResult>;
  /** Private durable composition used by attribution_followup. */
  followUp(input: { attemptEventId: string }): Promise<FailureLearningFollowUpResult>;
}

export interface FailureLearningDeps {
  db: Db;
  runTaskFn: PracticeTaskRunFn;
  enqueueVariant?: (attemptEventId: string) => Promise<void>;
}

async function classifyAttempt(
  db: Db | Tx,
  attemptEventId: string,
): Promise<
  | { status: 'eligible'; payload: Record<string, unknown> }
  | { status: 'skipped'; reason: 'attempt_not_found' | 'not_failure_attempt' }
> {
  const [row] = await db
    .select({
      action: event.action,
      subject_kind: event.subject_kind,
      outcome: event.outcome,
      payload: event.payload,
    })
    .from(event)
    .where(eq(event.id, attemptEventId))
    .limit(1);
  if (!row) return { status: 'skipped', reason: 'attempt_not_found' };
  if (row.action !== 'attempt' || row.subject_kind !== 'question' || row.outcome !== 'failure') {
    return { status: 'skipped', reason: 'not_failure_attempt' };
  }
  return { status: 'eligible', payload: (row.payload ?? {}) as Record<string, unknown> };
}

/**
 * Durable request operation used by the attempt-event subscriber.
 *
 * It owns automatic eligibility so neither producers nor delivery adapters
 * duplicate product rules. The caller supplies the transaction-bound enqueue
 * adapter; a stable pg-boss id makes a replay another accepted request.
 */
export async function requestFailureLearning(
  deps: FailureLearningRequestDeps,
  input: { attemptEventId: string },
): Promise<FailureLearningRequestResult> {
  const classified = await classifyAttempt(deps.db, input.attemptEventId);
  if (classified.status === 'skipped') {
    return { status: 'ignored', reason: classified.reason };
  }
  if (classified.payload.unsupported_judge === true) {
    return { status: 'ignored', reason: 'unsupported_judge' };
  }

  const failure = await getFailureAttemptById(deps.db, input.attemptEventId);
  if (!failure) return { status: 'ignored', reason: 'attempt_not_active' };
  if (failure.user_cause) return { status: 'ignored', reason: 'user_cause_present' };

  return {
    status: 'accepted',
    attributionJobId: await deps.enqueueAttribution(input.attemptEventId),
  };
}

async function attributeFailure(
  deps: FailureLearningDeps,
  attemptEventId: string,
  options: { automatic: boolean },
): Promise<AttributionResult> {
  const classified = await classifyAttempt(deps.db, attemptEventId);
  if (classified.status === 'skipped') {
    return { ...classified, modelInvoked: false };
  }
  if (options.automatic && classified.payload.unsupported_judge === true) {
    return { status: 'skipped', reason: 'unsupported_judge', modelInvoked: false };
  }

  const loaded = await getFailureAttemptWithReasoningTraceById(deps.db, attemptEventId);
  if (!loaded) {
    return { status: 'skipped', reason: 'attempt_not_active', modelInvoked: false };
  }
  const { failure, reasoning_trace: rawReasoningTrace } = loaded;
  if (options.automatic && failure.user_cause) {
    return { status: 'skipped', reason: 'user_cause_present', modelInvoked: false };
  }
  if (failure.question_snapshot === null) {
    return { status: 'skipped', reason: 'question_not_found', modelInvoked: false };
  }

  const [questionRow] = await deps.db
    .select({
      prompt_md: question.prompt_md,
      reference_md: question.reference_md,
      knowledge_ids: question.knowledge_ids,
      updated_at: question.updated_at,
    })
    .from(question)
    .where(eq(question.id, failure.question_id))
    .limit(1);
  const frozenQuestion = failure.question_snapshot?.question;
  if (!frozenQuestion && !questionRow) {
    return { status: 'skipped', reason: 'question_not_found', modelInvoked: false };
  }
  if (
    failure.question_snapshot === undefined &&
    questionRow &&
    questionRow.updated_at > failure.created_at
  ) {
    return { status: 'skipped', reason: 'question_not_found', modelInvoked: false };
  }

  const referencedKnowledgeIds =
    failure.referenced_knowledge_ids.length > 0
      ? failure.referenced_knowledge_ids
      : failure.question_snapshot === undefined
        ? (questionRow?.knowledge_ids ?? [])
        : [];
  const knowledgeContext = await loadFailureLearningKnowledgeContext(
    deps.db,
    referencedKnowledgeIds,
  );
  const subjectProfile = resolveSubjectProfile(knowledgeContext[0]?.effective_domain ?? null);
  const reasoningTraceMd = rawReasoningTrace?.trim() ? rawReasoningTrace : undefined;

  let modelInvoked = false;
  let outcome: AttributionOutcome;
  try {
    outcome = await runAttributionAndWriteJudgeEvent({
      db: deps.db,
      attemptEventId,
      input: {
        prompt_md: frozenQuestion ? frozenQuestion.prompt_md : (questionRow?.prompt_md ?? ''),
        reference_md: frozenQuestion
          ? frozenQuestion.reference_md
          : (questionRow?.reference_md ?? null),
        wrong_answer_md: failure.answer_md ?? '',
        knowledge_context: knowledgeContext,
        ...(reasoningTraceMd !== undefined ? { reasoning_trace_md: reasoningTraceMd } : {}),
      },
      referencedKnowledgeIds,
      subjectProfile,
      runTaskFn(kind, input, ctx) {
        modelInvoked = true;
        return deps.runTaskFn(kind, input, ctx);
      },
    });
  } catch (error) {
    return { status: 'failed_retryable', error, modelInvoked };
  }

  if (outcome.outcome === 'retryable') {
    return { status: 'failed_retryable', error: outcome.error, modelInvoked };
  }
  if (outcome.outcome === 'permanent') {
    return { status: 'failed_permanent', error: outcome.error, modelInvoked };
  }

  const judge = await getJudgeForAttempt(deps.db, attemptEventId);
  if (!judge) {
    return {
      status: 'failed_retryable',
      error: new Error('AttributionTask completed without writing a judge event'),
      modelInvoked,
    };
  }
  return {
    status: outcome.outcome === 'written' && modelInvoked ? 'written' : 'existing',
    judgeEventId: judge.judge_event_id,
    modelInvoked,
  };
}

export function createFailureLearning(deps: FailureLearningDeps): FailureLearning {
  return {
    attribute: ({ attemptEventId }) => attributeFailure(deps, attemptEventId, { automatic: false }),
    proposeVariant: ({ attemptEventId }) =>
      runVariantGen({ db: deps.db, attemptEventId, runTaskFn: deps.runTaskFn }),
    async followUp({ attemptEventId }) {
      const attribution = await attributeFailure(deps, attemptEventId, { automatic: true });
      if (attribution.status !== 'written' && attribution.status !== 'existing') {
        return attribution;
      }
      if (!deps.enqueueVariant) {
        return {
          status: 'failed_retryable',
          error: new Error('Failure Learning durable follow-up has no variant handoff'),
          modelInvoked: attribution.modelInvoked,
        };
      }
      await deps.enqueueVariant(attemptEventId);
      return { status: 'handed_off', attribution };
    },
  };
}
