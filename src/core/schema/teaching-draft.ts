// Compact conversation draft expanded deterministically into the shared declaration.
// Author-supplied keys are evidence for admission, never official source answers.
import { z } from 'zod';
import { mulberry32 } from '../rng';
import type { ScoringRuleT } from './assessment/scoring-rule';
import { DRAFT_DOCUMENT_SCHEMA_VERSION, type QuestionDraftDocumentT } from './question-draft';

// ---------- 工具参数形状 ----------

const TEXT_MAX = 4_000;
const OPTION_MAX = 300;

export const TeachingChoiceOption = z.string().min(1).max(OPTION_MAX);

export const TeachingSingleChoice = z
  .object({
    form: z.literal('single_choice'),
    options: z.array(TeachingChoiceOption).min(2).max(8),
    answer_index: z.number().int().min(0),
  })
  .strict();

export const TeachingMultiChoice = z
  .object({
    form: z.literal('multi_choice'),
    options: z.array(TeachingChoiceOption).min(2).max(8),
    answer_indices: z.array(z.number().int().min(0)).min(1).max(8),
  })
  .strict();

export const TeachingBlank = z
  .object({
    /** 印刷答案；accepted 追加可接受等价写法（含 canonical）。 */
    answer: z.string().min(1).max(120),
    accepted: z.array(z.string().min(1).max(120)).max(6).optional(),
    /** 数值答案走 numeric 键；tolerance 缺省 = absolute 0（严格相等）。 */
    numeric: z
      .object({
        value: z.number().finite(),
        tolerance: z.number().min(0).optional(),
        unit: z.string().min(1).max(20).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type TeachingBlankT = z.infer<typeof TeachingBlank>;

export const TeachingBlankForm = z
  .object({
    form: z.literal('blank'),
    blanks: z.array(TeachingBlank).min(1).max(6),
  })
  .strict();

export const TeachingMatching = z
  .object({
    form: z.literal('matching'),
    /** 左列条目（题面里被配对的一方）。 */
    left: z.array(z.string().min(1).max(OPTION_MAX)).min(2).max(8),
    /** 右列条目（含干扰项）。 */
    right: z.array(z.string().min(1).max(OPTION_MAX)).min(2).max(8),
    /** 正确配对：[left 下标, right 下标]。 */
    pairs: z
      .array(z.tuple([z.number().int().min(0), z.number().int().min(0)]))
      .min(1)
      .max(16),
  })
  .strict();

export const TeachingOrdering = z
  .object({
    form: z.literal('ordering'),
    /** 正确顺序；转换时仅打乱显示轴，答案继续绑定原 id。 */
    objects_in_order: z.array(z.string().min(1).max(OPTION_MAX)).min(2).max(8),
  })
  .strict();

export const TeachingBreakTap = z
  .object({
    form: z.literal('break_tap'),
    /**
     * 正确断句结果：各段按序拼接即冻结明文。断点集合 = 相邻段之间的字缝；
     * 作答宇宙 = 明文中全部合法字缝（含非断点，学习者逐缝点选）。
     */
    segments: z.array(z.string().min(1).max(500)).min(2).max(20),
  })
  .strict();

export const TeachingFree = z
  .object({
    form: z.literal('free'),
    reference_md: z.string().min(1).max(TEXT_MAX),
    /** 判分要点（可选；给出时铸成 rubric criteria）。 */
    required_points: z.array(z.string().min(1).max(OPTION_MAX)).min(1).max(6).optional(),
  })
  .strict();

export const TeachingDraftResponse = z.discriminatedUnion('form', [
  TeachingSingleChoice,
  TeachingMultiChoice,
  TeachingBlankForm,
  TeachingMatching,
  TeachingOrdering,
  TeachingBreakTap,
  TeachingFree,
]);
export type TeachingDraftResponseT = z.infer<typeof TeachingDraftResponse>;

export const TeachingDraft = z
  .object({
    /** 题面（含空位标记；公式用 LaTeX）。 */
    stem_md: z.string().min(1).max(TEXT_MAX),
    response: TeachingDraftResponse,
    /** 解析/讲解（公开，落 part.explanation_md）。 */
    solution_md: z.string().min(1).max(TEXT_MAX).optional(),
  })
  .strict();
export type TeachingDraftT = z.infer<typeof TeachingDraft>;

// ---------- 铸造错误（调用方转成诚实失败，不静默改文档） ----------

export class TeachingDraftValidationError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'TeachingDraftValidationError';
  }
}

// ---------- 确定性展开 ----------

const FULL_CREDIT_SELECT_RULE = (points: number): ScoringRuleT => ({
  version: 1,
  cases: [{ when: { miss: { eq: 0 }, wrong: { eq: 0 } }, award: { points } }],
  otherwise: { points: 0 },
});

const FULL_CREDIT_BLANK_RULE = (points: number): ScoringRuleT => ({
  version: 1,
  cases: [{ when: { correct: { eq: 1 } }, award: { points } }],
  otherwise: { points: 0 },
});

type DraftUnit = QuestionDraftDocumentT['parts'][number]['units'][number];

function displayOrder<T extends { id: string; label_md: string }>(entries: readonly T[]): T[] {
  // Canonical labels keep both the seed and starting order independent of the key.
  // Rejecting identity would reveal positional information, especially for two items.
  const shuffled = [...entries].sort((a, b) =>
    a.label_md < b.label_md ? -1 : a.label_md > b.label_md ? 1 : 0,
  );
  let seed = 2166136261;
  for (const char of JSON.stringify(shuffled.map((entry) => entry.label_md))) {
    seed = Math.imul(seed ^ char.charCodeAt(0), 16777619) >>> 0;
  }
  const random = mulberry32(seed);
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    const swap = shuffled[i];
    shuffled[i] = shuffled[j];
    shuffled[j] = swap;
  }
  return shuffled;
}

function choiceUnits(
  options: readonly string[],
  multi: boolean,
  answerIndices: readonly number[],
): DraftUnit[] {
  const seen = new Set<number>();
  for (const index of answerIndices) {
    if (index < 0 || index >= options.length) {
      throw new TeachingDraftValidationError(
        `answer index ${index} outside 0..${options.length - 1}`,
      );
    }
    if (seen.has(index)) {
      throw new TeachingDraftValidationError(`duplicate answer index ${index}`);
    }
    seen.add(index);
  }
  const items = options.map((text, i) => ({ item_id: `i${i + 1}`, label_md: text }));
  return [
    {
      unit_id: 'u1',
      slot_id: 's1',
      response_class: 'select',
      response_spec: {
        kind: 'select',
        items,
        pick: multi ? 'many' : 'one',
      },
      points: 1,
      key: {
        kind: 'select',
        accepted_item_ids: answerIndices.map((i) => items[i].item_id),
      },
      method: { kind: 'set-compare' },
      rule: FULL_CREDIT_SELECT_RULE(1),
      material_refs: [],
      metadata: {},
    },
  ];
}

function blankUnits(blanks: readonly TeachingBlankT[]): DraftUnit[] {
  return blanks.map((blank, i) => {
    const accepted = [...new Set([blank.answer, ...(blank.accepted ?? [])])];
    return {
      unit_id: `u${i + 1}`,
      slot_id: `s${i + 1}`,
      response_class: 'blank',
      response_spec: {
        kind: 'blank',
        ...(blank.numeric != null ? { format: 'math' as const } : { format: 'text' as const }),
      },
      points: 1,
      key: {
        kind: 'blank',
        key:
          blank.numeric != null
            ? {
                kind: 'numeric' as const,
                value: blank.numeric.value,
                tolerance: { kind: 'absolute' as const, value: blank.numeric.tolerance ?? 0 },
                ...(blank.numeric.unit != null ? { unit: blank.numeric.unit } : {}),
              }
            : { kind: 'text' as const, accepted },
      },
      method: { kind: 'exact' },
      rule: FULL_CREDIT_BLANK_RULE(1),
      material_refs: [],
      metadata: {},
    };
  });
}

function matchingUnit(form: z.infer<typeof TeachingMatching>): DraftUnit {
  const { left, right, pairs } = form;
  const pairSet = new Set<string>();
  for (const [li, ri] of pairs) {
    if (li < 0 || li >= left.length || ri < 0 || ri >= right.length) {
      throw new TeachingDraftValidationError(
        `matching pair [${li},${ri}] outside declared columns`,
      );
    }
    const key = `${li}:${ri}`;
    if (pairSet.has(key))
      throw new TeachingDraftValidationError(`duplicate matching pair [${li},${ri}]`);
    pairSet.add(key);
  }
  const axes = {
    left: left.map((label_md, i) => ({ id: `l${i + 1}`, label_md })),
    right: right.map((label_md, i) => ({ id: `r${i + 1}`, label_md })),
  };
  // 作答宇宙 = 全部 left×right 关系项；correct pairs 即 key。
  const items = axes.left.flatMap((l) =>
    axes.right.map((r) => ({
      item_id: `i_${l.id}_${r.id}`,
      coordinates: { left: l.id, right: r.id },
    })),
  );
  return {
    unit_id: 'u1',
    slot_id: 's1',
    response_class: 'select',
    response_spec: {
      kind: 'select',
      items,
      axes: { ...axes, right: displayOrder(axes.right) },
      pick: 'many',
    },
    points: 1,
    key: {
      kind: 'select',
      accepted_item_ids: pairs.map(([li, ri]) => `i_l${li + 1}_r${ri + 1}`),
    },
    method: { kind: 'set-compare' },
    rule: FULL_CREDIT_SELECT_RULE(1),
    material_refs: [],
    metadata: {},
  };
}

function orderingUnit(form: z.infer<typeof TeachingOrdering>): DraftUnit {
  const objects = form.objects_in_order;
  if (new Set(objects).size !== objects.length) {
    throw new TeachingDraftValidationError('ordering objects must be distinct');
  }
  const positions = objects.map((_, i) => ({ id: `p${i + 1}`, label_md: `${i + 1}` }));
  const objectAxis = objects.map((label_md, i) => ({ id: `o${i + 1}`, label_md }));
  const items = positions.flatMap((p) =>
    objectAxis.map((o) => ({
      item_id: `i_${p.id}_${o.id}`,
      coordinates: { position: p.id, object: o.id },
    })),
  );
  return {
    unit_id: 'u1',
    slot_id: 's1',
    response_class: 'select',
    response_spec: {
      kind: 'select',
      items,
      axes: { position: positions, object: displayOrder(objectAxis) },
      at_most_per_coordinate: { position: 1, object: 1 },
      pick: 'many',
    },
    points: 1,
    key: {
      kind: 'select',
      // objects_in_order[i] 的正确位置是第 i+1 位。
      accepted_item_ids: objectAxis.map((o, i) => `i_p${i + 1}_${o.id}`),
    },
    method: { kind: 'set-compare' },
    rule: FULL_CREDIT_SELECT_RULE(1),
    material_refs: [],
    metadata: {},
  };
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** 与 presentation.ts:441 同语义的字素簇起点集合（含文末偏移）。 */
function graphemeStartOffsets(text: string): Set<number> {
  const offsets = new Set<number>();
  let codePoints = 0;
  for (const segment of graphemeSegmenter.segment(text)) {
    offsets.add(codePoints);
    codePoints += [...segment.segment].length;
  }
  offsets.add(codePoints);
  return offsets;
}

function breakTapUnit(form: z.infer<typeof TeachingBreakTap>): DraftUnit {
  const text = form.segments.join('');
  if (text.length === 0) {
    throw new TeachingDraftValidationError('break_tap segments join to an empty text');
  }
  const chars = [...text];
  const starts = graphemeStartOffsets(text);
  // 作答宇宙 = 全部内部合法字缝：排除起点、终点与换行紧邻后缝（与发布 barrier
  // 的 break_gap_not_grapheme_boundary / break_gap_after_newline 同律）。
  const candidates = [...starts]
    .filter((gap) => gap > 0 && gap < chars.length && chars[gap - 1] !== '\n')
    .sort((a, b) => a - b);
  const breakSet = new Set<number>();
  let offset = 0;
  for (let i = 0; i < form.segments.length - 1; i += 1) {
    offset += [...form.segments[i]].length;
    if (!starts.has(offset)) {
      throw new TeachingDraftValidationError(
        `break_tap segment boundary at codepoint ${offset} is not a grapheme boundary`,
      );
    }
    if (chars[offset - 1] === '\n') {
      throw new TeachingDraftValidationError(
        `break_tap segment boundary at codepoint ${offset} sits immediately after a newline`,
      );
    }
    breakSet.add(offset);
  }
  return {
    unit_id: 'u1',
    slot_id: 's1',
    response_class: 'select',
    response_spec: {
      kind: 'select',
      items: candidates.map((gap) => ({ item_id: `i_${gap}`, gap_after_codepoint: gap })),
      text,
      pick: 'many',
    },
    points: 1,
    key: {
      kind: 'select',
      accepted_item_ids: [...breakSet].sort((a, b) => a - b).map((gap) => `i_${gap}`),
    },
    method: { kind: 'set-compare' },
    rule: FULL_CREDIT_SELECT_RULE(1),
    material_refs: [],
    metadata: {},
  };
}

function freeUnit(form: z.infer<typeof TeachingFree>): DraftUnit {
  const points = form.required_points?.length ?? 1;
  return {
    unit_id: 'u1',
    slot_id: 's1',
    response_class: 'free',
    response_spec: { kind: 'free' },
    points,
    reference_md: form.reference_md,
    ...(form.required_points != null && form.required_points.length > 0
      ? {
          rubric: {
            criteria: form.required_points.map((statement_md, i) => ({
              criterion_id: `c${i + 1}`,
              statement_md,
              max: 1,
            })),
          },
        }
      : {}),
    method: { kind: 'ai-rubric' },
    material_refs: [],
    metadata: {},
  };
}

export interface TeachingDraftOrigin {
  /** 发起拟题的会话（服务端注入，绝不取自模型参数）。 */
  session_id?: string;
  /** 触发回合 / 事件 id（服务端注入）。 */
  turn_id?: string;
}

/**
 * TeachingDraft → 声明文档（局部 id；绑定/组 id/呈现层都交给提交缝）。
 * question_kind 写入 metadata.teaching_draft 供读面与准入留痕。
 */
export function teachingDraftToDocument(
  draft: TeachingDraftT,
  options: { knowledge_ids?: readonly string[]; origin?: TeachingDraftOrigin } = {},
): QuestionDraftDocumentT {
  const units = ((): DraftUnit[] => {
    switch (draft.response.form) {
      case 'single_choice':
        return choiceUnits(draft.response.options, false, [draft.response.answer_index]);
      case 'multi_choice':
        return choiceUnits(draft.response.options, true, draft.response.answer_indices);
      case 'blank':
        return blankUnits(draft.response.blanks);
      case 'matching':
        return [matchingUnit(draft.response)];
      case 'ordering':
        return [orderingUnit(draft.response)];
      case 'break_tap':
        return [breakTapUnit(draft.response)];
      case 'free':
        return [freeUnit(draft.response)];
    }
  })();
  return {
    schema_version: DRAFT_DOCUMENT_SCHEMA_VERSION,
    parts: [
      {
        part_id: 'p1',
        prompt_md: draft.stem_md,
        material_ids: [],
        units,
        ...(draft.response.form === 'blank' && units.length > 1
          ? { blank_order: units.map((u) => u.slot_id) }
          : {}),
        ...(draft.solution_md != null ? { explanation_md: draft.solution_md } : {}),
        metadata: {},
      },
    ],
    materials: [],
    knowledge_ids: [...(options.knowledge_ids ?? [])],
    metadata: {
      teaching_draft: {
        question_kind: draft.response.form,
        chat_origin: {
          ...(options.origin?.session_id != null ? { session_id: options.origin.session_id } : {}),
          ...(options.origin?.turn_id != null ? { turn_id: options.origin.turn_id } : {}),
        },
      },
    },
    // 'generated'：作者即来源；ref 绝不写（doc.source.ref 会被 dedup 当
    // HTTP 来源 URL claim，非 URL 值会污染一页一题认领域）。
    source: { kind: 'generated', note: 'teaching_draft' },
  };
}
