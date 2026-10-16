import { z } from 'zod';

// ====================================================================
// YUK-1497 — Generative UI · 题目展示契约 presentation（spec v1 §1）
// ====================================================================
//
// 真相源：docs/design/2026-10-16-presentation-spec-v1.md；
// 讨论 §8（tlp-status/unified-question-grading-design.md）。
//
// presentation 是题目 revision 上【冻结的公开展示层】：一棵声明式积木树。
// 纪律：
//   - 展示不参与判分。判分只读作答信封（response.ts），不读积木文案。
//   - 布局/内容积木不带任何自由文字 —— 文字只来自引用的 part（prompt_md）
//     与材料（content_md / 图资产）。展示层没有地方写进答案或细则。
//   - 每个输入积木恰好绑定一个作答位（unit_id + slot_id + response_class）；
//     自定义块可绑定多个，但每个作答位仍然只被一个积木绑定。
//   - 公开部分只有内容/材料 ref、设计 token 与输入绑定，无 key、rubric
//     或方法私有配置 —— presentation 只含引用，公开投影无需另做脱敏。
//
// 纯类型层（无 IO、无 DB）；发布时的绑定校验见 validatePresentation，
// 公开投影见 dto.ts 的 projectPracticeIssuance。
//
// 递归类型先手写、schema 后注解（z.lazy）—— 同 structured_question.ts 的
// 先例；积木 kind 白名单即 PresentationBlockT 的 discriminated union。

/** 当前 presentation schema 版本（spec §1）。 */
export const PRESENTATION_SCHEMA_VERSION = 1;

/** 受支持的 renderer 契约版本（spec §3 规则 6：白名单）。 */
export const SUPPORTED_RENDERER_CONTRACTS = ['blocks-v1'] as const;
export type RendererContractT = (typeof SUPPORTED_RENDERER_CONTRACTS)[number];

// ---------- 作答绑定（spec §1.2） ----------

/** 作答原语类别：select↔select 槽、blank↔blank 槽、free↔open_response 槽。 */
export const ResponseClass = z.enum(['select', 'blank', 'free']);
export type ResponseClassT = z.infer<typeof ResponseClass>;

/** 输入积木/自定义块对【一个】作答位的绑定（spec §1.2）。 */
export const PresentationBind = z.object({
  /** 计分单元（scoring_basis.units[].scoring_unit_id）；校验见规则 3。 */
  unit_id: z.string().min(1),
  /** 作答槽（response_spec.slots[].slot_id）；校验见规则 1/2。 */
  slot_id: z.string().min(1),
  response_class: ResponseClass,
});
export type PresentationBindT = z.infer<typeof PresentationBind>;

/**
 * PDF 投影的作答区高度预留（spec §1.2「print 提示」）；只给作答卷投影用，
 * 不影响网页渲染，也不参与判分。
 */
export const PresentationPrintHint = z.object({
  /** 作答区预留高度（毫米）；缺省由投影方按槽种类默认。 */
  height_mm: z.number().min(0).optional(),
});
export type PresentationPrintHintT = z.infer<typeof PresentationPrintHint>;

// ---------- 积木类型（spec §1.1–§1.3，按 kind 区分） ----------
//
// block_id 在一个 presentation 内唯一（spec §3 规则 6）。容器积木
// （stack / passage_layout）递归引用 PresentationBlockT。

/** 纵向排列。 */
export type StackBlockT = {
  block_id: string;
  kind: 'stack';
  gap?: 'sm' | 'md' | 'lg';
  children: PresentationBlockT[];
};

/** 文章常驻布局（文左题右 / 文上题下）；children 是问题区。 */
export type PassageLayoutBlockT = {
  block_id: string;
  kind: 'passage_layout';
  /** 文章材料（kind=passage 的 SharedMaterial）。 */
  material_ref: string;
  layout: 'passage_left_questions_right' | 'passage_top';
  passage_width?: 'balanced' | 'wide';
  children: PresentationBlockT[];
};

/** part_ref（渲染该 part 的 prompt_md）或 material_ref（渲染 content_md），二选一。 */
export type TextMathBlockT = {
  block_id: string;
  kind: 'text_math';
  part_ref?: string;
  material_ref?: string;
};

/** 渲染已核验的公开图资产（kind=figure 的 SharedMaterial）。 */
export type FigureBlockT = {
  block_id: string;
  kind: 'figure';
  material_ref: string;
};

/** 输入积木共通字段（spec §1.2）：恰好一个 bind + 可选 print 提示。 */
type InputBlockBase = {
  block_id: string;
  bind: PresentationBindT;
  print?: PresentationPrintHintT;
};

/**
 * 单选/多选/判断的选项列表。槽形态要求：select 槽，items 无 coordinates /
 * gap_after_codepoint（纯选项 universe）；pick 决定单选/多选外观。
 * marker 只影响显示 —— item_id 永远不由显示字母推出。
 */
export type OptionListBlockT = InputBlockBase & {
  kind: 'option_list';
  layout?: 'vertical' | 'grid' | 'inline';
  marker?: 'letter' | 'number' | 'none';
};

/** 左右两列配对。槽形态要求：axes 恰好 left/right，items 带 coordinates。 */
export type MatchingColumnsBlockT = InputBlockBase & {
  kind: 'matching_columns';
};

/**
 * 断句/点字缝。槽形态要求：select 槽带 text，items 带 gap_after_codepoint；
 * 声明的字缝必须落在冻结明文的字素簇边界上（spec §1.2.1，绑定校验拒绝）。
 */
export type BreakTapBlockT = InputBlockBase & {
  kind: 'break_tap';
};

/** 排序：每个 (position, object) 关系组合是一个 item（spec §1.2.1）。 */
export type OrderingBlockT = InputBlockBase & {
  kind: 'ordering';
};

/** 单空文本输入（数值/表达式/诗句都是 blank）。 */
export type BlankInputBlockT = InputBlockBase & {
  kind: 'blank_input';
  width?: 'sm' | 'md' | 'lg';
};

/** 开放作答区（free = open_response 槽）：文字 + 照片等附件。 */
export type FreeAreaBlockT = InputBlockBase & {
  kind: 'free_area';
  min_lines?: number;
};

/**
 * 自定义块（沙箱，spec §1.3）：代码作为资产冻结（asset_id + digest，随
 * presentation 版本化），可绑定多个作答位。运行限制：无网络、无学习者
 * 数据、拿不到私有答案；只能通过宿主发出与 1.2 相同的作答信封。隔离方式
 * （iframe/Worker）由界面线选定，后端不表达。
 */
export type CustomBlockT = {
  block_id: string;
  kind: 'custom';
  sandbox: {
    asset: { asset_id: string; digest: string };
    entry: string;
    contract: 'sandbox-v1';
  };
  binds: PresentationBindT[];
};

/** 积木全集（discriminated on `kind`；kind 白名单即此 union，spec §3 规则 6）。 */
export type PresentationBlockT =
  | StackBlockT
  | PassageLayoutBlockT
  | TextMathBlockT
  | FigureBlockT
  | OptionListBlockT
  | MatchingColumnsBlockT
  | BreakTapBlockT
  | OrderingBlockT
  | BlankInputBlockT
  | FreeAreaBlockT
  | CustomBlockT;

// ---------- 展示层（spec §1） ----------

/** 冻结在 revision 上的公开展示层；旧 revision 无此层（继续逐槽渲染）。 */
export type PresentationT = {
  schema_version: 1;
  renderer_contract: RendererContractT;
  root: PresentationBlockT;
};

const BlockId = z.string().min(1);
const MaterialRef = z.string().min(1);

/** 递归前向引用：显式注解让成员 schema 推断不经过 PresentationBlock 自身。 */
const LazyBlock: z.ZodType<PresentationBlockT> = z.lazy(() => PresentationBlock);
const bindField = { bind: PresentationBind } as const;
const printField = { print: PresentationPrintHint.optional() } as const;

export const PresentationBlock: z.ZodType<PresentationBlockT> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    z.object({
      block_id: BlockId,
      kind: z.literal('stack'),
      gap: z.enum(['sm', 'md', 'lg']).optional(),
      children: z.array(LazyBlock).min(1),
    }),
    z.object({
      block_id: BlockId,
      kind: z.literal('passage_layout'),
      material_ref: MaterialRef,
      layout: z.enum(['passage_left_questions_right', 'passage_top']),
      passage_width: z.enum(['balanced', 'wide']).optional(),
      children: z.array(LazyBlock).min(1),
    }),
    z.object({
      block_id: BlockId,
      kind: z.literal('text_math'),
      part_ref: z.string().min(1).optional(),
      material_ref: MaterialRef.optional(),
    }),
    z.object({
      block_id: BlockId,
      kind: z.literal('figure'),
      material_ref: MaterialRef,
    }),
    z.object({
      block_id: BlockId,
      kind: z.literal('option_list'),
      ...bindField,
      layout: z.enum(['vertical', 'grid', 'inline']).optional(),
      marker: z.enum(['letter', 'number', 'none']).optional(),
      ...printField,
    }),
    z.object({
      block_id: BlockId,
      kind: z.literal('matching_columns'),
      ...bindField,
      ...printField,
    }),
    z.object({
      block_id: BlockId,
      kind: z.literal('break_tap'),
      ...bindField,
      ...printField,
    }),
    z.object({
      block_id: BlockId,
      kind: z.literal('ordering'),
      ...bindField,
      ...printField,
    }),
    z.object({
      block_id: BlockId,
      kind: z.literal('blank_input'),
      ...bindField,
      width: z.enum(['sm', 'md', 'lg']).optional(),
      ...printField,
    }),
    z.object({
      block_id: BlockId,
      kind: z.literal('free_area'),
      ...bindField,
      min_lines: z.number().int().min(1).optional(),
      ...printField,
    }),
    z.object({
      block_id: BlockId,
      kind: z.literal('custom'),
      sandbox: z.object({
        asset: z.object({
          asset_id: z.string().min(1),
          digest: z.string().min(1),
        }),
        entry: z.string().min(1),
        contract: z.literal('sandbox-v1'),
      }),
      binds: z.array(PresentationBind).min(1),
    }),
  ]),
);

export const Presentation: z.ZodType<PresentationT> = z.object({
  schema_version: z.literal(PRESENTATION_SCHEMA_VERSION),
  renderer_contract: z.enum(SUPPORTED_RENDERER_CONTRACTS),
  root: PresentationBlock,
});
