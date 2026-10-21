import { MAX_IMAGE_UPLOAD_BYTES } from '@/core/limits';
// 把 legacy question 工作副本归一为评估契约四层，供 publisher 在同一事务内铸成
// 不可变 revision。
//
// 保真：共享题干/rubric 以内联字节进 structure；figure 需调用方核验的实内容
// digest，缺失即 unverified + conversion issue。每个 part 只用它自己的答案来源；
// standalone 单叶可回退行级 reference，stem+subs 的无答案叶不继承 root reference，
// 解析不出时记 unrepresentable_answer，绝不发明键。
//
// rule_reference.source 看答案证据来源而非题目获取来源（ai_generated 永不 official）。
// 无可用依据的 part 记 conversion_issues，publisher 强制 withheld。
//
// 身份：part_id 的语义连续由 publisher 的 semantic diff 裁决；option_id 仅由文本
// 决定（relabel 不换身份）；material_id 内容寻址。

import { createHash } from 'node:crypto';
import type {
  ExecutionPlanT,
  NumericKeyCriterionT,
  PresentationT,
  QuestionGroupStructureT,
  ResponseOptionT,
  ResponseSlotT,
  ResponseSpecT,
  ScoringBasisT,
} from '@/core/schema/assessment';
import {
  ExecutionPlan,
  Presentation,
  QuestionGroupStructure,
  ResponseSpec,
  ScoringBasis,
} from '@/core/schema/assessment';
import { ConjectureProbeSpec, ConjectureProbeSpecV2 } from '@/core/schema/business';
import { extractAnswerHead, isExactCapableReference } from '@/core/schema/judge-routing';
import type { FigureRefT, StructuredQuestionT } from '@/core/schema/structured_question';

import { createProbeV2Criterion } from './assessment-probe-criterion';

type JsonObject = Record<string, unknown>;

/** rule_reference.source 合法值。 */
export type RuleProvenance = 'official' | 'system_proposed' | 'manual';

/** 转换未决项；有 issue 的组 publisher 强制 withheld。 */
export interface ConversionIssue {
  code: 'missing_reference' | 'unrepresentable_answer' | 'unverified_figure_digest';
  partId: string;
  detail: string;
}

/** Legacy 工作副本的契约归一输入（question 行的宽松投影 + 可选 parts）。 */
export interface NormalizableQuestionRow {
  id: string;
  kind: string;
  prompt_md: string;
  reference_md: string | null;
  rubric_json: JsonObject | null;
  choices_md: string[] | null;
  judge_kind_override: string | null;
  metadata?: JsonObject | null;
  structured: StructuredQuestionT | null;
  /** 语义不变的编辑会保留这些身份来源。 */
  parent_question_id?: string | null;
  /** 题目获取来源（provenance 映射用；缺省按 system_proposed 保守处理）。 */
  source?: string | null;
  /** 附图资产（→ structure.materials；内容寻址身份）。 */
  figures?: FigureRefT[] | null;
  /** 调用方核验过的 figure 实内容 digest（asset_id → sha256 hex，来自 asset
   * store 元数据）；缺失的 figure ⇒ 如实标 unverified digest + conversion issue。 */
  figureDigests?: Record<string, string> | null;
}

export interface NormalizedContract {
  structure: QuestionGroupStructureT;
  response_spec: ResponseSpecT;
  scoring_basis: ScoringBasisT;
  execution_plan: ExecutionPlanT;
  /** 从组根 structured.presentation 提升；digest 覆盖该层，缺省时旧 digest 不变。 */
  presentation?: PresentationT;
  /** 版本化完整性 digest：四层 canonical JSON 的 sha256（§3.1）。 */
  integrity_digest: string;
  /** 本组 root question id（单题 = 自身；part = 父）。 */
  group_id: string;
  /** 未决转换项（空 = 全部 part 有可发布品格依据）。 */
  conversion_issues: ConversionIssue[];
  /** 'reference' 含答案原文；'rubric'/'placeholder' 不得当答案用。 */
  rule_statement_origins?: Record<string, 'reference' | 'rubric' | 'placeholder'>;
}

function shortHash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 12);
}

function sha256Hex(input: string): string {
  return `sha256:${createHash('sha256').update(input).digest('hex')}`;
}

/**
 * 仅文本参与 option 身份；label 只是显示元数据。disambiguator 只处理同槽重复文本。
 */
export function mintOptionId(text: string, disambiguator?: string): string {
  return `opt_${shortHash(disambiguator != null ? `${disambiguator}\0${text}` : text)}`;
}

/** 内容寻址 material id；内容替换即新身份。 */
export function mintMaterialId(kind: string, text: string): string {
  return `mat_${shortHash(`${kind}\0${text}`)}`;
}

/**
 * 答案证据来源决定 provenance，与题目获取来源无关；AI 补写的答案永不 official。
 */
export function ruleProvenanceFor(
  source?: string | null,
  rubric?: JsonObject | null,
): RuleProvenance {
  if (rubric?.reference_solution_source === 'ai_generated') return 'system_proposed';
  if (source === 'web_sourced') return 'official';
  if (source === 'manual') return 'manual';
  return 'system_proposed';
}

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

/**
 * 解析 legacy 字母答案头（"AC" / "A C" / "A,C"）；null 表示不可解析，走 rule_reference。
 */
function parseChoiceAnswerHead(head: string, optionCount: number): number[] | null {
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

/** rubric → 稳定规则原文（确定性序列化；不发明内容，只保真呈现）。 */
function rubricToStatementMd(rubric: JsonObject): string {
  return JSON.stringify(rubric, null, 0);
}

interface MaterialBuild {
  materials: QuestionGroupStructureT['materials'];
  issues: ConversionIssue[];
}

/** 组级共享材料（stem/figures/rubric）；figure digest 缺失即 unverified + issue。 */
function buildSharedMaterials(ctx: {
  stemText: string | null;
  figures: FigureRefT[];
  figureDigests: Record<string, string> | null;
  rubric: JsonObject | null;
  partIdForIssues: string;
}): MaterialBuild {
  const materials: QuestionGroupStructureT['materials'] = [];
  const issues: ConversionIssue[] = [];
  if (ctx.stemText != null && ctx.stemText.trim().length > 0) {
    materials.push({
      material_id: mintMaterialId('plaintext', ctx.stemText),
      kind: 'plaintext',
      asset: { asset_id: `txt_${shortHash(ctx.stemText)}`, digest: sha256Hex(ctx.stemText) },
      caption: 'stem/shared context',
      content_md: ctx.stemText,
    });
  }
  for (const figure of ctx.figures) {
    const verified = ctx.figureDigests?.[figure.asset_id];
    if (verified == null) {
      // 不伪造 digest：标记未核验，publisher 会 withheld 该组。
      issues.push({
        code: 'unverified_figure_digest',
        partId: ctx.partIdForIssues,
        detail: `figure asset '${figure.asset_id}' has no verified content digest from the asset store`,
      });
      const unverifiedId = mintMaterialId('figure', `unverified:${figure.asset_id}`);
      if (!materials.some((m) => m.material_id === unverifiedId)) {
        materials.push({
          material_id: unverifiedId,
          kind: 'figure',
          asset: { asset_id: figure.asset_id, digest: `unverified:${figure.asset_id}` },
          alt_text: `figure (${figure.role}; digest unverified)`,
        });
      }
      continue;
    }
    const verifiedId = mintMaterialId('figure', verified);
    if (!materials.some((m) => m.material_id === verifiedId)) {
      materials.push({
        material_id: verifiedId,
        kind: 'figure',
        asset: { asset_id: figure.asset_id, digest: `sha256:${verified}` },
        alt_text: `figure (${figure.role})`,
      });
    }
  }
  if (ctx.rubric != null) {
    const rubricText = rubricToStatementMd(ctx.rubric);
    materials.push({
      material_id: mintMaterialId('rubric', rubricText),
      kind: 'plaintext',
      asset: { asset_id: `rub_${shortHash(rubricText)}`, digest: sha256Hex(rubricText) },
      visibility: 'private',
      caption: 'rubric (authoritative scoring input)',
      content_md: rubricText,
    });
  }
  return { materials, issues };
}

/** 一个可作答 part 的全部归一输入。 */
interface LeafInput {
  partId: string;
  prompt: string;
  choices: string[] | null;
  /** 该 part 自己的答案文本候选（叶 answers / part 行 reference）。 */
  answerTexts: string[];
  /**
   * answerTexts 来自行级 reference_md 的 standalone 兜底。exact-capable 时直接铸
   * text_key；选择槽解析不出字母则记 unrepresentable_answer。
   */
  answerFromRowReference?: boolean;
  judgeKindOverride: string | null;
  numericKey?: NumericKeyCriterionT;
  provenance: RuleProvenance;
  rubric: JsonObject | null;
}

/** 判分依据归一结果（criterion + 该 part 的槽位定型）。 */
interface LeafScoring {
  slot: ResponseSlotT;
  criterionKind: 'option_set_key' | 'text_key' | 'numeric_key' | 'rule_reference';
  numericKey?: NumericKeyCriterionT;
  acceptedOptionIds?: string[];
  acceptedTexts?: string[];
  ruleStatement?: string;
  ruleProvenance?: RuleProvenance;
  /** 'reference' 含答案原文；'rubric'/'placeholder' 绝非答案。 */
  ruleStatementOrigin?: 'reference' | 'rubric' | 'placeholder';
  issue?: ConversionIssue;
}

/** 文本寻址的槽内选项；重复文本以序号确定性消歧。 */
function mintSlotOptions(texts: string[]): ResponseOptionT[] {
  const seen = new Map<string, number>();
  return texts.map((text, idx) => {
    const dup = seen.get(text) ?? 0;
    seen.set(text, dup + 1);
    return {
      option_id: mintOptionId(text, dup > 0 ? `#${dup}` : undefined),
      label: String.fromCharCode(65 + idx),
      text,
    };
  });
}

/** 数值键只来自已知 metadata；不继承 5% 容差或旧部分给分阶梯。 */
function numericKeyFor(row: {
  kind?: string;
  judge_kind_override?: string | null;
  metadata?: JsonObject | null;
}): NumericKeyCriterionT | undefined {
  if (
    row.judge_kind_override !== 'unit_dimension' &&
    !(row.judge_kind_override == null && row.kind === 'calculation')
  )
    return;
  const meta = row.metadata;
  if (
    !meta ||
    typeof meta.reference_value !== 'number' ||
    !Number.isFinite(meta.reference_value) ||
    typeof meta.reference_unit !== 'string' ||
    !meta.reference_unit.trim()
  )
    return;
  const tolerance = meta.reference_tolerance;
  if (
    tolerance !== undefined &&
    (typeof tolerance !== 'number' || !Number.isFinite(tolerance) || tolerance < 0)
  )
    return;
  return {
    kind: 'numeric_key',
    expected: meta.reference_value,
    expected_unit: meta.reference_unit.trim(),
    tolerance:
      typeof tolerance === 'number' && meta.reference_value !== 0
        ? { kind: 'relative', ratio: tolerance }
        : { kind: 'absolute', value: typeof tolerance === 'number' ? tolerance : 0 },
  };
}

function normalizeLeafScoring(leaf: LeafInput): LeafScoring {
  const slotId = `${leaf.partId}::r`;
  const answerText = leaf.answerTexts.find((t) => t != null && t.trim().length > 0) ?? null;

  if (leaf.choices != null && leaf.choices.length >= 2) {
    const options = mintSlotOptions(leaf.choices);
    const head = answerText != null ? extractAnswerHead(answerText).trim() : '';
    const accepted = answerText != null ? parseChoiceAnswerHead(head, options.length) : null;
    if (accepted != null && accepted.length > 0) {
      const slot: ResponseSlotT =
        accepted.length === 1
          ? { slot_id: slotId, part_id: leaf.partId, kind: 'single_choice', options }
          : {
              // 多答案键 ⇒ multi_choice；接受集由 key 精确表达。
              slot_id: slotId,
              part_id: leaf.partId,
              kind: 'multi_choice',
              options,
              min_select: 1,
              max_select: options.length,
            };
      return {
        slot,
        criterionKind: 'option_set_key',
        acceptedOptionIds: accepted.map((idx) => options[idx].option_id),
      };
    }
    // 答案头不可解析时以 rule 文本承载；standalone 兜底存在但不可表示时记
    // unrepresentable_answer，不伪造键，也不冒充 official。
    const fallback = buildRuleStatement(answerText, leaf);
    return {
      slot: { slot_id: slotId, part_id: leaf.partId, kind: 'single_choice', options },
      criterionKind: 'rule_reference',
      ruleStatement: fallback.statement,
      ruleProvenance: fallback.origin === 'reference' ? leaf.provenance : 'system_proposed',
      ruleStatementOrigin: fallback.origin,
      issue:
        answerText == null
          ? missingReferenceIssue(leaf)
          : leaf.answerFromRowReference
            ? {
                code: 'unrepresentable_answer',
                partId: leaf.partId,
                detail: `row reference_md head does not parse as an option letter for slot '${slotId}' — withheld rather than minting a fabricated key`,
              }
            : undefined,
    };
  }

  if (leaf.numericKey) {
    return {
      slot: { slot_id: slotId, part_id: leaf.partId, kind: 'numeric' },
      criterionKind: 'numeric_key',
      numericKey: leaf.numericKey,
    };
  }

  const slot: ResponseSlotT = {
    slot_id: slotId,
    part_id: leaf.partId,
    kind: 'text',
    math_preview: false,
  };
  if (answerText == null) {
    const fallback = buildRuleStatement(null, leaf);
    return {
      slot,
      criterionKind: 'rule_reference',
      ruleStatement: fallback.statement,
      ruleProvenance: 'system_proposed',
      ruleStatementOrigin: fallback.origin,
      issue: missingReferenceIssue(leaf),
    };
  }
  // Standalone 兜底 reference 是已写定答案键：exact-capable 时直接铸 text_key，
  // 不要求显式 override；非兜底路径仍需 override。
  if (
    (leaf.judgeKindOverride === 'exact' || leaf.answerFromRowReference === true) &&
    isExactCapableReference(answerText)
  ) {
    return {
      slot,
      criterionKind: 'text_key',

      acceptedTexts:
        leaf.answerTexts.length > 0
          ? leaf.answerTexts.map((t) => extractAnswerHead(t))
          : [answerText],
    };
  }
  const rule = buildRuleStatement(answerText, leaf);
  return {
    slot,
    criterionKind: 'rule_reference',
    ruleStatement: rule.statement,
    ruleProvenance: rule.origin === 'reference' ? leaf.provenance : 'system_proposed',
    ruleStatementOrigin: rule.origin,
  };
}

function missingReferenceIssue(leaf: LeafInput): ConversionIssue {
  return {
    code: 'missing_reference',
    partId: leaf.partId,
    detail:
      leaf.rubric != null
        ? 'part 无参考答案（以 rubric 规则原文发布，provenance 如实标注）'
        : 'part 既无参考答案也无 rubric —— 转换未决， withheld 发布',
  };
}

/** 答案原文 + judge 意图标记；答案缺失时才用 rubric/占位，provenance 相应降级。 */
function buildRuleStatement(
  answerText: string | null,
  leaf: LeafInput,
): { statement: string; origin: 'reference' | 'rubric' | 'placeholder' } {
  const parts: string[] = [];
  let origin: 'reference' | 'rubric' | 'placeholder' = 'reference';
  if (answerText != null && answerText.trim().length > 0) {
    parts.push(answerText);
  } else if (leaf.rubric != null) {
    parts.push(rubricToStatementMd(leaf.rubric));
    origin = 'rubric';
  } else {
    parts.push('（无参考答案 —— 发布为待补规则，转换未决）');
    origin = 'placeholder';
  }
  if (leaf.judgeKindOverride != null) {
    parts.push(`（判分意图：${leaf.judgeKindOverride}）`);
  }
  return { statement: parts.join('\n\n'), origin };
}

function buildUnit(leaf: LeafInput, scoring: LeafScoring) {
  return {
    scoring_unit_id: `${leaf.partId}::u`,
    slot_refs: [scoring.slot.slot_id],
    material_refs: [] as string[],
    evidence_slot_refs: [] as string[],
    requires_group_evidence: false,
    criterion:
      scoring.criterionKind === 'option_set_key'
        ? {
            kind: 'option_set_key' as const,
            accepted_option_ids: scoring.acceptedOptionIds ?? [],
          }
        : scoring.numericKey
          ? scoring.numericKey
          : scoring.criterionKind === 'text_key'
            ? {
                kind: 'text_key' as const,
                accepted_texts: scoring.acceptedTexts ?? [],
                normalization: 'answer_head' as const,
              }
            : {
                kind: 'rule_reference' as const,
                rule_id: `${leaf.partId}::ref`,
                statement_md: scoring.ruleStatement ?? '',
                source: (scoring.ruleProvenance ?? 'system_proposed') as RuleProvenance,
              },
    points: 1,
  };
}

function executorFor(criterionKind: LeafScoring['criterionKind']) {
  switch (criterionKind) {
    case 'option_set_key':
      return { kind: 'deterministic', comparator: 'exact_option_set' } as const;
    case 'numeric_key':
      return { kind: 'deterministic', comparator: 'numeric_unit_conversion' } as const;
    case 'text_key':
      return { kind: 'deterministic', comparator: 'exact_text' } as const;
    default:
      // 未准入的模型判分不冒充，显式 human_review。
      return { kind: 'human_review' } as const;
  }
}

/**
 * 组根展示层过 Presentation；失败原样透传，由发布 barrier 拒发（不静默丢层）。
 */
function promoteStructuredPresentation(raw: unknown): PresentationT | undefined {
  if (raw == null) return undefined;
  const shaped = Presentation.safeParse(raw);
  return shaped.success ? shaped.data : (raw as PresentationT);
}

function assemble(
  groupId: string,
  materials: QuestionGroupStructureT['materials'],
  /** 每 part 引用的 material（共享材料全引用；part 私有材料只挂该 part）。 */
  materialIdsByPart: string[][],
  leaves: LeafInput[],
  extraIssues: ConversionIssue[],
  presentation?: PresentationT,
): NormalizedContract {
  // Freeze answer bytes as private material: a later reveal must not fetch a
  // newer mutable reference or synthesize a solution from the answer head.
  const frozenMaterials = [...materials];
  const frozenIdsByPart = materialIdsByPart.map((ids) => [...ids]);
  for (const [index, leaf] of leaves.entries()) {
    const text = leaf.answerTexts.filter((answer) => answer.trim().length > 0).join('\n\n');
    if (!text) continue;
    const materialId = mintMaterialId('solution', text);
    if (!frozenMaterials.some((material) => material.material_id === materialId)) {
      frozenMaterials.push({
        material_id: materialId,
        kind: 'plaintext',
        visibility: 'private',
        asset: { asset_id: `sol_${shortHash(text)}`, digest: sha256Hex(text) },
        caption: 'reference solution',
        content_md: text,
      });
    }
    frozenIdsByPart[index] ??= [];
    frozenIdsByPart[index].push(materialId);
  }
  const structure = QuestionGroupStructure.parse({
    group_id: groupId,
    materials: frozenMaterials,
    parts: leaves.map((leaf, i) => ({
      part_id: leaf.partId,
      prompt_md: leaf.prompt,
      material_ids: frozenIdsByPart[i] ?? [],
    })),
  });
  const scorings = leaves.map((leaf) => normalizeLeafScoring(leaf));
  const response_spec = ResponseSpec.parse({ slots: scorings.map((s) => s.slot) });
  const units = leaves.map((leaf, i) => buildUnit(leaf, scorings[i]));
  const scoring_basis = ScoringBasis.parse({
    units,
    aggregation: { kind: 'sum' },
    blank_scores_zero: true,
  });
  const execution_plan = ExecutionPlan.parse({
    plan_version: 1,
    assignments: units.map((unit, i) => ({
      scoring_unit_ids: [unit.scoring_unit_id],
      executor: executorFor(scorings[i].criterionKind),
    })),
    escalation: { on_unadmitted_model: 'withhold', on_low_confidence: 'human_review' },
  });
  return {
    structure,
    response_spec,
    scoring_basis,
    execution_plan,
    ...(presentation != null ? { presentation } : {}),
    integrity_digest: contractIntegrityDigest({
      structure,
      response_spec,
      scoring_basis,
      execution_plan,
      presentation,
    }),
    group_id: groupId,
    conversion_issues: [
      ...extraIssues,
      ...scorings.flatMap((s) => (s.issue != null ? [s.issue] : [])),
    ],
    rule_statement_origins: Object.fromEntries(
      scorings.flatMap((s, i) =>
        s.ruleStatementOrigin != null
          ? [[`${leaves[i].partId}::u`, s.ruleStatementOrigin] as const]
          : [],
      ),
    ),
  };
}

/**
 * 归一 legacy 行 → 评估契约四层 + integrity digest。纯函数（无 IO）。
 */
function normalizeQuestionRowBase(row: NormalizableQuestionRow): NormalizedContract {
  const group_id = row.parent_question_id ?? row.id;
  const provenance = ruleProvenanceFor(row.source, row.rubric_json);
  const figures = row.figures ?? [];

  const structuredRoot = row.structured;
  if (structuredRoot != null) {
    // stem + row prompt are shared context; leaf answers are the only answer source.
    const stemText = structuredRoot.prompt_text ?? '';
    const rowPrompt = row.prompt_md.trim();
    const stemMaterialText =
      rowPrompt.length > 0 && rowPrompt !== stemText.trim()
        ? `${stemText}\n\n${row.prompt_md}`
        : stemText;
    const shared = buildSharedMaterials({
      stemText: stemMaterialText,
      figures,
      figureDigests: row.figureDigests ?? null,
      rubric: row.rubric_json,
      partIdForIssues: structuredRoot.id,
    });
    // Standalone 单叶无 answers 时，行级 reference_md 是该题的真实答案；stem+subs
    // 的无答案叶不继承 root reference。空白 answers 与无 answers 用同一判据。
    const hasNonBlankAnswer = (answers: readonly string[] | null | undefined): boolean =>
      (answers ?? []).some((t) => t != null && t.trim().length > 0);
    const isStandaloneLeaf =
      (structuredRoot.sub_questions ?? []).length === 0 &&
      !hasNonBlankAnswer(structuredRoot.answers);
    const rowReference =
      isStandaloneLeaf && row.reference_md != null && row.reference_md.trim().length > 0
        ? row.reference_md
        : null;
    const leaves = collectLeaves(structuredRoot).map((leaf) => ({
      partId: leaf.id,
      prompt: leaf.prompt_text,
      choices: leaf.options?.map((o) => o.text) ?? null,
      answerTexts: hasNonBlankAnswer(leaf.answers)
        ? leaf.answers
        : rowReference != null
          ? [rowReference]
          : [],
      answerFromRowReference: rowReference != null && !hasNonBlankAnswer(leaf.answers),
      judgeKindOverride: row.judge_kind_override,
      numericKey:
        (structuredRoot.sub_questions ?? []).length === 0 ? numericKeyFor(row) : undefined,
      provenance,
      rubric: row.rubric_json,
    }));
    const sharedIds = shared.materials.map((m) => m.material_id);
    return assemble(
      group_id,
      shared.materials,
      leaves.map(() => sharedIds),
      leaves,
      shared.issues,

      promoteStructuredPresentation(structuredRoot.presentation),
    );
  }

  const shared = buildSharedMaterials({
    stemText: null,
    figures,
    figureDigests: row.figureDigests ?? null,
    rubric: row.rubric_json,
    partIdForIssues: row.id,
  });
  const sharedIds = shared.materials.map((m) => m.material_id);
  return assemble(
    group_id,
    shared.materials,
    [sharedIds],
    [
      {
        partId: row.id,
        prompt: row.prompt_md,
        choices: row.choices_md,
        answerTexts: row.reference_md != null ? [row.reference_md] : [],
        judgeKindOverride: row.judge_kind_override,
        numericKey: numericKeyFor(row),
        provenance,
        rubric: row.rubric_json,
      },
    ],
    shared.issues,
    // 无 structured 行没有展示层草稿位。
    undefined,
  );
}

export function normalizeQuestionRowToContract(row: NormalizableQuestionRow): NormalizedContract {
  const contract = normalizeQuestionRowBase(row);
  if (row.source === 'mind_probe' || row.metadata?.probe_spec != null) {
    const slot = contract.response_spec.slots[0];
    if (contract.response_spec.slots.length !== 1 || !slot)
      throw new Error('probe requires one response slot');
    contract.response_spec.slots = [
      {
        slot_id: slot.slot_id,
        part_id: slot.part_id,
        kind: 'open_response',
        accepted_evidence: [
          {
            kind: 'image',
            allowed_mime_patterns: ['image/png', 'image/jpeg', 'image/webp'],
            max_bytes: MAX_IMAGE_UPLOAD_BYTES,
            requires_security_scan: false,
          },
        ],
        evidence_required: false,
        max_chars: 10000,
      },
    ];
    contract.scoring_basis.units[0].evidence_slot_refs = [slot.slot_id];
    contract.scoring_basis.blank_scores_zero = false;
    contract.integrity_digest = contractIntegrityDigest(contract);
  }
  if (row.metadata?.probe_spec == null) return contract;
  const parsed = ConjectureProbeSpecV2.safeParse(
    ConjectureProbeSpec.parse(row.metadata.probe_spec),
  );
  if (!parsed.success) return contract;
  const probe = parsed.data;
  if (contract.scoring_basis.units.length !== 1 || contract.structure.parts.length !== 1) {
    throw new Error('response-aware probe requires one published scoring unit');
  }
  const unit = contract.scoring_basis.units[0];
  unit.criterion = createProbeV2Criterion({
    scoringUnitId: unit.scoring_unit_id,
    probeSpec: probe,
  });
  unit.points = 1;
  contract.scoring_basis.blank_scores_zero = false;
  contract.execution_plan.assignments = [
    {
      scoring_unit_ids: [unit.scoring_unit_id],
      executor: {
        kind: 'model_executor',
        task_kind: 'AssessmentRuleJudgeTask',
        admitted_slice_id: null,
      },
    },
  ];
  contract.integrity_digest = contractIntegrityDigest(contract);
  return contract;
}

interface LeafNode {
  id: string;
  prompt_text: string;
  answers: string[];
  options?: { label: string; text: string }[];
}

function collectLeaves(node: StructuredQuestionT, out: LeafNode[] = []): LeafNode[] {
  const subs = node.sub_questions ?? [];
  if (subs.length > 0) {
    for (const sub of subs) collectLeaves(sub, out);
    return out;
  }
  out.push({
    id: node.id,
    prompt_text: node.prompt_text,
    answers: node.answers ?? [],
    options: node.options,
  });
  return out;
}

export interface PartRow {
  kind?: string;
  judge_kind_override?: string | null;
  metadata?: JsonObject | null;
  id: string;
  prompt_md: string;
  reference_md: string | null;
  choices_md: string[] | null;
  /** Part 自己的 structured；单叶时其 options/answers 优先于行级列。 */
  structured?: StructuredQuestionT | null;
  /** Part 私有附图，只挂该 part。 */
  figures?: FigureRefT[] | null;
}

/**
 * 物理多 part 组归一：root 提供共享材料但不把 reference 摊派给 part；part 身份
 * 为子行 id，语义连续性由 publisher 的 semantic diff 裁决。
 */
export function normalizeQuestionGroupToContract(
  root: NormalizableQuestionRow,
  parts: PartRow[],
): NormalizedContract {
  if (parts.length === 0) return normalizeQuestionRowToContract(root);

  const provenance = ruleProvenanceFor(root.source, root.rubric_json);
  // Root prompt/figures/rubric 都是共享材料，随 digest 版本化。
  const shared = buildSharedMaterials({
    stemText: root.prompt_md,
    figures: root.figures ?? [],
    figureDigests: root.figureDigests ?? null,
    rubric: root.rubric_json,
    partIdForIssues: root.id,
  });
  const sharedIds = shared.materials.map((m) => m.material_id);
  const issues = [...shared.issues];

  const materialIdsByPart: string[][] = [];
  const leaves: LeafInput[] = parts.map((p) => {
    const partMaterials = [...sharedIds];
    // Part-private figures; dedupe by content identity so repeated assets add one material.
    const knownMaterialIds = new Set(shared.materials.map((m) => m.material_id));
    for (const figure of p.figures ?? []) {
      const verified = root.figureDigests?.[figure.asset_id];
      if (verified == null) {
        issues.push({
          code: 'unverified_figure_digest',
          partId: p.id,
          detail: `figure asset '${figure.asset_id}' has no verified content digest from the asset store`,
        });
        const unverifiedId = mintMaterialId('figure', `unverified:${figure.asset_id}`);
        if (!partMaterials.includes(unverifiedId)) partMaterials.push(unverifiedId);
        if (!knownMaterialIds.has(unverifiedId)) {
          knownMaterialIds.add(unverifiedId);
          shared.materials.push({
            material_id: unverifiedId,
            kind: 'figure',
            asset: { asset_id: figure.asset_id, digest: `unverified:${figure.asset_id}` },
            alt_text: `figure (${figure.role}; digest unverified)`,
          });
        }
        continue;
      }
      const materialId = mintMaterialId('figure', verified);
      if (!partMaterials.includes(materialId)) partMaterials.push(materialId);
      if (!knownMaterialIds.has(materialId)) {
        knownMaterialIds.add(materialId);
        shared.materials.push({
          material_id: materialId,
          kind: 'figure',
          asset: { asset_id: figure.asset_id, digest: `sha256:${verified}` },
          alt_text: `figure (${figure.role})`,
        });
      }
    }
    materialIdsByPart.push(partMaterials);

    // 单叶 structured 的 options/answers 优先于行级列。
    const structuredLeaf = p.structured != null ? collectLeaves(p.structured)[0] : undefined;
    const choices = structuredLeaf?.options?.map((o) => o.text) ?? p.choices_md ?? null;
    const answerTexts = structuredLeaf?.answers?.length
      ? structuredLeaf.answers
      : p.reference_md != null
        ? [p.reference_md]
        : [];
    return {
      partId: p.id,
      // Prefer the edited structured leaf text; flat prompt_md can lag and would
      // make an accepted edit a noop.
      prompt: structuredLeaf?.prompt_text ?? p.prompt_md,
      choices,
      answerTexts,
      judgeKindOverride: root.judge_kind_override,
      numericKey: numericKeyFor({
        ...p,
        judge_kind_override: p.judge_kind_override ?? root.judge_kind_override,
      }),
      provenance,
      rubric: null,
    };
  });
  return assemble(
    root.id,
    shared.materials,
    materialIdsByPart,
    leaves,
    issues,
    // Only the group root carries presentation; part rows are not promoted.
    promoteStructuredPresentation(root.structured?.presentation),
  );
}

/** 四层 + 可选 presentation 的 sha256；无 presentation 时与旧 digest 一致。 */
export function contractIntegrityDigest(contract: {
  structure: unknown;
  response_spec: unknown;
  scoring_basis: unknown;
  execution_plan: unknown;
  presentation?: unknown;
}): string {
  const canonical = JSON.stringify(contractLayers(contract), (_key, value) => value);
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

function contractLayers(contract: {
  structure: unknown;
  response_spec: unknown;
  scoring_basis: unknown;
  execution_plan: unknown;
  presentation?: unknown;
}): {
  structure: unknown;
  response_spec: unknown;
  scoring_basis: unknown;
  execution_plan: unknown;
  presentation?: unknown;
} {
  return {
    structure: contract.structure,
    response_spec: contract.response_spec,
    scoring_basis: contract.scoring_basis,
    execution_plan: contract.execution_plan,
    ...(contract.presentation != null ? { presentation: contract.presentation } : {}),
  };
}

function stableContractJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    item !== null && typeof item === 'object' && !Array.isArray(item)
      ? Object.keys(item)
          .sort()
          .reduce<Record<string, unknown>>((acc, key) => {
            acc[key] = (item as Record<string, unknown>)[key];
            return acc;
          }, {})
      : item,
  );
}

export interface PublishedContractSeal {
  parsed: {
    structure: QuestionGroupStructureT;
    response_spec: ResponseSpecT;
    scoring_basis: ScoringBasisT;
    execution_plan: ExecutionPlanT;
    presentation?: PresentationT;
  };
  /** 按发布 schema 解析后再按稳定键序序列化。 */
  canonical: string;
  /** 旧封存：schema 解析对象的键序（zod）。 */
  legacyParsed: string;
  /** 旧封存：对象自身键序；从库存读回时是 jsonb 键序，不是当初调用方的键序。 */
  legacyRaw: string;
}

/** 发布与准入共用的契约封存；旧 revision 可能仍是 legacyParsed/legacyRaw。 */
export function publishedContractSeal(contract: {
  structure: unknown;
  response_spec: unknown;
  scoring_basis: unknown;
  execution_plan: unknown;
  presentation?: unknown;
}): PublishedContractSeal {
  const parsed = {
    structure: QuestionGroupStructure.parse(contract.structure),
    response_spec: ResponseSpec.parse(contract.response_spec),
    scoring_basis: ScoringBasis.parse(contract.scoring_basis),
    execution_plan: ExecutionPlan.parse(contract.execution_plan),
    ...(contract.presentation != null
      ? { presentation: Presentation.parse(contract.presentation) }
      : {}),
  };
  return {
    parsed,
    canonical: `sha256:${createHash('sha256').update(stableContractJson(parsed)).digest('hex')}`,
    legacyParsed: contractIntegrityDigest(parsed),
    legacyRaw: contractIntegrityDigest(contract),
  };
}

/**
 * 只接受从这份对象重算的三种封印；值被改过时三者都会变。调用方键序与 jsonb 键序
 * 不在这里另开一档。
 */
export function publishedSealAccepts(seal: PublishedContractSeal, digest: string): boolean {
  return digest === seal.canonical || digest === seal.legacyParsed || digest === seal.legacyRaw;
}
