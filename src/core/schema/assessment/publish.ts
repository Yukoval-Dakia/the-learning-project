import { z } from 'zod';

// ====================================================================
// YUK-1046 — 统一评估契约 · 发布 policy（grounding §3.3、D1、D17）
// ====================================================================
//
// 资格与使用范围必须分清（§3.3）—— 旧 draft_status 同时表达“未完成”和
// “容器内可用”，这里拆成【独立维度】：
//   1. revision 是否存在（content completeness）；
//   2. 评分准入（scoring admission —— D1：model-proposed 规则在结构校验 +
//      独立核验通过后自动准入，显式标 system authored；未解决保持 withheld）；
//   3. general-pool / container-only（teaching/probe/intervention 的 revision
//      与容器 occurrence 同事务绑定，不需要入公共题池才拥有可用版本）；
//   4. issuance 一次性 claim；
//   5. suspended / withdrawn（verify 挂起 ≠ 撤回；archive 释放 live 去重
//      claim，不清除历史摘要/绑定）。
//
// D17 准入合同是切片级验收（zero-failure、≥30 holdout、零严重错误、
// per-criterion ≥95%、coverage ≥95%…）；本文件只承载【证据的显式形状】，
// 阈值执行属于 evaluator/admission lane。

// ---------- 答案规则来源（D1） ----------

/**
 * 答案/评分规则的来源。`system_verified` 显式标注 system authored ——
 * 【不是】official（D1 原文）；第二模型“同意”本身不构成证明。
 */
export const MarkingRuleProvenance = z.enum(['official', 'system_verified', 'manual']);
export type MarkingRuleProvenanceT = z.infer<typeof MarkingRuleProvenance>;

/** D1 双门：结构校验 + 独立核验。任一未过 ⇒ 规则 withheld，不自动准入。 */
export const VerificationRecord = z.object({
  structural_check_passed: z.boolean(),
  independent_verification: z
    .object({
      passed: z.boolean(),
      verifier: z.enum(['independent_model', 'human']),
      verified_at: z.string().datetime(),
    })
    .nullable(),
  note: z.string().optional(),
});
export type VerificationRecordT = z.infer<typeof VerificationRecord>;

/** D17 切片准入证据摘要（记录观测值；阈值裁决在 admission lane）。 */
export const ModelSliceAdmissionSummary = z.object({
  slice_id: z.string().min(1),
  holdout_cases: z.number().int().min(0),
  severe_errors_observed: z.number().int().min(0),
  per_criterion_agreement: z.number().min(0).max(1).nullable(),
  pipeline_coverage: z.number().min(0).max(1).nullable(),
});
export type ModelSliceAdmissionSummaryT = z.infer<typeof ModelSliceAdmissionSummary>;

/** 一次准入决定的证据包。 */
export const AdmissionEvidence = z.object({
  marking_provenance: MarkingRuleProvenance,
  verification: VerificationRecord,
  model_slice: ModelSliceAdmissionSummary.nullable(),
});
export type AdmissionEvidenceT = z.infer<typeof AdmissionEvidence>;

// ---------- 评分准入状态 ----------

export const ScoringAdmission = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('admitted'),
    evidence: AdmissionEvidence,
    admitted_at: z.string().datetime(),
    /** admission generation —— activation/复核时 CAS 核对（§3.3）。 */
    generation: z.number().int().min(0),
  }),
  z.object({
    state: z.literal('withheld'),
    reason: z.enum([
      'unverified_rules',
      'verification_failed',
      'no_admitted_executor',
      'owner_hold',
    ]),
    detail: z.string().default(''),
  }),
]);
export type ScoringAdmissionT = z.infer<typeof ScoringAdmission>;

/**
 * 新式 verify 记录（§3.3）：保存 (revision_id, digest, policy, generation)。
 * 旧验证可留证据，但不能改变新 revision 或较新 admission 决定。
 */
export const AdmissionVerificationRecord = z.object({
  revision_id: z.string().min(1),
  revision_digest: z.string().min(1),
  /** 版本化 policy id —— 阈值/流程可追溯。 */
  policy_id: z.string().min(1),
  generation: z.number().int().min(0),
  outcome: z.enum(['passed', 'suspended', 'failed']),
  recorded_at: z.string().datetime(),
});
export type AdmissionVerificationRecordT = z.infer<typeof AdmissionVerificationRecord>;

// ---------- 生命周期资格（draft_status 语义拆分） ----------

export const LifecycleQualification = z.object({
  /** 维度一：是否有已发布 revision（内容完整性）。 */
  has_published_revision: z.boolean(),
  /** 维度二：评分准入（自动判分资格； withheld 的题仍可显式手动练习，D9）。 */
  scoring_admission: ScoringAdmission,
  /** 维度三：使用范围 —— 公共题池 vs 容器内专用。 */
  availability: z.enum(['general_pool', 'container_only']),
  /** 维度四：挂起（verify 挂起 ≠ 撤回；挂起中不禁止新 issuance 即违规，见 §3.3 表）。 */
  suspension: z.object({
    suspended: z.boolean(),
    reason: z.enum(['verify_hold', 'retraction_hold']).nullable(),
  }),
  /** 维度五：撤回（保留历史摘要/绑定；释放 live 去重 claim）。 */
  withdrawal: z.object({
    withdrawn: z.boolean(),
    withdrawn_at: z.string().datetime().nullable(),
  }),
});
export type LifecycleQualificationT = z.infer<typeof LifecycleQualification>;

// ---------- 发布决定包 ----------

/**
 * publish 时一并与 revision 原子落库的决定（§3.1：新 revision、current
 * pointer、compatible projections 与发布事件同事务提交）。
 */
export const PublishDecision = z.object({
  lifecycle: LifecycleQualification,
  /** issuance claim 政策（one_time 用于诊断/probe/教学一次性占用）。 */
  issuance_claim_policy: z.enum(['one_time', 'unbounded']),
});
export type PublishDecisionT = z.infer<typeof PublishDecision>;
