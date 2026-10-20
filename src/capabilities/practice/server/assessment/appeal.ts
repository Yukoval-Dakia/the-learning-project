import { eq, sql } from 'drizzle-orm';
import { canonicalHash } from '@/core/migration/canonical';
import { ActivateEvaluationIntent, EvaluationProvenance } from '@/core/schema/assessment';
import type { Db, Tx } from '@/db/client';
import { evaluation, evaluation_effective_head, event } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { ApiError } from '@/kernel/http';
import {
  EvaluateSubmissionError,
  activateSubmissionCandidate,
  createFormalModelExecutor,
} from '../judge/evaluate-submission';
import { evaluateAttempt } from '../judge/evaluation-authority';

export async function createNativeAppeal(
  database: Db,
  input: { evaluation_id: string; reason_md?: string; idempotency_key?: string },
) {
  const reason = input.reason_md ?? '';
  const appealId = `evt_native_appeal_${canonicalHash({
    evaluation_id: input.evaluation_id,
    key: input.idempotency_key ?? canonicalHash(reason),
  })}`;
  return database.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${appealId}))`);
    const [existing] = await tx.select().from(event).where(eq(event.id, appealId)).limit(1);
    if (existing) {
      if (existing.payload.reason_md !== reason)
        throw new ApiError('appeal_conflict', 'appeal key already has a different reason', 409);
      return appealId;
    }
    const [original] = await tx
      .select()
      .from(evaluation)
      .where(eq(evaluation.evaluation_id, input.evaluation_id))
      .limit(1);
    if (!original) throw new ApiError('not_found', 'evaluation not found', 404);
    if (original.status !== 'completed' || original.provenance?.source !== 'automatic') {
      throw new ApiError('not_appealable', 'a completed automatic evaluation is required', 422);
    }
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('assessment-evaluation-group'), hashtext(${original.evaluation_group_id}))`,
    );
    const [head] = await tx
      .select()
      .from(evaluation_effective_head)
      .where(eq(evaluation_effective_head.evaluation_group_id, original.evaluation_group_id))
      .limit(1);
    if (!head || head.effective_evaluation_id !== original.evaluation_id) {
      throw new ApiError(
        'stale_head',
        'appeal must identify the current effective evaluation',
        409,
      );
    }
    await writeEvent(tx, {
      id: appealId,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'experimental:appeal_request',
      subject_kind: 'evaluation',
      subject_id: original.evaluation_id,
      outcome: null,
      payload: {
        reason_md: reason,
        evaluation_group_id: original.evaluation_group_id,
        expected_effective_id: original.evaluation_id,
        expected_generation: head.generation,
      },
    });
    return appealId;
  });
}

/**
 * YUK-1407 — proposal 接受的判分纠错入口（judge_retraction accept applier 调）。
 *
 * 与 createNativeAppeal 的差异：纠错可以针对**非 effective** 的 completed
 * 评价（未决/被替换的评价同样允许复核请求）；expected head 锚定的是该组
 * 【当前】 head（可为 null），rejudge job 仍经同一
 * `experimental:appeal_request` → rejudgeNativeAppeal → CAS 激活链执行。
 * 幂等键含 proposal 事件 id —— 每个 proposal 至多加挂一个纠错请求。
 */
export async function requestEvaluationCorrection(
  database: Db,
  input: {
    evaluation_id: string;
    reason_md?: string;
    proposal_event_id: string;
    /**
     * P1 review — proposal 创建时服务端观测的 head 快照。写请求时按组锁校验
     * 当前 head 仍等于该快照（防过期提案/重试把后落地的纠错 B 覆盖回 A）；
     * 快照原样入 appeal payload，成为后续 rejudge/activation CAS 的期望。
     * null/0 = 组无 head（全未决评价也可被纠错）。
     */
    expected_effective_id: string | null;
    expected_generation: number;
  },
) {
  const reason = input.reason_md ?? '';
  const correctionId = `evt_eval_correction_${canonicalHash({
    evaluation_id: input.evaluation_id,
    proposal: input.proposal_event_id,
  })}`;
  return database.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${correctionId}))`);
    const [existing] = await tx.select().from(event).where(eq(event.id, correctionId)).limit(1);
    if (existing) {
      if (existing.payload.reason_md !== reason)
        throw new ApiError('appeal_conflict', 'correction key already has a different reason', 409);
      return correctionId;
    }
    const [original] = await tx
      .select()
      .from(evaluation)
      .where(eq(evaluation.evaluation_id, input.evaluation_id))
      .limit(1);
    if (!original) throw new ApiError('not_found', 'evaluation not found', 404);
    if (original.status !== 'completed') {
      throw new ApiError(
        'not_correctable',
        'only a completed evaluation can be corrected — pending evaluation attempts are retryable infra state, not gradeable truth',
        422,
      );
    }
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('assessment-evaluation-group'), hashtext(${original.evaluation_group_id}))`,
    );
    const [head] = await tx
      .select()
      .from(evaluation_effective_head)
      .where(eq(evaluation_effective_head.evaluation_group_id, original.evaluation_group_id))
      .limit(1);
    if (
      (head?.effective_evaluation_id ?? null) !== input.expected_effective_id ||
      (head?.generation ?? 0) !== input.expected_generation
    ) {
      throw new ApiError(
        'stale_correction_target',
        'the group head moved since the correction proposal was filed — file a fresh proposal against the new head instead of rebasing this one',
        409,
      );
    }
    await writeEvent(tx, {
      id: correctionId,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'experimental:appeal_request',
      subject_kind: 'evaluation',
      subject_id: original.evaluation_id,
      outcome: null,
      caused_by_event_id: input.proposal_event_id,
      payload: {
        reason_md: reason,
        evaluation_group_id: original.evaluation_group_id,
        expected_effective_id: input.expected_effective_id,
        expected_generation: input.expected_generation,
        proposal_event_id: input.proposal_event_id,
      },
    });
    return correctionId;
  });
}

/**
 * 重判的确定性绑定冲突：重试不会改变结果。按 stale_head 同款落 hold resolution，
 * 否则 pg-boss 耗尽重试后进 DLQ，而 accept 已告诉 owner queued_rejudge。
 */
function isPermanentRejudgeConflict(error: unknown): boolean {
  if (error instanceof ApiError) return error.code === 'appeal_execution_conflict';
  if (error instanceof EvaluateSubmissionError) {
    return error.code === 'attempt_conflict' || error.code === 'evaluation_key_conflict';
  }
  return false;
}

export async function rejudgeNativeAppeal(database: Db, appeal: typeof event.$inferSelect) {
  const resolutionId = `evt_native_resolution_${canonicalHash(appeal.id)}`;
  const record = async (tx: Db | Tx, disposition: string, evaluationId?: string) => {
    // Used with the activation transaction, or alone for an explicit held result.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${resolutionId}))`);
    const [existing] = await tx
      .select({ id: event.id })
      .from(event)
      .where(eq(event.id, resolutionId));
    if (existing) return;
    await writeEvent(tx, {
      id: resolutionId,
      actor_kind: 'system',
      actor_ref: 'assessment:appeal',
      action: 'experimental:assessment_appeal_resolution',
      subject_kind: 'evaluation',
      subject_id: appeal.subject_id,
      outcome: null,
      caused_by_event_id: appeal.id,
      payload: { disposition, ...(evaluationId ? { evaluation_id: evaluationId } : {}) },
    });
  };
  const hold = async (reason: string, evaluationId?: string) => {
    await database.transaction((tx) => record(tx, reason, evaluationId));
    return { status: 'held' as const, appeal_event_id: appeal.id, reason };
  };
  const [original] = await database
    .select()
    .from(evaluation)
    .where(eq(evaluation.evaluation_id, appeal.subject_id))
    .limit(1);
  const provenance = EvaluationProvenance.safeParse(original?.provenance);
  if (
    !original ||
    !provenance.success ||
    !provenance.data.input_snapshot ||
    (provenance.data.source !== 'automatic' && provenance.data.source !== 'manual')
  )
    return hold('frozen_input_unavailable');
  const intent = ActivateEvaluationIntent.safeParse({
    evaluation_id: original.evaluation_id,
    expected_effective_id: appeal.payload.expected_effective_id,
    expected_generation: appeal.payload.expected_generation,
  });
  if (!intent.success) return hold('activation_intent_unavailable');
  const [head] = await database
    .select()
    .from(evaluation_effective_head)
    .where(eq(evaluation_effective_head.evaluation_group_id, original.evaluation_group_id))
    .limit(1);
  // YUK-1407 — 纠错请求允许非 effective 目标：组可能没有 head（全未决评价）。
  // null-safe 比较；head 缺失时只有 expected=null/0 的请求能推进。
  if (
    (head?.effective_evaluation_id ?? null) !== intent.data.expected_effective_id ||
    (head?.generation ?? 0) !== intent.data.expected_generation
  )
    return hold('stale_head');
  let candidate: Awaited<ReturnType<typeof evaluateAttempt>>;
  try {
    candidate = await evaluateAttempt({
      db: database,
      entry: 'appeal_rejudge',
      contract: {
        submission_id: original.submission_id,
        evaluation_group_id: original.evaluation_group_id,
        expected_submission_ids: provenance.data.input_snapshot.member_submission_ids,
        evaluation_key: `appeal:${appeal.id}`,
        provenance: {
          source: 'automatic',
          assisted: provenance.data.assisted,
          review_context: {
            appeal_event_id: appeal.id,
            prior_evaluation_id: original.evaluation_id,
            reason_md: typeof appeal.payload.reason_md === 'string' ? appeal.payload.reason_md : '',
          },
        },
        model_executor: createFormalModelExecutor(database),
      },
    });
  } catch (error) {
    if (isPermanentRejudgeConflict(error)) return hold('binding_conflict');
    throw error;
  }
  const candidateId = candidate.evaluation.record.evaluation_id;
  if (
    candidate.evaluation.record.status !== 'completed' ||
    candidate.result.coarse_outcome === 'unsupported'
  )
    return hold('review_required', candidateId);
  const activation = await activateSubmissionCandidate(
    database,
    { ...intent.data, evaluation_id: candidateId },
    {
      actorRef: 'assessment:appeal',
      record: (tx) => record(tx, 'effective', candidateId),
    },
  );
  if (activation.status !== 'activated' && activation.status !== 'already_effective')
    return hold(activation.status, candidateId);
  return {
    status: 'reassessed' as const,
    appeal_event_id: appeal.id,
    evaluation_id: candidateId,
    effect: activation.effect,
  };
}
