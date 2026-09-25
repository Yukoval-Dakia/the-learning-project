import { z } from 'zod';
import type { ResponseSpecT } from './response';
import type { QuestionGroupStructureT } from './structure';

// ====================================================================
// YUK-1046 — 五层模型 · 第三层：评分依据 ScoringBasis（grounding §4.4、D13）
// ====================================================================
//
// scoring unit 是唯一计分权威：
//   - response slot 是作答位置，不是计分权威 —— slot 上没有 points；
//   - 每个 scoring unit 显式引用其需要的 slot / 材料 / 证据，贡献分数恰好一次；
//   - 不存在 slot.points + criterion.points + dimension.points 的多层累加 ——
//     points 只出现在 unit 上，criterion 描述【怎么判】，dimension 不是独立
//     累加层（作文维度若要计分，就是各自的 scoring unit）；
//   - 合计由发布时选定的唯一聚合 policy 决定（sum / cap / weight / threshold）；
//   - 非加法整体等级用【显式映射】表达；未提供映射不凭空制造总分。
//
// 复杂规则（依赖/替代/带错续算）以 rule_reference 原文 + 获准执行器判定；
// 模型只能报告符合哪条规则及其证据，不能在输出中新增依赖图/权重（§4.4）。
// 不为全部考试构建通用 marking DSL。

// ---------- 判据（怎么判） ----------

/** 单/多选答案键：接受的 option_id 集合。更细的部分分语义走 rule_reference。 */
export const OptionSetKeyCriterion = z.object({
  kind: z.literal('option_set_key'),
  accepted_option_ids: z.array(z.string().min(1)).min(1),
});
export type OptionSetKeyCriterionT = z.infer<typeof OptionSetKeyCriterion>;

/** 文本答案键：接受文本 + 归一化档位；更细语义走 rule_reference。 */
export const TextKeyCriterion = z.object({
  kind: z.literal('text_key'),
  accepted_texts: z.array(z.string().min(1)).min(1),
  normalization: z.enum(['exact', 'trim', 'trim_casefold_nfc']).default('trim'),
});
export type TextKeyCriterionT = z.infer<typeof TextKeyCriterion>;

/** 数值答案键：期望值 + 容差（绝对或相对）；单位/有效位由执行器按声明校验。 */
export const NumericKeyCriterion = z.object({
  kind: z.literal('numeric_key'),
  expected: z.number(),
  tolerance: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('absolute'), value: z.number().min(0) }),
    z.object({ kind: z.literal('relative'), ratio: z.number().min(0) }),
  ]),
  expected_unit: z.string().min(1).optional(),
});
export type NumericKeyCriterionT = z.infer<typeof NumericKeyCriterion>;

/**
 * 规则引用：复杂/过程性评分依据以受版本化规则原文表达，由获准执行器
 * （model_executor / human_review）判定并给出符合哪条规则的证据。
 */
export const RuleReferenceCriterion = z.object({
  kind: z.literal('rule_reference'),
  rule_id: z.string().min(1),
  statement_md: z.string().min(1),
  source: z.enum(['official', 'system_proposed', 'manual']),
});
export type RuleReferenceCriterionT = z.infer<typeof RuleReferenceCriterion>;

/** 非加法整体等级：档位描述符 + rank（rank 越高越好）。分数由显式映射给出。 */
export const HolisticLevelCriterion = z.object({
  kind: z.literal('holistic_level'),
  levels: z
    .array(
      z.object({
        level_id: z.string().min(1),
        descriptor_md: z.string().min(1),
        rank: z.number().int().min(0),
      }),
    )
    .min(2),
});
export type HolisticLevelCriterionT = z.infer<typeof HolisticLevelCriterion>;

export const ScoringUnitCriterion = z.discriminatedUnion('kind', [
  OptionSetKeyCriterion,
  TextKeyCriterion,
  NumericKeyCriterion,
  RuleReferenceCriterion,
  HolisticLevelCriterion,
]);
export type ScoringUnitCriterionT = z.infer<typeof ScoringUnitCriterion>;

// ---------- scoring unit ----------

/**
 * 唯一计分单元。points：加法单元必填非负；holistic 单元为 null
 * （分数由 unit 级显式映射 level_points 在聚合时解析，validateScoringBasis 强制）。
 */
export const ScoringUnit = z.object({
  scoring_unit_id: z.string().min(1),
  /** 本单元需要读取的作答槽位（slot_id 引用）。 */
  slot_refs: z.array(z.string().min(1)).default([]),
  /** 本单元需要的共享材料（material_id 引用；无则空）。 */
  material_refs: z.array(z.string().min(1)).default([]),
  /** 本单元消费其附件证据的槽位（必须是 open_response 槽）。 */
  evidence_slot_refs: z.array(z.string().min(1)).default([]),
  /** 是否消费 evaluation group 级证据（如整页解题照，§7.3）。 */
  requires_group_evidence: z.boolean().default(false),
  criterion: ScoringUnitCriterion,
  points: z.number().min(0).nullable(),
  /**
   * holistic 单元的【显式等级→分数映射】（非加法整体等级，§4.4）：
   * key = level_id，只允许声明过的档位；映射可以不含某些档位 ——
   * 命中未映射档位时聚合进入 unresolved(no_mapping)，【不凭空制造总分】。
   * 加法单元禁止携带（validateScoringBasis 强制）。
   */
  level_points: z.record(z.string(), z.number().min(0)).optional(),
});
export type ScoringUnitT = z.infer<typeof ScoringUnit>;

// ---------- 聚合 policy（发布时选定唯一一种） ----------

/** 直接求和。 */
export const SumAggregation = z.object({ kind: z.literal('sum') });

/** 加权求和：weights 必须恰好覆盖全部 unit 各一次（validateScoringBasis 强制）。 */
export const WeightedSumAggregation = z.object({
  kind: z.literal('weighted_sum'),
  weights: z.record(z.string(), z.number().min(0)),
});

/** 封顶求和：先求和再截断到 cap。 */
export const CappedSumAggregation = z.object({
  kind: z.literal('capped_sum'),
  cap: z.number().min(0),
});

/** 档位映射：总分 → 等级（加法单元之上的非加法呈现；总分仍唯一聚合一次）。 */
export const ThresholdLevelsAggregation = z.object({
  kind: z.literal('threshold_levels'),
  thresholds: z
    .array(
      z.object({
        level_id: z.string().min(1),
        min_points: z.number().min(0),
      }),
    )
    .min(1),
});

export const AggregationPolicy = z.discriminatedUnion('kind', [
  SumAggregation,
  WeightedSumAggregation,
  CappedSumAggregation,
  ThresholdLevelsAggregation,
]);
export type AggregationPolicyT = z.infer<typeof AggregationPolicy>;

/** 评分依据全貌。blank_scores_zero 见 §4.4 / D13：空白只有政策明确才可计零。 */
export const ScoringBasis = z.object({
  units: z.array(ScoringUnit).min(1),
  aggregation: AggregationPolicy,
  /** 主动空白是否按声明 marking 计零；false 时空白进入 pending（missing 不得计零）。 */
  blank_scores_zero: z.boolean(),
});
export type ScoringBasisT = z.infer<typeof ScoringBasis>;

// ---------- 确定性校验（发布 barrier 的纯子集） ----------

export interface ScoringBasisIssue {
  code:
    | 'duplicate_scoring_unit_id'
    | 'unresolved_slot_ref'
    | 'unresolved_material_ref'
    | 'unresolved_evidence_slot_ref'
    | 'evidence_slot_not_open'
    | 'points_required_for_additive_unit'
    | 'points_must_be_null_for_holistic_unit'
    | 'level_points_required_for_holistic_unit'
    | 'level_points_forbidden_for_additive_unit'
    | 'level_points_level_not_declared'
    | 'weights_must_cover_units_exactly'
    | 'no_unit_references_any_slot';
  detail: string;
}

/**
 * 纯校验：unit 身份唯一、slot/material/evidence 引用可解析、points 纪律、
 * 聚合 policy 与 unit 集合的一致性（weights 恰好覆盖、holistic 映射合法）。
 * 这是“贡献恰好一次 / 无重复累加”的类型层之下的确定性执行层。
 */
export function validateScoringBasis(
  basis: ScoringBasisT,
  spec: ResponseSpecT,
  structure: QuestionGroupStructureT,
): ScoringBasisIssue[] {
  const issues: ScoringBasisIssue[] = [];
  const slotById = new Map(spec.slots.map((slot) => [slot.slot_id, slot] as const));
  const materialIds = new Set(structure.materials.map((material) => material.material_id));

  const unitIds = new Set<string>();
  for (const unit of basis.units) {
    if (unitIds.has(unit.scoring_unit_id)) {
      issues.push({
        code: 'duplicate_scoring_unit_id',
        detail: `scoring_unit_id '${unit.scoring_unit_id}' appears more than once`,
      });
    }
    unitIds.add(unit.scoring_unit_id);

    for (const slotId of unit.slot_refs) {
      if (!slotById.has(slotId)) {
        issues.push({
          code: 'unresolved_slot_ref',
          detail: `unit '${unit.scoring_unit_id}' references unknown slot '${slotId}'`,
        });
      }
    }
    for (const materialId of unit.material_refs) {
      if (!materialIds.has(materialId)) {
        issues.push({
          code: 'unresolved_material_ref',
          detail: `unit '${unit.scoring_unit_id}' references unknown material '${materialId}'`,
        });
      }
    }
    for (const evidenceSlotId of unit.evidence_slot_refs) {
      const slot = slotById.get(evidenceSlotId);
      if (slot == null) {
        issues.push({
          code: 'unresolved_evidence_slot_ref',
          detail: `unit '${unit.scoring_unit_id}' evidence references unknown slot '${evidenceSlotId}'`,
        });
      } else if (slot.kind !== 'open_response') {
        issues.push({
          code: 'evidence_slot_not_open',
          detail: `unit '${unit.scoring_unit_id}' evidence slot '${evidenceSlotId}' is not open_response`,
        });
      }
    }
    if (unit.criterion.kind === 'holistic_level') {
      if (unit.points !== null) {
        issues.push({
          code: 'points_must_be_null_for_holistic_unit',
          detail: `holistic unit '${unit.scoring_unit_id}' must leave points null (level_points decides)`,
        });
      }
      const levelPoints = unit.level_points ?? {};
      if (Object.keys(levelPoints).length === 0) {
        issues.push({
          code: 'level_points_required_for_holistic_unit',
          detail: `holistic unit '${unit.scoring_unit_id}' requires an explicit level_points mapping`,
        });
      } else {
        const declaredLevels = new Set(unit.criterion.levels.map((level) => level.level_id));
        for (const levelId of Object.keys(levelPoints)) {
          if (!declaredLevels.has(levelId)) {
            issues.push({
              code: 'level_points_level_not_declared',
              detail: `level_points of unit '${unit.scoring_unit_id}' references undeclared level '${levelId}'`,
            });
          }
        }
      }
    } else {
      if (unit.points === null) {
        issues.push({
          code: 'points_required_for_additive_unit',
          detail: `unit '${unit.scoring_unit_id}' is additive and requires points`,
        });
      }
      if (unit.level_points != null && Object.keys(unit.level_points).length > 0) {
        issues.push({
          code: 'level_points_forbidden_for_additive_unit',
          detail: `additive unit '${unit.scoring_unit_id}' must not carry level_points`,
        });
      }
    }
    if (
      unit.slot_refs.length === 0 &&
      unit.evidence_slot_refs.length === 0 &&
      !unit.requires_group_evidence
    ) {
      issues.push({
        code: 'no_unit_references_any_slot',
        detail: `unit '${unit.scoring_unit_id}' references no slot, evidence, or group evidence`,
      });
    }
  }

  const aggregation = basis.aggregation;
  if (aggregation.kind === 'weighted_sum') {
    const weightKeys = new Set(Object.keys(aggregation.weights));
    const missing = [...unitIds].filter((id) => !weightKeys.has(id));
    const extra = [...weightKeys].filter((id) => !unitIds.has(id));
    if (missing.length > 0 || extra.length > 0) {
      issues.push({
        code: 'weights_must_cover_units_exactly',
        detail: `weighted_sum weights must cover units exactly once; missing=${missing.join(',')} extra=${extra.join(',')}`,
      });
    }
  }
  return issues;
}
