import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { z } from 'zod';
import {
  BlankAnswerShape,
  EvidenceAcceptanceRule,
  SharedMaterialKind,
  VersionedAssetRef,
} from './assessment';
// scoring-rule.ts 未入 assessment index barrel —— 直接深引用（只读不修改受保护目录）。
import { ScoringRule } from './assessment/scoring-rule';
import type { FigureRefT, StructuredQuestionT } from './structured_question';

// ====================================================================
// YUK-1468 — 统一题库草稿文档（schema_version 2）
// ====================================================================
//
// `question_block.structured` 升级为可识别的统一草稿文档：question → parts →
// scoring units，外加材料与每层任意 metadata。提交时该文档直接映射到评估契约
// 四层（structure / response_spec / scoring_basis / execution_plan），由
// `draftDocumentToContract`（server/questions/draft-contract.ts）承担——本文件
// 只持有文档形状、类型守卫与【入方向】适配器（legacy StructuredQuestion → 草稿），
// 不依赖 kernel/server，保持 core/schema 的纯类型纪律。
//
// 身份纪律（与统一判分契约一致）：
//   - part_id / unit_id / slot_id / item_id / material_id 都是稳定身份，
//     操作一律按 id 寻址，绝不按下标或显示 label；
//   - 语义身份替换（选项被换成另一个选项、材料被换成另一份）必须铸新 id，
//     不能沿用旧 id 静默换内容；
//   - 答案权威在 unit 上：select → key.accepted_item_ids；blank → key.key；
//     free → reference_md / rubric。response_spec 只是作答面，不携带判分真相。
//
// 未决纪律：草稿允许不完整（缺 key/rule/材料），缺项以校验 issue 显式呈现，
// publishable=false——绝不靠默认值伪装完整。

export const DRAFT_DOCUMENT_SCHEMA_VERSION = 2 as const;

/** 任意扩展元数据（默认私有；保留权威字段不允许经此自授——见 draft-ops 保留键表）。 */
export const DraftMetadata = z.record(z.string(), z.unknown());
export type DraftMetadataT = z.infer<typeof DraftMetadata>;

// ---------- 材料 ----------

/**
 * 草稿材料 = 发布侧 SharedMaterial 的超集投影：多出 `source_ref` 与 `metadata`
 * （草稿期出处/留痕，不入 revision 契约层；契约层没有对应字段时如实丢弃，
 * 不塞进 caption/alt_text 冒充）。
 */
export const DraftMaterial = z.object({
  material_id: z.string().min(1),
  kind: SharedMaterialKind,
  asset: VersionedAssetRef,
  visibility: z.enum(['public', 'private']).optional(),
  caption: z.string().optional(),
  alt_text: z.string().optional(),
  /** 文本类材料的字节本体（content 即资产；figure 等走 asset store）。 */
  content_md: z.string().optional(),
  /** 草稿期出处（原题/页面/文档定位），不进 revision。 */
  source_ref: z.string().optional(),
  metadata: DraftMetadata.optional(),
});
export type DraftMaterialT = z.infer<typeof DraftMaterial>;

// ---------- 作答位（unit 内的 response_spec） ----------

export const DraftSelectItem = z.object({
  item_id: z.string().min(1),
  label_md: z.string().optional(),
  /** 关系 item 的轴→维度值坐标（matching: {left,right}；ordering: {position,object}）。 */
  coordinates: z.record(z.string(), z.string().min(1)).optional(),
  /** break item：字缝位置（该 item 覆盖的最后一个码点之后）。 */
  gap_after_codepoint: z.number().int().min(1).optional(),
  metadata: DraftMetadata.optional(),
});
export type DraftSelectItemT = z.infer<typeof DraftSelectItem>;

export const DraftSelectAxisEntry = z.object({
  id: z.string().min(1),
  label_md: z.string(),
});
export type DraftSelectAxisEntryT = z.infer<typeof DraftSelectAxisEntry>;

export const DraftSelectSpec = z.object({
  kind: z.literal('select'),
  /** 作答宇宙；items 全部原子不可再分，item_id 稳定。 */
  items: z.array(DraftSelectItem).default([]),
  /** 关系维度（配对 left/right、排序 position/object）；item.coordinates 引用这里的 id。 */
  axes: z.record(z.string(), z.array(DraftSelectAxisEntry).min(1)).optional(),
  /** 每个维度值最多出现几次（一对一配对：{left:1,right:1}）。输入语义，不是给分规则。 */
  at_most_per_coordinate: z.record(z.string(), z.number().int().min(1)).optional(),
  /** 断句的冻结明文；gap item 的字缝按它的 code point 计。 */
  text: z.string().min(1).optional(),
  pick: z.enum(['one', 'many']).optional(),
});
export type DraftSelectSpecT = z.infer<typeof DraftSelectSpec>;

/**
 * blank 作答面。answer_shape（YUK-1568，可选）声明这一空回答的数学对象
 * （公开输入语义；唯一定义在 assessment/blank-answer-shape.ts）。缺省 =
 * 未声明，不注入默认值，旧文本 exact 语义与 digest 不变；未知版本/字段
 * 在 schema 上 parse 失败，保存被拒 —— 不能 strip 后当未声明。
 */
export const DraftBlankSpec = z.object({
  kind: z.literal('blank'),
  format: z.enum(['text', 'math']).optional(),
  unit_hint: z.string().optional(),
  max_chars: z.number().int().min(1).optional(),
  answer_shape: BlankAnswerShape.optional(),
});
export type DraftBlankSpecT = z.infer<typeof DraftBlankSpec>;

export const DraftFreeSpec = z.object({
  kind: z.literal('free'),
  /** 接受的证据种类与约束（D10；空数组 = 只要文本）。 */
  accepts: z.array(EvidenceAcceptanceRule).optional(),
  evidence_required: z.boolean().optional(),
  max_chars: z.number().int().min(1).optional(),
});
export type DraftFreeSpecT = z.infer<typeof DraftFreeSpec>;

export const DraftUnitResponseSpec = z.discriminatedUnion('kind', [
  DraftSelectSpec,
  DraftBlankSpec,
  DraftFreeSpec,
]);
export type DraftUnitResponseSpecT = z.infer<typeof DraftUnitResponseSpec>;

// ---------- 判分（unit 上的权威） ----------

export const DraftResponseClass = z.enum(['select', 'blank', 'free']);
export type DraftResponseClassT = z.infer<typeof DraftResponseClass>;

export const DraftSelectKey = z.object({
  kind: z.literal('select'),
  /** 正确项集合 —— 比较只读这个集合，不读字母序。 */
  accepted_item_ids: z.array(z.string().min(1)).min(1),
});
export type DraftSelectKeyT = z.infer<typeof DraftSelectKey>;

/**
 * 单空文本的归一化。与契约 BlankNormalization 同字段，独立声明避免和评分契约互锁。
 * 缺省整段时，提交侧沿用新题默认（v1、nfkc/collapse 关）。编辑已发布题时整段原样带上，
 * 不再用 case_sensitive/trim 这两个布尔去猜其余字段。
 */
export const DraftBlankNormalization = z.object({
  version: z.string().min(1),
  nfkc: z.boolean().optional(),
  trim_outer: z.boolean().optional(),
  casefold: z.boolean().optional(),
  collapse_whitespace: z.boolean().optional(),
  ignore_punctuation: z.boolean().optional(),
  character_variants: z.array(z.tuple([z.string().min(1), z.string().min(1)])).optional(),
});
export type DraftBlankNormalizationT = z.infer<typeof DraftBlankNormalization>;

/**
 * 作者显式写下的大小写 / 首尾空白，和归一化段里的 casefold / trim_outer 不能各说各话。
 * 只在两边都写了且互相否定时拒绝。省略归一化字段不算冲突，提交侧会用作者的布尔盖过去。
 */
export function blankTextKeyConflict(key: {
  case_sensitive?: boolean;
  trim?: boolean;
  normalization?: { casefold?: boolean; trim_outer?: boolean };
}): string | null {
  if (key.case_sensitive === true && key.normalization?.casefold === true) {
    return 'case_sensitive true conflicts with normalization.casefold true';
  }
  if (key.case_sensitive === false && key.normalization?.casefold === false) {
    return 'case_sensitive false conflicts with normalization.casefold false';
  }
  if (key.trim === false && key.normalization?.trim_outer === true) {
    return 'trim false conflicts with normalization.trim_outer true';
  }
  if (key.trim === true && key.normalization?.trim_outer === false) {
    return 'trim true conflicts with normalization.trim_outer false';
  }
  return null;
}

/**
 * blank key：文本 or 数值+容差/单位（与契约 BlankKeyCriterion.key 同构，独立声明避免互锁）。
 * case_sensitive 为 true 表示区分大小写；normalization.casefold 为 true 表示折叠大小写。
 * trim 为 false 表示保留首尾空白；normalization.trim_outer 为 true 表示去掉。
 * 两边都写了且互相否定时，文档不能通过校验。
 */
export const DraftBlankTextKey = z
  .object({
    kind: z.literal('text'),
    /** 全部可接受文本（与契约 BlankKeyCriterion.accepted 同构）。 */
    accepted: z.array(z.string().min(1)).min(1),
    case_sensitive: z.boolean().optional(),
    trim: z.boolean().optional(),
    normalization: DraftBlankNormalization.optional(),
  })
  .superRefine((key, ctx) => {
    const conflict = blankTextKeyConflict(key);
    if (conflict == null) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: conflict,
      path: ['normalization'],
    });
  });
export type DraftBlankTextKeyT = z.infer<typeof DraftBlankTextKey>;

export const DraftBlankNumericKey = z.object({
  kind: z.literal('numeric'),
  value: z.number(),
  /** 与契约 NumericKeyCriterion.tolerance 同构的判别 union。 */
  tolerance: z
    .discriminatedUnion('kind', [
      z.object({ kind: z.literal('absolute'), value: z.number().min(0) }),
      z.object({ kind: z.literal('relative'), ratio: z.number().min(0) }),
    ])
    .optional(),
  unit: z.string().optional(),
  equivalent_forms: z.array(z.string()).optional(),
});
export type DraftBlankNumericKeyT = z.infer<typeof DraftBlankNumericKey>;

export const DraftBlankKey = z.object({
  kind: z.literal('blank'),
  key: z.union([DraftBlankTextKey, DraftBlankNumericKey]),
});
export type DraftBlankKeyT = z.infer<typeof DraftBlankKey>;

export const DraftUnitKey = z.discriminatedUnion('kind', [DraftSelectKey, DraftBlankKey]);
export type DraftUnitKeyT = z.infer<typeof DraftUnitKey>;

export const DraftRubricCriterion = z.object({
  criterion_id: z.string().min(1),
  statement_md: z.string().optional(),
  max: z.number(),
  allowed_awards: z.array(z.number()).optional(),
  metadata: DraftMetadata.optional(),
});
export type DraftRubricCriterionT = z.infer<typeof DraftRubricCriterion>;

export const DraftRubric = z.object({
  criteria: z.array(DraftRubricCriterion),
  guidance_md: z.string().optional(),
});
export type DraftRubricT = z.infer<typeof DraftRubric>;

export const DraftMethodKind = z.enum(['set-compare', 'exact', 'jev', 'ai-rubric', 'human_review']);
export type DraftMethodKindT = z.infer<typeof DraftMethodKind>;

/** 判分方法绑定：det 方法固定签名；模型方法必须带 admitted binding（D17）。 */
export const DraftMethod = z.object({
  kind: DraftMethodKind,
  version: z.string().optional(),
  /** 已准入的能力切片 / runner 绑定引用（模型方法必填才能准入）。 */
  binding: z.string().optional(),
  /** 模型任务 kind（typed task，非通用 chat）。 */
  task_kind: z.string().optional(),
});
export type DraftMethodT = z.infer<typeof DraftMethod>;

// ---------- 计分单元 ----------

export const DraftUnit = z.object({
  unit_id: z.string().min(1),
  slot_id: z.string().min(1),
  response_class: DraftResponseClass,
  response_spec: DraftUnitResponseSpec,
  /** 未印分值允许 null（草稿未决态；规则 unknown 同理，绝不伪零）。 */
  points: z.number().min(0).nullable().optional(),
  key: DraftUnitKey.optional(),
  /** free 的参考作答（文本）。 */
  reference_md: z.string().optional(),
  rubric: DraftRubric.optional(),
  method: DraftMethod,
  /** set-compare / exact 单元的给分规则（印刷政策；缺 = 未决）。 */
  rule: ScoringRule.optional(),
  material_refs: z.array(z.string().min(1)).default([]),
  metadata: DraftMetadata.default({}),
});
export type DraftUnitT = z.infer<typeof DraftUnit>;

// ---------- part / document ----------

export const DraftPart = z.object({
  part_id: z.string().min(1),
  prompt_md: z.string().default(''),
  /** 印刷题号（显示用，不是身份）。 */
  question_no: z.string().optional(),
  /** 该 part 直接引用的共享材料。 */
  material_ids: z.array(z.string().min(1)).default([]),
  units: z.array(DraftUnit).default([]),
  /**
   * YUK-1568（第 1 片，可选）：本 part 独立 blank 槽的默认逻辑序（显式
   * slot_id 列表，恰覆盖本 part 的 blank 槽各一次；交叉校验在发布 barrier）。
   * 缺省 = 未声明，不注入默认值，旧文档 JSON/digest 不变。
   */
  blank_order: z.array(z.string().min(1)).min(1).optional(),
  /** 解析/讲解文本（公开）。 */
  explanation_md: z.string().optional(),
  metadata: DraftMetadata.default({}),
});
export type DraftPartT = z.infer<typeof DraftPart>;

export const DraftSourceKind = z.enum([
  'generated',
  'adapted',
  'owner_material',
  'photo_ingest',
  'jyeoo_fetch',
  'sourcing_web',
  'manual',
]);
export type DraftSourceKindT = z.infer<typeof DraftSourceKind>;

/** 获取来源；非 fetch 来源用自己的可复现指纹，绝不伪造 extraction_hash。 */
export const DraftSource = z.object({
  kind: DraftSourceKind,
  /** adapted 来源指向的库内 question id。 */
  adapted_from_question_id: z.string().optional(),
  /** 外部 ref（url / document / asset / 原题定位）。 */
  ref: z.string().optional(),
  note: z.string().optional(),
});
export type DraftSourceT = z.infer<typeof DraftSource>;

/** 编辑已发布题时草稿钉住的原始组与基底 revision（submit 前 CAS 校验对象）。 */
export const DraftBase = z.object({
  question_id: z.string().min(1),
  /** 建草稿时 lifecycle.current_revision_id；null = 组尚无已发布版本。 */
  revision_id: z.string().min(1).nullable().optional(),
});
export type DraftBaseT = z.infer<typeof DraftBase>;

export const QuestionDraftDocument = z.object({
  schema_version: z.literal(DRAFT_DOCUMENT_SCHEMA_VERSION),
  parts: z.array(DraftPart).default([]),
  materials: z.array(DraftMaterial).default([]),
  knowledge_ids: z.array(z.string().min(1)).default([]),
  metadata: DraftMetadata.default({}),
  /** 呈现层（另一 lane 的契约）：不透明透传保存，本 lane 不解析不验证。 */
  presentation: z.unknown().optional(),
  source: DraftSource.optional(),
  base: DraftBase.optional(),
});
export type QuestionDraftDocumentT = z.infer<typeof QuestionDraftDocument>;

// ---------- 类型守卫与归一 ----------

/** question_block.structured 的新形状：legacy StructuredQuestion（无 schema_version）或 v2 草稿。 */
export type QuestionBlockStructuredT = StructuredQuestionT | QuestionDraftDocumentT;

export function isDraftDocumentV2(value: unknown): value is QuestionDraftDocumentT {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { schema_version?: unknown }).schema_version === DRAFT_DOCUMENT_SCHEMA_VERSION
  );
}

export function isLegacyStructuredQuestion(value: unknown): value is StructuredQuestionT {
  return (
    typeof value === 'object' &&
    value !== null &&
    !isDraftDocumentV2(value) &&
    typeof (value as { id?: unknown }).id === 'string' &&
    typeof (value as { role?: unknown }).role === 'string' &&
    typeof (value as { prompt_text?: unknown }).prompt_text === 'string'
  );
}

/** 列/事件快照的松散守卫：legacy 或 v2 都接受，其它形状原样拒绝。 */
export const QuestionBlockStructured = z.union([QuestionDraftDocument, z.unknown()]);
export type QuestionBlockStructuredZ = z.infer<typeof QuestionBlockStructured>;

export function createEmptyDraftDocument(
  init?: Partial<QuestionDraftDocumentT>,
): QuestionDraftDocumentT {
  return QuestionDraftDocument.parse({
    schema_version: DRAFT_DOCUMENT_SCHEMA_VERSION,
    parts: [],
    materials: [],
    knowledge_ids: [],
    metadata: {},
    ...(init ?? {}),
  });
}

// ---------- 稳定身份 mint ----------

function shortHash(input: string): string {
  return bytesToHex(sha256(utf8ToBytes(input))).slice(0, 12);
}

/**
 * 内容寻址 item id：与发布侧 mintOptionId 同一语义（仅内容文本参与身份，
 * label/显示元数据不铸造身份；同宇宙内重复文本以序号消歧）。
 */
export function mintDraftItemId(text: string, disambiguator?: string): string {
  return `it_${shortHash(disambiguator != null ? `${disambiguator}\0${text}` : text)}`;
}

/** 内容寻址 material id：内容替换 ⇒ 新身份（与发布侧 mintMaterialId 同语义）。 */
export function mintDraftMaterialId(kind: string, text: string): string {
  return `mat_${shortHash(`${kind}\0${text}`)}`;
}

export function mintDraftAssetId(prefix: string, text: string): string {
  return `${prefix}_${shortHash(text)}`;
}

export function sha256Hex(input: string): string {
  return `sha256:${bytesToHex(sha256(utf8ToBytes(input)))}`;
}

// ---------- legacy StructuredQuestion → 草稿适配器 ----------

const LETTER_INDEX: Record<string, number> = {
  A: 0,
  B: 1,
  C: 2,
  D: 3,
  E: 4,
  F: 5,
  G: 6,
  H: 7,
  a: 0,
  b: 1,
  c: 2,
  d: 3,
  e: 4,
  f: 5,
  g: 6,
  h: 7,
};

/** legacy 答案头解析（"AC"、"A C"、"A,C" 等）→ 选项下标；解析不出返回 null。 */
function parseAnswerHeadIndices(head: string, optionCount: number): number[] | null {
  const tokens = head.replace(/[\s,、，;；/]/g, '');
  if (tokens.length === 0) return null;
  const indices = new Set<number>();
  for (const ch of tokens) {
    const idx = LETTER_INDEX[ch];
    if (idx === undefined || idx >= optionCount) return null;
    indices.add(idx);
  }
  return [...indices].sort((a, b) => a - b);
}

/** 与发布侧 extractAnswerHead 同语义的最小实现：取答案行首部（"答：B"→"B"）。 */
function extractAnswerHeadLite(answer: string): string {
  const trimmed = answer.trim();
  const head = trimmed.split(/\r?\n/, 1)[0]?.trim() ?? '';
  const m = /^(?:答|答案|正确答案)\s*[:：]?\s*(.+)$/u.exec(head);
  return (m?.[1] ?? head).trim();
}

interface LeafAdapter {
  part: DraftPartT;
  stemTexts: string[];
}

/**
 * legacy 叶节点 → part + 一个 unit。options → select（字母键解析进
 * accepted_item_ids）；无选项且答案可 exact → blank；否则 free（reference 承载
 * 答案原文，绝不伪造键）。规则按印刷政策诚实生成：单选/单空 otherwise=0
 * （全对/全错语义没有部分分），多选 otherwise=unknown（无印部分规则不造分）。
 */
function adaptLeaf(leaf: StructuredQuestionT): LeafAdapter {
  const options = leaf.options ?? [];
  const answers = (leaf.answers ?? []).filter((t) => t.trim().length > 0);
  const unitId = `${leaf.id}::u`;
  const slotId = `${leaf.id}::r`;
  const part: DraftPartT = {
    part_id: leaf.id,
    prompt_md: leaf.prompt_text,
    ...(leaf.question_no != null ? { question_no: leaf.question_no } : {}),
    material_ids: [],
    units: [],
    ...(leaf.analysis != null && leaf.analysis.trim().length > 0
      ? { explanation_md: leaf.analysis }
      : {}),
    metadata: {
      ...(leaf.kind != null ? { kind: leaf.kind } : {}),
      ...(leaf.source != null ? { extracted_by: leaf.source } : {}),
      ...(leaf.page_index != null ? { page_index: leaf.page_index } : {}),
      ...(leaf.bbox != null ? { bbox: leaf.bbox } : {}),
      ...(leaf.student_answer_present != null
        ? { student_answer_present: leaf.student_answer_present }
        : {}),
    },
  };
  if (options.length >= 2) {
    const items = options.map((opt) => ({
      item_id: mintDraftItemId(opt.text),
      label_md: opt.text,
      metadata: { label: opt.label },
    }));
    const head = answers.length > 0 ? extractAnswerHeadLite(answers[0]) : '';
    const accepted = head ? parseAnswerHeadIndices(head, options.length) : null;
    const multi = accepted != null && accepted.length > 1;
    const points = 1;
    const key =
      accepted != null && accepted.length > 0
        ? ({
            kind: 'select' as const,
            accepted_item_ids: accepted.map((i) => items[i].item_id),
          } satisfies DraftSelectKeyT)
        : undefined;
    part.units.push({
      unit_id: unitId,
      slot_id: slotId,
      response_class: 'select',
      response_spec: {
        kind: 'select',
        items,
        pick: multi ? 'many' : 'one',
      },
      points,
      ...(key != null ? { key } : {}),
      method: { kind: 'set-compare' },
      rule: {
        version: 1,
        cases: [
          {
            when: { miss: { eq: 0 }, wrong: { eq: 0 } },
            award: { points },
          },
        ],
        otherwise: multi ? { unknown: 'partial_points_not_printed' } : { points: 0 },
      },
      material_refs: [],
      metadata: {},
    });
    return { part, stemTexts: [] };
  }
  if (answers.length > 0 && isShortAnswer(answers[0])) {
    const points = 1;
    part.units.push({
      unit_id: unitId,
      slot_id: slotId,
      response_class: 'blank',
      response_spec: { kind: 'blank', format: 'text' },
      points,
      key: { kind: 'blank', key: { kind: 'text', accepted: [extractAnswerHeadLite(answers[0])] } },
      method: { kind: 'exact' },
      rule: {
        version: 1,
        cases: [{ when: { correct: { eq: 1 } }, award: { points } }],
        otherwise: { points: 0 },
      },
      material_refs: [],
      metadata: {},
    });
    return { part, stemTexts: [] };
  }
  part.units.push({
    unit_id: unitId,
    slot_id: slotId,
    response_class: 'free',
    response_spec: { kind: 'free' },
    ...(answers.length > 0 ? { reference_md: answers.join('\n\n') } : {}),
    method: { kind: 'ai-rubric' },
    material_refs: [],
    metadata: {},
  });
  return { part, stemTexts: [] };
}

/** 短答案启发式：单行且 ≤80 字按 blank 适配（更长/多行走 free 不伪造键）。 */
function isShortAnswer(answer: string): boolean {
  const head = extractAnswerHeadLite(answer);
  return head.length > 0 && head.length <= 80 && !head.includes('\n');
}

/**
 * legacy StructuredQuestion 树 → v2 草稿文档。stem 文本（含 sub_questions 的容器
 * 节点）摊平为共享 plaintext 材料并被各叶 part 引用；叶 node id 保留为 part_id
 * （身份保留——语义连续性由发布侧 diff 裁决）。
 */
export function structuredQuestionToDraftDocument(
  root: StructuredQuestionT,
  figures: FigureRefT[] = [],
): QuestionDraftDocumentT {
  const materials: DraftMaterialT[] = [];
  const materialIdForAsset = new Map<string, string>();
  for (const figure of figures) {
    const materialId = mintDraftMaterialId('figure', `unverified:${figure.asset_id}`);
    if (!materialIdForAsset.has(figure.asset_id)) {
      materialIdForAsset.set(figure.asset_id, materialId);
      materials.push({
        material_id: materialId,
        kind: 'figure',
        asset: { asset_id: figure.asset_id, digest: `unverified:${figure.asset_id}` },
        alt_text: `figure (${figure.role}; digest unverified)`,
        metadata: { attach_confidence: figure.attach_confidence },
      });
    }
  }
  const attachMaterialId = (nodeId: string): string[] => {
    const ids: string[] = [];
    for (const figure of figures) {
      if (figure.attached_to_index === nodeId) {
        const id = materialIdForAsset.get(figure.asset_id);
        if (id != null) ids.push(id);
      }
    }
    return ids;
  };

  const parts: DraftPartT[] = [];
  const subs = root.sub_questions ?? [];
  if (subs.length === 0) {
    const { part } = adaptLeaf(root);
    part.material_ids = attachMaterialId(root.id);
    parts.push(part);
  } else {
    // stem 文本 → 共享材料（带字节，content 即资产）。
    const stemMaterialId = mintDraftMaterialId('plaintext', root.prompt_text);
    materials.unshift({
      material_id: stemMaterialId,
      kind: 'plaintext',
      asset: {
        asset_id: mintDraftAssetId('txt', root.prompt_text),
        digest: sha256Hex(root.prompt_text),
      },
      caption: 'stem/shared context',
      content_md: root.prompt_text,
    });
    for (const sub of subs) {
      const { part } = adaptLeaf(sub);
      part.material_ids = [stemMaterialId, ...attachMaterialId(sub.id)];
      parts.push(part);
    }
  }
  return createEmptyDraftDocument({
    parts,
    materials,
    metadata: {
      adapted_from: 'structured_question',
      ...(root.kind != null ? { kind: root.kind } : {}),
      ...(root.extraction_evidence != null
        ? { extraction_evidence: root.extraction_evidence }
        : {}),
    },
  });
}

// ---------- 草稿 → legacy 投影（question.structured 兼容视图） ----------

/**
 * v2 文档 → legacy StructuredQuestion 形状（只读投影：题库详情/地址化读取等
 * 旧消费者继续可读）。单 part → standalone 节点；多 part → stem + subs。
 * 答案权威字段原样映射进 answers（select 键 → item label，blank → key 文本，
 * free → reference）。不可逆字段（typed rule/method/metadata）不进投影。
 */
export function draftDocumentToStructuredQuestion(
  doc: QuestionDraftDocumentT,
): StructuredQuestionT {
  const leafFor = (part: DraftPartT, role: 'sub' | 'standalone'): StructuredQuestionT => {
    // part.units[1..] 不得静默丢失 —— 多 unit part 展开为 stem 节点，
    // 每 unit 一个显式子叶，id 取 `<part_id>__<unit_id>` 稳定坐标。
    if (part.units.length > 1) {
      const stemNode: StructuredQuestionT = {
        id: part.part_id,
        role: 'stem',
        ...(part.question_no != null ? { question_no: part.question_no } : {}),
        prompt_text: part.prompt_md,
        source: 'agent_edit',
        sub_questions: part.units.map((unit) => unitLeafFor(part, unit)),
      };
      return stemNode;
    }
    const unit = part.units[0];
    const node: StructuredQuestionT = {
      id: part.part_id,
      role,
      ...(part.question_no != null ? { question_no: part.question_no } : {}),
      prompt_text: part.prompt_md,
      source: 'agent_edit',
    };
    if (unit?.response_spec.kind === 'select' && unit.response_spec.items.length > 0) {
      node.options = unit.response_spec.items.map((item, idx) => ({
        label: String.fromCharCode(65 + idx),
        text: item.label_md ?? item.item_id,
      }));
    }
    const answers: string[] = [];
    if (unit?.key?.kind === 'select') {
      const byId = new Map(
        unit.response_spec.kind === 'select'
          ? unit.response_spec.items.map((item) => [item.item_id, item] as const)
          : [],
      );
      const labels = unit.key.accepted_item_ids
        .map((id) => byId.get(id))
        .map((item) =>
          item != null
            ? unit.response_spec.kind === 'select'
              ? String.fromCharCode(
                  65 + unit.response_spec.items.findIndex((i) => i.item_id === item.item_id),
                )
              : ''
            : '',
        )
        .filter((label) => label.length > 0);
      if (labels.length > 0) answers.push(labels.join(''));
    } else if (unit?.key?.kind === 'blank') {
      answers.push(
        unit.key.key.kind === 'text'
          ? unit.key.key.accepted.join(' / ')
          : String(unit.key.key.value),
      );
    } else if (unit?.reference_md != null) {
      answers.push(unit.reference_md);
    }
    if (answers.length > 0) node.answers = answers;
    if (part.explanation_md != null) node.analysis = part.explanation_md;
    return node;
  };

  const unitLeafFor = (part: DraftPartT, unit: DraftUnitT): StructuredQuestionT => {
    const node: StructuredQuestionT = {
      id: `${part.part_id}__${unit.unit_id}`,
      role: 'sub',
      prompt_text: part.prompt_md,
      source: 'agent_edit',
    };
    if (unit.response_spec.kind === 'select' && unit.response_spec.items.length > 0) {
      node.options = unit.response_spec.items.map((item, idx) => ({
        label: String.fromCharCode(65 + idx),
        text: item.label_md ?? item.item_id,
      }));
    }
    const answers: string[] = [];
    if (unit.key?.kind === 'select') {
      const byId = new Map(
        unit.response_spec.kind === 'select'
          ? unit.response_spec.items.map((item) => [item.item_id, item] as const)
          : [],
      );
      const labels = unit.key.accepted_item_ids
        .map((id) => byId.get(id))
        .map((item) =>
          item != null
            ? unit.response_spec.kind === 'select'
              ? String.fromCharCode(
                  65 + unit.response_spec.items.findIndex((i) => i.item_id === item.item_id),
                )
              : ''
            : '',
        )
        .filter((label) => label.length > 0);
      if (labels.length > 0) answers.push(labels.join(''));
    } else if (unit.key?.kind === 'blank') {
      answers.push(
        unit.key.key.kind === 'text'
          ? unit.key.key.accepted.join(' / ')
          : String(unit.key.key.value),
      );
    } else if (unit.reference_md != null) {
      answers.push(unit.reference_md);
    }
    if (answers.length > 0) node.answers = answers;
    return node;
  };

  if (doc.parts.length === 1) {
    return leafFor(doc.parts[0], 'standalone');
  }
  const stemText = doc.parts
    .flatMap((part) => part.material_ids)
    .map((id) => doc.materials.find((m) => m.material_id === id))
    .find((m) => m != null && m.caption === 'stem/shared context')?.content_md;
  const stemId = doc.base?.question_id ?? 'group';
  return {
    id: stemId,
    role: 'stem',
    prompt_text: stemText ?? '',
    source: 'agent_edit',
    sub_questions: doc.parts.map((part) => leafFor(part, 'sub')),
  };
}
