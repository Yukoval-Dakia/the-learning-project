// YUK-1043 — 统一发布链 · 契约 normalizer（grounding §3.1/§4.4）。
//
// 把 legacy `question` 工作副本（flat 列）转换为 YUK-1046 评估契约四层
// （structure / response_spec / scoring_basis / execution_plan），供 publisher
// 在同一事务内铸成不可变 question_revision。
//
// 身份纪律（§3.1 —— part/slot/option/criterion 身份在语义不变时保留；语义替换
// 生成新身份；禁止按 label/数组 index/相同文本【自动认定跨内容连续身份】）：
//   - part_id：优先沿用 structured 树的 node id（编辑路径保留 node id —— 语义
//     不变 ⇒ 同 id）；无树的单题用 question.id 本身（单题 = 1-part 组）。
//   - slot_id：`{part_id}::r` 派生坐标 —— part 身份保留 ⇒ slot 身份保留。
//   - option_id：`opt_{sha256(label\0text)[:12]}` 内容确定性铸造 —— 内容不变
//     ⇒ 跨发布同 id；文本变化 ⇒ 新 id（语义替换）。这不是“按文本认定连续
//     身份”（那是对【已变化内容】映射回旧身份的禁令）；这里是内容寻址铸造，
//     不变性与替换性恰好是要求的行为。
//
// 执行计划映射（保守、诚实）：legacy `exact` 可比形状 → deterministic 比较器；
// 其余 judge kind 一律 human_review（keyword/semantic/steps/unit_dimension/
// multimodal 的自动执行【未按 D17 准入】—— 声明了但没 runner 的假能力不保留，
// evaluator lane（YUK-1047）落准入后再切 model_executor）。
//
// 评分依据映射：选择题 → option_set_key（接受集 = reference head 的字母解析）；
// 解析不可得或非选择 → rule_reference（statement = 原文 reference，官方来源
// 由 caller 断言）。本文不发明 marking DSL。

import { createHash } from 'node:crypto';
import type {
  ExecutionPlanT,
  QuestionGroupStructureT,
  ResponseSpecT,
  ScoringBasisT,
} from '@/core/schema/assessment';
import {
  ExecutionPlan,
  QuestionGroupStructure,
  ResponseSpec,
  ScoringBasis,
} from '@/core/schema/assessment';
import { extractAnswerHead } from '@/core/schema/judge-routing';
import type { StructuredQuestionT } from '@/core/schema/structured_question';

type JsonObject = Record<string, unknown>;

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
}

function shortHash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 12);
}

/** 内容寻址 option id：不变 ⇒ 稳定；改文本 ⇒ 新身份（见文件头身份纪律）。 */
export function mintOptionId(label: string, text: string): string {
  return `opt_${shortHash(`${label}\0${text}`)}`;
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

/**
 * 归一 legacy 行 → 评估契约四层 + integrity digest。纯函数（无 IO）。
 */
export function normalizeQuestionRowToContract(row: NormalizableQuestionRow): NormalizedContract {
  const group_id = row.parent_question_id ?? row.id;

  // ---- 身份来源：structured 树优先（node id 即 part 身份），否则单题自身。----
  const structuredRoot = row.structured;
  const leafNodes = structuredRoot
    ? collectLeaves(structuredRoot)
    : [{ id: row.id, prompt_text: row.prompt_md, answers: [], options: undefined }];

  const parts = leafNodes.map((leaf) => ({
    part_id: leaf.id,
    prompt_md: leaf.prompt_text,
    material_ids: [] as string[],
  }));
  const structure = QuestionGroupStructure.parse({
    group_id,
    materials: [],
    parts,
  });

  // ---- ResponseSpec：每叶一个 slot；choices（行级或树节点级）→ 单选。----
  const rowChoices = row.choices_md ?? undefined;
  const slots = leafNodes.map((leaf, i) => {
    const partId = parts[i].part_id;
    const leafChoices = leaf.options?.map((o) => o.text) ?? rowChoices;
    if (leafChoices && leafChoices.length >= 2) {
      return {
        slot_id: `${partId}::r`,
        part_id: partId,
        kind: 'single_choice' as const,
        options: leafChoices.map((text, idx) => ({
          option_id: mintOptionId(String.fromCharCode(65 + idx), text),
          label: String.fromCharCode(65 + idx),
          text,
        })),
      };
    }
    return {
      slot_id: `${partId}::r`,
      part_id: partId,
      kind: 'text' as const,
      math_preview: false,
    };
  });
  const response_spec = ResponseSpec.parse({ slots });

  // ---- ScoringBasis：每叶一个 scoring unit（贡献恰好一次）。----

  const units = leafNodes.map((_leaf, i) => {
    const slot = slots[i];
    const slotId = slot.slot_id;
    const partId = parts[i].part_id;
    // 选择槽 + 可解析答案头 → option_set_key；其余 → rule_reference（原文）。
    if (slot.kind === 'single_choice' && row.reference_md) {
      const head = extractAnswerHead(row.reference_md).trim();
      const accepted = parseChoiceAnswerHead(head, slot.options.length);
      if (accepted != null && accepted.length > 0) {
        return {
          scoring_unit_id: `${partId}::u`,
          slot_refs: [slotId],
          material_refs: [],
          evidence_slot_refs: [],
          requires_group_evidence: false,
          criterion: {
            kind: 'option_set_key' as const,
            accepted_option_ids: accepted.map((idx) => slot.options[idx].option_id),
          },
          points: 1,
          level_points: undefined,
        };
      }
    }
    return {
      scoring_unit_id: `${partId}::u`,
      slot_refs: [slotId],
      material_refs: [],
      evidence_slot_refs: [],
      requires_group_evidence: false,
      criterion: {
        kind: 'rule_reference' as const,
        rule_id: `${partId}::ref`,
        statement_md: row.reference_md ?? '（无参考答案 —— 发布为待补规则）',
        source: 'official' as const,
      },
      points: 1,
      level_points: undefined,
    };
  });
  const scoring_basis = ScoringBasis.parse({
    units,
    aggregation: { kind: 'sum' },
    blank_scores_zero: true,
  });

  // ---- ExecutionPlan：executor 由每个 unit 的实际判据种类决定
  //（option_set_key → exact_option_set；其余 → human_review —— 未准入的
  //  legacy judge kind 不冒充自动判分能力，evaluator lane 落准入后切换）。----
  const execution_plan = ExecutionPlan.parse({
    plan_version: 1,
    assignments: units.map((unit) => ({
      scoring_unit_ids: [unit.scoring_unit_id],
      executor:
        unit.criterion.kind === 'option_set_key'
          ? ({ kind: 'deterministic', comparator: 'exact_option_set' } as const)
          : ({ kind: 'human_review' } as const),
    })),
    escalation: { on_unadmitted_model: 'withhold', on_low_confidence: 'human_review' },
  });

  const integrity_digest = contractIntegrityDigest({
    structure,
    response_spec,
    scoring_basis,
    execution_plan,
  });

  return { structure, response_spec, scoring_basis, execution_plan, integrity_digest, group_id };
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
 * 物理多 part 组归一：root（题干/共享上下文）+ parts（按 part_index 调用方排序）。
 * part 身份 = 子 question 行 id（编辑保留行 id ⇒ 身份保留，§3.1）；root 自身
 * 不再作为一个 part（单题组才用 root id 当 part）。每 part 归一与单题同规则
 * （选项→单选槽 + 头解析；否则文本槽 + rule_reference）。
 */
export function normalizeQuestionGroupToContract(
  root: NormalizableQuestionRow,
  parts: PartRow[],
): NormalizedContract {
  if (parts.length === 0) return normalizeQuestionRowToContract(root);

  const group_id = root.id;
  const structure = QuestionGroupStructure.parse({
    group_id,
    materials: [],
    parts: parts.map((p) => ({
      part_id: p.id,
      prompt_md: p.prompt_md,
      material_ids: [],
    })),
  });

  const slots = parts.map((p) => {
    const choices = p.choices_md ?? [];
    if (choices.length >= 2) {
      return {
        slot_id: `${p.id}::r`,
        part_id: p.id,
        kind: 'single_choice' as const,
        options: choices.map((text, idx) => ({
          option_id: mintOptionId(String.fromCharCode(65 + idx), text),
          label: String.fromCharCode(65 + idx),
          text,
        })),
      };
    }
    return { slot_id: `${p.id}::r`, part_id: p.id, kind: 'text' as const, math_preview: false };
  });
  const response_spec = ResponseSpec.parse({ slots });

  const units = parts.map((p, i) => {
    const slot = slots[i];
    const unitBase = {
      scoring_unit_id: `${p.id}::u`,
      slot_refs: [slot.slot_id],
      material_refs: [],
      evidence_slot_refs: [],
      requires_group_evidence: false,
      points: 1,
    };
    if (slot.kind === 'single_choice' && p.reference_md) {
      const head = extractAnswerHead(p.reference_md).trim();
      const accepted = parseChoiceAnswerHead(head, slot.options.length);
      if (accepted != null && accepted.length > 0) {
        return {
          ...unitBase,
          criterion: {
            kind: 'option_set_key' as const,
            accepted_option_ids: accepted.map((idx) => slot.options[idx].option_id),
          },
        };
      }
    }
    return {
      ...unitBase,
      criterion: {
        kind: 'rule_reference' as const,
        rule_id: `${p.id}::ref`,
        statement_md: p.reference_md ?? '（无参考答案 —— 发布为待补规则）',
        source: 'official' as const,
      },
    };
  });
  const scoring_basis = ScoringBasis.parse({
    units,
    aggregation: { kind: 'sum' },
    blank_scores_zero: true,
  });

  // 多 part 组的执行器：逐 unit 由判据种类决定（与单题同规则）。
  const execution_plan = ExecutionPlan.parse({
    plan_version: 1,
    assignments: units.map((unit) => ({
      scoring_unit_ids: [unit.scoring_unit_id],
      executor:
        unit.criterion.kind === 'option_set_key'
          ? ({ kind: 'deterministic', comparator: 'exact_option_set' } as const)
          : ({ kind: 'human_review' } as const),
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
    group_id,
  };
}
