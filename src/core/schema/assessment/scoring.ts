import { unit as parseUnit } from 'mathjs';
import { z } from 'zod';
import { ConjectureProbeSpecV2 } from '../business';
import { isInteriorGap } from './position-gap';
import type { ResponseSlotT, ResponseSpecT, SelectSlotT } from './response';
import { ScoringRule, validateScoringRule } from './scoring-rule';
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

/** 文本答案键：接受文本 + 归一化档位；更细语义走 rule_reference。
 * `answer_head`（YUK-1047）：先抽答案头（“答：B”→“B”、答案+解析→答案）再
 * NFKC+trim+lowercase —— 与 legacy exact 判分同语义（judge-routing.ts）。 */
export const TextKeyCriterion = z.object({
  kind: z.literal('text_key'),
  accepted_texts: z.array(z.string().min(1)).min(1),
  normalization: z.enum(['exact', 'trim', 'trim_casefold_nfc', 'answer_head']).default('trim'),
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
 * 配对题答案键（P1-8）：显式编码【哪个左项配哪个右项】—— 不能用 option
 * 集合冒充（集合无法表达映射关系）。与 exact_matching_pairs 比较器配套。
 * 私有判据：随 revision 冻结，公开 issuance DTO 不含 criterion，反馈
 * 揭示走 RevealedAnswerKey（dto.ts）。
 */
export const MatchingPairsKeyCriterion = z.object({
  kind: z.literal('matching_pairs_key'),
  accepted_pairs: z
    .array(
      z.object({
        item_id: z.string().min(1),
        option_id: z.string().min(1),
      }),
    )
    .min(1),
  /**
   * 题级部分分规则（ADR-0074 D3a）：只按卷面【印出来的】规则 typed 录入；
   * 缺省（无印规则）＝非全对记对数、partial、分数未知（不造分）。
   * 卷面印每对分值时，录入侧亦可按 ADR 拆为每对一计分单元 —— 两种承载
   * 都合法；本规则不发明权重。
   */
  rule: z
    .object({
      kind: z.literal('per_correct_pair'),
      /** 每配对一对得多少分（卷面印值）。 */
      points_per_pair: z.number().min(0),
    })
    .optional(),
});
export type MatchingPairsKeyCriterionT = z.infer<typeof MatchingPairsKeyCriterion>;

/**
 * 位置集合键（ADR-0074 D3a 断句）：接受的断点集合 + 题级 typed 计分规则。
 * 私有判据（同 matching_pairs_key 的公私边界）。位置语义见 position-gap.ts
 * （冻结明文的 code point 内部字缝）。规则只按卷面印规则 typed 录入
 * （例：「每对一处 1 分、超 3 处 0 分」）；缺省＝无印规则：非精确集合记
 * 对数、partial、分数未知（不造分）。绝不解析中文规则原文 —— 规则必须
 * 录入时 typed 填入，不 regex 猜。
 */
export const PositionSetKeyCriterion = z.object({
  kind: z.literal('position_set_key'),
  /** 接受的断点集合（内部字缝索引；validateScoringBasis 校验范围与唯一）。 */
  accepted_positions: z.array(z.number().int().min(1)).min(1),
  rule: z
    .object({
      kind: z.literal('per_correct_break'),
      /** 每对一处得多少分（卷面印值）。 */
      points_per_break: z.number().min(0),
      /** 「超 N 处 0 分」的 N：作答断点数 > N ⇒ 0 分（validateScoringBasis
       * 强制 N ≥ 接受集合大小 —— 精确集合不得被自家规则归零）。 */
      max_breaks: z.number().int().min(1),
    })
    .optional(),
});
export type PositionSetKeyCriterionT = z.infer<typeof PositionSetKeyCriterion>;

/**
 * 规则引用：复杂/过程性评分依据以受版本化规则原文表达，由获准执行器
 * （model_executor / human_review）判定并给出符合哪条规则的证据。
 */
export const RuleReferenceCriterion = z.object({
  kind: z.literal('rule_reference'),
  rule_id: z.string().min(1),
  statement_md: z.string().min(1),
  source: z.enum(['official', 'system_proposed', 'manual']),
  probe_spec: ConjectureProbeSpecV2.optional(),
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

// ---------- K1 统一判据（YUK-1496）：select_key / blank_key ----------
//
// 新题只写这两种确定性键；给分全部由 unit.rule（scoring-rule.ts）表达。
// option_set_key / matching_pairs_key / position_set_key 是被取代的按题型键：
// 已冻结 revision 原样可读可重放，写入方迁到 select_key 后不再产生新行。

/** select 的正确 item 集合（选项、关系、字缝统一为稳定 item id）。 */
export const SelectKeyCriterion = z.object({
  kind: z.literal('select_key'),
  accepted_item_ids: z.array(z.string().min(1)).min(1),
});
export type SelectKeyCriterionT = z.infer<typeof SelectKeyCriterion>;

/**
 * 单空 exact 的归一化，带版本；不同科目不共享宽松规则（诗词逐字、数学/英语
 * 可 casefold）。character_variants 是题目显式声明的异体字等价对，缺省为空
 * —— 诗词错字是否整句零分由题目规则声明，不设全局默认。
 */
export const BlankNormalization = z.object({
  version: z.string().min(1),
  nfkc: z.boolean().default(false),
  trim_outer: z.boolean().default(true),
  casefold: z.boolean().default(false),
  collapse_whitespace: z.boolean().default(false),
  ignore_punctuation: z.boolean().default(false),
  character_variants: z.array(z.tuple([z.string().min(1), z.string().min(1)])).default([]),
});
export type BlankNormalizationT = z.infer<typeof BlankNormalization>;

export const BlankKeyCriterion = z.object({
  kind: z.literal('blank_key'),
  key: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('text'),
      accepted: z.array(z.string().min(1)).min(1),
      normalization: BlankNormalization,
    }),
    /** 数值：保留既有容差与单位换算能力（expected_unit 存在时按 mathjs 换算）。 */
    z.object({
      kind: z.literal('numeric'),
      expected: z.number(),
      tolerance: NumericKeyCriterion.shape.tolerance,
      expected_unit: z.string().min(1).optional(),
    }),
  ]),
});
export type BlankKeyCriterionT = z.infer<typeof BlankKeyCriterion>;

export const ScoringUnitCriterion = z.discriminatedUnion('kind', [
  OptionSetKeyCriterion,
  MatchingPairsKeyCriterion,
  PositionSetKeyCriterion,
  TextKeyCriterion,
  NumericKeyCriterion,
  RuleReferenceCriterion,
  HolisticLevelCriterion,
  SelectKeyCriterion,
  BlankKeyCriterion,
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
   * key = level_id，只允许声明过的档位。可以【完全省略】—— 纯档位评分
   * （ordinal-only rubric）合法：命中任何档位都不产生总分（no_mapping），
   * 不凭空造分；映射也可不含某些档位 —— 命中未映射档位同样 no_mapping。
   * 加法单元禁止携带（validateScoringBasis 强制）。
   */
  level_points: z.record(z.string(), z.number().min(0)).optional(),
  /**
   * K1 给分规则（YUK-1496）：select_key / blank_key 单元必填，其余判据禁携。
   * 规则读比较计数给分；分值未知显式写 unknown，不造分。
   */
  rule: ScoringRule.optional(),
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
    | 'level_points_forbidden_for_additive_unit'
    | 'level_points_level_not_declared'
    | 'criterion_slot_kind_mismatch'
    | 'key_option_not_declared'
    | 'key_item_not_declared'
    | 'key_position_not_declared'
    | 'key_position_duplicated'
    | 'key_rule_conflicts_exact_set'
    | 'key_rule_points_mismatch'
    | 'key_pairing_violation'
    | 'weights_must_cover_units_exactly'
    | 'no_unit_references_any_slot'
    | 'rule_required'
    | 'rule_forbidden_for_criterion'
    | 'k1_key_requires_one_slot'
    | 'blank_key_unit_unsupported'
    | 'rule_metric_not_applicable'
    | 'rule_outcome_not_applicable'
    | 'rule_item_not_in_key'
    | 'rule_exceeds_unit_points'
    | 'rule_key_response_not_full_marks';
  detail: string;
}

// P1-8：判据↔槽位种类相容表 —— 答案键必须落在能承载它的槽位上。
/**
 * 浮点相等（相对 ε=1e-9）：卷面十进制分值（如 1.5×3、0.5×2）不得因二进制
 * 表示误差被误拒（独立复核 P1-2 —— 校验“可达满分=发布满分”，非重算权重）。
 */
function samePoints(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
}
function expectsSlotKinds(
  criterion: ScoringUnitT['criterion'],
): readonly ResponseSlotT['kind'][] | null {
  switch (criterion.kind) {
    case 'option_set_key':
      return ['single_choice', 'multi_choice'];
    case 'matching_pairs_key':
      return ['matching'];
    case 'position_set_key':
      return ['sentence_breaks'];
    case 'text_key':
      return ['text', 'open_response'];
    case 'numeric_key':
      return ['numeric'];
    case 'select_key':
      return ['select'];
    case 'blank_key':
      return ['blank'];
    case 'rule_reference':
    case 'holistic_level':
      return null; // 不限槻位种类（规则/等级可判任意响应）
  }
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
    // P1-8：判据↔槽位种类相容 + 键内 id 可解析（防止“集合冒充映射”之类的错配）。
    const expectedKinds = expectsSlotKinds(unit.criterion);
    const referencedSlots = unit.slot_refs
      .map((slotId) => slotById.get(slotId))
      .filter((slot): slot is ResponseSlotT => slot != null);
    if (expectedKinds != null) {
      for (const slot of referencedSlots) {
        if (!expectedKinds.includes(slot.kind)) {
          issues.push({
            code: 'criterion_slot_kind_mismatch',
            detail: `unit '${unit.scoring_unit_id}' criterion '${unit.criterion.kind}' cannot read slot '${slot.slot_id}' of kind '${slot.kind}'`,
          });
        }
      }
    }
    if (unit.criterion.kind === 'option_set_key') {
      const declaredOptions = new Set(
        referencedSlots
          .filter((slot) => slot.kind === 'single_choice' || slot.kind === 'multi_choice')
          .flatMap((slot) =>
            slot.kind === 'single_choice' || slot.kind === 'multi_choice' ? slot.options : [],
          )
          .map((option) => option.option_id),
      );
      for (const optionId of unit.criterion.accepted_option_ids) {
        if (!declaredOptions.has(optionId)) {
          issues.push({
            code: 'key_option_not_declared',
            detail: `unit '${unit.scoring_unit_id}' key references undeclared option '${optionId}'`,
          });
        }
      }
    }
    if (unit.criterion.kind === 'matching_pairs_key') {
      const matchingSlots = referencedSlots.filter(
        (slot): slot is Extract<ResponseSlotT, { kind: 'matching' }> => slot.kind === 'matching',
      );
      for (const pair of unit.criterion.accepted_pairs) {
        const resolvesInSomeSlot = matchingSlots.some(
          (slot) =>
            slot.left_items.some((item) => item.item_id === pair.item_id) &&
            slot.right_options.some((option) => option.option_id === pair.option_id),
        );
        if (!resolvesInSomeSlot) {
          issues.push({
            code: 'key_item_not_declared',
            detail: `unit '${unit.scoring_unit_id}' pair '${pair.item_id}'→'${pair.option_id}' does not resolve in any referenced matching slot`,
          });
        }
      }
      // ADR-0074 D3a：声明 one_to_one 的槽，键内同一右选项不得配多个左项
      // （键与作答位基数声明同源 —— 否则永远判不出全对）。
      for (const slot of matchingSlots) {
        if (slot.pairing !== 'one_to_one') continue;
        const optionUse = new Map<string, number>();
        for (const pair of unit.criterion.accepted_pairs) {
          const resolvesHere =
            slot.left_items.some((item) => item.item_id === pair.item_id) &&
            slot.right_options.some((option) => option.option_id === pair.option_id);
          if (resolvesHere) {
            optionUse.set(pair.option_id, (optionUse.get(pair.option_id) ?? 0) + 1);
          }
        }
        for (const [optionId, uses] of optionUse) {
          if (uses > 1) {
            issues.push({
              code: 'key_pairing_violation',
              detail: `unit '${unit.scoring_unit_id}' key pairs right option '${optionId}' with ${uses} left items in one_to_one slot '${slot.slot_id}'`,
            });
          }
        }
      }
      // 独立复核 P1-2：印规则可达满分必须等于发布 unit.points —— 矛盾规则
      // 在发布/服务共用的 canonical 校验处拒绝，不封顶、不折算、不让精确
      // 集合静默绕过矛盾规则。
      if (unit.criterion.rule?.kind === 'per_correct_pair' && unit.points != null) {
        const attainable =
          unit.criterion.rule.points_per_pair * unit.criterion.accepted_pairs.length;
        if (!samePoints(attainable, unit.points)) {
          issues.push({
            code: 'key_rule_points_mismatch',
            detail: `unit '${unit.scoring_unit_id}' printed rule attains ${attainable} (${unit.criterion.rule.points_per_pair}×${unit.criterion.accepted_pairs.length} pairs) but the unit publishes points=${unit.points} — contradictory rule is rejected at entry, never capped or rescaled`,
          });
        }
      }
    }
    if (unit.criterion.kind === 'position_set_key') {
      const breakSlots = referencedSlots.filter(
        (slot): slot is Extract<ResponseSlotT, { kind: 'sentence_breaks' }> =>
          slot.kind === 'sentence_breaks',
      );
      const seenKeyPositions = new Set<number>();
      for (const position of unit.criterion.accepted_positions) {
        if (seenKeyPositions.has(position)) {
          issues.push({
            code: 'key_position_duplicated',
            detail: `unit '${unit.scoring_unit_id}' accepts break position ${position} more than once`,
          });
        }
        seenKeyPositions.add(position);
        if (!breakSlots.some((slot) => isInteriorGap(slot.text, position))) {
          issues.push({
            code: 'key_position_not_declared',
            detail: `unit '${unit.scoring_unit_id}' accepted break position ${position} is not an interior code-point gap of any referenced sentence_breaks slot`,
          });
        }
      }
      if (
        unit.criterion.rule?.kind === 'per_correct_break' &&
        unit.criterion.rule.max_breaks < unit.criterion.accepted_positions.length
      ) {
        issues.push({
          code: 'key_rule_conflicts_exact_set',
          detail: `unit '${unit.scoring_unit_id}' rule max_breaks=${unit.criterion.rule.max_breaks} is below the accepted break count ${unit.criterion.accepted_positions.length} — the exact reference set would be zeroed by its own rule`,
        });
      }
      // 独立复核 P1-2：同配对 —— 印规则可达满分必须等于发布 unit.points。
      if (unit.criterion.rule?.kind === 'per_correct_break' && unit.points != null) {
        const attainable =
          unit.criterion.rule.points_per_break * unit.criterion.accepted_positions.length;
        if (!samePoints(attainable, unit.points)) {
          issues.push({
            code: 'key_rule_points_mismatch',
            detail: `unit '${unit.scoring_unit_id}' printed rule attains ${attainable} (${unit.criterion.rule.points_per_break}×${unit.criterion.accepted_positions.length} breaks) but the unit publishes points=${unit.points} — contradictory rule is rejected at entry, never capped or rescaled`,
          });
        }
      }
    }
    issues.push(...validateK1Unit(unit, referencedSlots));
    if (unit.criterion.kind === 'holistic_level') {
      if (unit.points !== null) {
        issues.push({
          code: 'points_must_be_null_for_holistic_unit',
          detail: `holistic unit '${unit.scoring_unit_id}' must leave points null (level_points decides)`,
        });
      }
      const levelPoints = unit.level_points ?? {};
      if (Object.keys(levelPoints).length > 0) {
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

/**
 * K1 单元校验（YUK-1496）：select_key 恰好读一个 select 槽、键 id 都在 universe、
 * 键本身是合法作答（不违反 at_most_per_coordinate）；select_key/blank_key 必带
 * 规则且与 points 一致；其余判据不得携带 rule（避免两套给分并存）。
 */
function validateK1Unit(unit: ScoringUnitT, referencedSlots: ResponseSlotT[]): ScoringBasisIssue[] {
  const issues: ScoringBasisIssue[] = [];
  const criterion = unit.criterion;
  if (criterion.kind !== 'select_key' && criterion.kind !== 'blank_key') {
    if (unit.rule != null) {
      issues.push({
        code: 'rule_forbidden_for_criterion',
        detail: `unit '${unit.scoring_unit_id}' criterion '${criterion.kind}' must not carry a K1 rule`,
      });
    }
    return issues;
  }
  if (criterion.kind === 'select_key') {
    const selectSlots = referencedSlots.filter(
      (slot): slot is SelectSlotT => slot.kind === 'select',
    );
    if (selectSlots.length !== 1 || unit.slot_refs.length !== 1) {
      issues.push({
        code: 'k1_key_requires_one_slot',
        detail: `unit '${unit.scoring_unit_id}' select_key must read exactly one select slot`,
      });
    } else {
      const slot = selectSlots[0];
      const itemById = new Map(slot.items.map((item) => [item.item_id, item] as const));
      const seen = new Set<string>();
      for (const id of criterion.accepted_item_ids) {
        if (!itemById.has(id)) {
          issues.push({
            code: 'key_item_not_declared',
            detail: `unit '${unit.scoring_unit_id}' key item '${id}' is not in slot '${slot.slot_id}' universe`,
          });
        }
        if (seen.has(id)) {
          issues.push({
            code: 'key_position_duplicated',
            detail: `unit '${unit.scoring_unit_id}' key lists item '${id}' more than once`,
          });
        }
        seen.add(id);
      }
      for (const [axis, limit] of Object.entries(slot.at_most_per_coordinate ?? {})) {
        const uses = new Map<string, number>();
        for (const id of seen) {
          const value = itemById.get(id)?.coordinates?.[axis];
          if (value != null) uses.set(value, (uses.get(value) ?? 0) + 1);
        }
        if ([...uses.values()].some((count) => count > limit)) {
          issues.push({
            code: 'key_pairing_violation',
            detail: `unit '${unit.scoring_unit_id}' key violates at_most_per_coordinate.${axis}=${limit}`,
          });
        }
      }
    }
  }
  if (criterion.kind === 'blank_key') {
    // 判分只读一个作答位：多空必须拆成多个 unit，不能让第二个空被静默忽略。
    const blankSlots = referencedSlots.filter((slot) => slot.kind === 'blank');
    if (blankSlots.length !== 1 || unit.slot_refs.length !== 1) {
      issues.push({
        code: 'k1_key_requires_one_slot',
        detail: `unit '${unit.scoring_unit_id}' blank_key must read exactly one blank slot`,
      });
    }
    if (criterion.key.kind === 'numeric' && criterion.key.expected_unit != null) {
      try {
        parseUnit(1, criterion.key.expected_unit);
      } catch {
        issues.push({
          code: 'blank_key_unit_unsupported',
          detail: `unit '${unit.scoring_unit_id}' reference unit '${criterion.key.expected_unit}' cannot be parsed; every answer would stay pending`,
        });
      }
    }
  }
  if (unit.rule == null) {
    issues.push({
      code: 'rule_required',
      detail: `unit '${unit.scoring_unit_id}' criterion '${criterion.kind}' needs an explicit scoring rule`,
    });
    return issues;
  }
  if (unit.points == null) return issues; // points_required_for_additive_unit 已报
  const ruleIssues =
    criterion.kind === 'select_key'
      ? validateScoringRule(unit.rule, {
          unitId: unit.scoring_unit_id,
          points: unit.points,
          facts: 'set',
          keyIds: criterion.accepted_item_ids,
        })
      : validateScoringRule(unit.rule, {
          unitId: unit.scoring_unit_id,
          points: unit.points,
          facts: 'single',
        });
  issues.push(...ruleIssues);
  return issues;
}
