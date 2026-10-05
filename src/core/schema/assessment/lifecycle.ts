// ====================================================================
// YUK-1056 — draft_status 语义拆分词表（grounding §3.3 / §15 常量化）
// ====================================================================
//
// 旧 `question.draft_status` 是 NULL≡active 的松散三态文本列，一个字面量同时
// 表达「未完成（尚需 verify/promote）」与「容器内可用（不属公共题池）」两个
// 不同事实。统一契约（YUK-1044/1046）把它拆成【独立维度】；本文件是全部
// 生命周期字面量的唯一词表 —— 业务写路径与判定断言必须用这些常量，不再
// 手写裸字面量。
//
// 语义映射（§3.3 表）：
//   draft_status='draft'          —— 未完成：未核验、不可判分、不可发题；
//                                    折叠成 availability=container_only +
//                                    scoring_admission=withheld(unverified_rules)。
//   draft_status IS NULL / 'active' —— 可入公共题池：legacy 行等价
//                                    availability=general_pool；admission 由
//                                    verify/promote 事务显式决定。
//   挂起 / 撤回 / claim           —— 不再是 draft_status 的隐式含义；走
//                                    question_group_lifecycle 独立列。
//
// 命名：值对象用大写蛇形，且全部 `as const` —— 任何扩值（如未来 archive
// 显式值）必须在 coverage/审计 doc 里重新对齐（YUK-1056 审计口径）。

/** legacy `question.draft_status` 列字面量（text 列，非 enum —— NULL≡active）。 */
export const LEGACY_DRAFT_STATUS = {
  /** 未完成/容器内隐藏：pool-visibility 唯一硬排除值（notDraftPredicate）。 */
  DRAFT: 'draft',
  /** 显式 active（允许写入；语义等价 NULL——fail-open 判据下两者同池可见）。 */
  ACTIVE: 'active',
} as const;
export type LegacyDraftStatusT = (typeof LEGACY_DRAFT_STATUS)[keyof typeof LEGACY_DRAFT_STATUS];

/** NULL 与显式 'active' 在池可见性下等价（红线-4 fail-open）。 */
export function isLegacyPoolVisibleStatus(status: string | null): boolean {
  return status !== LEGACY_DRAFT_STATUS.DRAFT;
}

/** 维度三：使用范围 —— 公共题池 vs 容器内专用（§3.3 拆分后的可用性轴）。 */
export const QUESTION_AVAILABILITY = {
  /** 通用练习池候选（配合 admission/挂起谓词决定实际可见）。 */
  GENERAL_POOL: 'general_pool',
  /** 容器内专用：teaching/probe/intervention 的 revision 与容器 occurrence 同事务绑定，不入公共池。 */
  CONTAINER_ONLY: 'container_only',
} as const;
export type QuestionAvailabilityT =
  (typeof QUESTION_AVAILABILITY)[keyof typeof QUESTION_AVAILABILITY];

/** 维度二：评分准入（D1/D17 —— 未准入绝不自动判分）。 */
export const SCORING_ADMISSION_STATE = {
  ADMITTED: 'admitted',
  WITHHELD: 'withheld',
} as const;
export type ScoringAdmissionStateT =
  (typeof SCORING_ADMISSION_STATE)[keyof typeof SCORING_ADMISSION_STATE];

/** withheld 的显式原因（CHECK 强制分支完整性；admitted 分支恒 NULL）。 */
export const SCORING_ADMISSION_WITHHELD_REASON = {
  /** 规则未通过结构校验 + 独立核验双门（未决，非拒绝）。 */
  UNVERIFIED_RULES: 'unverified_rules',
  /** 核验执行且未通过（含 verify_suspended 场景）。 */
  VERIFICATION_FAILED: 'verification_failed',
  /** 该判分能力切片无 D17 准入执行器。 */
  NO_ADMITTED_EXECUTOR: 'no_admitted_executor',
  /** owner 显式挂起（运维/审计决定）。 */
  OWNER_HOLD: 'owner_hold',
} as const;
export type ScoringAdmissionWithheldReasonT =
  (typeof SCORING_ADMISSION_WITHHELD_REASON)[keyof typeof SCORING_ADMISSION_WITHHELD_REASON];

/** 挂起原因（suspended=true 分支必填；verify 挂起 ≠ 撤回）。 */
export const SUSPENSION_REASON = {
  /** 题源 verify 挂起（verify-suspended 窗口内的提交落 needs_review 未决）。 */
  VERIFY_HOLD: 'verify_hold',
  /** 提案撤回挂起。 */
  RETRACTION_HOLD: 'retraction_hold',
} as const;
export type SuspensionReasonT = (typeof SUSPENSION_REASON)[keyof typeof SUSPENSION_REASON];

/** issuance claim 政策（一次性诊断/probe 占用 vs 无界发题）。 */
export const ISSUANCE_CLAIM_POLICY = {
  ONE_TIME: 'one_time',
  UNBOUNDED: 'unbounded',
} as const;
export type IssuanceClaimPolicyT =
  (typeof ISSUANCE_CLAIM_POLICY)[keyof typeof ISSUANCE_CLAIM_POLICY];

/** 判分规则来源（D1：system authored ≠ official；第二模型同意不构成证明）。 */
export const MARKING_RULE_PROVENANCE = {
  OFFICIAL: 'official',
  SYSTEM_VERIFIED: 'system_verified',
  MANUAL: 'manual',
} as const;
export type MarkingRuleProvenanceLiteralT =
  (typeof MARKING_RULE_PROVENANCE)[keyof typeof MARKING_RULE_PROVENANCE];

/** admission verify 记录 outcome（版本化 policy id + outcome 留痕）。 */
export const ADMISSION_VERIFICATION_OUTCOME = {
  PASSED: 'passed',
  SUSPENDED: 'suspended',
  FAILED: 'failed',
} as const;
export type AdmissionVerificationOutcomeT =
  (typeof ADMISSION_VERIFICATION_OUTCOME)[keyof typeof ADMISSION_VERIFICATION_OUTCOME];

/**
 * 未完成 → 容器维度的 canonical 映射（draft_status 拆分后的桥语义）。
 * pre-cutover 数据迁移：'draft' ⇒ container_only + withheld(unverified_rules) +
 * suspended=false；NULL/'active' ⇒ general_pool（admission 按事件世系重放判定）。
 */
export const LEGACY_DRAFT_SPLIT = {
  [LEGACY_DRAFT_STATUS.DRAFT]: {
    availability: QUESTION_AVAILABILITY.CONTAINER_ONLY,
    scoring_admission_state: SCORING_ADMISSION_STATE.WITHHELD,
    withheld_reason: SCORING_ADMISSION_WITHHELD_REASON.UNVERIFIED_RULES,
  },
  [LEGACY_DRAFT_STATUS.ACTIVE]: {
    availability: QUESTION_AVAILABILITY.GENERAL_POOL,
  },
  /** NULL 列同 ACTIVE（NULL≡active）。 */
  NULL: { availability: QUESTION_AVAILABILITY.GENERAL_POOL },
} as const;
