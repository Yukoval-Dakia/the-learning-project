import { z } from 'zod';

// ====================================================================
// YUK-1568（第 1 片）— K1 blank 答案声明 answer_shape 的唯一定义
// ====================================================================
//
// answer_shape 是【公开输入语义】：一个 blank 槽回答“什么数学对象”。它不携带
// 正确端点、答案个数、正确系数或容差 —— 判分真相仍在私有 scoring key
// （blank_key 的 accepted 别名 / numeric key 的 expected+tolerance）。
//
// 单一权威：本文件是 answer_shape 的唯一 Zod 定义；草稿
// （question-draft.ts DraftBlankSpec）与冻结契约（response.ts BlankSlot）复用
// 同一份 schema，不再出现两套同名字段。比较器是第 2 片（blank-answer-compare，
// 仅 grade / admission 消费），本片只做声明、往返与保护。
//
// 纪律（设计 §2.2 / yuk1568-k1-answer-semantics-plan.md）：
//   - value 是封闭的判别联合，不是任意递归表达式语言；notation 只能在该
//     value kind 允许的输入语法里选，agent 不能提交正则或代码；
//   - strict 对象：未知字段直接 parse 失败，绝不 strip 后当有效声明 —— 旧读者
//     遇到不认识的新字段/版本必须显式拒绝（fail-loud），不能静默降级；
//   - version 目前只有 'k1-math-v1'；未来版本新读者未支持时同样 parse 失败；
//   - format=math、学科是数学、题面含公式都不构成声明 —— 只有本字段存在才算。

/** 当前支持的声明版本。 */
export const ANSWER_SHAPE_VERSION = 'k1-math-v1' as const;
export type AnswerShapeVersionT = typeof ANSWER_SHAPE_VERSION;

/** 该版本封闭的输入语法集合（设计 §2.2 notation；按 value kind 受限）。 */
export const ANSWER_SHAPE_NOTATIONS = [
  /** 有理分数 a/b（含整数）。 */
  'fraction',
  /** 有限十进制。 */
  'decimal',
  /** 区间记号 (a,b] / [a,b) / ∞ 端点。 */
  'interval',
  /** 绑定声明量的不等式（如 x≥5/2 且 x≤7）。 */
  'inequality',
  /** 集合描述 {x | P(x)}。 */
  'set_builder',
  /** 列举 {…}（finite_set 的列举连接词）。 */
  'roster',
  /** 有序坐标 tuple (a,b)。 */
  'tuple',
  /** 方程形式（affine_line 的 ax+by+c=0）。 */
  'equation',
] as const;
export type AnswerShapeNotationT = (typeof ANSWER_SHAPE_NOTATIONS)[number];

/**
 * number 的单位输入要求（可选）。unit 与私有 numeric key 的 expected_unit
 * 对齐（同名同义），不是第二答案权威；accepts_bare_number 声明裸数是否可按
 * 该默认单位解释 —— 只有显式允许时裸数才不判缺单位。
 */
const AnswerUnitRequirement = z
  .object({
    unit: z.string().min(1),
    accepts_bare_number: z.boolean(),
  })
  .strict();

/** 数值：整数/有限十进制/有理分数；无单位时的精确值走私有 numeric key。 */
const NumberAnswerShape = z
  .object({
    kind: z.literal('number'),
    unit: AnswerUnitRequirement.optional(),
  })
  .strict();

/** 区间/区间并集/绑定该量的不等式；binding 是被声明的变量或明确量表达式（x、k、M-m）。 */
const IntervalSetAnswerShape = z
  .object({
    kind: z.literal('interval_set'),
    binding: z.string().min(1),
  })
  .strict();

/** 一个点：有序坐标 tuple（axes 声明维数与有序坐标轴，如 [x,y]）；交换坐标不等价。 */
const PointAnswerShape = z
  .object({
    kind: z.literal('point'),
    axes: z.array(z.string().min(1)).min(1),
  })
  .strict();

/** 有理系数一次直线 ax+by+c=0（variables 声明有序变量，如 [x,y]）；仅非零整体比例等价。 */
const AffineLineAnswerShape = z
  .object({
    kind: z.literal('affine_line'),
    variables: z.array(z.string().min(1)).min(2),
  })
  .strict();

/**
 * 列全解集的有限集合：成员是 number / point / affine_line 之一；只在这一层
 * 忽略成员排列（order=unordered）；成员重复被禁止（duplicates=forbidden）。
 * item=point 时必须声明 axes（成员点的维数与坐标轴）。
 */
const FiniteSetAnswerShape = z
  .object({
    kind: z.literal('finite_set'),
    item: z.enum(['number', 'point', 'affine_line']),
    axes: z.array(z.string().min(1)).min(1).optional(),
    order: z.literal('unordered'),
    duplicates: z.literal('forbidden'),
  })
  .strict();

/** 封闭的 value 联合（设计 §2.2 表格；不是任意表达式语言）。 */
export const AnswerShapeValue = z.discriminatedUnion('kind', [
  NumberAnswerShape,
  IntervalSetAnswerShape,
  PointAnswerShape,
  AffineLineAnswerShape,
  FiniteSetAnswerShape,
]);
export type AnswerShapeValueT = z.infer<typeof AnswerShapeValue>;

export type AnswerShapeValueKindT = AnswerShapeValueT['kind'];

/** 各 value kind 允许的输入语法（notation 只能从中选，非空）。 */
export const NOTATIONS_BY_VALUE_KIND: Readonly<
  Record<AnswerShapeValueKindT, readonly AnswerShapeNotationT[]>
> = {
  number: ['fraction', 'decimal'],
  interval_set: ['interval', 'inequality', 'set_builder'],
  point: ['tuple'],
  affine_line: ['equation'],
  finite_set: ['roster', 'set_builder'],
};

/**
 * answer_shape 唯一定义：{version, value, notation}。strict + 逐 kind 校验：
 * notation 必须落在该 kind 允许的语法内；finite_set(point) 必须带 axes，
 * 其余 kind 带 axes 是声明错误（不能 strip 后当没写）。
 */
export const BlankAnswerShape = z
  .object({
    version: z.literal(ANSWER_SHAPE_VERSION),
    value: AnswerShapeValue,
    notation: z.array(z.enum(ANSWER_SHAPE_NOTATIONS)).min(1),
  })
  .strict()
  .superRefine((shape, ctx) => {
    const allowed = NOTATIONS_BY_VALUE_KIND[shape.value.kind];
    for (const notation of shape.notation) {
      if (!allowed.includes(notation)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `notation '${notation}' is not allowed for answer_shape value kind '${shape.value.kind}' (allowed: ${allowed.join(' | ')})`,
          path: ['notation'],
        });
      }
    }
    const hasAxes = shape.value.kind === 'finite_set' && shape.value.axes != null;
    if (shape.value.kind === 'finite_set' && shape.value.item === 'point' && !hasAxes) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "finite_set of points must declare 'axes' (member dimension and ordered coordinate axes)",
        path: ['value', 'axes'],
      });
    }
  });
export type BlankAnswerShapeT = z.infer<typeof BlankAnswerShape>;

// ---------- 声明探测（解析前宽松扫描；保护用） ----------
//
// 保护语义（设计 §2.1/§4）：只要槽位/结构里【存在】声明字段就算“已声明”，
// 无论本读者能否解析其版本或形状 —— 未支持/坏声明必须显式拒绝，不能 Zod
// strip 后当无声明继续旧解释。扫描因此只认字段存在性，不做 schema 判断。

export interface AnswerShapeDeclaration {
  slot_id: string;
  answer_shape: unknown;
}

/** 裸 response_spec JSON 中带 answer_shape 字段的 blank 槽（未解析对象也可探测）。 */
export function findAnswerShapeDeclarations(responseSpecRaw: unknown): AnswerShapeDeclaration[] {
  const slots = (responseSpecRaw as { slots?: unknown } | null | undefined)?.slots;
  if (!Array.isArray(slots)) return [];
  const out: AnswerShapeDeclaration[] = [];
  for (const slot of slots) {
    if (slot == null || typeof slot !== 'object') continue;
    const record = slot as Record<string, unknown>;
    if (record.kind !== 'blank') continue;
    if (record.answer_shape == null) continue;
    const slotId = typeof record.slot_id === 'string' ? record.slot_id : '(unknown slot_id)';
    out.push({ slot_id: slotId, answer_shape: record.answer_shape });
  }
  return out;
}

export interface BlankOrderDeclaration {
  part_id: string;
  blank_order: unknown;
}

/** 裸 structure JSON 中带非空 blank_order 字段的 part（未解析对象也可探测）。 */
export function findBlankOrderDeclarations(structureRaw: unknown): BlankOrderDeclaration[] {
  const parts = (structureRaw as { parts?: unknown } | null | undefined)?.parts;
  if (!Array.isArray(parts)) return [];
  const out: BlankOrderDeclaration[] = [];
  for (const part of parts) {
    if (part == null || typeof part !== 'object') continue;
    const record = part as Record<string, unknown>;
    if (record.blank_order == null) continue;
    const partId = typeof record.part_id === 'string' ? record.part_id : '(unknown part_id)';
    out.push({ part_id: partId, blank_order: record.blank_order });
  }
  return out;
}

/** 声明的可读描述（拒绝/扣留原因的 detail 用；对未知形状保持宽容，不抛错）。 */
export function describeAnswerShape(answerShapeRaw: unknown): string {
  if (answerShapeRaw == null || typeof answerShapeRaw !== 'object') {
    return 'unparsed answer_shape';
  }
  const record = answerShapeRaw as Record<string, unknown>;
  const version = typeof record.version === 'string' ? record.version : '?';
  const value = record.value as Record<string, unknown> | null | undefined;
  const kind =
    value != null && typeof value === 'object' && typeof value.kind === 'string' ? value.kind : '?';
  return `${version}/${kind}`;
}
