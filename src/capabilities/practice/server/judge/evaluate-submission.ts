// ====================================================================
// YUK-1047 — evaluateSubmission 的持久化入口（grounding §4.2–§4.4）
// ====================================================================
//
// 本模块是 §4.3 `evaluateSubmission(submissionId, evaluationGroupId,
// executionPolicy)` 的【落库实现】：冻结输入（assessment_submission +
// question_revision + assessment_issuance）→ evaluateSubmissionCore（纯内核，
// `@/core/schema/assessment/evaluation.ts`）→ candidate evaluation 行。
//
// 纪律（不可弱化）：
//   - 只产 candidate：绝不触碰 evaluation_effective_head（activation =
//     YUK-1045），绝不写学习状态（settlement = YUK-1053）；
//   - 坐标一致性 fail-closed：submission.evaluation_group_id 必须等于请求
//     的 group（复合 FK (submission, group) 兜底前先在应用层明确拦截）；
//   - group session lock serializes frozen input loading, execution and sealing;
//     no transaction remains open while a model runs. The unique attempt key is the final fence.
//   - 幂等：同 attempt 冲突时读回全载荷比对 —— 逐字相同 = replay（返回已存在
//     行），不同 = 真并发发散（attempt_conflict 抛出，绝不覆盖）。
//   - evaluation_id 内容寻址（eva_<sha256-48>）：重试同输入 ⇒ 同身份。
//
// 模型执行器是注入端口（ModelUnitExecutorPort）：本文件【不】含 provider/LLM
// 调用 —— typed transport 归 src/server/ai/ 后续 lane（YUK-1049）。

import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  evaluationMemberFromRows,
  freezeEvaluationInput,
  sameMemberSet,
} from '@/core/assessment-input';
import { canonicalHash } from '@/core/migration/canonical';
import {
  EvaluationContractError,
  type EvaluationExecutionPolicyT,
  type EvaluationProvenanceT,
  EvaluationRecord,
  type EvaluationRecordT,
  ModelExecutionNotStartedError,
  type ModelUnitExecutorPort,
  type ScoringBasisT,
  SubmissionRecord,
  evaluateSubmissionCore,
  projectIssuedScoringBasis,
} from '@/core/schema/assessment';
import type { Db, Tx } from '@/db/client';
import {
  assessment_issuance,
  assessment_submission,
  evaluation,
  evaluation_effective_head,
  evaluation_group,
  question_group_lifecycle,
  question_revision,
} from '@/db/schema';
import { withinSessionAdvisoryLock } from '@/db/session-advisory-lock';
import {
  type ActivateEvaluationRequestT,
  type SettlementObservers,
  activateEvaluation,
  createJevModelExecutor,
  createPiModelExecutor,
  learningSettlement,
  snapshotAssessmentLearningScope,
  withdrawCapturedOccurrence,
} from '@/server/assessment/runtime';
import { checkRateLimit } from '@/server/http/rate-limit';
import { createRecordedModelExecutor } from './recorded-model-executor';

// Native assessment runtime ports are assembled at this existing capability boundary.
export { snapshotAssessmentLearningScope, withdrawCapturedOccurrence };

/**
 * YUK-1092 — 装配描述符：在本模块组合点按 descriptor 铸
 * ModelUnitExecutorPort（当前唯一 lane：Jev typed executor）。
 *
 * `deadline_at` 是【必填】caller 输入 —— Jev 重试 + advanced fallback 共享
 * 同一面墙钟上限（release 条件），装配点不虚构全局默认值；
 * `rule_threshold` 是按切片的 policy 输入（rule_reference 单元缺阈值 ⇒
 * 端口 fail-closed unjudgeable，绝不发明阈值）。
 */
export interface JevModelExecutorSpec {
  readonly kind: 'jev';
  /** 单次端口调用（含 Jev 重试与 advanced fallback）的绝对墙钟上界（ms epoch）。 */
  readonly deadline_at: number;
  /** rule_reference 的 noul 满足阈值（per-slice policy；缺省 ⇒ rule_reference 单元 pending）。 */
  readonly rule_threshold?: number;
  /** Jev 不可服务时调用的已批准高级执行器（同 ModelExecutorRequest，共享 deadline）。 */
  readonly advanced_executor?: ModelUnitExecutorPort;
  /** 调用方取消信号（转发进 typed runner 与 advanced executor）。 */
  readonly signal?: AbortSignal;
}

export interface PiModelExecutorSpec {
  readonly kind: 'pi';
  readonly deadline_at: number;
  readonly max_cost_usd_micros: number;
  readonly signal?: AbortSignal;
}

/** evaluateSubmission 请求（§4.3 Interface）。 */
export interface EvaluateSubmissionRequest {
  submission_id: string;
  evaluation_group_id: string;
  /** Same operation across preview/commit/redelivery. A regrade uses a new key. */
  evaluation_key?: string;
  /** Commit may only read this existing candidate, never dispatch another execution. */
  expected_evaluation_id?: string;
  /** Exact complete member set; omission explicitly selects only submission_id. */
  expected_submission_ids?: string[];
  /** 执行期 policy（不改给分规则；仅低置信 gate 等执行面旋钮）。 */
  policy?: EvaluationExecutionPolicyT;
  /**
   * manual_assert（D9）：显式手动/自评结果直落 candidate，跳过执行器分发。
   * provenance.source 必须为 manual|self_report（内核强制）。
   */
  mode?: 'execute' | 'manual_assert';
  asserted_unit_results?: import('@/core/schema/assessment').ScoringUnitResultT[];
  provenance?: EvaluationProvenanceT;
  /**
   * admitted model_executor 单元的执行端口，或在本模块装配的描述符
   * （{kind:'jev'} ⇒ createJevModelExecutor）；缺失 ⇒ 该单元 retryable
   * infra_failure。描述符形态要求 db 为池化 Db 句柄（非 Tx）—— 模型
   * run/cost 台账行是独立证据，不能随评估事务回滚而丢失。
   */
  model_executor?: ModelUnitExecutorPort | JevModelExecutorSpec | PiModelExecutorSpec;
}

export interface EvaluateSubmissionResult {
  /** 落库（或 replay 已存在）的 candidate evaluation。 */
  record: EvaluationRecordT;
  /** 真实写入时间（持久化列；契约 EvaluationRecord 不含该字段）。 */
  created_at: Date;
  /** true = (submission, attempt) 冲突且全载荷一致 —— 幂等重放，未新写。 */
  replayed: boolean;
  /** 本次评估依据的【已冻结】scoring basis（revision 快照；消费侧投影用）。 */
  scoring_basis: ScoringBasisT;
  model_units_invoked: number;
  spent_cost_usd_micros: number;
}

export class EvaluateSubmissionError extends Error {
  override name = 'EvaluateSubmissionError';
  constructor(
    public readonly code:
      | 'submission_not_found'
      | 'issuance_not_found'
      | 'revision_not_found'
      | 'group_scope_mismatch'
      | 'group_membership_mismatch'
      | 'evaluation_busy'
      | 'attempt_conflict'
      | 'evaluation_key_conflict'
      | 'candidate_not_found'
      | 'invalid_executor_spec',
    detail: string,
  ) {
    super(`evaluateSubmission: ${code} — ${detail}`);
  }
}

/** Published task identity selects a registered native executor; no URL/key override. */
export function createFormalModelExecutor(
  db: Db,
  signal?: AbortSignal,
  admission?: 'durable',
): ModelUnitExecutorPort {
  const deadlineAt = Date.now() + 90_000;
  let admitted = false;
  return createRecordedModelExecutor(
    db,
    (request, callerSignal, taskRunId) => {
      if (request.executor.task_kind === 'AssessmentRuleJudgeTask') {
        return createPiModelExecutor({
          db,
          deadlineAt,
          signal,
          taskRunId,
          maxCostUsdMicros: request.executor.max_cost_usd_micros ?? 0,
        })(request, callerSignal);
      }
      return createJevModelExecutor({ db, deadlineAt, signal, taskRunId })(request, callerSignal);
    },
    {
      beforeClaim: () => {
        if (admitted) return;
        try {
          if (admission !== 'durable') checkRateLimit();
        } catch (error) {
          if (!(error instanceof Error)) throw error;
          throw new ModelExecutionNotStartedError(error);
        }
        admitted = true;
      },
    },
  );
}

/**
 * YUK-1092 — 组合点接线：descriptor ⇒ 实名 ModelUnitExecutorPort。
 *
 * 在事务之外解析：模型 run/cost 台账行的 db 必须是池化 Db（tx 句柄会让
 * 付费调用证据随评估事务回滚消失，且 ai_task_runs 的并发重试依赖独立
 * 连接）——传 Tx + descriptor 直接 fail-loud，绝不悄悄借事务句柄。
 */
export function resolveModelExecutor(
  db: Db | Tx,
  executor: ModelUnitExecutorPort | JevModelExecutorSpec | PiModelExecutorSpec | undefined,
): ModelUnitExecutorPort | undefined {
  if (executor === undefined || typeof executor === 'function') return executor;
  if (executor.kind !== 'jev' && executor.kind !== 'pi') {
    throw new EvaluateSubmissionError(
      'invalid_executor_spec',
      `model_executor spec kind '${String((executor as { kind: unknown }).kind)}' has no registered lane`,
    );
  }
  if (!('$client' in db)) {
    throw new EvaluateSubmissionError(
      'invalid_executor_spec',
      'model_executor spec requires the pool Db handle (not Tx): model run/cost ledger rows are independent evidence and must not roll back with the evaluation transaction',
    );
  }
  if (executor.kind === 'pi') {
    return createPiModelExecutor({
      db,
      deadlineAt: executor.deadline_at,
      maxCostUsdMicros: executor.max_cost_usd_micros,
      signal: executor.signal,
    });
  }
  return createJevModelExecutor({
    db,
    deadlineAt: executor.deadline_at,
    ruleThreshold: executor.rule_threshold,
    advancedExecutor: executor.advanced_executor,
    signal: executor.signal,
  });
}

/** 内容寻址 evaluation 身份（≤48 hex，与迁移 `aev_*` 前缀族一致的可读前缀）。 */
function evaluationIdFor(record: EvaluationRecordT): string {
  return `eva_${canonicalHash({
    submission_id: record.submission_id,
    evaluation_group_id: record.evaluation_group_id,
    attempt: record.attempt,
    status: record.status,
    unit_results: record.unit_results,
    aggregate: record.aggregate,
    plan_digest: record.plan_digest,
    run_refs: record.run_refs,
    provenance: record.provenance ?? null,
  }).slice(0, 48)}`;
}

/** plan digest = canonical hash of {execution_plan, scoring_basis}（评分语义权威对）。 */
function planDigestOf(revision: { execution_plan: unknown; scoring_basis: unknown }): string {
  return `sha256:${canonicalHash({
    execution_plan: revision.execution_plan,
    scoring_basis: revision.scoring_basis,
  })}`;
}

interface EvaluationRowPayload {
  evaluation_id: string;
  evaluation_group_id: string;
  submission_id: string;
  attempt: number;
  status: 'pending' | 'completed';
  unit_results: EvaluationRecordT['unit_results'];
  aggregate: EvaluationRecordT['aggregate'];
  plan_digest: string | null;
  run_refs: string[];
  provenance: Record<string, unknown> | null;
}

/**
 * 全载荷比较（replay 判定）：冲突行与本次结果逐字段相等才算同一评估的
 * 幂等重放；任何差异 = 真并发发散（attempt_conflict）。created_at 不参与
 * （重放时刻不同是必然）。
 */
function evaluationPayloadEquals(a: EvaluationRowPayload, b: EvaluationRowPayload): boolean {
  return canonicalHash(a) === canonicalHash(b);
}

/**
 * §4.3 evaluateSubmission：读冻结契约 → 纯内核评估 → candidate 行落库。
 * Short load/seal transactions share a session group lock; model work runs between them.
 */
export async function evaluateSubmission(
  db: Db | Tx,
  request: EvaluateSubmissionRequest,
): Promise<EvaluateSubmissionResult> {
  // 模型执行器解析在事务之外（descriptor ⇒ Jev 端口装配；见
  // resolveModelExecutor 的 db 句柄纪律）。
  const modelExecutor = resolveModelExecutor(db, request.model_executor);

  if (
    modelExecutor !== undefined &&
    (!('$client' in db) || typeof db.$client.reserve !== 'function')
  ) {
    throw new EvaluateSubmissionError(
      'invalid_executor_spec',
      'model execution requires a pool Db handle, never an enclosing transaction',
    );
  }

  const run = async (database: Db | Tx): Promise<EvaluateSubmissionResult> => {
    const execute = await database.transaction(
      async (tx): Promise<() => Promise<EvaluateSubmissionResult>> => {
        // The same group lock serializes submissions, all member evaluators and activation.
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext('assessment-evaluation-group'), hashtext(${request.evaluation_group_id}))`,
        );
        // ---- 冻结输入装载（锁序：group advisory → submission → 派生维度；发题事实不可变） ----
        const [requestedSubmission] = await tx
          .select()
          .from(assessment_submission)
          .where(eq(assessment_submission.submission_id, request.submission_id))
          .for('update')
          .limit(1);
        if (requestedSubmission == null) {
          throw new EvaluateSubmissionError(
            'submission_not_found',
            `submission '${request.submission_id}' does not exist`,
          );
        }
        if (requestedSubmission.evaluation_group_id !== request.evaluation_group_id) {
          // (submission, group) 复合 FK 的兜底前先显式拒绝 —— 跨组评估引用是调用方 bug。
          throw new EvaluateSubmissionError(
            'group_scope_mismatch',
            `submission '${request.submission_id}' belongs to group '${requestedSubmission.evaluation_group_id}', not '${request.evaluation_group_id}'`,
          );
        }

        const [group] = await tx
          .select()
          .from(evaluation_group)
          .where(eq(evaluation_group.evaluation_group_id, request.evaluation_group_id))
          .limit(1);
        const memberRows = await tx
          .select()
          .from(assessment_submission)
          .where(eq(assessment_submission.evaluation_group_id, request.evaluation_group_id));
        const ids = memberRows.map((row) => row.submission_id);
        if (
          !group ||
          !sameMemberSet(group.submission_ids, ids) ||
          !sameMemberSet(request.expected_submission_ids ?? [request.submission_id], ids)
        ) {
          throw new EvaluateSubmissionError(
            'group_membership_mismatch',
            'declare the exact complete frozen group membership',
          );
        }
        const [head] = await tx
          .select()
          .from(evaluation_effective_head)
          .where(eq(evaluation_effective_head.evaluation_group_id, request.evaluation_group_id))
          .limit(1);
        const submissionRow = memberRows.find(
          (row) =>
            row.submission_id ===
            (head?.submission_id ??
              (memberRows.length === 1 ? requestedSubmission.submission_id : undefined)),
        );
        if (!submissionRow)
          throw new EvaluateSubmissionError(
            'group_membership_mismatch',
            'group anchor is not a member',
          );
        const issuances = await tx
          .select()
          .from(assessment_issuance)
          .where(
            inArray(
              assessment_issuance.issuance_id,
              memberRows.map((row) => row.issuance_id),
            ),
          );
        const members = memberRows.map((row) => {
          const issuance = issuances.find((item) => item.issuance_id === row.issuance_id);
          if (!issuance) throw new EvaluateSubmissionError('issuance_not_found', row.issuance_id);
          return evaluationMemberFromRows(row, issuance);
        });
        const [issuanceRow] = await tx
          .select()
          .from(assessment_issuance)
          .where(eq(assessment_issuance.issuance_id, submissionRow.issuance_id))
          .limit(1);
        if (issuanceRow == null) {
          throw new EvaluateSubmissionError(
            'issuance_not_found',
            `issuance '${submissionRow.issuance_id}' referenced by submission '${request.submission_id}' does not exist`,
          );
        }
        const [revisionRow] = await tx
          .select()
          .from(question_revision)
          .where(eq(question_revision.revision_id, submissionRow.revision_id))
          .limit(1);
        if (revisionRow == null) {
          throw new EvaluateSubmissionError(
            'revision_not_found',
            `revision '${submissionRow.revision_id}' referenced by submission '${request.submission_id}' does not exist`,
          );
        }

        // Observe before execution. Never let activation's caller supply a missing
        // admission fact or refresh stale evidence after a concurrent verification.
        // No lifecycle lock across a model call: activation rechecks under the root lock.
        const [admissionSnapshot] = await tx
          .select({
            current_revision_id: question_group_lifecycle.current_revision_id,
            generation: question_group_lifecycle.scoring_admission_generation,
            state: question_group_lifecycle.scoring_admission_state,
            suspended: question_group_lifecycle.suspended,
            withdrawn: question_group_lifecycle.withdrawn,
          })
          .from(question_group_lifecycle)
          .where(eq(question_group_lifecycle.group_id, revisionRow.group_id))
          .limit(1);

        const submission = SubmissionRecord.parse({
          submission_id: submissionRow.submission_id,
          issuance_id: submissionRow.issuance_id,
          revision_id: submissionRow.revision_id,
          evaluation_group_id: submissionRow.evaluation_group_id,
          response_set: submissionRow.response_set,
          group_evidence: submissionRow.group_evidence,
          idempotency_key: submissionRow.idempotency_key,
          submitted_at: submissionRow.submitted_at.toISOString(),
        });
        const revision = {
          revision_id: revisionRow.revision_id,
          group_id: revisionRow.group_id,
          revision_ordinal: revisionRow.revision_ordinal,
          integrity_digest: revisionRow.integrity_digest,
          structure: revisionRow.structure,
          response_spec: revisionRow.response_spec,
          scoring_basis: revisionRow.scoring_basis,
          execution_plan: revisionRow.execution_plan,
          published_at: revisionRow.published_at.toISOString(),
          supersedes_revision_id: revisionRow.supersedes_revision_id,
        };

        const inputSnapshot = freezeEvaluationInput(submission, revision, members);
        const executionReceipt =
          request.evaluation_key === undefined
            ? null
            : {
                key: request.evaluation_key,
                intent_digest: `sha256:${canonicalHash({
                  input: inputSnapshot,
                  mode: request.mode ?? 'execute',
                  policy: request.policy ?? {},
                  source: request.provenance?.source ?? 'automatic',
                  assisted: request.provenance?.assisted ?? false,
                  review_context: request.provenance?.review_context ?? null,
                  asserted_unit_results: request.asserted_unit_results ?? null,
                })}`,
              };
        if (executionReceipt !== null) {
          if (executionReceipt.key.trim().length === 0) {
            throw new EvaluateSubmissionError('evaluation_key_conflict', 'empty execution key');
          }
          // The group lock is also held by other delivery paths; check before any
          // model invocation or new attempt allocation. Admission remains frozen
          // on the original candidate and is rechecked by activation.
          const [existing] = await tx
            .select()
            .from(evaluation)
            .where(
              and(
                eq(evaluation.evaluation_group_id, request.evaluation_group_id),
                sql`${evaluation.provenance}->'execution_receipt'->>'key' = ${executionReceipt.key}`,
              ),
            )
            .limit(1);
          if (existing) {
            if (
              request.expected_evaluation_id !== undefined &&
              request.expected_evaluation_id !== existing.evaluation_id
            ) {
              throw new EvaluateSubmissionError(
                'evaluation_key_conflict',
                'candidate ID does not belong to this operation',
              );
            }
            const record = EvaluationRecord.parse(existing);
            if (
              record.provenance?.execution_receipt?.intent_digest !== executionReceipt.intent_digest
            ) {
              throw new EvaluateSubmissionError(
                'evaluation_key_conflict',
                'execution key already binds different frozen inputs or grading intent',
              );
            }
            return async () => ({
              record,
              created_at: existing.created_at,
              replayed: true,
              scoring_basis: projectIssuedScoringBasis(revision, inputSnapshot.issued_part_ids),
              model_units_invoked: 0,
              spent_cost_usd_micros: 0,
            });
          }
        }

        if (request.expected_evaluation_id !== undefined) {
          throw new EvaluateSubmissionError(
            'candidate_not_found',
            'commit requires a previously sealed candidate',
          );
        }

        // ---- attempt 序号（group 锁内、固定 head 锚点分配） ----
        const [latest] = await tx
          .select({ attempt: evaluation.attempt })
          .from(evaluation)
          .where(eq(evaluation.submission_id, submissionRow.submission_id))
          .orderBy(desc(evaluation.attempt))
          .limit(1);
        const attempt = (latest?.attempt ?? 0) + 1;

        return async () => {
          const core = await evaluateSubmissionCore({
            evaluation_id: 'pending', // 占位：内容寻址 id 在 record 产生后重铸（不参与评估语义）
            submission,
            revision,
            issued_part_ids: inputSnapshot.issued_part_ids,
            member_inputs: members,
            attempt,
            provenance: {
              ...(request.provenance ?? { source: 'automatic', assisted: false }),
              admission_snapshot: admissionSnapshot ?? null,
              input_snapshot: inputSnapshot,
              execution_receipt: executionReceipt,
            },
            plan_digest: planDigestOf(revision),
            policy: request.policy,
            mode: request.mode,
            asserted_unit_results: request.asserted_unit_results,
            model_executor: modelExecutor,
          }).catch((error: unknown) => {
            if (error instanceof ModelExecutionNotStartedError) throw error.cause;
            throw error;
          });

          return database.transaction(async (tx) => {
            const record = { ...core.record, evaluation_id: evaluationIdFor(core.record) };
            const payload: EvaluationRowPayload = {
              evaluation_id: record.evaluation_id,
              evaluation_group_id: record.evaluation_group_id,
              submission_id: record.submission_id,
              attempt: record.attempt,
              status: record.status,
              unit_results: record.unit_results,
              aggregate: record.aggregate,
              plan_digest: record.plan_digest ?? null,
              run_refs: record.run_refs,
              provenance: (record.provenance as Record<string, unknown> | undefined) ?? null,
            };
            const now = new Date();
            const inserted = await tx
              .insert(evaluation)
              .values({ ...payload, created_at: now })
              .onConflictDoNothing({ target: [evaluation.submission_id, evaluation.attempt] })
              .returning({ id: evaluation.evaluation_id });

            if (inserted.length === 0) {
              // (submission_id, attempt) 冲突：读回全载荷比对 —— 一致 = replay，发散 = conflict。
              const [existing] = await tx
                .select()
                .from(evaluation)
                .where(
                  and(
                    eq(evaluation.submission_id, submissionRow.submission_id),
                    eq(evaluation.attempt, attempt),
                  ),
                )
                .limit(1);
              if (existing == null) {
                // 不可能形状（unique 冲突但行不可见）—— fail-loud，绝不当 replay。
                throw new EvaluateSubmissionError(
                  'attempt_conflict',
                  `attempt ${attempt} conflicted but no row is visible for submission '${submissionRow.submission_id}'`,
                );
              }
              const existingPayload: EvaluationRowPayload = {
                evaluation_id: existing.evaluation_id,
                evaluation_group_id: existing.evaluation_group_id,
                submission_id: existing.submission_id,
                attempt: existing.attempt,
                status: existing.status,
                unit_results: existing.unit_results,
                aggregate: existing.aggregate,
                plan_digest: existing.plan_digest,
                run_refs: existing.run_refs,
                provenance: existing.provenance,
              };
              if (!evaluationPayloadEquals(existingPayload, payload)) {
                throw new EvaluateSubmissionError(
                  'attempt_conflict',
                  `attempt ${attempt} for submission '${submissionRow.submission_id}' already committed with divergent content (existing evaluation '${existing.evaluation_id}') — concurrent evaluators diverged; resolve and retry as a new attempt`,
                );
              }
              return {
                record: {
                  ...record,
                  evaluation_id: existing.evaluation_id,
                  status: existing.status,
                  unit_results: existing.unit_results,
                  aggregate: existing.aggregate,
                  plan_digest: existing.plan_digest,
                  run_refs: existing.run_refs,
                },
                created_at: existing.created_at,
                replayed: true,
                scoring_basis: core.scoring_basis,
                model_units_invoked: core.model_units_invoked,
                spent_cost_usd_micros: core.spent_cost_usd_micros,
              };
            }
            return {
              record,
              created_at: now,
              replayed: false,
              scoring_basis: core.scoring_basis,
              model_units_invoked: core.model_units_invoked,
              spent_cost_usd_micros: core.spent_cost_usd_micros,
            };
          });
        };
      },
    );
    return execute();
  };

  // Deterministic callers may already own a transaction; model callers must not.
  if (!('$client' in db) || typeof db.$client.reserve !== 'function') return run(db);
  return withinSessionAdvisoryLock(
    db,
    {
      namespace: 'assessment-evaluation-group',
      key: request.evaluation_group_id,
      busy: () => new EvaluateSubmissionError('evaluation_busy', 'evaluation group is busy; retry'),
    },
    new Date(Date.now() + 30_000),
    run,
  );
}

// EvaluationContractError 经本模块透传：结构违背（revision 不匹配 / response_set
// 非法 / basis/plan 非法 / 聚合不可投影）是【请求级拒绝】，不落任何行。
export { EvaluationContractError };

/** Activation and the entry's immutable receipt share one transaction. */
export async function activateSubmissionCandidate(
  database: Db,
  intent: ActivateEvaluationRequestT,
  options: {
    actorRef: string;
    allowCapturedOriginal?: boolean;
    now?: Date;
    record?: (tx: Tx) => Promise<void>;
    /** Persist immutable participation before settlement reads its capture, in the same transaction. */
    recordOriginal?: (tx: Tx) => Promise<void>;
    onThetaApplied?: SettlementObservers['onThetaApplied'];
  },
) {
  return database.transaction(async (tx) => {
    const result = await activateEvaluation(tx, intent, {
      settle: async (input) => {
        await options.recordOriginal?.(input.tx);
        return learningSettlement(input, { onThetaApplied: options.onThetaApplied });
      },
      allowCapturedOriginal: options.allowCapturedOriginal,
      actorRef: options.actorRef,
      now: options.now,
    });
    if (result.status === 'activated') await options.record?.(tx);
    return result;
  });
}
