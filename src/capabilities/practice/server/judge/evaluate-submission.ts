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
//   - attempt 身份 = max(attempt)+1，在单事务内锁 submission 行（FOR UPDATE）
//     串行化重试者；(submission_id, attempt) 唯一键是最后防线；
//   - 幂等：同 attempt 冲突时读回全载荷比对 —— 逐字相同 = replay（返回已存在
//     行），不同 = 真并发发散（attempt_conflict 抛出，绝不覆盖）。
//   - evaluation_id 内容寻址（eva_<sha256-48>）：重试同输入 ⇒ 同身份。
//
// 模型执行器是注入端口（ModelUnitExecutorPort）：本文件【不】含 provider/LLM
// 调用 —— typed transport 归 src/server/ai/ 后续 lane（YUK-1049）。

import { and, desc, eq } from 'drizzle-orm';
import { canonicalHash } from '@/core/migration/canonical';
import {
  EvaluationContractError,
  type EvaluationExecutionPolicyT,
  type EvaluationProvenanceT,
  type EvaluationRecordT,
  type ModelUnitExecutorPort,
  type ScoringBasisT,
  SubmissionRecord,
  evaluateSubmissionCore,
} from '@/core/schema/assessment';
import type { Db, Tx } from '@/db/client';
import {
  assessment_issuance,
  assessment_submission,
  evaluation,
  question_revision,
} from '@/db/schema';

/** evaluateSubmission 请求（§4.3 Interface）。 */
export interface EvaluateSubmissionRequest {
  submission_id: string;
  evaluation_group_id: string;
  /** 执行期 policy（不改给分规则；仅低置信 gate 等执行面旋钮）。 */
  policy?: EvaluationExecutionPolicyT;
  /**
   * manual_assert（D9）：显式手动/自评结果直落 candidate，跳过执行器分发。
   * provenance.source 必须为 manual|self_report（内核强制）。
   */
  mode?: 'execute' | 'manual_assert';
  asserted_unit_results?: import('@/core/schema/assessment').ScoringUnitResultT[];
  provenance?: EvaluationProvenanceT;
  /** admitted model_executor 单元的执行端口；缺失 ⇒ 该单元 retryable infra_failure。 */
  model_executor?: ModelUnitExecutorPort;
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
      | 'attempt_conflict',
    detail: string,
  ) {
    super(`evaluateSubmission: ${code} — ${detail}`);
  }
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
 * 全程单事务：submission 行 FOR UPDATE 串行化 attempt 序号。
 */
export async function evaluateSubmission(
  db: Db | Tx,
  request: EvaluateSubmissionRequest,
): Promise<EvaluateSubmissionResult> {
  const run = async (tx: Tx): Promise<EvaluateSubmissionResult> => {
    // ---- 冻结输入装载（锁序：submission → 派生维度；发题事实不可变） ----
    const [submissionRow] = await tx
      .select()
      .from(assessment_submission)
      .where(eq(assessment_submission.submission_id, request.submission_id))
      .for('update')
      .limit(1);
    if (submissionRow == null) {
      throw new EvaluateSubmissionError(
        'submission_not_found',
        `submission '${request.submission_id}' does not exist`,
      );
    }
    if (submissionRow.evaluation_group_id !== request.evaluation_group_id) {
      // (submission, group) 复合 FK 的兜底前先显式拒绝 —— 跨组评估引用是调用方 bug。
      throw new EvaluateSubmissionError(
        'group_scope_mismatch',
        `submission '${request.submission_id}' belongs to group '${submissionRow.evaluation_group_id}', not '${request.evaluation_group_id}'`,
      );
    }

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

    // ---- attempt 序号（submission 行锁内分配 ⇒ 并发评估串行化） ----
    const [latest] = await tx
      .select({ attempt: evaluation.attempt })
      .from(evaluation)
      .where(eq(evaluation.submission_id, request.submission_id))
      .orderBy(desc(evaluation.attempt))
      .limit(1);
    const attempt = (latest?.attempt ?? 0) + 1;

    const core = await evaluateSubmissionCore({
      evaluation_id: 'pending', // 占位：内容寻址 id 在 record 产生后重铸（不参与评估语义）
      submission,
      revision,
      issued_part_ids: issuanceRow.part_ids,
      attempt,
      provenance: request.provenance,
      plan_digest: planDigestOf(revision),
      policy: request.policy,
      mode: request.mode,
      asserted_unit_results: request.asserted_unit_results,
      model_executor: request.model_executor,
    });

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
          and(eq(evaluation.submission_id, request.submission_id), eq(evaluation.attempt, attempt)),
        )
        .limit(1);
      if (existing == null) {
        // 不可能形状（unique 冲突但行不可见）—— fail-loud，绝不当 replay。
        throw new EvaluateSubmissionError(
          'attempt_conflict',
          `attempt ${attempt} conflicted but no row is visible for submission '${request.submission_id}'`,
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
          `attempt ${attempt} for submission '${request.submission_id}' already committed with divergent content (existing evaluation '${existing.evaluation_id}') — concurrent evaluators diverged; resolve and retry as a new attempt`,
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
        scoring_basis: revision.scoring_basis,
        model_units_invoked: core.model_units_invoked,
        spent_cost_usd_micros: core.spent_cost_usd_micros,
      };
    }
    return {
      record,
      created_at: now,
      replayed: false,
      scoring_basis: revision.scoring_basis,
      model_units_invoked: core.model_units_invoked,
      spent_cost_usd_micros: core.spent_cost_usd_micros,
    };
  };

  // 调用方传入 Db 时开启单事务；传入 Tx 时 transaction() 落到嵌套 savepoint
  // （drizzle 语义）—— 两种调用形态共用同一实现，不产生第二套执行路径。
  return await db.transaction(run);
}

// EvaluationContractError 经本模块透传：结构违背（revision 不匹配 / response_set
// 非法 / basis/plan 非法 / 聚合不可投影）是【请求级拒绝】，不落任何行。
export { EvaluationContractError };
