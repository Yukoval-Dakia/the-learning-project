import { z } from 'zod';

import { EvidenceAcceptanceRule, EvidenceAttachment } from './materials';
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

// P1-6（YUK-1046 复审）：每个槽位显式声明所属 part —— issuance 选择 part 子集时，
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

/** 配对：left items × right options；ID 对选择即可作答，不要求拖拽编辑器。 */
export const MatchingSlot = z.object({
  ...slotBase,
  kind: z.literal('matching'),
  left_items: z.array(ResponseItem).min(2),
  right_options: z.array(ResponseOption).min(2),
  allow_left_unmatched: z.boolean().default(false),
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

export const ChoiceResponse = z.object({
  slot_id: SlotId,
  kind: z.literal('choice'),
  /** 空数组 = 主动空白（非 missing）。 */
  option_ids: z.array(z.string().min(1)).default([]),
});

export const TextResponse = z.object({
  slot_id: SlotId,
  kind: z.literal('text'),
  /** '' = 主动空白。 */
  text_md: z.string(),
});

export const NumericResponse = z.object({
  slot_id: SlotId,
  kind: z.literal('numeric'),
  /** null = 未解析出数值。是否算【主动空白】取决于 raw_input：见 isBlankSlotResponse。 */
  value: z.number().nullable(),
  /** 学习者原始输入；非空且 value=null ⇒ 未解析（不可当空白计零，P1-4）。 */
  raw_input: z.string().optional(),
});

export const FormulaResponse = z.object({
  slot_id: SlotId,
  kind: z.literal('formula'),
  /** '' = 主动空白。 */
  latex: z.string(),
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
});

export const OrderingResponse = z.object({
  slot_id: SlotId,
  kind: z.literal('ordering'),
  /** 空 = 主动空白；否则应为 items 的排列（validateResponseSet 校验）。 */
  item_order: z.array(z.string().min(1)).default([]),
});

export const OpenResponse = z.object({
  slot_id: SlotId,
  kind: z.literal('open'),
  text_md: z.string().default(''),
  evidence: z.array(EvidenceAttachment).default([]),
});

export const SlotResponse = z.discriminatedUnion('kind', [
  ChoiceResponse,
  TextResponse,
  NumericResponse,
  FormulaResponse,
  MatchingResponse,
  OrderingResponse,
  OpenResponse,
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
    | 'unresolved_part_ref';
  detail: string;
}

/**
 * 纯校验：ResponseSpec 自身一致性（身份唯一、引用可解析、约束自洽）。
 * 传入 structure 时同时校验 slot.part_id 可解析（P1-6 part 作用域）。
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
        // P2：右选项 option_id 重复也必须拦截（与 choice 同纪律）。
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
  // P1-B：单元格与表格必须同 part（scope closure）—— 否则 part 子集发题会
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
  return issues;
}

/**
 * spec 中存在、但 ResponseSet 中【没有条目】的【可作答】槽位 = missing（非空白）。
 * 表格是布局容器（P1-5）：不直接作答，不参与完整性判定 —— 每格子槽各自计。
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
 * 数值槽（P1-4）：value=null 且 raw_input 为空才算空白；
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
    case 'open':
      return entry.text_md.trim().length === 0 && entry.evidence.length === 0;
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
    | 'single_choice_multiple_selection';
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
      for (const optionId of entry.option_ids) {
        if (!optionIds.has(optionId)) {
          issues.push({
            code: 'unknown_option_id',
            detail: `slot '${entry.slot_id}' response references unknown option '${optionId}'`,
          });
        }
      }
      // P2：单选槽收到多个选择是结构性错误（空白 = 0 个；多选 = 换 multi 原语）。
      if (slot.kind === 'single_choice' && entry.option_ids.length > 1) {
        issues.push({
          code: 'single_choice_multiple_selection',
          detail: `slot '${entry.slot_id}' is single_choice but received ${entry.option_ids.length} selections`,
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
