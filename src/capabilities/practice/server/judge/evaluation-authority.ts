// Student grading consumes frozen submissions. Candidates remain separate from
// activation and learning settlement; teacher-side QA retains its own judges.

import type { EvaluationRecordT, ScoringBasisT } from '@/core/schema/assessment';
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
  lane: 'contract';
  contract_wiring: 'wired';
  note: string;
}

/** Source wiring only. Publication/model admission and deployed acceptance are separate gates. */
export const EVALUATION_ENTRY_POINTS: readonly EntryPointDisposition[] = [
  {
    entry: 'solo_submit',
    lane: 'contract',
    contract_wiring: 'wired',
    note: 'Synchronous submit commits the served issuance and frozen submission.',
  },
  {
    entry: 'durable_judge_run',
    lane: 'contract',
    contract_wiring: 'wired',
    note: 'Durable jobs retain submission references and paid-call claims across retries.',
  },
  {
    entry: 'paper_submit',
    lane: 'contract',
    contract_wiring: 'wired',
    note: 'Paper members use issued groups, atomic capture and buffered disclosure.',
  },
  {
    entry: 'solve_tutor',
    lane: 'contract',
    contract_wiring: 'wired',
    note: 'Solve commits the frozen response and assistance provenance.',
  },
  {
    entry: 'appeal_rejudge',
    lane: 'contract',
    contract_wiring: 'wired',
    note: 'Appeals evaluate frozen members and activate against the expected head.',
  },
  {
    entry: 'conjecture_probe',
    lane: 'contract',
    contract_wiring: 'wired',
    note: 'Probe preview binds the frozen signature; its result never activates practice learning.',
  },
  {
    entry: 'ingestion_grading',
    lane: 'contract',
    contract_wiring: 'wired',
    note: 'Originals persist before evaluation; enrollment requires publication admission.',
  },
  {
    entry: 'advice_preview',
    lane: 'contract',
    contract_wiring: 'wired',
    note: 'Preview produces a frozen candidate without activating learning.',
  },
] as const;

// ---------- 输入 ----------

/** contract lane：作答已落契约表，直接给 §4.3 坐标。 */
export interface ContractGradingRef {
  submission_id: string;
  evaluation_group_id: string;
  evaluation_key?: string;
  expected_evaluation_id?: string;
  /** 覆盖 evaluateSubmission 的执行面/来源/manually-asserted 结果。 */
  expected_submission_ids?: EvaluateSubmissionRequest['expected_submission_ids'];
  policy?: EvaluateSubmissionRequest['policy'];
  mode?: EvaluateSubmissionRequest['mode'];
  asserted_unit_results?: EvaluateSubmissionRequest['asserted_unit_results'];
  provenance?: EvaluateSubmissionRequest['provenance'];
  model_executor?: EvaluateSubmissionRequest['model_executor'];
}

export interface ContractAttemptInput {
  entry: GradingEntryPoint;
  db: Db;
  contract: ContractGradingRef;
}
export type EvaluateAttemptInput = ContractAttemptInput;

// ---------- 输出 ----------

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

export type EvaluateAttemptOutcome = ContractAttemptOutcome;

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
  if (normalized == null) {
    // YUK-1095 — 分母不可得（deriveCoarseVerdict reason='no_denominator'）⇒
    // 绝不伪造 0 分 / incorrect / confidence=1：points>0 但没有已发布分母时
    // 归一化不了，按 §4.4「不凭空造总分」纪律回落 unsupported，如实带原因。
    return {
      score: null,
      score_meaning: 'correctness',
      coarse_outcome: 'unsupported',
      confidence: 0,
      capability_ref: CONTRACT_CAPABILITY_REF,
      feedback_md: `evaluation has no published denominator (${verdict.reason}) — points cannot be normalized into a grade`,
      evidence_json: { ...evidence_json, verdict_reason: verdict.reason },
    };
  }
  if (normalized <= 0) {
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

/** Evaluate one frozen candidate without changing the effective head. */
export async function evaluateAttempt(
  input: EvaluateAttemptInput,
): Promise<EvaluateAttemptOutcome> {
  if ('legacy' in input) {
    throw new Error(`evaluateAttempt[${input.entry}]: legacy grading input is retired`);
  }
  const evaluation = await evaluateSubmission(input.db, {
    submission_id: input.contract.submission_id,
    evaluation_group_id: input.contract.evaluation_group_id,
    evaluation_key: input.contract.evaluation_key,
    expected_evaluation_id: input.contract.expected_evaluation_id,
    expected_submission_ids: input.contract.expected_submission_ids,
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
