import { z } from 'zod';

import { type SharedMaterialT, isPublicSharedMaterial } from './materials';
import type { ResponseSlotT, ResponseSpecT } from './response';
import type { ScoringBasisT } from './scoring';
import type { QuestionGroupStructureT } from './structure';

// ====================================================================
// YUK-1497 — Generative UI · 题目展示契约 presentation（spec v1 §1）
// ====================================================================
//
// 真相源：docs/design/2026-10-16-presentation-spec-v1.md（含 7bb5d0236
// §1.2.1/规则 6 更正）；讨论 §8（tlp-status/unified-question-grading-design.md）。
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
  /**
   * P1 防布局点击劫持：iframe 高度只取块声明，120–720px；缺省由 UI 取
   * CUSTOM_FRAME_HEIGHT_DEFAULT（320）。iframe 自身永远改不了它。
   */
  frame_height_px?: number;
};

/**
 * §1.3 自定义块契约常量 —— 纯层（validatePresentation）与发布 barrier 的
 * DB 校验（publishQuestionGroup）共用：
 *   - digest 固定 'sha256:' + 64 位小写 hex，必须等于资产行的 sha256
 *     （即 'sha256:' + source_asset.sha256）；'unverified:' 前缀永不可发布。
 *   - asset_id 内容寻址（v2）：必须等于 'sbx_' + digest hex 前 32 位 ——
 *     加上资产行 sha256 与字节实测 sha256 相符，id ↔ 字节绑定不可变。
 *     资产 writer 随 R8（录入 agent）落地：服务端算 sha256、一次写入
 *     （ON CONFLICT DO NOTHING），本层不建 writer。
 *   - entry 是代码资产定义的全局函数名（非空 JS 标识符，≤64 字符）；宿主在
 *     沙箱内调 globalThis[entry](port)，port 只能为 binds 内槽位交作答条目。
 *   - 代码资产限制在 DB 侧执行（source_asset 行上）：mime ∈
 *     CUSTOM_ASSET_MIME_TYPES，byte_size ≤ CUSTOM_ASSET_MAX_BYTES（256 KiB）；
 *     字节内容另扫描禁序（findCustomCodeForbiddenSequence：`</script`、
 *     `<!--`、NUL 字节；发布 barrier 读字节后调）。
 */
export const CUSTOM_ASSET_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
export const CUSTOM_ENTRY_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
export const CUSTOM_ENTRY_MAX_LENGTH = 64;
export const CUSTOM_ASSET_MAX_BYTES = 256 * 1024;
export const CUSTOM_ASSET_MIME_TYPES = ['text/javascript', 'application/javascript'] as const;
export const CUSTOM_ASSET_ID_PREFIX = 'sbx_';
export const CUSTOM_FRAME_HEIGHT_MIN = 120;
export const CUSTOM_FRAME_HEIGHT_MAX = 720;
/** 缺省高度只由 UI 采用（块未声明时）；后端不注入缺省值。 */
export const CUSTOM_FRAME_HEIGHT_DEFAULT = 320;

/** 从合法 digest 推导内容寻址 asset_id（'sbx_' + hex 前 32 位）；digest 不合法返回 null。 */
export function customAssetIdForDigest(digest: string): string | null {
  return CUSTOM_ASSET_DIGEST_PATTERN.test(digest)
    ? `${CUSTOM_ASSET_ID_PREFIX}${digest.slice('sha256:'.length, 'sha256:'.length + 32)}`
    : null;
}

/**
 * §1.3 v2 禁序扫描（纯函数）：代码里出现 `</script`（不分大小写）、`<!--`
 * 或 NUL 字节（\u0000）会提前终止/破坏外层 script —— 发布 barrier 读到字节
 * 后必须拒绝（custom_code_forbidden_sequence，detail 点名命中的序列）。
 * 返回最早命中（sequence 是可打印标签，NUL 显示为 'NUL (U+0000)'），
 * 干净代码返回 null。
 */
export function findCustomCodeForbiddenSequence(code: string): {
  sequence: string;
  index: number;
} | null {
  const candidates: Array<{ sequence: string; index: number }> = [];
  const scriptIndex = code.toLowerCase().indexOf('</script');
  if (scriptIndex !== -1) candidates.push({ sequence: '</script', index: scriptIndex });
  const commentIndex = code.indexOf('<!--');
  if (commentIndex !== -1) candidates.push({ sequence: '<!--', index: commentIndex });
  const nulIndex = code.indexOf('\u0000');
  if (nulIndex !== -1) candidates.push({ sequence: 'NUL (U+0000)', index: nulIndex });
  if (candidates.length === 0) return null;
  return candidates.reduce((earliest, candidate) =>
    candidate.index < earliest.index ? candidate : earliest,
  );
}

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
      frame_height_px: z
        .number()
        .int()
        .min(CUSTOM_FRAME_HEIGHT_MIN)
        .max(CUSTOM_FRAME_HEIGHT_MAX)
        .optional(),
    }),
  ]),
);

export const Presentation: z.ZodType<PresentationT> = z.object({
  schema_version: z.literal(PRESENTATION_SCHEMA_VERSION),
  renderer_contract: z.enum(SUPPORTED_RENDERER_CONTRACTS),
  root: PresentationBlock,
});

// ====================================================================
// 发布时的绑定校验（spec §3 规则 1–6；纯确定性原语，无 IO）
// ====================================================================

export interface PresentationIssue {
  code: /** 规则 6：renderer 契约 / schema 版本不在白名单。 */
    | 'unsupported_renderer_contract'
    | 'unsupported_schema_version'
    /** 规则 6：block_id 在 presentation 内重复。 */
    | 'duplicate_block_id'
    /** 规则 5：part_ref / material_ref 解析失败或引用不可渲染。 */
    | 'unresolved_part_ref'
    | 'unresolved_material_ref'
    /** 规则 5：presentation 是公开内容 —— 引用了私有材料。 */
    | 'non_public_material_ref'
    /** 规则 5：figure 材料必须已核验（digest 非 unverified）且 kind=figure。 */
    | 'unverified_figure_material'
    | 'figure_material_kind'
    /** 规则 5：text_math 的 part_ref / material_ref 必须二选一。 */
    | 'text_math_ref_shape'
    /** 规则 5：passage_layout 材料不是 passage 也不是内联 plaintext。 */
    | 'passage_material_kind'
    /** 规则 1/3：bind 指向未知槽位（或布局容器槽）。 */
    | 'unresolved_slot_bind'
    /** 规则 3：bind.unit_id 不是声明的计分单元，或 unit.slot_refs 不含该槽。 */
    | 'unresolved_unit_bind'
    | 'unit_slot_mismatch'
    /** 规则 2：response_class 与槽种类不一致。 */
    | 'response_class_mismatch'
    /** 规则 4：输入积木种类与槽形态不相容（§1.2 表）。 */
    | 'slot_shape_incompatible'
    /** 规则 6（7bb5d0236 更正）：break_tap 字缝不在字素簇边界上。 */
    | 'break_gap_not_grapheme_boundary'
    /** 规则 6（717ad010a 更正）：break_tap 字缝紧跟在 `\n` 之后（与换行前字缝歧义）。 */
    | 'break_gap_after_newline'
    /** 规则 1：发出范围内可作答槽未被绑定。 */
    | 'slot_not_bound'
    /** 规则 1：同一作答位被多个积木/bind 重复绑定。 */
    | 'slot_double_bound'
    /** §1.3 自定义块：sandbox 契约版本不在白名单。 */
    | 'custom_contract_unsupported'
    /** §1.3 自定义块：digest 不是 'sha256:<64 位小写 hex>'（与资产行 sha256 相符由 DB 侧比对）。 */
    | 'custom_asset_digest_invalid'
    /** §1.3 自定义块：digest 带 'unverified:' 前缀 —— 未核验资产永不可发布。 */
    | 'custom_asset_unverified'
    /** §1.3 自定义块：entry 不是 ≤64 字符的非空 JS 标识符。 */
    | 'custom_entry_invalid'
    /** §1.3 自定义块：binds 为空（自定义块至少绑定一个作答位）。 */
    | 'custom_binds_empty'
    /** §1.3 v2 自定义块：asset_id 不是从 digest 内容寻址推出的 'sbx_'+hex前32位。 */
    | 'custom_asset_not_content_addressed'
    /** §1.3 v2 自定义块：frame_height_px 不在 120–720 整数范围（发布 barrier 的 DB 阶段同样拒字节禁序，见 custom_code_forbidden_sequence）。 */
    | 'custom_frame_height_invalid'
    /** §1.3 v2 自定义块：代码含 '</script'（不分大小写）或 '<!--'（发布 barrier 读字节后拒；纯层无字节，此处只登记码值）。 */
    | 'custom_code_forbidden_sequence';
  detail: string;
}

/** 槽种类 ↔ bind.response_class（规则 2）。 */
const RESPONSE_CLASS_BY_SLOT_KIND: Partial<Record<ResponseSlotT['kind'], ResponseClassT>> = {
  select: 'select',
  blank: 'blank',
  open_response: 'free',
};

/** §1.2 输入积木种类。 */
type InputBlockKind =
  | 'option_list'
  | 'matching_columns'
  | 'break_tap'
  | 'ordering'
  | 'blank_input'
  | 'free_area';

/** 输入积木种类 ↔ 绑定槽种类（规则 4 的第 1 列）。 */
const SLOT_KIND_BY_INPUT_BLOCK: Record<InputBlockKind, ResponseSlotT['kind']> = {
  option_list: 'select',
  matching_columns: 'select',
  break_tap: 'select',
  ordering: 'select',
  blank_input: 'blank',
  free_area: 'open_response',
};

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/**
 * 冻结明文的【字素簇起始】code point 偏移集合（含文末偏移）。
 * gap i 表示「第 i 个 code point 之前」—— 只有恰好落在某字素簇起点的字缝
 * 才是可声明的断点（组合字符、emoji 内部不是字缝；spec §1.2.1）。
 */
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

interface BreakTapTextIndex {
  /** 字素簇起始 code point 偏移（含文末）。 */
  graphemeStarts: Set<number>;
  /** 冻结明文的 code point 数组（查换行前字符用）。 */
  chars: string[];
}

interface WalkState {
  issues: PresentationIssue[];
  blockIds: Set<string>;
  /** 覆盖计数用 bind（输入积木单 bind + 自定义块整块计入的 binds）。 */
  coverageBinds: PresentationBindT[];
  slotById: Map<string, ResponseSlotT>;
  scopeAnswerableSlotIds: Set<string>;
  /** 与公开投影同律的范围内计分单元（slot_refs+evidence_slot_refs 全发出）。 */
  scopeUnitIds: Set<string>;
  breakTapByText: Map<string, BreakTapTextIndex>;
}

function axisNamesExact(
  axes: Record<string, unknown> | undefined,
  expected: readonly string[],
): boolean {
  const names = Object.keys(axes ?? {}).sort();
  const want = [...expected].sort();
  return names.length === want.length && names.every((name, index) => name === want[index]);
}

/** 规则 4 的 select 系形态检查（§1.2 表 + §1.2.1 字素簇边界）。 */
function checkSelectShape(
  state: WalkState,
  select: Extract<ResponseSlotT, { kind: 'select' }>,
  blockId: string,
  inputKind: InputBlockKind,
): void {
  const { issues } = state;
  if (inputKind === 'option_list') {
    const plain = select.items.every(
      (item) => item.coordinates == null && item.gap_after_codepoint == null,
    );
    if (!plain) {
      issues.push({
        code: 'slot_shape_incompatible',
        detail: `option_list block '${blockId}' requires a select slot whose items carry neither coordinates nor gaps`,
      });
    }
    return;
  }
  if (inputKind === 'matching_columns') {
    if (!axisNamesExact(select.axes, ['left', 'right'])) {
      issues.push({
        code: 'slot_shape_incompatible',
        detail: `matching_columns block '${blockId}' requires a select slot with axes exactly {left, right}`,
      });
    }
    if (!select.items.every((item) => item.coordinates != null)) {
      issues.push({
        code: 'slot_shape_incompatible',
        detail: `matching_columns block '${blockId}' requires a select slot whose items all carry coordinates`,
      });
    }
    return;
  }
  if (inputKind === 'break_tap') {
    if (select.text == null) {
      issues.push({
        code: 'slot_shape_incompatible',
        detail: `break_tap block '${blockId}' requires a select slot with frozen text`,
      });
      return;
    }
    if (!select.items.every((item) => item.gap_after_codepoint != null)) {
      issues.push({
        code: 'slot_shape_incompatible',
        detail: `break_tap block '${blockId}' requires a select slot whose items all carry gap_after_codepoint`,
      });
      return;
    }
    let index = state.breakTapByText.get(select.text);
    if (index == null) {
      index = {
        graphemeStarts: graphemeStartOffsets(select.text),
        chars: [...select.text],
      };
      state.breakTapByText.set(select.text, index);
    }
    for (const item of select.items) {
      const gap = item.gap_after_codepoint;
      if (gap == null) continue;
      if (!index.graphemeStarts.has(gap)) {
        issues.push({
          code: 'break_gap_not_grapheme_boundary',
          detail: `break_tap block '${blockId}' item '${item.item_id}' gap ${gap} is not on a grapheme-cluster boundary of the frozen text`,
        });
        continue;
      }
      // 717ad010a：紧跟 `\n` 之后的字缝与换行前的字缝同位置，歧义 —— 拒绝；
      // 行末断句用 `\n` 之前的字缝（界面把它画在行尾）。
      if (index.chars[gap - 1] === '\n') {
        issues.push({
          code: 'break_gap_after_newline',
          detail: `break_tap block '${blockId}' item '${item.item_id}' gap ${gap} sits immediately after a newline — use the gap before the '\n' instead`,
        });
      }
    }
    return;
  }
  if (inputKind === 'ordering') {
    if (!axisNamesExact(select.axes, ['position', 'object'])) {
      issues.push({
        code: 'slot_shape_incompatible',
        detail: `ordering block '${blockId}' requires a select slot with axes exactly {position, object}`,
      });
    }
    // 与 matching_columns 同律：每个 (position, object) 关系 item 都必须带坐标，
    // 否则界面无法把作答映射回 item（review R1）。
    if (!select.items.every((item) => item.coordinates != null)) {
      issues.push({
        code: 'slot_shape_incompatible',
        detail: `ordering block '${blockId}' requires a select slot whose items all carry coordinates`,
      });
    }
  }
}

/**
 * 单个 bind 的规则 2/3/4 校验；返回该 bind 是否落在发出范围内
 * （覆盖计数用 —— 与公开投影的整枝剪除同律）。
 */
function validateBind(
  state: WalkState,
  bind: PresentationBindT,
  blockId: string,
  inputKind: InputBlockKind | null,
  unitById: Map<string, ScoringBasisT['units'][number]>,
): boolean {
  const { issues, slotById } = state;
  const slot = slotById.get(bind.slot_id);
  if (slot == null || slot.kind === 'table') {
    issues.push({
      code: 'unresolved_slot_bind',
      detail: `block '${blockId}' binds ${slot?.kind === 'table' ? 'table (layout container)' : 'unknown'} slot '${bind.slot_id}'`,
    });
    return false;
  }
  const unit = unitById.get(bind.unit_id);
  if (unit == null) {
    issues.push({
      code: 'unresolved_unit_bind',
      detail: `block '${blockId}' binds unknown scoring unit '${bind.unit_id}'`,
    });
  } else if (!unit.slot_refs.includes(bind.slot_id)) {
    issues.push({
      code: 'unit_slot_mismatch',
      detail: `unit '${bind.unit_id}' slot_refs does not include bound slot '${bind.slot_id}'`,
    });
  }
  if (RESPONSE_CLASS_BY_SLOT_KIND[slot.kind] !== bind.response_class) {
    issues.push({
      code: 'response_class_mismatch',
      detail: `block '${blockId}' response_class '${bind.response_class}' does not match slot '${slot.slot_id}' kind '${slot.kind}'`,
    });
  }
  // 规则 4：输入积木种类与槽形态相容（自定义块不走 §1.2 表 —— 只有 bind 语义）。
  if (inputKind != null) {
    if (SLOT_KIND_BY_INPUT_BLOCK[inputKind] !== slot.kind) {
      issues.push({
        code: 'slot_shape_incompatible',
        detail: `${inputKind} block '${blockId}' cannot bind slot '${slot.slot_id}' of kind '${slot.kind}'`,
      });
    } else if (slot.kind === 'select') {
      checkSelectShape(state, slot, blockId, inputKind);
    }
  }
  // 覆盖计数与公开投影的整枝剪除同律（review R1）：槽在发出范围内还不够 ——
  // bind 的单元也必须存活。单元的 slot_refs/evidence_slot_refs 只要有一个
  // 不在发出范围内，dto 投影就会剪掉该积木；若此处仍计为覆盖，校验会宣称
  // 已绑定而学习者看到的 DTO 里没有输入面。
  return state.scopeAnswerableSlotIds.has(bind.slot_id) && state.scopeUnitIds.has(bind.unit_id);
}

/** 文本/材料引用解析（规则 5）；presentation 是公开内容 —— 材料必须公开。 */
function checkMaterialRef(
  state: WalkState,
  materialsById: Map<string, SharedMaterialT>,
  materialRef: string,
  blockId: string,
  options: { requireFigure?: boolean; requirePassage?: boolean; requireContent?: boolean } = {},
): void {
  const material = materialsById.get(materialRef);
  if (material == null) {
    state.issues.push({
      code: 'unresolved_material_ref',
      detail: `block '${blockId}' references unknown material '${materialRef}'`,
    });
    return;
  }
  if (!isPublicSharedMaterial(material)) {
    state.issues.push({
      code: 'non_public_material_ref',
      detail: `block '${blockId}' references private material '${materialRef}' — presentation is public content`,
    });
  }
  if (options.requireFigure) {
    if (material.kind !== 'figure') {
      state.issues.push({
        code: 'figure_material_kind',
        detail: `figure block '${blockId}' references material '${materialRef}' of kind '${material.kind}'`,
      });
    }
    if (material.asset.digest.startsWith('unverified:')) {
      state.issues.push({
        code: 'unverified_figure_material',
        detail: `figure block '${blockId}' references material '${materialRef}' whose asset digest is unverified`,
      });
    }
  }
  if (options.requirePassage) {
    // review R1：normalizer 只铸造 plaintext 内联材料（从不产 passage kind），
    // passage_layout 接受 passage 或内联 plaintext 材料（spec §1.1 更正）；
    // 其余 kind 用专门 issue code 拒绝。
    if (material.kind !== 'passage' && material.kind !== 'plaintext') {
      state.issues.push({
        code: 'passage_material_kind',
        detail: `passage_layout block '${blockId}' references material '${materialRef}' of kind '${material.kind}' (expected passage or inline plaintext)`,
      });
    }
  }
  if (options.requireContent && material.content_md == null) {
    state.issues.push({
      code: 'unresolved_material_ref',
      detail: `block '${blockId}' references material '${materialRef}' without inline content_md — nothing to render`,
    });
  }
}

function walkBlock(
  state: WalkState,
  block: PresentationBlockT,
  partIds: Set<string>,
  materialsById: Map<string, SharedMaterialT>,
  unitById: Map<string, ScoringBasisT['units'][number]>,
): void {
  const { issues } = state;
  if (state.blockIds.has(block.block_id)) {
    issues.push({
      code: 'duplicate_block_id',
      detail: `block_id '${block.block_id}' appears more than once`,
    });
  }
  state.blockIds.add(block.block_id);

  switch (block.kind) {
    case 'stack':
      for (const child of block.children) {
        walkBlock(state, child, partIds, materialsById, unitById);
      }
      return;
    case 'passage_layout':
      checkMaterialRef(state, materialsById, block.material_ref, block.block_id, {
        requirePassage: true,
        requireContent: true,
      });
      for (const child of block.children) {
        walkBlock(state, child, partIds, materialsById, unitById);
      }
      return;
    case 'text_math': {
      const hasPart = block.part_ref != null;
      const hasMaterial = block.material_ref != null;
      if (hasPart === hasMaterial) {
        issues.push({
          code: 'text_math_ref_shape',
          detail: `text_math block '${block.block_id}' must carry exactly one of part_ref / material_ref`,
        });
      }
      if (block.part_ref != null && !partIds.has(block.part_ref)) {
        issues.push({
          code: 'unresolved_part_ref',
          detail: `text_math block '${block.block_id}' references unknown part '${block.part_ref}'`,
        });
      }
      if (block.material_ref != null) {
        checkMaterialRef(state, materialsById, block.material_ref, block.block_id, {
          requireContent: true,
        });
      }
      return;
    }
    case 'figure':
      checkMaterialRef(state, materialsById, block.material_ref, block.block_id, {
        requireFigure: true,
      });
      return;
    case 'option_list':
    case 'matching_columns':
    case 'break_tap':
    case 'ordering':
    case 'blank_input':
    case 'free_area': {
      const inputKind = block.kind satisfies InputBlockKind;
      if (validateBind(state, block.bind, block.block_id, inputKind, unitById)) {
        state.coverageBinds.push(block.bind);
      }
      return;
    }
    case 'custom': {
      // §1.3 纯校验（fail-closed）：契约版本、digest 形状、entry 标识符、
      // binds 非空。资产行存在性 / sha256 相符 / mime / 大小是 DB 校验，在
      // publishQuestionGroup 的 presentation barrier 里查（纯层无 IO）。
      const sandboxContract: string = block.sandbox.contract;
      if (sandboxContract !== 'sandbox-v1') {
        issues.push({
          code: 'custom_contract_unsupported',
          detail: `custom block '${block.block_id}' sandbox contract '${sandboxContract}' is not supported (sandbox-v1)`,
        });
      }
      const digest = block.sandbox.asset.digest;
      let digestWellFormed = false;
      if (digest.startsWith('unverified:')) {
        issues.push({
          code: 'custom_asset_unverified',
          detail: `custom block '${block.block_id}' carries an unverified asset digest '${digest}' — unverified assets are never publishable`,
        });
      } else if (!CUSTOM_ASSET_DIGEST_PATTERN.test(digest)) {
        issues.push({
          code: 'custom_asset_digest_invalid',
          detail: `custom block '${block.block_id}' asset digest '${digest}' must be 'sha256:<64 lowercase hex>' equal to the source_asset sha256`,
        });
      } else {
        digestWellFormed = true;
      }
      // v2 内容寻址：asset_id 必须等于 'sbx_' + digest hex 前 32 位（digest
      // 合法才比对，避免连锁噪声）。配合 DB 侧 sha256 相符 + 字节实测，
      // id ↔ 字节绑定不可变。
      const expectedAssetId = customAssetIdForDigest(digest);
      if (digestWellFormed && expectedAssetId !== block.sandbox.asset.asset_id) {
        issues.push({
          code: 'custom_asset_not_content_addressed',
          detail: `custom block '${block.block_id}' asset_id '${block.sandbox.asset.asset_id}' must be the content-addressed '${expectedAssetId}' ('sbx_' + first 32 hex of the digest)`,
        });
      }
      const entry = block.sandbox.entry;
      if (entry.length > CUSTOM_ENTRY_MAX_LENGTH || !CUSTOM_ENTRY_PATTERN.test(entry)) {
        issues.push({
          code: 'custom_entry_invalid',
          detail: `custom block '${block.block_id}' entry '${entry}' must be a non-empty JavaScript identifier of at most ${CUSTOM_ENTRY_MAX_LENGTH} characters`,
        });
      }
      if (block.binds.length === 0) {
        issues.push({
          code: 'custom_binds_empty',
          detail: `custom block '${block.block_id}' binds no answerable slot`,
        });
      }
      // v2 防布局点击劫持：高度只取块声明，120–720 整数；缺省由 UI 取 320。
      const frameHeight = block.frame_height_px;
      if (
        frameHeight !== undefined &&
        (!Number.isInteger(frameHeight) ||
          frameHeight < CUSTOM_FRAME_HEIGHT_MIN ||
          frameHeight > CUSTOM_FRAME_HEIGHT_MAX)
      ) {
        issues.push({
          code: 'custom_frame_height_invalid',
          detail: `custom block '${block.block_id}' frame_height_px ${String(frameHeight)} must be an integer in [${CUSTOM_FRAME_HEIGHT_MIN}, ${CUSTOM_FRAME_HEIGHT_MAX}]`,
        });
      }
      // 自定义块绑定多个作答位；覆盖计数与公开投影同律 —— 任一 bind 落在
      // 发出范围外 ⇒ 整块被剪掉，其余 bind 不计入（否则投影会缺输入面）。
      const inScope = block.binds.map((bind) =>
        validateBind(state, bind, block.block_id, null, unitById),
      );
      if (inScope.every((flag) => flag)) {
        state.coverageBinds.push(...block.binds);
      }
      return;
    }
  }
}

/**
 * 纯校验（spec §3 规则 1–6）：presentation 对题目契约（structure /
 * response_spec / scoring_basis）的绑定一致性。发布 barrier 与出题门共用。
 *
 * 传入 issuedPartIds 时按「发出 part 子集」校验：覆盖计数只算范围内可作答
 * 槽，范围外 bind 不计错 —— 与公开投影的整枝剪除同律（自定义块任一 bind
 * 出范围 ⇒ 整块不计入）。缺省 = 全部 parts（发布 barrier 口径）。
 */
export function validatePresentation(
  presentation: PresentationT,
  structure: QuestionGroupStructureT,
  response_spec: ResponseSpecT,
  scoring_basis: ScoringBasisT,
  issuedPartIds?: readonly string[],
): PresentationIssue[] {
  const issues: PresentationIssue[] = [];
  if (presentation.schema_version !== PRESENTATION_SCHEMA_VERSION) {
    issues.push({
      code: 'unsupported_schema_version',
      detail: `schema_version ${String(presentation.schema_version)} is not supported (expected ${PRESENTATION_SCHEMA_VERSION})`,
    });
  }
  if (
    !(SUPPORTED_RENDERER_CONTRACTS as readonly string[]).includes(presentation.renderer_contract)
  ) {
    issues.push({
      code: 'unsupported_renderer_contract',
      detail: `renderer_contract '${presentation.renderer_contract}' is not supported (${SUPPORTED_RENDERER_CONTRACTS.join(', ')})`,
    });
    return issues; // 契约版本不受支持 —— 后续校验无意义，fail fast。
  }

  const partIds = new Set(structure.parts.map((part) => part.part_id));
  const materialsById = new Map(
    structure.materials.map((material) => [material.material_id, material] as const),
  );
  const slotById = new Map(response_spec.slots.map((slot) => [slot.slot_id, slot] as const));
  const unitById = new Map(
    scoring_basis.units.map((unit) => [unit.scoring_unit_id, unit] as const),
  );
  const scopeParts = new Set(issuedPartIds ?? partIds);
  const scopeAnswerableSlotIds = new Set(
    response_spec.slots
      .filter((slot) => scopeParts.has(slot.part_id) && slot.kind !== 'table')
      .map((slot) => slot.slot_id),
  );
  // 范围内存活单元：与 dto.ts 公开投影的 scopedUnits 同判据 —— 单元的
  // slot_refs 与 evidence_slot_refs 全落在发出范围内可作答槽内才存活；
  // 缺省（发布 barrier 全量口径）时全部 parts 在范围，等价于全部单元。
  const scopeUnitIds = new Set(
    scoring_basis.units
      .filter((unit) =>
        [...unit.slot_refs, ...unit.evidence_slot_refs].every((id) =>
          scopeAnswerableSlotIds.has(id),
        ),
      )
      .map((unit) => unit.scoring_unit_id),
  );

  const state: WalkState = {
    issues,
    blockIds: new Set(),
    coverageBinds: [],
    slotById,
    scopeAnswerableSlotIds,
    scopeUnitIds,
    breakTapByText: new Map(),
  };

  walkBlock(state, presentation.root, partIds, materialsById, unitById);

  // 规则 1：范围内每个可作答槽恰好被绑定一次 —— 不漏，不重。
  const bindCounts = new Map<string, number>();
  for (const bind of state.coverageBinds) {
    bindCounts.set(bind.slot_id, (bindCounts.get(bind.slot_id) ?? 0) + 1);
  }
  for (const slotId of scopeAnswerableSlotIds) {
    const count = bindCounts.get(slotId) ?? 0;
    if (count === 0) {
      issues.push({
        code: 'slot_not_bound',
        detail: `answerable slot '${slotId}' is not bound by any input block`,
      });
    } else if (count > 1) {
      issues.push({
        code: 'slot_double_bound',
        detail: `slot '${slotId}' is bound ${count} times — every answerable slot binds exactly one input block`,
      });
    }
  }
  return issues;
}

// ====================================================================
// 缺省展示（spec §5）：录入 agent 的起点，不是 agent 组版的替代。
// ====================================================================

/**
 * 纯推导：按题目契约生成一份【合法的】声明式缺省展示 ——
 * stack → 每个 part 一块 text_math → 每个可作答槽按【槽形态】选一个输入积木
 * （review R1：先看 item 形状，再看 axes）：
 *   gap items（全带 gap_after_codepoint）→ break_tap；
 *   coordinated items（全带 coordinates）+ axes{left,right} → matching_columns；
 *   coordinated items + axes{position,object} → ordering；
 *   plain items（无 coordinates 无 gap）→ option_list；
 *   blank → blank_input；open_response → free_area。
 * unit 取第一个 slot_refs 包含该槽的计分单元。
 * 契约无法用 blocks-v1 表达（旧槽种类、无计分单元、select 形态不可判）时
 * 返回 null —— 不伪造；返回前过 validatePresentation 自检，绝不交出
 * 一个过不了发布 barrier 的缺省（如字缝不在字素簇边界的 break_tap）。
 */
export function defaultPresentation(
  structure: QuestionGroupStructureT,
  response_spec: ResponseSpecT,
  scoring_basis: ScoringBasisT,
): PresentationT | null {
  const children: PresentationBlockT[] = [];
  for (const part of structure.parts) {
    children.push({
      block_id: `blk_part_${part.part_id}`,
      kind: 'text_math',
      part_ref: part.part_id,
    });
    for (const slot of response_spec.slots) {
      if (slot.part_id !== part.part_id || slot.kind === 'table') continue;
      const unit = scoring_basis.units.find((candidate) =>
        candidate.slot_refs.includes(slot.slot_id),
      );
      if (unit == null) return null;
      const bind: PresentationBindT = {
        unit_id: unit.scoring_unit_id,
        slot_id: slot.slot_id,
        response_class:
          slot.kind === 'select' ? 'select' : slot.kind === 'blank' ? 'blank' : 'free',
      };
      if (slot.kind === 'select') {
        // 先看 item 形状（review R1）—— axes 只在 coordinated 分支里细分。
        const allGaps =
          slot.items.length > 0 && slot.items.every((item) => item.gap_after_codepoint != null);
        const allCoordinated =
          slot.items.length > 0 && slot.items.every((item) => item.coordinates != null);
        if (allGaps) {
          // break_tap 需要冻结明文；缺 text 的槽无法表达（不伪造）。
          if (slot.text == null) return null;
          children.push({ block_id: `blk_${slot.slot_id}`, kind: 'break_tap', bind });
          continue;
        }
        if (allCoordinated) {
          if (axisNamesExact(slot.axes, ['left', 'right'])) {
            children.push({ block_id: `blk_${slot.slot_id}`, kind: 'matching_columns', bind });
            continue;
          }
          if (axisNamesExact(slot.axes, ['position', 'object'])) {
            children.push({ block_id: `blk_${slot.slot_id}`, kind: 'ordering', bind });
            continue;
          }
          // 带 coordinates 但 axes 不是 left/right 或 position/object —— blocks-v1
          // 没有对应积木，不伪造。
          return null;
        }
        const plain = slot.items.every(
          (item) => item.coordinates == null && item.gap_after_codepoint == null,
        );
        if (!plain) return null;
        children.push({ block_id: `blk_${slot.slot_id}`, kind: 'option_list', bind });
        continue;
      }
      if (slot.kind === 'blank') {
        children.push({ block_id: `blk_${slot.slot_id}`, kind: 'blank_input', bind });
        continue;
      }
      if (slot.kind === 'open_response') {
        children.push({ block_id: `blk_${slot.slot_id}`, kind: 'free_area', bind });
        continue;
      }
      // 旧槽种类（single_choice 等）没有 K1 作答类 —— blocks-v1 绑不了。
      return null;
    }
  }
  const candidate: PresentationT = {
    schema_version: PRESENTATION_SCHEMA_VERSION,
    renderer_contract: 'blocks-v1',
    root: { block_id: 'blk_root', kind: 'stack', gap: 'md', children },
  };
  // 绝不交出过不了发布 barrier 的缺省（如字缝不在字素簇边界 / 换行后字缝）。
  return validatePresentation(candidate, structure, response_spec, scoring_basis).length === 0
    ? candidate
    : null;
}

// ====================================================================
// 公开投影的整枝剪除（spec §3 末段）—— 纯函数，dto.ts / 界面线共用。
// ====================================================================

/**
 * 把 presentation 剪到发出范围：积木树里引用未发出 part / 单元 / 槽 / 未绑定
 * 材料的分支整枝去掉。presentation 只含引用，不需要另做脱敏。
 *
 *   - text_math：part_ref 未发出（且无 material_ref）或 material 未随发 → 剪；
 *   - figure / passage_layout：材料未随 issuance 绑定（公开、同 digest）→ 剪；
 *   - 输入积木：bind 的槽或单元不在发出范围 → 剪；
 *   - custom：任一 bind 出范围 → 整块剪（与 validatePresentation 覆盖计数同律）；
 *   - 容器剪空 → 连容器一起剪；根被剪掉 → 返回 null（UI 回退逐槽渲染）。
 */
export function prunePresentation(
  presentation: PresentationT,
  scope: {
    /** 发出的 part 子集。 */
    issuedPartIds: ReadonlySet<string>;
    /** 发出范围内可作答槽（非 table）。 */
    issuedAnswerableSlotIds: ReadonlySet<string>;
    /** slot_refs/evidence_slot_refs 全落在发出槽内的计分单元。 */
    issuedUnitIds: ReadonlySet<string>;
    /** issuance 实际绑定（同 digest）的公开材料。 */
    boundPublicMaterialIds: ReadonlySet<string>;
  },
): PresentationT | null {
  const pruneBlock = (block: PresentationBlockT): PresentationBlockT | null => {
    switch (block.kind) {
      case 'stack': {
        const children = block.children
          .map(pruneBlock)
          .filter((child): child is PresentationBlockT => child != null);
        if (children.length === 0) return null;
        return { ...block, children };
      }
      case 'passage_layout': {
        if (!scope.boundPublicMaterialIds.has(block.material_ref)) return null;
        const children = block.children
          .map(pruneBlock)
          .filter((child): child is PresentationBlockT => child != null);
        if (children.length === 0) return null;
        return { ...block, children };
      }
      case 'text_math': {
        if (block.part_ref == null && block.material_ref == null) return null;
        if (block.material_ref != null) {
          return scope.boundPublicMaterialIds.has(block.material_ref) ? block : null;
        }
        // 引用未发出 part 的分支整枝去掉（spec §3 末段）。part_id 非空由
        // schema xor 语义与上方判空保证。
        return scope.issuedPartIds.has(block.part_ref as string) ? block : null;
      }
      case 'figure':
        return scope.boundPublicMaterialIds.has(block.material_ref) ? block : null;
      case 'option_list':
      case 'matching_columns':
      case 'break_tap':
      case 'ordering':
      case 'blank_input':
      case 'free_area': {
        const { bind } = block;
        if (
          !scope.issuedAnswerableSlotIds.has(bind.slot_id) ||
          !scope.issuedUnitIds.has(bind.unit_id)
        ) {
          return null;
        }
        return block;
      }
      case 'custom': {
        const allInScope = block.binds.every(
          (bind) =>
            scope.issuedAnswerableSlotIds.has(bind.slot_id) &&
            scope.issuedUnitIds.has(bind.unit_id),
        );
        return allInScope ? block : null;
      }
    }
  };

  const prunedRoot = pruneBlock(presentation.root);
  if (prunedRoot == null) return null;
  return { ...presentation, root: prunedRoot };
}
