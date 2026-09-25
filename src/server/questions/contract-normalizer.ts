// YUK-1043 — 统一发布链 · 契约 normalizer（grounding §3.1/§4.4；复审 P1-2/P1-3）。
//
// 把 legacy `question` 工作副本（flat 列）转换为 YUK-1046 评估契约四层
// （structure / response_spec / scoring_basis / execution_plan），供 publisher
// 在同一事务内铸成不可变 question_revision。
//
// 保真纪律（P1-2 —— 归一不得丢失或发明权威内容）：
//   - 题干/共享上下文（复合 root prompt、structured stem、rubric）以
//     【带字节】的 material 内联进 structure（content_md；复审 P1-2a：不可变
//     revision 必须自恢复共享段落，不能只留 hash 引用）；figures 引用 asset
//     store 的真实资产 + 由调用方核验的实内容 digest（无核验值 ⇒ 如实标注
//     unverified，不伪造）；
//   - 每个 part 的判分依据来自【它自己的】答案来源（part 行 reference /
//     structured 叶 answers）；root 的 reference 与无答案叶【绝不】互相兜底
//     （复审 P1-2b：缺叶答案 ⇒ conversion_issue + withheld，不继承 root 键）；
//   - rule_reference.source 按【答案证据】的实际来源映射（复审 P1-2c：
//     rubric.reference_solution_source='ai_generated' ⇒ system_proposed，
//     即使题目本身来自 web_sourced —— 题目获取来源 ≠ 答案权威来源，D1）；
//     web_sourced 页面参考 → official、manual 录入 → manual、其余模型链 →
//     system_proposed；rubric/placeholder 来源一律不冒充 official；
//   - judge_kind_override 进入 rule 文本标记行 ⇒ 改判分意图 ⇒ digest 变。
//
// 多答案键（P1-3）：reference 头解析出 ≥2 个字母 ⇒ multi_choice 槽
// （min 1 / max options.length，接受集由 option_set_key 精确表达）+
// exact_option_set —— 不再把多选键塞进 single_choice（校验器拒绝、合法作答
// 无法表示）。
//
// 未决转换（fail-honest）：无可用品格依据的 part 记入 conversion_issues；
// publisher 据此强制 withheld —— 显式 unresolved，绝不发明 one-point 规则。
//
// 身份纪律（§3.1；复审 P1-3 裁决）：
//   - part_id：structured 叶 node id / 物理子行 id / 单题行 id。行/node 保留
//     只是【实体】保留；语义是否连续由 publisher 的 SEMANTIC diff 裁决
//     （判分相关内容实质变化 ⇒ replaced + 显式映射，绝不静默记 retained）。
//   - slot_id：`{part_id}::r` 派生 —— part 保留 ⇒ slot 保留。
//   - option_id：`opt_<sha256(text)>` —— 【仅文本】参与身份（label 是显示
//     元数据，不是身份输入；复审裁决：relabel 不铸造新身份）。同槽内文本
//     重复时以序号后缀消歧（病态形状，确定性处理）。
//   - material_id：内容寻址（sha256(kind\0text)）—— 内容不变 ⇒ 稳定；
//     内容替换 ⇒ 新身份。

import { createHash } from 'node:crypto';
import type {
  ExecutionPlanT,
  QuestionGroupStructureT,
  ResponseOptionT,
  ResponseSlotT,
  ResponseSpecT,
  ScoringBasisT,
} from '@/core/schema/assessment';
import {
  ExecutionPlan,
  QuestionGroupStructure,
  ResponseSpec,
  ScoringBasis,
} from '@/core/schema/assessment';
import { extractAnswerHead, isExactCapableReference } from '@/core/schema/judge-routing';
import type { FigureRefT, StructuredQuestionT } from '@/core/schema/structured_question';

type JsonObject = Record<string, unknown>;

/** rule_reference.source 合法值（YUK-1046 scoring.ts）。 */
export type RuleProvenance = 'official' | 'system_proposed' | 'manual';

/** 转换未决项 —— 有 issue 的组 publisher 强制 withheld（不发明品格依据）。 */
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
  /** 版本化完整性 digest：四层 canonical JSON 的 sha256（§3.1）。 */
  integrity_digest: string;
  /** 本组 root question id（单题 = 自身；part = 父）。 */
  group_id: string;
  /** 未决转换项（空 = 全部 part 有可发布品格依据）。 */
  conversion_issues: ConversionIssue[];
}

function shortHash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 12);
}

function sha256Hex(input: string): string {
  return `sha256:${createHash('sha256').update(input).digest('hex')}`;
}

/**
 * 内容寻址 option id —— 仅【文本】参与身份（P1-3 裁决：label 是显示元数据，
 * relabel 不铸造新身份；文本变 ⇒ 新身份 = 语义替换）。disambiguator 仅用于
 * 同槽内文本重复的病态形状（确定性消歧）。
 */
export function mintOptionId(text: string, disambiguator?: string): string {
  return `opt_${shortHash(disambiguator != null ? `${disambiguator}\0${text}` : text)}`;
}

/** 内容寻址 material id：素材内容替换 ⇒ 新身份（§3.1）。 */
export function mintMaterialId(kind: string, text: string): string {
  return `mat_${shortHash(`${kind}\0${text}`)}`;
}

/**
 * 答案权威 provenance 映射（P1-2c：看【答案证据】来源，不是题目获取来源）：
 *   - rubric.reference_solution_source === 'ai_generated' ⇒ system_proposed
 *     （solution-generate backfill 的显式留痕 —— AI 补写的答案绝不 official）；
 *   - web_sourced 页面参考 ⇒ official；manual 人工录入 ⇒ manual；
 *   - 其余模型链（quiz_gen / dreaming / mistake_variant / …）⇒ system_proposed。
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
 * 解析 reference head 为选项下标集合。legacy exact 判分的字母语义：接受
 * "AC"、"A C"、"A,C" 等形式。返回 null = 解析不可得（走 rule_reference）。
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

/** 构建组级共享材料（stem 文本 / root figures / root rubric）。文本材料带
 * content_md 字节；figure 用调用方核验的实 digest（缺失 ⇒ unverified + issue）。 */
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
      // 不伪造内容 digest：如实标注未核验（publisher 会 withheld 该组）。
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
  judgeKindOverride: string | null;
  provenance: RuleProvenance;
  rubric: JsonObject | null;
}

/** 判分依据归一结果（criterion + 该 part 的槽位定型）。 */
interface LeafScoring {
  slot: ResponseSlotT;
  criterionKind: 'option_set_key' | 'text_key' | 'rule_reference';
  acceptedOptionIds?: string[];
  acceptedTexts?: string[];
  ruleStatement?: string;
  ruleProvenance?: RuleProvenance;
  issue?: ConversionIssue;
}

/** 同槽内选项铸造：文本寻址；重复文本以序号消歧（确定性）。 */
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

function normalizeLeafScoring(leaf: LeafInput): LeafScoring {
  const slotId = `${leaf.partId}::r`;
  const answerText = leaf.answerTexts.find((t) => t != null && t.trim().length > 0) ?? null;

  // ---- 选择槽：先解析答案头（字母数决定 single/multi，P1-3）。----
  if (leaf.choices != null && leaf.choices.length >= 2) {
    const options = mintSlotOptions(leaf.choices);
    const head = answerText != null ? extractAnswerHead(answerText).trim() : '';
    const accepted = answerText != null ? parseChoiceAnswerHead(head, options.length) : null;
    if (accepted != null && accepted.length > 0) {
      const slot: ResponseSlotT =
        accepted.length === 1
          ? { slot_id: slotId, part_id: leaf.partId, kind: 'single_choice', options }
          : {
              // 多答案键 ⇒ multi_choice（min 1 / max 全集；接受集由 key 精确表达）。
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
    // 选择题但答案头不可解析 → 以 rule 文本承载（不发明键）。rubric/placeholder
    // 来源 ⇒ provenance 降为 system_proposed（不冒充 official，D1）。
    const fallback = buildRuleStatement(answerText, leaf);
    return {
      slot: { slot_id: slotId, part_id: leaf.partId, kind: 'single_choice', options },
      criterionKind: 'rule_reference',
      ruleStatement: fallback.statement,
      ruleProvenance: fallback.origin === 'reference' ? leaf.provenance : 'system_proposed',
      issue: answerText == null ? missingReferenceIssue(leaf) : undefined,
    };
  }

  // ---- 文本槽：显式 exact 判分意图 + 可胜 reference ⇒ 确定性 text_key。----
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
      ruleProvenance: 'system_proposed', // placeholder/rubric 来源不冒充 official
      issue: missingReferenceIssue(leaf),
    };
  }
  if (leaf.judgeKindOverride === 'exact' && isExactCapableReference(answerText)) {
    return {
      slot,
      criterionKind: 'text_key',
      // 接受集 = 该 part 的全部答案文本（多答案 any-of 语义）。
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

/** rule 文本 = 答案原文（reference / 叶 answers）+ judge 意图标记（改任一
 * ⇒ digest 变）。rubric 不进 statement（它以 material 形式进 structure）；
 * 仅当答案缺失时以 rubric 原文充当规则 —— provenance 降为 system_proposed。 */
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
        : scoring.criterionKind === 'text_key'
          ? {
              kind: 'text_key' as const,
              accepted_texts: scoring.acceptedTexts ?? [],
              normalization: 'trim' as const,
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
    case 'text_key':
      return { kind: 'deterministic', comparator: 'exact_text' } as const;
    default:
      // 未准入的模型判分能力不冒充（D17）—— 显式 human_review。
      return { kind: 'human_review' } as const;
  }
}

function assemble(
  groupId: string,
  materials: QuestionGroupStructureT['materials'],
  /** 每 part 引用的 material（共享材料全引用；part 私有材料只挂该 part）。 */
  materialIdsByPart: string[][],
  leaves: LeafInput[],
  extraIssues: ConversionIssue[],
): NormalizedContract {
  const structure = QuestionGroupStructure.parse({
    group_id: groupId,
    materials,
    parts: leaves.map((leaf, i) => ({
      part_id: leaf.partId,
      prompt_md: leaf.prompt,
      material_ids: materialIdsByPart[i] ?? [],
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
    integrity_digest: contractIntegrityDigest({
      structure,
      response_spec,
      scoring_basis,
      execution_plan,
    }),
    group_id: groupId,
    conversion_issues: [
      ...extraIssues,
      ...scorings.flatMap((s) => (s.issue != null ? [s.issue] : [])),
    ],
  };
}

/**
 * 归一 legacy 行 → 评估契约四层 + integrity digest。纯函数（无 IO）。
 */
export function normalizeQuestionRowToContract(row: NormalizableQuestionRow): NormalizedContract {
  const group_id = row.parent_question_id ?? row.id;
  // P1-2c —— provenance 看【答案证据】来源：ai_generated backfill 留痕优先。
  const provenance = ruleProvenanceFor(row.source, row.rubric_json);
  const figures = row.figures ?? [];

  const structuredRoot = row.structured;
  if (structuredRoot != null) {
    // structured 树：stem（根节点）文本 + row prompt（若与 stem 不同文）都是
    // 共享上下文材料；叶 node id 即 part 身份；叶 answers 是唯一答案来源
    //（P1-2b：无答案叶不继承 root reference —— 未决转换）。
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
    const leaves = collectLeaves(structuredRoot).map((leaf) => ({
      partId: leaf.id,
      prompt: leaf.prompt_text,
      choices: leaf.options?.map((o) => o.text) ?? null,
      answerTexts: leaf.answers,
      judgeKindOverride: row.judge_kind_override,
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
        provenance,
        rubric: row.rubric_json,
      },
    ],
    shared.issues,
  );
}

// ---- structured 树的叶收集（stem→subs；standalone→自身） ----

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

// ---- 物理多 part 组（parent_question_id 子行） ----

export interface PartRow {
  id: string;
  prompt_md: string;
  reference_md: string | null;
  choices_md: string[] | null;
  /** P1-2c —— part 自己的 structured（单叶时其 options/answers 优先于行级列）。 */
  structured?: StructuredQuestionT | null;
  /** P1-2c —— part 自己的附图（part 私有材料，只挂该 part）。 */
  figures?: FigureRefT[] | null;
}

/**
 * 物理多 part 组归一：root（题干/共享上下文 → 材料；root reference 不摊派给
 * part —— 每 part 用自己的答案，P1-2）+ parts（按 part_index 调用方排序）。
 * part 身份 = 子 question 行 id（编辑保留行 id ⇒ 实体保留；语义连续性由
 * publisher 的 semantic diff 裁决，§3.1/P1-3）。
 */
export function normalizeQuestionGroupToContract(
  root: NormalizableQuestionRow,
  parts: PartRow[],
): NormalizedContract {
  if (parts.length === 0) return normalizeQuestionRowToContract(root);

  // P1-2c —— 答案证据 provenance（root rubric 的 ai_generated 留痕对全组生效）。
  const provenance = ruleProvenanceFor(root.source, root.rubric_json);
  // 复合 root 的 prompt 是共享题干材料；root figures（若有）为共享资产；root 级
  // rubric 同样是权威评分输入（material 版本化，进 digest）。
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
    // part 私有 figures（内容寻址；无核验 digest ⇒ 如实 unverified + issue）。
    // 同一资产跨 part 复用时去重 —— material_id 即内容身份，重复引用同一
    // 资产不新增 material 行（duplicate_material_id 形状不修入契约）。
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

    // part 自己的 structured：单叶树的 options/answers 优先于行级列（P1-2c）。
    const structuredLeaf = p.structured != null ? collectLeaves(p.structured)[0] : undefined;
    const choices = structuredLeaf?.options?.map((o) => o.text) ?? p.choices_md ?? null;
    const answerTexts = structuredLeaf?.answers?.length
      ? structuredLeaf.answers
      : p.reference_md != null
        ? [p.reference_md]
        : [];
    return {
      partId: p.id,
      prompt: p.prompt_md,
      choices,
      answerTexts,
      judgeKindOverride: root.judge_kind_override,
      provenance,
      rubric: null, // rubric 是 root 级的；part 无自己的 rubric 列
    };
  });
  return assemble(root.id, shared.materials, materialIdsByPart, leaves, issues);
}

/** §3.1 完整性 digest：四层 canonical JSON 的 sha256（顺序固定）。 */
export function contractIntegrityDigest(contract: {
  structure: unknown;
  response_spec: unknown;
  scoring_basis: unknown;
  execution_plan: unknown;
}): string {
  const canonical = JSON.stringify(
    {
      structure: contract.structure,
      response_spec: contract.response_spec,
      scoring_basis: contract.scoring_basis,
      execution_plan: contract.execution_plan,
    },
    (_key, value) => value,
  );
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}
