import { eq } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import { event, question } from '@/db/schema';
import { shouldEnqueueBackgroundJobs } from '@/kernel/background-job-enqueue';
import { HostOperationNotInstalledError } from '@/kernel/host-operation';
import { enqueueNoteRefineTrigger } from '@/kernel/note-refine-trigger';
import { resolveVerdictForAttempt } from '@/kernel/read-models/assessment-verdict';
import {
  getFailureAttemptForDerivationById,
  getFailureAttemptWithReasoningTraceForDerivationById,
} from '@/kernel/read-models/failure-attempts';
import { loadFailureLearningKnowledgeContext } from '@/kernel/read-models/failure-learning-context';
import { notesForKnowledge } from '@/kernel/read-models/notes-read';
import type { BoundRunTaskTextFn } from '@/server/ai/runner-fn';
import { resolveSubjectProfile } from '@/subjects/profile';
import { loadAttributionEvidence } from './attribution-context';
import {
  type AttributionOutcome,
  runAttributionAndWriteJudgeEvent,
} from './failure-learning-attribution';
import { loadNativeFailureContext } from './failure-learning-native';
import { type RunVariantGenResult, runVariantGen } from './failure-learning-variant';

export type FailureLearningSkipReason =
  | 'attempt_not_found'
  | 'not_failure_attempt'
  | 'attempt_not_active'
  | 'unsupported_judge'
  | 'user_cause_present'
  | 'question_not_found'
  | 'verdict_overturned';

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
  | { status: 'skipped'; reason: FailureLearningSkipReason; modelInvoked: boolean }
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
        | 'user_cause_present'
        | 'verdict_overturned';
    };

export interface FailureLearningRequestDeps {
  db: Db | Tx;
  /** Persist the durable dispatch obligation inside the caller's transaction;
   * returns the stable attribution stage job id. */
  recordAttributionIntent(attemptEventId: string): Promise<string>;
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
  runTaskFn: BoundRunTaskTextFn;
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
  if (
    row.subject_kind !== 'question' ||
    (row.action !== 'experimental:assessment_attempt' &&
      (row.action !== 'attempt' || row.outcome !== 'failure'))
  ) {
    return { status: 'skipped', reason: 'not_failure_attempt' };
  }
  return { status: 'eligible', payload: (row.payload ?? {}) as Record<string, unknown> };
}

/**
 * Durable request operation used by the attempt-event subscriber.
 *
 * It owns automatic eligibility so neither producers nor delivery adapters
 * duplicate product rules. The caller supplies the transaction-bound intent
 * writer; the deterministic intent row makes a replay another accepted request.
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

  // Paid-fanout suppression: attempt.outcome is an immutable execution fact, so an attempt
  // whose judge was overturned still reads outcome='failure'. Re-read the effective judge
  // before enqueueing attribution so an overturned attempt cannot drive paid work.
  const verdict = await resolveVerdictForAttempt(deps.db, input.attemptEventId);
  if (verdict.effective?.verdict.coarse_outcome === 'correct') {
    return { status: 'ignored', reason: 'verdict_overturned' };
  }

  const failure = await getFailureAttemptForDerivationById(deps.db, input.attemptEventId);
  if (!failure) return { status: 'ignored', reason: 'attempt_not_active' };
  if (failure.user_cause) return { status: 'ignored', reason: 'user_cause_present' };

  return {
    status: 'accepted',
    attributionJobId: await deps.recordAttributionIntent(input.attemptEventId),
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

  // Paid-fanout suppression: automatic attribution skips an attempt whose judge was
  // overturned to correct. Manual calls (automatic:false) stay available as an explicit
  // owner/copilot fallback.
  if (options.automatic) {
    const verdict = await resolveVerdictForAttempt(deps.db, attemptEventId);
    if (verdict.effective?.verdict.coarse_outcome === 'correct') {
      return { status: 'skipped', reason: 'verdict_overturned', modelInvoked: false };
    }
  }

  const loaded = await getFailureAttemptWithReasoningTraceForDerivationById(
    deps.db,
    attemptEventId,
  );
  if (!loaded) {
    return { status: 'skipped', reason: 'attempt_not_active', modelInvoked: false };
  }
  const { failure, reasoning_trace: rawReasoningTrace } = loaded;
  if (options.automatic && failure.user_cause) {
    return { status: 'skipped', reason: 'user_cause_present', modelInvoked: false };
  }
  const native = failure.assessment
    ? await loadNativeFailureContext(deps.db, attemptEventId)
    : null;
  if (failure.assessment && !native)
    return { status: 'skipped', reason: 'question_not_found', modelInvoked: false };
  if (!native && failure.question_snapshot === null) {
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
  if (!native && !frozenQuestion && !questionRow) {
    return { status: 'skipped', reason: 'question_not_found', modelInvoked: false };
  }
  if (
    failure.question_snapshot === undefined &&
    questionRow &&
    questionRow.updated_at > failure.created_at
  ) {
    return { status: 'skipped', reason: 'question_not_found', modelInvoked: false };
  }

  const promptMd =
    native?.prompt_md ??
    (frozenQuestion ? frozenQuestion.prompt_md : (questionRow?.prompt_md ?? ''));
  const wrongAnswerMd = native?.answer_md ?? failure.answer_md ?? '';
  const referencedKnowledgeIds =
    native?.knowledge_ids ??
    (failure.referenced_knowledge_ids.length > 0
      ? failure.referenced_knowledge_ids
      : failure.question_snapshot === undefined
        ? (questionRow?.knowledge_ids ?? [])
        : []);
  const knowledgeContext = await loadFailureLearningKnowledgeContext(
    deps.db,
    referencedKnowledgeIds,
  );
  const subjectProfile = resolveSubjectProfile(knowledgeContext[0]?.effective_domain ?? null);
  const reasoningTraceMd = rawReasoningTrace?.trim() ? rawReasoningTrace : undefined;
  const evidence = await loadAttributionEvidence(deps.db, {
    attemptEventId,
    questionId: failure.question_id,
    attemptPayload: classified.payload,
    knowledgeIds: referencedKnowledgeIds,
    gradingEvidence: native?.grading_evidence ?? null,
    revisionId: native?.revision_id ?? null,
    failedPartIds: native?.failed_part_ids ?? [],
  });

  let modelInvoked = false;
  let outcome: AttributionOutcome;
  try {
    outcome = await runAttributionAndWriteJudgeEvent({
      db: deps.db,
      attemptEventId,
      input: {
        prompt_md: promptMd,
        reference_md: native
          ? native.reference_md
          : frozenQuestion
            ? frozenQuestion.reference_md
            : (questionRow?.reference_md ?? null),
        wrong_answer_md: wrongAnswerMd,
        knowledge_context: knowledgeContext,
        ...(reasoningTraceMd !== undefined ? { reasoning_trace_md: reasoningTraceMd } : {}),
        ...evidence,
      },
      referencedKnowledgeIds,
      ...(native ? { nativeExpectation: native } : {}),
      subjectProfile,
      runTaskFn(kind, input, ctx) {
        modelInvoked = true;
        return deps.runTaskFn(kind, input, ctx);
      },
    });
  } catch (error) {
    return { status: 'failed_retryable', error, modelInvoked };
  }

  if (outcome.outcome === 'superseded')
    return { status: 'skipped', reason: 'verdict_overturned', modelInvoked };
  if (outcome.outcome === 'retryable') {
    return { status: 'failed_retryable', error: outcome.error, modelInvoked };
  }
  if (outcome.outcome === 'permanent') {
    return { status: 'failed_permanent', error: outcome.error, modelInvoked };
  }

  // Chain-resolved effective judge, not a direct caused_by read: a rejudge anchors
  // caused_by=appeal, so a caused_by-only read would return a stale verdict.
  const verdicts = await resolveVerdictForAttempt(deps.db, attemptEventId);
  const judgeEventId = verdicts.effective?.judge_event_id ?? null;
  if (!judgeEventId) {
    return {
      status: 'failed_retryable',
      error: new Error('AttributionTask completed without writing a judge event'),
      modelInvoked,
    };
  }
  await enqueueMarkWrongNoteRefine({
    db: deps.db,
    knowledgeIds: referencedKnowledgeIds,
    knowledgeNames: knowledgeContext.map((node) => node.name),
    promptMd,
    wrongAnswerMd,
    attemptEventId,
    judgeEventId,
  });
  return {
    status: outcome.outcome === 'written' && modelInvoked ? 'written' : 'existing',
    judgeEventId,
    modelInvoked,
  };
}

/** Paid note-refine jobs one wrong answer may fan out. One first note per knowledge point. */
const MARK_WRONG_NOTE_LIMIT = 8;

function clipLearnerText(value: string): string {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length <= 400 ? text : `${text.slice(0, 399)}…`;
}

async function enqueueMarkWrongNoteRefine(input: {
  db: Db;
  knowledgeIds: string[];
  knowledgeNames: string[];
  promptMd: string;
  wrongAnswerMd: string;
  attemptEventId: string;
  judgeEventId: string;
}): Promise<void> {
  const knowledgeIds = [
    ...new Set(input.knowledgeIds.map((id) => id.trim()).filter(Boolean)),
  ].slice(0, MARK_WRONG_NOTE_LIMIT);
  if (knowledgeIds.length === 0) return;
  const notes = await Promise.all(
    knowledgeIds.map((knowledgeId) => notesForKnowledge(input.db, knowledgeId, { limit: 1 })),
  );
  const artifactIds: string[] = [];
  const seen = new Set<string>();
  for (const batch of notes) {
    const note = batch[0];
    if (!note || seen.has(note.id)) continue;
    seen.add(note.id);
    artifactIds.push(note.id);
    if (artifactIds.length >= MARK_WRONG_NOTE_LIMIT) break;
  }
  if (artifactIds.length === 0) return;
  const names = input.knowledgeNames.filter((name) => name.trim().length > 0);
  const contextMd = [
    '学习者在这些知识点上做错了一题。',
    names.length > 0 ? `知识点：${names.join('、')}` : null,
    input.promptMd.trim() ? `题目：${clipLearnerText(input.promptMd)}` : null,
    `学习者的答案：${clipLearnerText(input.wrongAnswerMd) || '（空）'}`,
  ]
    .filter((line): line is string => line !== null)
    .join('\n');
  for (const artifactId of artifactIds) {
    try {
      const result = await enqueueNoteRefineTrigger({
        db: input.db,
        artifactId,
        kind: 'mark_wrong',
        contextMd,
        evidenceIds: [input.attemptEventId],
        triggerEventId: input.judgeEventId,
      });
      if (result.status === 'failed') {
        console.warn(
          `[failure-learning] mark_wrong note refine enqueue failed for ${artifactId}: ${result.error}`,
        );
      }
    } catch (err) {
      if (err instanceof HostOperationNotInstalledError) {
        if (shouldEnqueueBackgroundJobs()) {
          console.error('[failure-learning] note refine trigger is not installed', err);
        }
        return;
      }
      throw err;
    }
  }
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
