import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { canonicalHash } from '@/core/migration/canonical';
import {
  ActivateEvaluationIntent,
  EvaluationProvenance,
  EvaluationRecord,
  type EvaluationRecordT,
} from '@/core/schema/assessment';
import type { Db, Tx } from '@/db/client';
import { evaluation, evaluation_effective_head, event } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { ApiError } from '@/kernel/http';
import { lockAssessmentEvaluationGroup } from '@/kernel/locks/assessment-evaluation-group-lock';
import {
  lockEvaluationCorrection,
  lockNativeAppeal,
  lockNativeResolution,
} from '@/kernel/locks/settlement';
import {
  EvaluateSubmissionError,
  activateSubmissionCandidate,
  createFormalModelExecutor,
  evaluateAttempt,
} from '../../grading/public';

export interface NativeAppealReceipt {
  appeal_event_id: string;
  /**
   * False when a terminal resolution already covers this request — either this
   * exact appeal id was already resolved, or the same submission + reason already
   * produced a completed `effective` rejudge the call reuses. The caller must not
   * enqueue a rejudge (and must not spend a model call) in that case. True for a
   * fresh appeal and for retryable unfinished/failed attempts.
   */
  should_rejudge: boolean;
}

async function appealResolutionExists(db: Db | Tx, appealId: string): Promise<boolean> {
  const [resolution] = await db
    .select({ id: event.id })
    .from(event)
    .where(
      and(
        eq(event.caused_by_event_id, appealId),
        eq(event.action, 'experimental:assessment_appeal_resolution'),
      ),
    )
    .limit(1);
  return resolution !== undefined;
}

/**
 * Completed-result idempotency (YUK-1880): a second appeal for the SAME submission
 * and the SAME reason must not re-run the model once a rejudge already landed a
 * result — including the one-click case where the effective anchor moved to a new
 * evaluation_id and the appeal id would differ. Only `effective` dispositions
 * (changed OR unchanged verdicts) complete the boundary; failed, 429, held and
 * unfinished attempts stay retryable. Latest completed appeal wins. Must run
 * under `lockAssessmentEvaluationGroup` so no sibling appeal can be mid-resolve.
 */
async function findCompletedAppealForSubmission(
  tx: Tx,
  input: { evaluation_group_id: string; submission_id: string; reason: string },
): Promise<string | null> {
  const appeals = await tx
    .select({
      id: event.id,
      subject_id: event.subject_id,
      reason_md: sql<string | null>`${event.payload}->>'reason_md'`,
    })
    .from(event)
    .where(
      and(
        eq(event.action, 'experimental:appeal_request'),
        eq(event.subject_kind, 'evaluation'),
        sql`${event.payload}->>'evaluation_group_id' = ${input.evaluation_group_id}`,
      ),
    )
    .orderBy(desc(event.created_at), desc(event.id));
  const matching = appeals.filter(
    (row) => (row.reason_md ?? '') === input.reason && row.subject_id !== null,
  );
  if (matching.length === 0) return null;
  const subjectEvals = await tx
    .select({ evaluation_id: evaluation.evaluation_id, submission_id: evaluation.submission_id })
    .from(evaluation)
    .where(
      inArray(
        evaluation.evaluation_id,
        matching.map((row) => row.subject_id as string),
      ),
    );
  const sameSubmission = new Set(
    subjectEvals
      .filter((row) => row.submission_id === input.submission_id)
      .map((row) => row.evaluation_id),
  );
  const candidates = matching.filter((row) => sameSubmission.has(row.subject_id as string));
  if (candidates.length === 0) return null;
  const resolutions = await tx
    .select({
      appeal_id: event.caused_by_event_id,
      disposition: sql<string | null>`${event.payload}->>'disposition'`,
    })
    .from(event)
    .where(
      and(
        eq(event.action, 'experimental:assessment_appeal_resolution'),
        inArray(
          event.caused_by_event_id,
          candidates.map((row) => row.id),
        ),
      ),
    );
  const resolved = new Set(
    resolutions
      .filter((row) => row.disposition === 'effective')
      .map((row) => row.appeal_id as string),
  );
  return candidates.find((row) => resolved.has(row.id))?.id ?? null;
}

export async function createNativeAppeal(
  database: Db,
  input: { evaluation_id: string; reason_md?: string; idempotency_key?: string },
): Promise<NativeAppealReceipt> {
  const reason = input.reason_md ?? '';
  const appealId = `evt_native_appeal_${canonicalHash({
    evaluation_id: input.evaluation_id,
    key: input.idempotency_key ?? canonicalHash(reason),
  })}`;
  return database.transaction(async (tx) => {
    await lockNativeAppeal(tx, appealId);
    const [existing] = await tx.select().from(event).where(eq(event.id, appealId)).limit(1);
    if (existing) {
      if (existing.payload.reason_md !== reason)
        throw new ApiError('appeal_conflict', 'appeal key already has a different reason', 409);
      return {
        appeal_event_id: appealId,
        should_rejudge: !(await appealResolutionExists(tx, appealId)),
      };
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
    await lockAssessmentEvaluationGroup(tx, original.evaluation_group_id);
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
    const reused = await findCompletedAppealForSubmission(tx, {
      evaluation_group_id: original.evaluation_group_id,
      submission_id: original.submission_id,
      reason,
    });
    if (reused) return { appeal_event_id: reused, should_rejudge: false };
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
    return { appeal_event_id: appealId, should_rejudge: true };
  });
}

/**
 * proposal 接受的判分纠错入口（judge_retraction accept applier 调）。
 *
 * 与 createNativeAppeal 的差异：纠错可以针对**非 effective** 的 completed
 * 评价（未决/被替换的评价同样允许复核请求）；expected head 锚定的是该组
 * 【当前】 head（可为 null），rejudge job 仍经同一
 * `experimental:appeal_request` → rejudgeNativeAppeal → CAS 激活链执行。
 * 幂等键含 proposal 事件 id —— 每个 proposal 至多加挂一个纠错请求。
 */
export function evaluationCorrectionEventId(evaluationId: string, proposalEventId: string): string {
  return `evt_eval_correction_${canonicalHash({
    evaluation_id: evaluationId,
    proposal: proposalEventId,
  })}`;
}

export async function requestEvaluationCorrection(
  database: Db | Tx,
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
  const correctionId = evaluationCorrectionEventId(input.evaluation_id, input.proposal_event_id);
  return database.transaction(async (tx) => {
    await lockEvaluationCorrection(tx, correctionId);
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
    await lockAssessmentEvaluationGroup(tx, original.evaluation_group_id);
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

/**
 * changed/unchanged 在写侧裁决：只有这里同时拥有 before record、after record
 * 与激活结果（读侧拿不到 partial_unknown 计数这类 null-score 维度）。
 * 签名只取结果承载面——分数 / 部分对计数 / 单元判定 / 聚合结果；散文段
 * （feedback_md / evidence_citations / comparison / detail）每次重判必然
 * 不同，不入签。数组按 id 归序，option_ids 排序。
 */
function appealOutcomeSignature(record: EvaluationRecordT) {
  return {
    status: record.status,
    units: record.unit_results
      .map((unit) =>
        unit.status === 'scored'
          ? {
              id: unit.scoring_unit_id,
              points: unit.points_awarded,
              blank: unit.scored_because,
              partial: unit.partial_unknown_points
                ? {
                    c: unit.partial_unknown_points.correct_count,
                    t: unit.partial_unknown_points.total_count,
                  }
                : null,
              matched: unit.matched
                ? {
                    rule: unit.matched.rule_id ?? null,
                    level: unit.matched.level_id ?? null,
                    options: [...unit.matched.option_ids].sort(),
                  }
                : null,
            }
          : { id: unit.scoring_unit_id, pending: unit.pending.reason },
      )
      .sort((a, b) => a.id.localeCompare(b.id)),
    aggregate:
      record.aggregate == null
        ? null
        : record.aggregate.kind === 'points_total'
          ? { kind: record.aggregate.kind, points: record.aggregate.points }
          : record.aggregate.kind === 'level'
            ? {
                kind: record.aggregate.kind,
                level: record.aggregate.level_id,
                points: record.aggregate.points,
              }
            : record.aggregate.kind === 'partial_unknown_points'
              ? {
                  kind: record.aggregate.kind,
                  known: record.aggregate.known_points,
                  units: record.aggregate.partial_units
                    .map((u) => ({ id: u.scoring_unit_id, c: u.correct_count, t: u.total_count }))
                    .sort((a, b) => a.id.localeCompare(b.id)),
                }
              : { kind: record.aggregate.kind, reason: record.aggregate.reason },
  };
}

export async function rejudgeNativeAppeal(database: Db, appeal: typeof event.$inferSelect) {
  const resolutionId = `evt_native_resolution_${canonicalHash(appeal.id)}`;
  const record = async (
    tx: Tx,
    disposition: string,
    evaluationId?: string,
    verdictChange?: 'changed' | 'unchanged',
  ) => {
    // Used with the activation transaction, or alone for an explicit held result.
    await lockNativeResolution(tx, resolutionId);
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
      payload: {
        disposition,
        ...(evaluationId ? { evaluation_id: evaluationId } : {}),
        ...(verdictChange ? { verdict_change: verdictChange } : {}),
      },
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
  // 纠错请求允许非 effective 目标：组可能没有 head（全未决评价）。
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
  const verdictChange: 'changed' | 'unchanged' =
    canonicalHash(appealOutcomeSignature(EvaluationRecord.parse(original))) ===
    canonicalHash(appealOutcomeSignature(candidate.evaluation.record))
      ? 'unchanged'
      : 'changed';
  const activation = await activateSubmissionCandidate(
    database,
    { ...intent.data, evaluation_id: candidateId },
    {
      actorRef: 'assessment:appeal',
      correction: { appealEventId: appeal.id, priorEvaluationId: original.evaluation_id },
      record: (tx) => record(tx, 'effective', candidateId, verdictChange),
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
