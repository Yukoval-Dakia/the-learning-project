// YUK-1445 (Stage 1 / G1+G2) — question admission definition.
//
// The admission lane consumes a frozen draft definition (the four contract
// layers) plus per-unit scoring intent declared by intake. It is deliberately
// NOT a schema-level type (src/core/schema/assessment is frozen for this
// lane): this is the module-local envelope `runQuestionAdmission` accepts.
//
// A definition is already-resolved on the response_spec axis: slots are in
// their FINAL form (select/blank/open_response for new content, legacy kinds
// kept verbatim for units that cannot be upgraded). `original_response_spec`
// keeps the pre-conversion spec so unresolved units can publish unchanged.

import type { ExecutionPlanT } from '@/core/schema/assessment/execution';
import type { ResponseSlotT, ResponseSpecT } from '@/core/schema/assessment/response';
import type {
  AggregationPolicyT,
  BlankNormalizationT,
  ScoringUnitCriterionT,
  ScoringUnitT,
} from '@/core/schema/assessment/scoring';
import type { ScoringRuleT } from '@/core/schema/assessment/scoring-rule';
import type { QuestionGroupStructureT } from '@/core/schema/assessment/structure';

/** Unit kinds the admission lane can resolve. 'free' has no deterministic
 * executor yet (no admitted model slice) and always withholds. */
export type AdmissionUnitKind = 'select' | 'blank' | 'free' | 'unsupported';

export interface AdmissionUnitSpec {
  scoring_unit_id: string;
  part_id: string;
  /** slot_refs in the FINAL spec (converted slots keep the same slot_id). */
  slot_refs: string[];
  material_refs: string[];
  evidence_slot_refs: string[];
  requires_group_evidence: boolean;
  /** 卷面印出的分值；null = 未印分（加法单元须有分值才可准入）。 */
  points: number | null;
  unit_kind: AdmissionUnitKind;
  /** Converted slot this unit will grade against when resolved; null when the
   *  unit keeps its legacy slot (unresolved / unsupported / free). */
  resolved_slot: ResponseSlotT | null;
  /** 已 typed 录入的判据（待独立核验的种子）；absent = dual solve mints it. */
  seeded_criterion: ScoringUnitCriterionT | null;
  /** 已 typed 录入的给分规则；absent = default policy rule (select/blank). */
  seeded_rule: ScoringRuleT | null;
  /** 判据种子与本题型的相容性说明（如 legacy 判据形状不能直接进新 spec）。 */
  seed_constraint?: string;
  /** blank 单元的归一化政策（版本化；不在 solve 输出里，由录入侧声明）。 */
  blank_normalization: BlankNormalizationT | null;
  /** 印刷 rubric/规则原文（free 单元的 rubric 证据 + 其它单元的判分规则证据）。 */
  printed_rule_md?: string;
}

/** 印出答案原文（evidence only —— 只作 crosscheck，绝不铸键）。 */
export interface AdmissionSourceAnswer {
  /** 归属单元；absent = 组级未归属原文。 */
  unit_id?: string;
  reference_md: string;
  /** 定位信息（material_id / locator）。 */
  locator?: string;
}

export interface QuestionAdmissionDefinition {
  group_id: string;
  /**
   * 本定义所基于的【归一前】草稿契约 digest（job 在行快照上计算）。持久化时
   * 用它做 drift CAS —— 行内容变了，本 admission 的全部证据随之失效。
   * submit_question 等新路径可不携带（其 draft 本身是冻结输入）。
   */
  base_contract_digest: string | null;
  structure: QuestionGroupStructureT;
  /** 转换后的最终作答契约（resolve 单元用；未 resolve 单元落回原 spec 槽位）。 */
  response_spec: ResponseSpecT;
  /** 转换前 spec（unresolved 单元回退用）。与 response_spec 恒等时可省略。 */
  original_response_spec?: ResponseSpecT;
  /** 归一前的原始 scoring units —— 未 resolve 单元在发布契约中原样保留判据。 */
  original_units?: ScoringUnitT[];
  /** 归一前的原执行计划 —— 未 resolve 单元沿用原 assignment。 */
  original_plan?: ExecutionPlanT;
  units: AdmissionUnitSpec[];
  aggregation: AggregationPolicyT;
  blank_scores_zero: boolean;
  source_answers: AdmissionSourceAnswer[];
}
