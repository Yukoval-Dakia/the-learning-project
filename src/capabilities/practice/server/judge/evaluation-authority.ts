// ====================================================================
// YUK-1047 — evaluateAttempt：全部权威评分入口的统一漏斗（grounding §4.2）
// ====================================================================
//
// 所有产生分数/判词的入口【必须】经本模块进入评估 —— 这是唯一的判分 seam：
//
//   - contract lane：调用方携带 {submission_id, evaluation_group_id} ⇒
//     evaluateSubmission（evaluate-submission.ts）—— 读冻结
//     submission/revision/issuance，产 candidate evaluation 行，
//     candidate 永不生效（activation = YUK-1045，settlement = YUK-1053）。
//   - legacy lane：作答尚未落契约表（saveSubmission/issuance = YUK-1052
//     未落地）⇒ 既有 JudgeInvoker 管线判分，outcome 如实标注
//     lane:'legacy' —— 判分权威性不经第三方旁路，全部汇聚于本漏斗。
//
// §4.2 八入口的登记与现状见 EVALUATION_ENTRY_POINTS —— 「走统一契约」与
// 「统一漏斗已收口」是两件事：本 PR 先把【权威性】收敛成单一 seam，逐入口的
// contract 接线依赖尚未落地的 writer（YUK-1052/1045），登记表如实记录
// blocked-by，不冒充已切换。
//
// 不在本表内的产分路径（问题质量链）有意除外：quiz_verify / source_verify /
// solve_check / teaching_quality 是教师侧 QA，不是学生评分 —— grounding
// §4.2 末段明确保留其异源/否决语义，不得机械并入。

import type {
  EvaluationRecordT,
  ModelUnitExecutorPort,
  ScoringBasisT,
} from '@/core/schema/assessment';
import {
  VERDICT_CORRECT_THRESHOLD,
  deriveCoarseVerdict,
} from '@/core/schema/assessment/settlement';
import type { JudgeResultV2T } from '@/core/schema/capability';
import type { Db } from '@/db/client';
import {
  type EvaluateSubmissionRequest,
  type EvaluateSubmissionResult,
  evaluateSubmission,
} from './evaluate-submission';
import { type JudgeInvokerOutput, createDefaultJudgeInvoker } from './invoker';
import type { JudgeAnswerParams } from './question-contract';

// ---------- 入口登记（grounding §4.2 表） ----------

/** §4.2 八个权威评分入口的标识。 */
export type GradingEntryPoint =
  | 'solo_submit'
  | 'durable_judge_run'
  | 'paper_submit'
  | 'solve_tutor'
  | 'appeal_rejudge'
  | 'conjecture_probe'
  | 'ingestion_grading'
  | 'advice_preview';

export interface EntryPointDisposition {
  entry: GradingEntryPoint;
  /** 本 PR 后该入口实际走的 funnel lane。 */
  lane: 'legacy' | 'contract';
  /**
   * contract 接线的当前状态。'pending_writer' = 该入口的作答尚不能产生
   * contract submission（缺 saveSubmission/issuance writer），funnel 已可接
   * contract 调用 —— 入口侧接线随对应 writer 落地时翻转。
   */
  contract_wiring: 'wired' | 'pending_writer' | 'pending_activation';
  blocked_by: string[];
  note: string;
}

/**
 * 八入口登记表（grounding §4.2 逐行对应）。诚实语义：`lane` 是【当前】实际
 * 走道；`contract_wiring='pending_writer'` 不表示该入口被豁免 —— funnel 是
 * 必经 seam，契约行一旦可写，同一调用改传 contract 引用即完成切换。
 */
export const EVALUATION_ENTRY_POINTS: readonly EntryPointDisposition[] = [
  {
    entry: 'solo_submit',
    lane: 'legacy',
    contract_wiring: 'pending_writer',
    blocked_by: ['YUK-1052'],
    note: 'submit.ts judgeSubmit 的同步 invoke；作答落 saveSubmission 后改传 contract。',
  },
  {
    entry: 'durable_judge_run',
    lane: 'legacy',
    contract_wiring: 'pending_writer',
    blocked_by: ['YUK-1052'],
    note: 'judge_run 经 judgeSubmit 复用同一判分头；payload 需冻结 submission 引用后切换。',
  },
  {
    entry: 'paper_submit',
    lane: 'legacy',
    contract_wiring: 'pending_writer',
    blocked_by: ['YUK-1052'],
    note: '多 slot 联合 evaluation group 语义由契约侧表达；paid claim/once-only 保留。',
  },
  {
    entry: 'solve_tutor',
    lane: 'legacy',
    contract_wiring: 'pending_writer',
    blocked_by: ['YUK-1052'],
    note: 'solve-session 作答落契约后同一 seam 判分，不另建评分系统。',
  },
  {
    entry: 'appeal_rejudge',
    lane: 'legacy',
    contract_wiring: 'pending_writer',
    blocked_by: ['YUK-1052', 'YUK-1045'],
    note: '契约侧就绪后改读冻结 submission（文本/图/part/版本），不再用 current row + text-only；已迁移历史作答可经 identity mapping 定位 submission。',
  },
  {
    entry: 'conjecture_probe',
    lane: 'legacy',
    contract_wiring: 'pending_writer',
    blocked_by: ['YUK-1052'],
    note: '诊断签名与 partial/unsupported 安全语义保留在入口层；contract 结果经同一投影消费。',
  },
  {
    entry: 'ingestion_grading',
    lane: 'legacy',
    contract_wiring: 'pending_writer',
    blocked_by: ['YUK-1052'],
    note: '原绕过 invoker 直连 multimodal_direct；现经 funnel 统一判分（judge_kind_override 保留直派语义），flag 关闭也不是豁免。',
  },
  {
    entry: 'advice_preview',
    lane: 'legacy',
    contract_wiring: 'pending_writer',
    blocked_by: ['YUK-1052'],
    note: '预览不生效不更新学习；contract 切换后签名绑定 revision/submission digest + candidate 引用。',
  },
] as const;

// ---------- 输入 ----------

/** contract lane：作答已落契约表，直接给 §4.3 坐标。 */
export interface ContractGradingRef {
  submission_id: string;
  evaluation_group_id: string;
  /** 覆盖 evaluateSubmission 的执行面/来源/manually-asserted 结果。 */
  policy?: EvaluateSubmissionRequest['policy'];
  mode?: EvaluateSubmissionRequest['mode'];
  asserted_unit_results?: EvaluateSubmissionRequest['asserted_unit_results'];
  provenance?: EvaluateSubmissionRequest['provenance'];
  model_executor?: ModelUnitExecutorPort;
}

export interface LegacyAttemptInput {
  entry: GradingEntryPoint;
  /** 未落契约的作答：既有 JudgeInvoker 参数（含 db）。 */
  legacy: JudgeAnswerParams;
}
export interface ContractAttemptInput {
  entry: GradingEntryPoint;
  db: Db;
  contract: ContractGradingRef;
}
export type EvaluateAttemptInput = LegacyAttemptInput | ContractAttemptInput;

// ---------- 输出 ----------

/**
 * legacy lane 结果透传 JudgeInvokerOutput（route/result/telemetry/
 * modelAttempted/execution）—— 下游（resolveInvokedExecutionProvenance、
 * 事件 payload）所需字段原样在位。判分路径与 invoke() 逐字节相同；
 * `lane`/`entry` 只是漏斗标签，不改判分语义。
 */
export interface LegacyAttemptOutcome extends JudgeInvokerOutput {
  readonly lane: 'legacy';
  readonly entry: GradingEntryPoint;
}

export interface ContractAttemptOutcome {
  readonly lane: 'contract';
  readonly entry: GradingEntryPoint;
  evaluation: EvaluateSubmissionResult;
  /**
   * 候选评估的消费侧投影（JudgeResultV2 兼容形态）。candidate 未生效 —
   * 这只是【本次评估结果】的读模型，activation/settlement 不消费它。
   */
  result: JudgeResultV2T;
}

export type EvaluateAttemptOutcome = LegacyAttemptOutcome | ContractAttemptOutcome;

// ---------- contract → JudgeResultV2 投影 ----------

const CONTRACT_CAPABILITY_REF = { id: 'evaluate_submission', version: '1.0.0' } as const;

/**
 * 把 EvaluationRecord 投影为 JudgeResultV2（消费侧兼容形状）。
 *
 * 计分纪律（§4.4）：未决/未映射绝不造伪分 —— 一律 coarse='unsupported'
 * + 显式 reason（evaluation 行保留全部 pending 细节）；分数只在
 * points_total 聚合下归一化到 [0,1]（binary comparator ⇒ 只可能 0/满分，
 * 部分分来自多 unit 子集）。level 聚合有显式映射时同样归一化；无映射
 * （points=null）⇒ unsupported，不造总分。
 */
export function projectEvaluationToJudgeResult(
  record: EvaluationRecordT,
  basis: ScoringBasisT,
): JudgeResultV2T {
  // YUK-1053 — verdict 派生单源到 core/schema/assessment/settlement.ts
  // （学习结算读同一函数；阈值/未映射/分母纪律不再双写）。
  const verdict = deriveCoarseVerdict(record, basis);
  const pendingEvidence = {
    evaluation_id: record.evaluation_id,
    pending_units: record.unit_results
      .filter((unit) => unit.status === 'pending')
      .map((unit) => ({ scoring_unit_id: unit.scoring_unit_id, pending: unit.pending })),
  };
  if (record.status === 'pending' || record.aggregate == null) {
    return {
      score: null,
      score_meaning: 'correctness',
      coarse_outcome: 'unsupported',
      confidence: 0,
      capability_ref: CONTRACT_CAPABILITY_REF,
      feedback_md: 'evaluation pending: retryable infrastructure failure — not a grade',
      evidence_json: pendingEvidence,
    };
  }
  const aggregate = record.aggregate;
  if (aggregate.kind === 'unresolved') {
    return {
      score: null,
      score_meaning: 'correctness',
      coarse_outcome: 'unsupported',
      confidence: 0,
      capability_ref: CONTRACT_CAPABILITY_REF,
      feedback_md: `evaluation unresolved: ${aggregate.reason}`,
      evidence_json: {
        ...pendingEvidence,
        aggregate_reason: aggregate.reason,
        aggregate_detail: aggregate.detail,
      },
    };
  }
  if (verdict.points == null) {
    // 命中未映射档位 —— 不凭空造总分（§4.4 / judgment.ts no_mapping 同纪律）。
    return {
      score: null,
      score_meaning: 'correctness',
      coarse_outcome: 'unsupported',
      confidence: 0,
      capability_ref: CONTRACT_CAPABILITY_REF,
      feedback_md: 'evaluation hit a level with no published points mapping',
      evidence_json: pendingEvidence,
    };
  }
  const { points, maxPoints, normalized } = verdict;
  const scoredUnitFeedback = record.unit_results
    .map((unit) => (unit.status === 'scored' ? unit.feedback_md : undefined))
    .find((feedback): feedback is string => typeof feedback === 'string' && feedback.length > 0);
  const evidence_json = {
    evaluation_id: record.evaluation_id,
    evaluation_group_id: record.evaluation_group_id,
    submission_id: record.submission_id,
    attempt: record.attempt,
    plan_digest: record.plan_digest ?? null,
    points,
    max_points: maxPoints,
    unit_results: record.unit_results,
  };
  if (normalized == null || normalized <= 0) {
    return {
      score: 0,
      score_meaning: 'correctness',
      coarse_outcome: 'incorrect',
      confidence: 1,
      capability_ref: CONTRACT_CAPABILITY_REF,
      feedback_md: scoredUnitFeedback ?? 'no accepted answer key matched',
      evidence_json,
    };
  }
  if (normalized >= VERDICT_CORRECT_THRESHOLD) {
    return {
      score: Math.max(VERDICT_CORRECT_THRESHOLD, normalized),
      score_meaning: 'correctness',
      coarse_outcome: 'correct',
      confidence: 1,
      capability_ref: CONTRACT_CAPABILITY_REF,
      feedback_md: scoredUnitFeedback ?? '',
      evidence_json,
    };
  }
  return {
    score: normalized,
    score_meaning: 'correctness',
    coarse_outcome: 'partial',
    confidence: 1,
    capability_ref: CONTRACT_CAPABILITY_REF,
    feedback_md: scoredUnitFeedback ?? 'partial credit across scoring units',
    evidence_json,
  };
}

// ---------- 统一漏斗 ----------

/**
 * 全部权威评分入口的【唯一】进入点（YUK-1047）。两条 lane：
 *
 *   - `contract` 引用存在 ⇒ evaluateSubmission（读冻结契约，落 candidate
 *     行；绝不触碰 effective head / 学习状态）；
 *   - `legacy` 参数存在 ⇒ JudgeInvoker（既有判分管线原样透传，含
 *     part_ref narrowing / appeal_context / durable override / imageFetchFn /
 *     runTaskFn seam —— 判分行为零变化，只汇聚入口权威）。
 *
 * 两者互斥；同传 ⇒ 契约优先但立即 fail-loud（调用方 bug 不静默吞）。
 */
export async function evaluateAttempt(input: ContractAttemptInput): Promise<ContractAttemptOutcome>;
export async function evaluateAttempt(input: LegacyAttemptInput): Promise<LegacyAttemptOutcome>;
export async function evaluateAttempt(
  input: EvaluateAttemptInput,
): Promise<EvaluateAttemptOutcome> {
  if ('contract' in input && 'legacy' in input) {
    throw new Error(
      `evaluateAttempt[${input.entry}]: both contract and legacy inputs supplied — callers must choose exactly one lane`,
    );
  }
  if ('contract' in input) {
    const evaluation = await evaluateSubmission(input.db, {
      submission_id: input.contract.submission_id,
      evaluation_group_id: input.contract.evaluation_group_id,
      policy: input.contract.policy,
      mode: input.contract.mode,
      asserted_unit_results: input.contract.asserted_unit_results,
      provenance: input.contract.provenance,
      model_executor: input.contract.model_executor,
    });
    // 消费侧投影：发布侧聚合声明（归一化分母）随 EvaluateSubmissionResult
    // 回传（冻结 revision 的 basis 快照）—— 不二次查库，不重推计分语义。
    return {
      lane: 'contract',
      entry: input.entry,
      evaluation,
      result: projectEvaluationToJudgeResult(evaluation.record, evaluation.scoring_basis),
    };
  }
  if ('legacy' in input) {
    const invoked = await createDefaultJudgeInvoker().invoke(input.legacy);
    return { lane: 'legacy', entry: input.entry, ...invoked };
  }
  throw new Error(
    `evaluateAttempt[${(input as EvaluateAttemptInput).entry}]: neither contract nor legacy input supplied`,
  );
}
