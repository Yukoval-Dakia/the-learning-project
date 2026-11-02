// 诊断落点（actionable weak point）—— KC 之下的可行动薄弱点合同（YUK-1582）。
//
// 与 ADR-0035 三维诊断的关系：三维（R / p(L) / difficulty）回答 KC 级「记得牢不牢 / 此刻会不会」；
// 本类型是只读派生的**更细诊断对象**——子技能或关键步骤粒度的「下一步练什么」，不写回任何
// 掌握/调度状态，不参与 FSRS / p(L) / difficulty。
//
// 设计锚：
//   - docs/design/2026-10-06-continuous-learning-system-behavior.md §6.1（判断不能压缩成
//     无边界「几何薄弱」；须落到可行动目标 + 证据 + 未知）。
//   - docs/design/2026-06-16-meta-cause-taxonomy-research.md（knowledge_gap 陈述性 vs
//     flawed_model 程序性；每个 meta-cause 对应不同处方）。
//
// 证据红线：evidence_refs 只指向一手学习事实事件与既有判定（失败 attempt/review、judge 归因、
// user_cause 归因、被 owner 接受的 misconception 所携带的一手事件指针）；禁止指向 agent note、
// 派生 scan 或另一个 weak point（自喂）。落点本身是派生读，不是第二真相源。
import { z } from 'zod';
import { CauseCategoryId, MetaCause, type MetaCauseT } from './cause';

/** 陈述侧（能说出定义/陈述）与程序侧（能执行变形/程序）是不同的训练对象与证据对象。 */
export const WeakPointKind = z.enum(['concept_statement', 'procedural_execution']);
export type WeakPointKindT = z.infer<typeof WeakPointKind>;

/**
 * 训练去向，按 meta-cause 处方（taxonomy §1「直接挂干预含义」）：
 *   concept_review       — 概念复习/重学材料（陈述性缺口 → 初教）。
 *   retrieval_practice   — 无提示检索练习（可用但取不出 → 检索训练，不重教）。
 *   procedural_practice  — 程序性练习（转译/变形执行 → 练步骤本身）。
 *   discrimination_probe — 判别性探针/认知冲突练习（坏规则/条件误用 → 反例与条件辨识）。
 */
export const WeakPointTrainingDestination = z.enum([
  'concept_review',
  'retrieval_practice',
  'procedural_practice',
  'discrimination_probe',
]);
export type WeakPointTrainingDestinationT = z.infer<typeof WeakPointTrainingDestination>;

/** 证据角色 ∈ 一手事件（attempt/review/assessment_attempt）∪ 既有判定（judge / user_cause）。 */
export const WeakPointEvidenceRole = z.enum([
  'failed_attempt',
  'judge_attribution',
  'user_cause_attribution',
]);
export type WeakPointEvidenceRoleT = z.infer<typeof WeakPointEvidenceRole>;

export const WeakPointEvidenceRef = z
  .object({
    event_id: z.string().min(1),
    role: WeakPointEvidenceRole,
  })
  .strict();
export type WeakPointEvidenceRefT = z.infer<typeof WeakPointEvidenceRef>;

/**
 * 定性证据强度带，不是校准概率（未过校准闸的数值不得当置信用，ADR-0035 推论）。
 *   single_failure — 窗口内 1 次独立失败。
 *   recurring      — 窗口内 ≥2 次独立失败，或 owner 已接受同身份 soft misconception。
 *   probe_confirmed — 同身份 misconception 已硬确认（source='hard'，探针证据升级）。
 */
export const WeakPointEvidenceStrength = z.enum(['single_failure', 'recurring', 'probe_confirmed']);
export type WeakPointEvidenceStrengthT = z.infer<typeof WeakPointEvidenceStrength>;

/** 可行动 meta 集（六类排除 execution_slip 后的余集），落点规则的键。 */
export type ActionableMetaCause = Exclude<MetaCauseT, 'execution_slip'>;

export interface MetaCauseLandingRule {
  kind: WeakPointKindT;
  destination: WeakPointTrainingDestinationT;
  /** 该侧的具体可训练方面，进入 target_md。 */
  aspect_md: string;
  /** 目标动词短语，进入 target_md。 */
  goal_md: string;
}

/**
 * meta_cause → 落点规则的单源映射。execution_slip 被有意排除：slip 是「知识与计划都对，
 * 落笔偏离意图」，处方是提示自查而非训练（taxonomy §1 #1）；把 slip 记成薄弱点会
 * 把注意力问题误诊为能力缺口。排除的失败进 unknowns（slip_only_failures），不静默丢弃。
 */
export const WEAK_POINT_LANDING_RULES: Readonly<Record<ActionableMetaCause, MetaCauseLandingRule>> =
  {
    knowledge_gap: {
      kind: 'concept_statement',
      destination: 'concept_review',
      aspect_md: '定义/规则的陈述',
      goal_md: '能独立说出并写出',
    },
    retrieval_failure: {
      kind: 'concept_statement',
      destination: 'retrieval_practice',
      aspect_md: '无提示下的定义/规则提取',
      goal_md: '能在无提示时给出',
    },
    flawed_model: {
      kind: 'procedural_execution',
      destination: 'discrimination_probe',
      aspect_md: '执行中的关键变形/步骤',
      goal_md: '能不经提示正确执行',
    },
    rule_misapplication: {
      kind: 'procedural_execution',
      destination: 'discrimination_probe',
      aspect_md: '方法适用条件的辨识',
      goal_md: '能独立判断何时用、何时不用',
    },
    representation_failure: {
      kind: 'procedural_execution',
      destination: 'procedural_practice',
      aspect_md: '题意到可解形式的转译',
      goal_md: '能独立完成',
    },
  } as const;

export const WeakPointUnknownReason = z.enum([
  /** 窗口内失败没有任何 active 归因（judge/user_cause 都缺或被纠正）——原因未知，不猜。 */
  'no_active_attribution',
  /** 归因类目解析不出 meta-cause（实例级缺失且该科目无 prior 或类目非诊断性）。 */
  'meta_cause_unresolved',
  /** 窗口内失败全部是 execution_slip——不构成训练薄弱点，按 slip 处方提示自查。 */
  'slip_only_failures',
]);
export type WeakPointUnknownReasonT = z.infer<typeof WeakPointUnknownReason>;

export const ActionableWeakPoint = z
  .object({
    kind: WeakPointKind,
    /** 仅当该失败簇的证据里没有任何知识点引用时才为 null（先补标注再训练）。 */
    knowledge_id: z.string().min(1).nullable(),
    /** knowledge.name；null-KC 或节点缺失时为 null。派生显示辅助，非身份。 */
    knowledge_name: z.string().nullable(),
    /** 可行动目标描述（模板 + KC 名 + 科目错因标签 + 证据摘要；不含编造比例）。 */
    target_md: z.string().min(1),
    cause_category: CauseCategoryId,
    /** 科目错因标签（subject profile label），给消费者人话。 */
    cause_label: z.string(),
    meta_cause: MetaCause,
    training_destination: WeakPointTrainingDestination,
    evidence_refs: z.array(WeakPointEvidenceRef).min(1),
    /** 窗口内贡献本落点的独立失败次数（按 attempt 事件去重）。 */
    failure_count: z.number().int().positive(),
    evidence_strength: WeakPointEvidenceStrength,
    first_seen_at: z.coerce.date(),
    last_seen_at: z.coerce.date(),
  })
  .strict();
export type ActionableWeakPointT = z.infer<typeof ActionableWeakPoint>;

export const WeakPointUnknownSummary = z
  .object({
    reason: WeakPointUnknownReason,
    failure_count: z.number().int().nonnegative(),
    /** 最多 3 个样本事件 id，供下钻核对；空数组合法（无样本可给时如实为空）。 */
    sample_event_ids: z.array(z.string().min(1)).max(3),
  })
  .strict();
export type WeakPointUnknownSummaryT = z.infer<typeof WeakPointUnknownSummary>;

/** 一次只读派生的完整结果：落点列表 + 显式 unknown 汇总，二者都不编造。 */
export const ActionableWeakPointDerivation = z
  .object({
    as_of: z.coerce.date(),
    window_since: z.coerce.date(),
    scanned_failure_count: z.number().int().nonnegative(),
    weak_points: z.array(ActionableWeakPoint),
    unknowns: z.array(WeakPointUnknownSummary),
  })
  .strict();
export type ActionableWeakPointDerivationT = z.infer<typeof ActionableWeakPointDerivation>;

/** 落点身份键（meta_cause × cause_category × knowledge_id|'-'）；与 conjecture 身份同族但更细一轴。 */
export function weakPointKey(
  metaCause: MetaCauseT,
  causeCategory: string,
  knowledgeId: string | null,
): string {
  return `${metaCause}::${causeCategory}::${knowledgeId ?? '-'}`;
}
