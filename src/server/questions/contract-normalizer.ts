// YUK-1043 — 统一发布链 · 契约 normalizer（grounding §3.1/§4.4；复审 P1-2/P1-3）。
//
// 把 legacy `question` 工作副本（flat 列）转换为 YUK-1046 评估契约四层
// （structure / response_spec / scoring_basis / execution_plan），供 publisher
// 在同一事务内铸成不可变 question_revision。
//
// 保真纪律（P1-2 —— 归一不得丢失或发明权威内容）：
//   - 题干/共享上下文（复合 root prompt、structured stem、figures 资产）进
//     structure.materials（内容寻址 material 身份），parts 引用之 —— 改 root
//     题干/图 ⇒ digest 变 ⇒ 新 revision；
//   - 每个 part 的判分依据来自【它自己的】答案来源（part 行 reference /
//     structured 叶 answers），root 的 reference 不再摊派到每个叶（复审
//     「Structured leaf answer B + root reference A → 发布 A 的键」即此 bug）；
//   - rubric_json 参与 rule 文本（reference 缺失但有 rubric ⇒ 以 rubric 为
//     规则原文，provenance 如实标注，不标 official）；
//   - rule_reference.source 按【答案实际来源】映射（web_sourced→official、
//     manual→manual、其余模型链→system_proposed）—— D1：placeholder /
//     AI 生成规则绝不冒充 official；
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
// 身份纪律（§3.1 —— part/slot/option/criterion 身份语义不变时保留；语义替换
// 生成新身份；禁止按 label/数组 index/相同文本【自动认定跨内容连续身份】）：
//   - part_id：structured 叶 node id（编辑路径保留 node id）；物理多 part 组
//     用子行 id；单题用行 id。行/node 保留 = 实体保留（工作副本编辑语义）；
//     语义替换（树节点重建/新 part 行）天然产生新 id。
//   - slot_id：`{part_id}::r` 派生 —— part 保留 ⇒ slot 保留。
//   - option_id / material_id：内容寻址铸造（sha256(label\0text) /
//     sha256(kind\0text)）—— 内容不变 ⇒ 跨发布同 id；内容变 ⇒ 新 id（语义
//     替换）。这是【铸造】而非「把已变内容映射回旧身份」；跨版本的身份
//     增删由 publisher 计算 identity diff 并随发布事件持久化（映射轨迹）。

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
  code: 'missing_reference' | 'unrepresentable_answer';
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
  /** 答案权威来源（provenance 映射用；缺省按 system_proposed 保守处理）。 */
  source?: string | null;
  /** 附图资产（→ structure.materials；内容寻址身份）。 */
  figures?: FigureRefT[] | null;
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

/** 内容寻址 option id：不变 ⇒ 稳定；改文本 ⇒ 新身份（见文件头身份纪律）。 */
export function mintOptionId(label: string, text: string): string {
  return `opt_${shortHash(`${label}\0${text}`)}`;
}

/** 内容寻址 material id：素材内容替换 ⇒ 新身份（§3.1）。 */
export function mintMaterialId(kind: string, text: string): string {
  return `mat_${shortHash(`${kind}\0${text}`)}`;
}

/** 答案规则来源映射：web_sourced 参考答案抽取自来源页 ⇒ official；人工录入
 * ⇒ manual；其余模型链（quiz_gen / dreaming / mistake_variant / …）⇒
 * system_proposed（D1：system authored ≠ official）。未知来源保守 system_proposed。 */
export function ruleProvenanceFor(source?: string | null): RuleProvenance {
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

interface SharedContext {
  /** stem/root 共享文本材料（内容寻址 material）。 */
  stemText: string | null;
  /** 附图（row 级 figures）。 */
  figures: FigureRefT[];
  /** rubric（若有）：权威评分输入 ⇒ 以 material 形式随 revision 版本化 ——
   * reference 存在与否都进 digest（P1-2：改 rubric 必须产生新版本）。 */
  rubric: JsonObject | null;
}

function buildMaterials(ctx: SharedContext): QuestionGroupStructureT['materials'] {
  const materials: QuestionGroupStructureT['materials'] = [];
  if (ctx.stemText != null && ctx.stemText.trim().length > 0) {
    materials.push({
      material_id: mintMaterialId('plaintext', ctx.stemText),
      kind: 'plaintext',
      asset: {
        asset_id: `txt_${shortHash(ctx.stemText)}`,
        digest: `sha256:${createHash('sha256').update(ctx.stemText).digest('hex')}`,
      },
      caption: 'stem/shared context',
    });
  }
  for (const figure of ctx.figures) {
    materials.push({
      material_id: mintMaterialId('figure', figure.asset_id),
      kind: 'figure',
      asset: { asset_id: figure.asset_id, digest: `asset:${figure.asset_id}` },
      alt_text: `figure (${figure.role})`,
    });
  }
  if (ctx.rubric != null) {
    const rubricText = rubricToStatementMd(ctx.rubric);
    materials.push({
      material_id: mintMaterialId('rubric', rubricText),
      kind: 'plaintext',
      asset: {
        asset_id: `rub_${shortHash(rubricText)}`,
        digest: `sha256:${createHash('sha256').update(rubricText).digest('hex')}`,
      },
      caption: 'rubric (authoritative scoring input)',
    });
  }
  return materials;
}

/** 一个可作答 part 的全部归一输入。 */
interface LeafInput {
  partId: string;
  prompt: string;
  choices: string[] | null;
  /** 该 part 自己的答案文本候选（叶 answers / part 行 reference），按序优先。 */
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

function normalizeLeafScoring(leaf: LeafInput): LeafScoring {
  const slotId = `${leaf.partId}::r`;
  const answerText = leaf.answerTexts.find((t) => t != null && t.trim().length > 0) ?? null;

  // ---- 选择槽：先解析答案头（字母数决定 single/multi，P1-3）。----
  if (leaf.choices != null && leaf.choices.length >= 2) {
    const options: ResponseOptionT[] = leaf.choices.map((text, idx) => ({
      option_id: mintOptionId(String.fromCharCode(65 + idx), text),
      label: String.fromCharCode(65 + idx),
      text,
    }));
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
  leaves: LeafInput[],
): NormalizedContract {
  const structure = QuestionGroupStructure.parse({
    group_id: groupId,
    materials,
    parts: leaves.map((leaf) => ({
      part_id: leaf.partId,
      prompt_md: leaf.prompt,
      material_ids: materials.map((m) => m.material_id),
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
    conversion_issues: scorings.flatMap((s) => (s.issue != null ? [s.issue] : [])),
  };
}

/**
 * 归一 legacy 行 → 评估契约四层 + integrity digest。纯函数（无 IO）。
 */
export function normalizeQuestionRowToContract(row: NormalizableQuestionRow): NormalizedContract {
  const group_id = row.parent_question_id ?? row.id;
  const provenance = ruleProvenanceFor(row.source);
  const figures = row.figures ?? [];

  const structuredRoot = row.structured;
  if (structuredRoot != null) {
    // structured 树：stem（根节点）文本 + row prompt（若与 stem 不同文）都是
    // 共享上下文材料；叶 node id 即 part 身份；叶 answers 优先于 row reference。
    const stemText = structuredRoot.prompt_text ?? '';
    const rowPrompt = row.prompt_md.trim();
    const stemMaterialText =
      rowPrompt.length > 0 && rowPrompt !== stemText.trim()
        ? `${stemText}\n\n${row.prompt_md}`
        : stemText;
    const materials = buildMaterials({
      stemText: stemMaterialText,
      figures,
      rubric: row.rubric_json,
    });
    const leaves = collectLeaves(structuredRoot).map((leaf) => ({
      partId: leaf.id,
      prompt: leaf.prompt_text,
      choices: leaf.options?.map((o) => o.text) ?? null,
      answerTexts:
        leaf.answers.length > 0 ? leaf.answers : row.reference_md ? [row.reference_md] : [],
      judgeKindOverride: row.judge_kind_override,
      provenance,
      rubric: row.rubric_json,
    }));
    return assemble(group_id, materials, leaves);
  }

  const materials = buildMaterials({ stemText: null, figures, rubric: row.rubric_json });
  return assemble(group_id, materials, [
    {
      partId: row.id,
      prompt: row.prompt_md,
      choices: row.choices_md,
      answerTexts: row.reference_md != null ? [row.reference_md] : [],
      judgeKindOverride: row.judge_kind_override,
      provenance,
      rubric: row.rubric_json,
    },
  ]);
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
}

/**
 * 物理多 part 组归一：root（题干/共享上下文 → 材料；root reference 不摊派给
 * part —— 每 part 用自己的答案，P1-2）+ parts（按 part_index 调用方排序）。
 * part 身份 = 子 question 行 id（编辑保留行 id ⇒ 身份保留，§3.1）；root 自身
 * 不再作为一个 part（单题组才用 root id 当 part）。
 */
export function normalizeQuestionGroupToContract(
  root: NormalizableQuestionRow,
  parts: PartRow[],
): NormalizedContract {
  if (parts.length === 0) return normalizeQuestionRowToContract(root);

  const provenance = ruleProvenanceFor(root.source);
  // 复合 root 的 prompt 是共享题干材料；figures（若有）为共享资产；root 级
  // rubric 同样是权威评分输入（material 版本化，进 digest）。
  const materials = buildMaterials({
    stemText: root.prompt_md,
    figures: root.figures ?? [],
    rubric: root.rubric_json,
  });
  const leaves: LeafInput[] = parts.map((p) => ({
    partId: p.id,
    prompt: p.prompt_md,
    choices: p.choices_md,
    answerTexts: p.reference_md != null ? [p.reference_md] : [],
    judgeKindOverride: root.judge_kind_override,
    provenance,
    rubric: null, // rubric 是 root 级的；part 无自己的 rubric 列
  }));
  return assemble(root.id, materials, leaves);
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
