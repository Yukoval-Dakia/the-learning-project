import { z } from 'zod';

import { BlankAnswerShape, type BlankAnswerShapeT } from './blank-answer-shape';
import { EvidenceAcceptanceRule, EvidenceAttachment } from './materials';
import { codePointCount, isInteriorGap } from './position-gap';
import type { QuestionGroupStructureT } from './structure';

// ====================================================================
// YUK-1046 — 五层模型 · 第二层：作答要求 ResponseSpec（grounding §4.4、§7.2）
// ====================================================================
//
// ResponseSpec 是【作答契约】：slots 描述作答位置与输入原语。关键纪律：
//   - response slot 是作答位置，【不是】计分权威（§4.4）—— slot 上没有任何
//     points 字段；分数只存在于 scoring unit。
//   - 通用原语，不是学校题型枚举：单/多选（stable option id，数量不硬编码）、
//     文本/数值/公式、多空/表格、配对/排序、开放作答 + D10 原始证据。
//   - 空集合与 missing 区分（§7.2）：显式空 option_ids / 空 text = 主动空白；
//     ResponseSet 中缺该 slot 的条目 = 未作答（missing）。
//
// 身份纪律（§3.1）：slot_id / option_id 稳定；语义替换生成新身份，
// 禁止按 label / 数组 index / 相同文本自动认定连续身份。

// ---------- 选项 ----------

/** stable option 身份 + 显示 label + 文本。数量无上限（不硬编码 4）。 */
export const ResponseOption = z.object({
  option_id: z.string().min(1),
  label: z.string().min(1),
  text: z.string(),
});
export type ResponseOptionT = z.infer<typeof ResponseOption>;

/** 匹配题左侧条目 / 排序条目共用形状（item_id 稳定身份）。 */
export const ResponseItem = z.object({
  item_id: z.string().min(1),
  label: z.string().min(1),
  text: z.string(),
});
export type ResponseItemT = z.infer<typeof ResponseItem>;

/** 槽位在题面中的显示定位（行列/标签）；仅呈现用途，不参与身份与计分。 */
export const SlotPlacement = z.object({
  row: z.number().int().min(0).optional(),
  col: z.number().int().min(0).optional(),
  label: z.string().optional(),
});
export type SlotPlacementT = z.infer<typeof SlotPlacement>;

const SlotId = z.string().min(1);
const PartId = z.string().min(1);

// ---------- 槽位原语（discriminated on `kind`） ----------

// 每个槽位显式声明所属 part —— issuance 选择 part 子集时，
// 投影只包含该范围内的槽位；不得从数组顺序或题面文本推断归属。
const slotBase = {
  slot_id: SlotId,
  /** 所属题目部分（part_id 引用 structure.parts；validateResponseSpec 校验解析）。 */
  part_id: PartId,
  placement: SlotPlacement.optional(),
} as const;

/** 单选：stable option id 集合语义；数量 ≥2，无上限。 */
export const SingleChoiceSlot = z.object({
  ...slotBase,
  kind: z.literal('single_choice'),
  options: z.array(ResponseOption).min(2),
});

/** 多选：显式 min/max 约束（≤ options.length）。 */
export const MultiChoiceSlot = z.object({
  ...slotBase,
  kind: z.literal('multi_choice'),
  options: z.array(ResponseOption).min(2),
  min_select: z.number().int().min(1),
  max_select: z.number().int().min(1),
});

/** 文本作答；math_preview 声明是否提供数学预览（原文保留，§7.2）。 */
export const TextSlot = z.object({
  ...slotBase,
  kind: z.literal('text'),
  max_chars: z.number().int().min(1).optional(),
  math_preview: z.boolean().default(false),
});

/** 数值作答；unit_hint/precision 仅输入辅助，判分依据在 scoring unit。 */
export const NumericSlot = z.object({
  ...slotBase,
  kind: z.literal('numeric'),
  unit_hint: z.string().optional(),
  precision: z.number().int().min(0).optional(),
});

/** 公式作答（LaTeX）。结构化解释为派生证据，不悄悄重写原答案（§7.2）。 */
export const FormulaSlot = z.object({
  ...slotBase,
  kind: z.literal('formula'),
  notation: z.enum(['latex']),
});

/**
 * 表格/多空：布局容器。单元格是【子槽位引用】—— cells[].slot_id 指向
 * 本 ResponseSpec 中的其它原语槽位（text/numeric/single_choice/...）；
 * 混合响应与整题计分不互相强制一对一（§7.2）。
 */
export const TableSlot = z.object({
  ...slotBase,
  kind: z.literal('table'),
  column_headers: z.array(z.string()).min(1),
  row_labels: z.array(z.string()).min(1),
  cells: z
    .array(
      z.object({
        row: z.number().int().min(0),
        col: z.number().int().min(0),
        slot_id: SlotId,
      }),
    )
    .min(1),
});

/**
 * 配对（ADR-0074 D3a：左右两列配对，点选作答、确定性判）：作答提交
 * {kind:'matching', pairs:[{item_id, option_id}]} —— item_id 是左列稳定 id、
 * option_id 是右列稳定 id（不认文字/位置；历史已发行的 revision 与已存
 * submission 即此形状，不做任何 id 改名或语义改写）。
 */
export const MatchingSlot = z.object({
  ...slotBase,
  kind: z.literal('matching'),
  left_items: z.array(ResponseItem).min(2),
  right_options: z.array(ResponseOption).min(2),
  allow_left_unmatched: z.boolean().default(false),
  /**
   * ADR-0074 D3a 配对基数逐题声明。【缺省 = 历史宽松行为】（右选项可被
   * 多个左项配对、不强制一对一）—— 存量 revision/submission 的结构校验
   * 语义逐字不变，不猜历史题的基数。one_to_one：同一右选项被多个左项
   * 配对是结构违背（duplicate_pair_option）；many_to_one：显式允许复用。
   */
  pairing: z.enum(['one_to_one', 'many_to_one']).optional(),
  /** 右列含干扰项（存在不与任何左项配对的右选项；UI 允许右列留空）。不含键信息。 */
  has_distractors: z.boolean().optional(),
});

/** 排序：完整顺序提交；键盘上下移动/序号编辑足够（§7.2）。 */
export const OrderingSlot = z.object({
  ...slotBase,
  kind: z.literal('ordering'),
  items: z.array(ResponseItem).min(2),
});

/**
 * 开放作答：文字 + D10 原始证据附件（audio/video/PDF/plaintext 与 image 并列）。
 * accepted_evidence 为空 = 纯文字开放作答；证据规则由发布侧声明。
 */
export const OpenResponseSlot = z.object({
  ...slotBase,
  kind: z.literal('open_response'),
  accepted_evidence: z.array(EvidenceAcceptanceRule).default([]),
  evidence_required: z.boolean().default(false),
  max_chars: z.number().int().min(1).optional(),
});

/**
 * 断句（ADR-0074 D3a）：对冻结明文的字间点选。text 是【冻结原文】——
 * 客户端必须逐字渲染同一字符串并按其 code point 计数（见 position-gap.ts
 * 的索引语义）；不做 HTML/空白/折行归一化。不在此声明处数或上限：题目
 * 要求只在题面文字里，接受的断点集合与题级规则是私有判据
 * （position_set_key，scoring.ts）。
 */
export const SentenceBreaksSlot = z.object({
  ...slotBase,
  kind: z.literal('sentence_breaks'),
  /** 冻结明文（有效断句位置要求 ≥2 个 code point；validateResponseSet 校验）。 */
  text: z.string().min(1),
});

// ---------- K1 统一作答（YUK-1496）：select / blank；free 沿用 open_response ----------
//
// 新题只用三类作答：select（从公开 universe 中选稳定 item）、blank（一个
// 单空文本）、free（open_response：文字 + 原始证据）。旧题型槽位只读保留，
// 供已冻结 revision 回读与重放。

/**
 * select universe 的一个 item。item_id 是唯一身份；含义由题目定义：
 *   - 选项：只有 label_md；
 *   - 关系（配对/排序）：coordinates 指向 axes 中各维度的稳定 id；
 *   - 断句字缝：gap_after_codepoint 指向 slot.text 的内部字缝（position-gap.ts）。
 * grader 只比 item_id 集合，不解析 id、标签或坐标。改含义 = 新 item_id。
 */
export const SelectItem = z.object({
  item_id: z.string().min(1),
  label_md: z.string().optional(),
  coordinates: z.record(z.string(), z.string().min(1)).optional(),
  gap_after_codepoint: z.number().int().min(1).optional(),
});
export type SelectItemT = z.infer<typeof SelectItem>;

export const SelectAxisEntry = z.object({
  id: z.string().min(1),
  label_md: z.string(),
});
export type SelectAxisEntryT = z.infer<typeof SelectAxisEntry>;

/**
 * select：一个模型覆盖单选、多选、判断、配对、断句、排序。
 * 输入层只拒绝结构违背（未知/重复 item、违反 at_most_per_coordinate）；
 * 选多、选错、超出印刷数量都是有效作答，交给给分规则（如「超过 3 处 0 分」）。
 */
export const SelectSlot = z.object({
  ...slotBase,
  kind: z.literal('select'),
  items: z.array(SelectItem).min(1),
  /** 关系维度（配对 left/right、排序 position/object）；item.coordinates 引用这里的 id。 */
  axes: z.record(z.string(), z.array(SelectAxisEntry).min(1)).optional(),
  /** 每个维度值最多出现几次（一对一配对：{left:1,right:1}）。是输入语义，不是给分规则。 */
  at_most_per_coordinate: z.record(z.string(), z.number().int().min(1)).optional(),
  /** 断句的冻结明文；gap item 的字缝按它的 code point 计（同 sentence_breaks）。 */
  text: z.string().min(1).optional(),
  /** 渲染提示（单选用 one）；从不校验作答数量。 */
  pick: z.enum(['one', 'many']).default('many'),
});
export type SelectSlotT = z.infer<typeof SelectSlot>;

/**
 * select item 的可读描述（参考答案展示/导出用；不参与判分）：
 * 有 label_md 用 label；关系用各维度显示文字以「→」相连；字缝给出前后字。
 */
export function describeSelectItem(slot: SelectSlotT, itemId: string): string {
  const item = slot.items.find((candidate) => candidate.item_id === itemId);
  if (item == null) return itemId;
  if (item.label_md) return item.label_md;
  if (item.coordinates != null) {
    return Object.entries(item.coordinates)
      .map(
        ([axis, value]) =>
          slot.axes?.[axis]?.find((entry) => entry.id === value)?.label_md ?? value,
      )
      .join(' → ');
  }
  if (item.gap_after_codepoint != null && slot.text != null) {
    const chars = [...slot.text];
    const at = item.gap_after_codepoint;
    return `${chars.slice(Math.max(0, at - 2), at).join('')}｜${chars.slice(at, at + 2).join('')}`;
  }
  return itemId;
}

/** blank：一个 unit 收一个字符串；多空拆多个 blank。数值/表达式/诗句都是 blank。
 * answer_shape（YUK-1568，可选）声明这一空回答的数学对象（公开输入语义，
 * 不携带答案）；缺省 = 未声明，旧题原文本 exact 语义不变。未知版本/字段在
 * 本 schema 上 parse 失败 —— 读者必须显式拒绝，不能 strip 后当未声明。 */
export const BlankSlot = z.object({
  ...slotBase,
  kind: z.literal('blank'),
  format: z.enum(['text', 'math']).default('text'),
  unit_hint: z.string().optional(),
  max_chars: z.number().int().min(1).optional(),
  answer_shape: BlankAnswerShape.optional(),
});
export type BlankSlotT = z.infer<typeof BlankSlot>;
export type { BlankAnswerShapeT };

export const ResponseSlot = z.discriminatedUnion('kind', [
  SingleChoiceSlot,
  MultiChoiceSlot,
  TextSlot,
  NumericSlot,
  FormulaSlot,
  TableSlot,
  MatchingSlot,
  OrderingSlot,
  OpenResponseSlot,
  SentenceBreaksSlot,
  SelectSlot,
  BlankSlot,
]);
export type ResponseSlotT = z.infer<typeof ResponseSlot>;

/** 作答要求：slots ≥1，slot_id 唯一（validateResponseSpec 校验）。 */
export const ResponseSpec = z.object({
  slots: z.array(ResponseSlot).min(1),
});
export type ResponseSpecT = z.infer<typeof ResponseSpec>;

// ---------- 学习者作答（ResponseSet） ----------
//
// 条目数组（非 record）：【缺条目】本身就是 missing 的表达；显式空值
// （空 option_ids / 空 text / null value）是主动空白（blank）。二者在
// pending/计零语义上严格区分（§4.4：只有完整提交且评分政策明确时空白可计 0）。

// YUK-1052 / Q-922 — 答题置信度自评 self_confidence（1-5 整数，observe-only）。
// 学生作答当时对本次作答的主观把握；mirror ReviewOnQuestion.self_confidence
// （YUK-444）语义：仅随 ResponseSet 条目持久化供后续分析，绝不进判分/θ̂/FSRS ——
// 命名刻意用 self_confidence 而非 confidence（后者是 judge 置信度）。
// OPTIONAL（engagement 红线零强制）：缺省 = 未采集，历史行解析逐字不变
// （byte-identical 读路径，同 YUK-444）。UI 采集面（PfPaper 每题）属
// YUK-1051 lane；本侧只有契约+存储位+提交/草稿接收。
export const SelfConfidence = z.number().int().min(1).max(5).optional();
export type SelfConfidenceT = z.infer<typeof SelfConfidence>;

export const ChoiceResponse = z.object({
  slot_id: SlotId,
  kind: z.literal('choice'),
  /** 空数组 = 主动空白（非 missing）。 */
  option_ids: z.array(z.string().min(1)).default([]),
  self_confidence: SelfConfidence,
});

export const TextResponse = z.object({
  slot_id: SlotId,
  kind: z.literal('text'),
  /** '' = 主动空白。 */
  text_md: z.string(),
  self_confidence: SelfConfidence,
});

export const NumericResponse = z.object({
  slot_id: SlotId,
  kind: z.literal('numeric'),
  /** null = 未解析出数值。是否算【主动空白】取决于 raw_input：见 isBlankSlotResponse。 */
  value: z.number().nullable(),
  /** 学习者原始输入；非空且 value=null ⇒ 未解析（不可当空白计零）。 */
  raw_input: z.string().optional(),
  self_confidence: SelfConfidence,
});

export const FormulaResponse = z.object({
  slot_id: SlotId,
  kind: z.literal('formula'),
  /** '' = 主动空白。 */
  latex: z.string(),
  self_confidence: SelfConfidence,
});

export const MatchingResponse = z.object({
  slot_id: SlotId,
  kind: z.literal('matching'),
  /** 空 = 主动空白；allow_left_unmatched 时允许部分对。 */
  pairs: z
    .array(
      z.object({
        item_id: z.string().min(1),
        option_id: z.string().min(1),
      }),
    )
    .default([]),
  self_confidence: SelfConfidence,
});

export const OrderingResponse = z.object({
  slot_id: SlotId,
  kind: z.literal('ordering'),
  /** 空 = 主动空白；否则应为 items 的排列（validateResponseSet 校验）。 */
  item_order: z.array(z.string().min(1)).default([]),
  self_confidence: SelfConfidence,
});

export const OpenResponse = z.object({
  slot_id: SlotId,
  kind: z.literal('open'),
  text_md: z.string().default(''),
  evidence: z.array(EvidenceAttachment).default([]),
  self_confidence: SelfConfidence,
});

/** 断句作答：positions = 冻结明文的 code point 内部字缝索引（1..L-1；空 = 主动空白）。 */
export const SentenceBreaksResponse = z.object({
  slot_id: SlotId,
  kind: z.literal('sentence_breaks'),
  positions: z.array(z.number().int().min(0)).default([]),
  self_confidence: SelfConfidence,
});

/**
 * K1 作答状态：answered 有内容；blank 主动交白（内容必须为空）；unknown 是
 * 字迹/圈选辨认不清（capture 如实上报，内容不作判分依据）。缺条目才是 missing。
 */
export const ResponseState = z.enum(['answered', 'blank', 'unknown']);
export type ResponseStateT = z.infer<typeof ResponseState>;

export const SelectResponse = z.object({
  slot_id: SlotId,
  kind: z.literal('select'),
  state: ResponseState,
  item_ids: z.array(z.string().min(1)).default([]),
  self_confidence: SelfConfidence,
});

export const BlankResponse = z.object({
  slot_id: SlotId,
  kind: z.literal('blank'),
  state: ResponseState,
  text: z.string().default(''),
  self_confidence: SelfConfidence,
});

export const SlotResponse = z.discriminatedUnion('kind', [
  ChoiceResponse,
  TextResponse,
  NumericResponse,
  FormulaResponse,
  MatchingResponse,
  OrderingResponse,
  OpenResponse,
  SentenceBreaksResponse,
  SelectResponse,
  BlankResponse,
]);
export type SlotResponseT = z.infer<typeof SlotResponse>;

export const ResponseSet = z.object({
  entries: z.array(SlotResponse).default([]),
});
export type ResponseSetT = z.infer<typeof ResponseSet>;

// ---------- 确定性原语（无 IO） ----------

export interface ResponseSpecIssue {
  code:
    | 'duplicate_slot_id'
    | 'duplicate_option_id'
    | 'duplicate_item_id'
    | 'invalid_select_bounds'
    | 'unresolved_cell_slot'
    | 'cell_part_scope_violation'
    | 'cell_references_table'
    | 'duplicate_cell_coord'
    | 'table_bounds'
    | 'unresolved_part_ref'
    | 'select_coordinate_invalid'
    | 'select_duplicate_relation'
    | 'select_gap_invalid'
    | 'select_item_shape_mixed'
    | 'select_at_most_unknown_axis'
    | 'blank_order_unresolved_slot'
    | 'blank_order_non_blank_slot'
    | 'blank_order_cross_part'
    | 'blank_order_duplicate'
    | 'blank_order_coverage';
  detail: string;
}

/**
 * select 槽自洽（YUK-1496）：item 身份唯一；一个槽内 item 只有一种形态
 * （选项 / 关系 / 字缝）；关系坐标恰好覆盖全部 axes 且指向声明值、同一坐标
 * 组合不重复；字缝落在 text 的内部且不重复；at_most 只约束声明过的维度。
 */
function validateSelectSlot(slot: SelectSlotT): ResponseSpecIssue[] {
  const issues: ResponseSpecIssue[] = [];
  const itemIds = new Set<string>();
  for (const item of slot.items) {
    if (itemIds.has(item.item_id)) {
      issues.push({
        code: 'duplicate_item_id',
        detail: `slot '${slot.slot_id}' repeats item_id '${item.item_id}'`,
      });
    }
    itemIds.add(item.item_id);
  }
  const relational = slot.items.filter((item) => item.coordinates != null).length;
  const gaps = slot.items.filter((item) => item.gap_after_codepoint != null).length;
  const shapes = [relational, gaps].filter((count) => count > 0);
  if (
    shapes.length > 1 ||
    (relational > 0 && relational !== slot.items.length) ||
    (gaps > 0 && gaps !== slot.items.length)
  ) {
    issues.push({
      code: 'select_item_shape_mixed',
      detail: `slot '${slot.slot_id}' mixes option, relation and gap items`,
    });
  }
  const axes = slot.axes ?? {};
  const axisNames = Object.keys(axes);
  for (const axis of axisNames) {
    const ids = (axes[axis] ?? []).map((entry) => entry.id);
    if (new Set(ids).size !== ids.length) {
      issues.push({
        code: 'select_coordinate_invalid',
        detail: `slot '${slot.slot_id}' axis '${axis}' repeats an entry id`,
      });
    }
  }
  if (relational > 0) {
    const seenTuples = new Set<string>();
    for (const item of slot.items) {
      const coordinates = item.coordinates ?? {};
      const names = Object.keys(coordinates);
      const valid =
        names.length === axisNames.length &&
        axisNames.every((axis) =>
          (axes[axis] ?? []).some((entry) => entry.id === coordinates[axis]),
        );
      if (!valid) {
        issues.push({
          code: 'select_coordinate_invalid',
          detail: `slot '${slot.slot_id}' item '${item.item_id}' coordinates must name exactly the declared axes with declared values`,
        });
        continue;
      }
      const tuple = axisNames.map((axis) => `${axis}=${coordinates[axis]}`).join('|');
      if (seenTuples.has(tuple)) {
        issues.push({
          code: 'select_duplicate_relation',
          detail: `slot '${slot.slot_id}' declares relation ${tuple} under more than one item_id`,
        });
      }
      seenTuples.add(tuple);
    }
  }
  if (gaps > 0) {
    const seenGaps = new Set<number>();
    for (const item of slot.items) {
      const gap = item.gap_after_codepoint;
      if (gap == null) continue;
      if (slot.text == null || !isInteriorGap(slot.text, gap) || seenGaps.has(gap)) {
        issues.push({
          code: 'select_gap_invalid',
          detail: `slot '${slot.slot_id}' item '${item.item_id}' gap ${gap} is not a unique interior gap of the frozen text`,
        });
      }
      seenGaps.add(gap);
    }
  }
  for (const axis of Object.keys(slot.at_most_per_coordinate ?? {})) {
    if (!axisNames.includes(axis)) {
      issues.push({
        code: 'select_at_most_unknown_axis',
        detail: `slot '${slot.slot_id}' at_most_per_coordinate names undeclared axis '${axis}'`,
      });
    }
  }
  return issues;
}

/**
 * 纯校验：ResponseSpec 自身一致性（身份唯一、引用可解析、约束自洽）。
 * 传入 structure 时同时校验 slot.part_id 可解析（part 作用域）。
 */
export function validateResponseSpec(
  spec: ResponseSpecT,
  structure?: QuestionGroupStructureT,
): ResponseSpecIssue[] {
  const issues: ResponseSpecIssue[] = [];
  const slotIds = new Set<string>();
  const choiceOptionIds = new Map<string, Set<string>>();
  const tableIds = new Set<string>();

  for (const slot of spec.slots) {
    if (slotIds.has(slot.slot_id)) {
      issues.push({
        code: 'duplicate_slot_id',
        detail: `slot_id '${slot.slot_id}' appears more than once`,
      });
    }
    slotIds.add(slot.slot_id);

    if (slot.kind === 'single_choice' || slot.kind === 'multi_choice') {
      const optionIds = new Set<string>();
      for (const option of slot.options) {
        if (optionIds.has(option.option_id)) {
          issues.push({
            code: 'duplicate_option_id',
            detail: `slot '${slot.slot_id}' repeats option_id '${option.option_id}'`,
          });
        }
        optionIds.add(option.option_id);
      }
      choiceOptionIds.set(slot.slot_id, optionIds);
      if (slot.kind === 'multi_choice' && slot.max_select > slot.options.length) {
        issues.push({
          code: 'invalid_select_bounds',
          detail: `slot '${slot.slot_id}' max_select exceeds option count`,
        });
      }
      if (slot.kind === 'multi_choice' && slot.min_select > slot.max_select) {
        issues.push({
          code: 'invalid_select_bounds',
          detail: `slot '${slot.slot_id}' min_select exceeds max_select`,
        });
      }
    }
    if (slot.kind === 'matching' || slot.kind === 'ordering') {
      const items = slot.kind === 'matching' ? slot.left_items : slot.items;
      const itemIds = new Set<string>();
      for (const item of items) {
        if (itemIds.has(item.item_id)) {
          issues.push({
            code: 'duplicate_item_id',
            detail: `slot '${slot.slot_id}' repeats item_id '${item.item_id}'`,
          });
        }
        itemIds.add(item.item_id);
      }
      if (slot.kind === 'matching') {
        // 右选项 option_id 重复也必须拦截（与 choice 同纪律）。
        const rightOptionIds = new Set<string>();
        for (const option of slot.right_options) {
          if (rightOptionIds.has(option.option_id)) {
            issues.push({
              code: 'duplicate_option_id',
              detail: `slot '${slot.slot_id}' repeats right option_id '${option.option_id}'`,
            });
          }
          rightOptionIds.add(option.option_id);
        }
        choiceOptionIds.set(slot.slot_id, rightOptionIds);
        for (const option of slot.right_options) {
          if (itemIds.has(option.option_id)) {
            issues.push({
              code: 'duplicate_item_id',
              detail: `slot '${slot.slot_id}' right option_id '${option.option_id}' collides with a left item_id`,
            });
          }
        }
      }
    }
    if (slot.kind === 'select') {
      issues.push(...validateSelectSlot(slot));
    }
    if (structure != null) {
      const partIds = new Set(structure.parts.map((part) => part.part_id));
      if (!partIds.has(slot.part_id)) {
        issues.push({
          code: 'unresolved_part_ref',
          detail: `slot '${slot.slot_id}' references unknown part '${slot.part_id}'`,
        });
      }
    }
    if (slot.kind === 'table') {
      tableIds.add(slot.slot_id);
    }
  }

  // 第二遍：表格单元格引用（需要完整 slot 集合）。
  // 单元格与表格必须同 part（scope closure）—— 否则 part 子集发题会
  // 产生悬空表格；跨 part 表格如未来需要，须另立显式依赖契约，不在此默许。
  const partBySlotId = new Map(spec.slots.map((slot) => [slot.slot_id, slot.part_id] as const));
  for (const slot of spec.slots) {
    if (slot.kind !== 'table') continue;
    const coords = new Set<string>();
    for (const cell of slot.cells) {
      if (!slotIds.has(cell.slot_id)) {
        issues.push({
          code: 'unresolved_cell_slot',
          detail: `table '${slot.slot_id}' cell (${cell.row},${cell.col}) references unknown slot '${cell.slot_id}'`,
        });
        continue;
      }
      if (partBySlotId.get(cell.slot_id) !== slot.part_id) {
        issues.push({
          code: 'cell_part_scope_violation',
          detail: `table '${slot.slot_id}' (part '${slot.part_id}') cell references slot '${cell.slot_id}' of another part '${partBySlotId.get(cell.slot_id) ?? '?'}' — cells must share the table's part`,
        });
        continue;
      }
      if (tableIds.has(cell.slot_id)) {
        issues.push({
          code: 'cell_references_table',
          detail: `table '${slot.slot_id}' cell references another table slot '${cell.slot_id}'`,
        });
        continue;
      }
      const coord = `${cell.row},${cell.col}`;
      if (coords.has(coord)) {
        issues.push({
          code: 'duplicate_cell_coord',
          detail: `table '${slot.slot_id}' has two cells at (${coord})`,
        });
      }
      coords.add(coord);
      if (cell.row >= slot.row_labels.length || cell.col >= slot.column_headers.length) {
        issues.push({
          code: 'table_bounds',
          detail: `table '${slot.slot_id}' cell (${coord}) outside declared grid`,
        });
      }
    }
  }

  // 第三遍（YUK-1568）：part.blank_order 与 response 交叉校验 —— 声明的
  // 默认逻辑序必须恰覆盖本 part 的 blank 槽各一次，不跨 part、不重复、不缺项、
  // 不指向非 blank 槽。缺项/重复不回退数组序，直接拒绝（发布 barrier / serve
  // 前置校验都会走到这里；无声明的旧 part 不受影响）。
  if (structure != null) {
    const blankSlotIdsByPart = new Map<string, string[]>();
    for (const slot of spec.slots) {
      if (slot.kind !== 'blank') continue;
      const list = blankSlotIdsByPart.get(slot.part_id) ?? [];
      list.push(slot.slot_id);
      blankSlotIdsByPart.set(slot.part_id, list);
    }
    const slotById = new Map(spec.slots.map((slot) => [slot.slot_id, slot] as const));
    for (const part of structure.parts) {
      if (part.blank_order == null) continue;
      const seen = new Set<string>();
      for (const slotId of part.blank_order) {
        if (seen.has(slotId)) {
          issues.push({
            code: 'blank_order_duplicate',
            detail: `part '${part.part_id}' blank_order lists slot '${slotId}' more than once`,
          });
          continue;
        }
        seen.add(slotId);
        const slot = slotById.get(slotId);
        if (slot == null) {
          issues.push({
            code: 'blank_order_unresolved_slot',
            detail: `part '${part.part_id}' blank_order references unknown slot '${slotId}'`,
          });
          continue;
        }
        if (slot.kind !== 'blank') {
          issues.push({
            code: 'blank_order_non_blank_slot',
            detail: `part '${part.part_id}' blank_order references slot '${slotId}' of kind '${slot.kind}' — only blank slots carry the default logical order`,
          });
          continue;
        }
        if (slot.part_id !== part.part_id) {
          issues.push({
            code: 'blank_order_cross_part',
            detail: `part '${part.part_id}' blank_order references slot '${slotId}' of another part '${slot.part_id}'`,
          });
        }
      }
      const partBlanks = blankSlotIdsByPart.get(part.part_id) ?? [];
      const missing = partBlanks.filter((id) => !seen.has(id));
      if (missing.length > 0) {
        issues.push({
          code: 'blank_order_coverage',
          detail: `part '${part.part_id}' declares blank_order but does not cover its blank slot(s): ${missing.join(', ')}`,
        });
      }
    }
  }
  return issues;
}

/**
 * spec 中存在、但 ResponseSet 中【没有条目】的【可作答】槽位 = missing（非空白）。
 * 表格是布局容器：不直接作答，不参与完整性判定 —— 每格子槽各自计。
 */
export function missingSlotIds(spec: ResponseSpecT, responseSet: ResponseSetT): string[] {
  const answered = new Set(responseSet.entries.map((entry) => entry.slot_id));
  return spec.slots
    .filter((slot) => slot.kind !== 'table')
    .map((slot) => slot.slot_id)
    .filter((id) => !answered.has(id));
}

/**
 * 主动空白判定（显式空值；与 missing —— 缺条目 —— 严格区分）。
 * 数值槽：value=null 且 raw_input 为空才算空白；
 * value=null 但 raw_input 非空 = 【未解析】，不是空白 —— 不得进计零路径，
 * 应由执行器给出 unparseable_response 未决态。既不造数也不丢原文。
 */
export function isBlankSlotResponse(entry: SlotResponseT): boolean {
  switch (entry.kind) {
    case 'choice':
      return entry.option_ids.length === 0;
    case 'text':
      return entry.text_md.trim().length === 0;
    case 'numeric':
      return entry.value === null && (entry.raw_input ?? '').trim().length === 0;
    case 'formula':
      return entry.latex.trim().length === 0;
    case 'matching':
      return entry.pairs.length === 0;
    case 'ordering':
      return entry.item_order.length === 0;
    case 'sentence_breaks':
      return entry.positions.length === 0;
    case 'open':
      return entry.text_md.trim().length === 0 && entry.evidence.length === 0;
    case 'select':
    case 'blank':
      return entry.state === 'blank';
  }
}

export interface ResponseSetIssue {
  code:
    | 'duplicate_entry_slot'
    | 'unknown_slot'
    | 'kind_mismatch'
    | 'unknown_option_id'
    | 'unknown_item_id'
    | 'duplicate_pair_item'
    | 'ordering_not_permutation'
    | 'single_choice_multiple_selection'
    | 'duplicate_selected_option'
    | 'select_count_out_of_bounds'
    | 'duplicate_pair_option'
    | 'position_out_of_range'
    | 'duplicate_position'
    | 'response_state_inconsistent'
    | 'select_coordinate_overused';
  detail: string;
}

/** 纯校验：ResponseSet 对 ResponseSpec 的结构一致性（引用可解析、形状匹配）。 */
export function validateResponseSet(
  spec: ResponseSpecT,
  responseSet: ResponseSetT,
): ResponseSetIssue[] {
  const issues: ResponseSetIssue[] = [];
  const byId = new Map(spec.slots.map((slot) => [slot.slot_id, slot] as const));
  const seen = new Set<string>();

  for (const entry of responseSet.entries) {
    if (seen.has(entry.slot_id)) {
      issues.push({
        code: 'duplicate_entry_slot',
        detail: `multiple entries for slot '${entry.slot_id}'`,
      });
    }
    seen.add(entry.slot_id);

    const slot = byId.get(entry.slot_id);
    if (slot == null) {
      issues.push({
        code: 'unknown_slot',
        detail: `entry references unknown slot '${entry.slot_id}'`,
      });
      continue;
    }
    // 表格槽是布局容器，不直接作答 —— 单元格子槽各自有条目。
    const expectedKind: Record<string, string> = {
      single_choice: 'choice',
      multi_choice: 'choice',
      text: 'text',
      numeric: 'numeric',
      formula: 'formula',
      matching: 'matching',
      ordering: 'ordering',
      open_response: 'open',
      sentence_breaks: 'sentence_breaks',
      select: 'select',
      blank: 'blank',
    };
    if (slot.kind === 'table') {
      issues.push({
        code: 'kind_mismatch',
        detail: `slot '${entry.slot_id}' is a table (layout container); answer its cell slots individually`,
      });
      continue;
    }
    if (expectedKind[slot.kind] !== entry.kind) {
      issues.push({
        code: 'kind_mismatch',
        detail: `slot '${entry.slot_id}' expects '${expectedKind[slot.kind]}' response, got '${entry.kind}'`,
      });
      continue;
    }

    if (entry.kind === 'choice') {
      const optionIds =
        slot.kind === 'single_choice' || slot.kind === 'multi_choice'
          ? new Set(slot.options.map((option) => option.option_id))
          : slot.kind === 'matching'
            ? new Set(slot.right_options.map((option) => option.option_id))
            : new Set<string>();
      // YUK-1096：同一 option 被重复选择是结构违背 —— 不是
      // “多选了一个”的量变，重复本身就意味着上游提交面出 bug。
      const selected = new Set<string>();
      for (const optionId of entry.option_ids) {
        if (!optionIds.has(optionId)) {
          issues.push({
            code: 'unknown_option_id',
            detail: `slot '${entry.slot_id}' response references unknown option '${optionId}'`,
          });
        }
        if (selected.has(optionId)) {
          issues.push({
            code: 'duplicate_selected_option',
            detail: `slot '${entry.slot_id}' response selects option '${optionId}' more than once`,
          });
        }
        selected.add(optionId);
      }
      // 单选槽收到多个选择是结构性错误（空白 = 0 个；多选 = 换 multi 原语）。
      if (slot.kind === 'single_choice' && entry.option_ids.length > 1) {
        issues.push({
          code: 'single_choice_multiple_selection',
          detail: `slot '${entry.slot_id}' is single_choice but received ${entry.option_ids.length} selections`,
        });
      }
      // YUK-1096：multi_choice 的非空选择必须落在声明的
      // [min_select, max_select] 内 —— 少于 min / 超出 max 是违例。
      // 空数组 = 主动空白（§7.2），不是“选了 0 个”，不走 count 校验；
      // 空白是否计零由 basis.blank_scores_zero 另行裁决。
      if (
        slot.kind === 'multi_choice' &&
        entry.option_ids.length > 0 &&
        (entry.option_ids.length < slot.min_select || entry.option_ids.length > slot.max_select)
      ) {
        issues.push({
          code: 'select_count_out_of_bounds',
          detail: `slot '${entry.slot_id}' received ${entry.option_ids.length} selections, outside declared [${slot.min_select}, ${slot.max_select}]`,
        });
      }
    }
    if (entry.kind === 'matching' && slot.kind === 'matching') {
      const itemIds = new Set(slot.left_items.map((item) => item.item_id));
      const optionIds = new Set(slot.right_options.map((option) => option.option_id));
      const pairedItems = new Set<string>();
      for (const pair of entry.pairs) {
        if (!itemIds.has(pair.item_id)) {
          issues.push({
            code: 'unknown_item_id',
            detail: `slot '${entry.slot_id}' pair references unknown left item '${pair.item_id}'`,
          });
        }
        if (!optionIds.has(pair.option_id)) {
          issues.push({
            code: 'unknown_option_id',
            detail: `slot '${entry.slot_id}' pair references unknown right option '${pair.option_id}'`,
          });
        }
        if (pairedItems.has(pair.item_id)) {
          issues.push({
            code: 'duplicate_pair_item',
            detail: `slot '${entry.slot_id}' pairs left item '${pair.item_id}' twice`,
          });
        }
        pairedItems.add(pair.item_id);
      }
      // ADR-0074 D3a：声明 one_to_one 时，同一右选项被多个左项配对是
      // 结构违背（不是“多配了一个”的量变）。缺省/many_to_one 保持历史
      // 宽松行为 —— 存量 submission 不因此变非法。
      if (slot.pairing === 'one_to_one') {
        const pairedOptions = new Set<string>();
        for (const pair of entry.pairs) {
          if (pairedOptions.has(pair.option_id)) {
            issues.push({
              code: 'duplicate_pair_option',
              detail: `slot '${entry.slot_id}' is declared one_to_one but pairs right option '${pair.option_id}' more than once`,
            });
          }
          pairedOptions.add(pair.option_id);
        }
      }
    }
    if (entry.kind === 'sentence_breaks' && slot.kind === 'sentence_breaks') {
      // 位置语义见 position-gap.ts：内部字缝 1..L-1（code point 计），
      // 文首/文末/越界/重复都是结构性拒绝 —— 绝不静默截断或猜位。
      const seenPositions = new Set<number>();
      for (const position of entry.positions) {
        if (!isInteriorGap(slot.text, position)) {
          issues.push({
            code: 'position_out_of_range',
            detail: `slot '${entry.slot_id}' position ${position} is not an interior code-point gap of the frozen text (valid: 1..${codePointCount(slot.text) - 1})`,
          });
        }
        if (seenPositions.has(position)) {
          issues.push({
            code: 'duplicate_position',
            detail: `slot '${entry.slot_id}' marks break position ${position} more than once`,
          });
        }
        seenPositions.add(position);
      }
    }
    if (entry.kind === 'select' || entry.kind === 'blank') {
      // blank 状态必须内容为空；answered 必须有内容。unknown 的内容不作判分依据。
      const empty = entry.kind === 'select' ? entry.item_ids.length === 0 : entry.text === '';
      if ((entry.state === 'blank' && !empty) || (entry.state === 'answered' && empty)) {
        issues.push({
          code: 'response_state_inconsistent',
          detail: `slot '${entry.slot_id}' state '${entry.state}' contradicts its content`,
        });
      }
    }
    if (entry.kind === 'select' && slot.kind === 'select') {
      // 重复或 universe 外 id 是协议错误，不先去重再判（统一设计 §2）。
      const itemById = new Map(slot.items.map((item) => [item.item_id, item] as const));
      const picked = new Set<string>();
      for (const itemId of entry.item_ids) {
        if (!itemById.has(itemId)) {
          issues.push({
            code: 'unknown_item_id',
            detail: `slot '${entry.slot_id}' response references unknown item '${itemId}'`,
          });
        }
        if (picked.has(itemId)) {
          issues.push({
            code: 'duplicate_selected_option',
            detail: `slot '${entry.slot_id}' response selects item '${itemId}' more than once`,
          });
        }
        picked.add(itemId);
      }
      for (const [axis, limit] of Object.entries(slot.at_most_per_coordinate ?? {})) {
        const uses = new Map<string, number>();
        for (const itemId of picked) {
          const value = itemById.get(itemId)?.coordinates?.[axis];
          if (value != null) uses.set(value, (uses.get(value) ?? 0) + 1);
        }
        for (const [value, count] of uses) {
          if (count > limit) {
            issues.push({
              code: 'select_coordinate_overused',
              detail: `slot '${entry.slot_id}' uses ${axis}='${value}' ${count} times (at most ${limit})`,
            });
          }
        }
      }
    }
    if (entry.kind === 'ordering' && slot.kind === 'ordering') {
      const itemIds = new Set(slot.items.map((item) => item.item_id));
      const ordered = new Set(entry.item_order);
      for (const itemId of entry.item_order) {
        if (!itemIds.has(itemId)) {
          issues.push({
            code: 'unknown_item_id',
            detail: `slot '${entry.slot_id}' order references unknown item '${itemId}'`,
          });
        }
      }
      const isPermutation =
        ordered.size === entry.item_order.length &&
        entry.item_order.length === slot.items.length &&
        [...ordered].every((id) => itemIds.has(id));
      if (entry.item_order.length > 0 && !isPermutation) {
        issues.push({
          code: 'ordering_not_permutation',
          detail: `slot '${entry.slot_id}' item_order is not a permutation of the declared items`,
        });
      }
    }
  }
  return issues;
}

// ---------- 发出范围投影（YUK-1052：autosave/submission 校验口径） ----------

/**
 * 纯投影：完整 ResponseSpec → 只含发出 part 范围内槽位的 spec。
 * 用途：draft/submission 的结构校验只能在【本次 issuance 实际发出】的槽位集
 * 上进行 —— 发题绑定的 part 子集（issuance.part_ids）决定可作答面，不允许
 * 引用未发出槽位的作答/草稿被接受（学生从未见到它们）。
 *
 * 输出保持 slot 对象原样（不重建），仅过滤 part_id 范围；表格布局容器随其
 * part 同去 —— validateIssuanceBinding 已保证发出范围内的表格其单元格全部
 * 在范围内，所以这里投影不会制造悬空表格引用。
 */
export function scopeResponseSpec(spec: ResponseSpecT, partIds: readonly string[]): ResponseSpecT {
  const scope = new Set(partIds);
  return {
    slots: spec.slots.filter((slot) => scope.has(slot.part_id)),
  };
}

// ---------- blank_order 默认逻辑序投影（YUK-1568） ----------

/**
 * 把声明的 blank_order 投影成槽位默认顺序（纯函数；展示、公开 DTO 与缺省
 * presentation 共用）。做法是对每个声明了 blank_order 的 part，只在其 blank
 * 槽【自己占住的位置】内按声明序重排 —— 其余槽的相对顺序一律不动，未声明
 * 的 part 与旧 revision 完全 no-op（数组序原样返回）。
 *
 * 身份纪律：blank_order 只是默认逻辑序（服务默认展示与 DTO 规范顺序）；
 * 作答身份永远按 slot_id，绝不按序数。显式 K5 物理布局（presentation /
 * PDF region map）仍以 block/region → slot_id 绑定为准，placement 从属不变，
 * 不因本投影改写。
 */
export function slotsInDefaultOrder<T extends { slot_id: string; part_id: string; kind: string }>(
  slots: readonly T[],
  parts: readonly { part_id: string; blank_order?: readonly string[] }[],
): T[] {
  const orderByPart = new Map<string, readonly string[]>();
  for (const part of parts) {
    if (part.blank_order == null || part.blank_order.length === 0) continue;
    orderByPart.set(part.part_id, part.blank_order);
  }
  if (orderByPart.size === 0) return [...slots];
  const out = [...slots];
  for (const [partId, blankOrder] of orderByPart) {
    const positions: number[] = [];
    for (let index = 0; index < out.length; index += 1) {
      const slot = out[index];
      if (slot.part_id === partId && slot.kind === 'blank') positions.push(index);
    }
    if (positions.length === 0) continue;
    const rank = new Map(blankOrder.map((slotId, index) => [slotId, index] as const));
    const reordered = positions
      .map((position) => out[position])
      .sort(
        (a, b) =>
          (rank.get(a.slot_id) ?? Number.MAX_SAFE_INTEGER) -
          (rank.get(b.slot_id) ?? Number.MAX_SAFE_INTEGER),
      );
    positions.forEach((position, offset) => {
      out[position] = reordered[offset] as T;
    });
  }
  return out;
}
