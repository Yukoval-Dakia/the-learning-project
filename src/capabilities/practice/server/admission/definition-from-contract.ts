// YUK-1445 — admission definition builder.
//
// Turns a NormalizedContract (row-normalized draft four layers, produced by
// kernel assessment-normalization) into a QuestionAdmissionDefinition:
//   - legacy response slots are upgraded to the batch-A surface
//     (single/multi_choice → select, text/numeric/formula → blank,
//     open_response kept for free); non-representable kinds stay untouched and
//     their units classify as 'unsupported'.
//   - existing typed criteria become SEEDS the dual solve must reproduce —
//     never the key source themselves (G1: AI-written structured answers are
//     admitted only when a second independent solve agrees).
//   - private solution/rubric materials are collected as source_answers for
//     the cross-check lane only (never parsed into keys — 零文本解析键).

import { isPublicSharedMaterial } from '@/core/schema/assessment/materials';
import type { ResponseSlotT } from '@/core/schema/assessment/response';
import type { BlankNormalizationT, ScoringUnitCriterionT } from '@/core/schema/assessment/scoring';
import type { NormalizedContract } from '@/kernel/records/assessment-normalization';
import type {
  AdmissionSourceAnswer,
  AdmissionUnitKind,
  AdmissionUnitSpec,
  QuestionAdmissionDefinition,
} from './contract';

export const DEFAULT_BLANK_NORMALIZATION: BlankNormalizationT = {
  version: 'blank-norm@1',
  nfkc: true,
  trim_outer: true,
  casefold: false,
  collapse_whitespace: true,
  ignore_punctuation: false,
  character_variants: [],
};

/** text_key 的 legacy 归一化档位 → 版本化 BlankNormalization（answer_head 的
 * 抽头步骤只对 reference 做过；作答侧同语义 = nfkc+trim+casefold）。 */
export function mapLegacyTextNormalization(
  normalization: 'exact' | 'trim' | 'trim_casefold_nfc' | 'answer_head',
): BlankNormalizationT {
  switch (normalization) {
    case 'exact':
      return {
        ...DEFAULT_BLANK_NORMALIZATION,
        version: 'exact@1',
        nfkc: false,
        trim_outer: false,
        collapse_whitespace: false,
      };
    case 'trim':
      return {
        ...DEFAULT_BLANK_NORMALIZATION,
        version: 'trim@1',
        nfkc: false,
        collapse_whitespace: false,
      };
    case 'trim_casefold_nfc':
      return { ...DEFAULT_BLANK_NORMALIZATION, version: 'trim_casefold@1', casefold: true };
    case 'answer_head':
      return { ...DEFAULT_BLANK_NORMALIZATION, version: 'answer_head@1', casefold: true };
  }
}

/** legacy/new slot → batch-A slot（可升级才转换；其余原样保留）。 */
function convertSlot(slot: ResponseSlotT): { slot: ResponseSlotT; targetKind: AdmissionUnitKind } {
  switch (slot.kind) {
    case 'select':
      return { slot, targetKind: 'select' };
    case 'blank':
      return { slot, targetKind: 'blank' };
    case 'open_response':
      return { slot, targetKind: 'free' };
    case 'single_choice':
      return {
        slot: {
          slot_id: slot.slot_id,
          part_id: slot.part_id,
          placement: slot.placement,
          kind: 'select',
          items: slot.options.map((option) => ({
            item_id: option.option_id,
            // YUK-1406：select.label_md 只写选项原文 —— 渲染层自画 A/B/C 序号
            // （OptionListBlock 的 mark span / worksheet-plan 的 letterFor），前缀
            // 会造成双序号（DTO 实证：label_md "C. …" + 渲染端两道序号）。同
            // draft-contract.ts single/multi→select 与 question-draft 的 label_md
            // 纯正文约定。item_id/顺序/pick 不变；空正文省略 label_md。
            ...(option.text.length > 0 ? { label_md: option.text } : {}),
          })),
          pick: 'one',
        },
        targetKind: 'select',
      };
    case 'multi_choice':
      return {
        slot: {
          slot_id: slot.slot_id,
          part_id: slot.part_id,
          placement: slot.placement,
          kind: 'select',
          items: slot.options.map((option) => ({
            item_id: option.option_id,
            // YUK-1406：同 single_choice —— label_md 仅选项原文，序号由渲染层画。
            ...(option.text.length > 0 ? { label_md: option.text } : {}),
          })),
          pick: 'many',
        },
        targetKind: 'select',
      };
    case 'text':
      return {
        slot: {
          slot_id: slot.slot_id,
          part_id: slot.part_id,
          placement: slot.placement,
          kind: 'blank',
          format: 'text',
          max_chars: slot.max_chars,
        },
        targetKind: 'blank',
      };
    case 'numeric':
      return {
        slot: {
          slot_id: slot.slot_id,
          part_id: slot.part_id,
          placement: slot.placement,
          kind: 'blank',
          format: 'math',
          unit_hint: slot.unit_hint,
        },
        targetKind: 'blank',
      };
    case 'formula':
      return {
        slot: {
          slot_id: slot.slot_id,
          part_id: slot.part_id,
          placement: slot.placement,
          kind: 'blank',
          format: 'math',
        },
        targetKind: 'blank',
      };
    default:
      return { slot, targetKind: 'unsupported' };
  }
}

/** seed 提取：已有 typed 判据 → 双解须复现的种子（仅同形可比较；异种判据
 * 不作为种子 —— solve 重新产出并报告）。 */
function seedFor(
  unitKind: AdmissionUnitKind,
  criterion: ScoringUnitCriterionT,
): { seed: ScoringUnitCriterionT | null; constraint?: string } {
  if (unitKind === 'select') {
    if (criterion.kind === 'select_key') return { seed: criterion };
    if (criterion.kind === 'option_set_key') {
      return {
        seed: { kind: 'select_key', accepted_item_ids: criterion.accepted_option_ids },
        constraint: 'legacy option_set_key seed mapped onto select items',
      };
    }
    return { seed: null, constraint: `criterion '${criterion.kind}' carries no select key seed` };
  }
  if (unitKind === 'blank') {
    if (criterion.kind === 'blank_key') return { seed: criterion };
    if (criterion.kind === 'text_key') {
      return {
        seed: {
          kind: 'blank_key',
          key: {
            kind: 'text',
            accepted: criterion.accepted_texts,
            normalization: mapLegacyTextNormalization(criterion.normalization),
          },
        },
        constraint: 'legacy text_key seed mapped onto blank_key (text)',
      };
    }
    if (criterion.kind === 'numeric_key') {
      return {
        seed: {
          kind: 'blank_key',
          key: {
            kind: 'numeric',
            expected: criterion.expected,
            tolerance: criterion.tolerance,
            expected_unit: criterion.expected_unit,
          },
        },
        constraint: 'legacy numeric_key seed mapped onto blank_key (numeric)',
      };
    }
    return { seed: null, constraint: `criterion '${criterion.kind}' carries no blank key seed` };
  }
  return { seed: null };
}

function blankNormalizationFor(seed: ScoringUnitCriterionT | null): BlankNormalizationT | null {
  if (seed?.kind === 'blank_key' && seed.key.kind === 'text') return seed.key.normalization;
  return DEFAULT_BLANK_NORMALIZATION;
}

/**
 * NormalizedContract → QuestionAdmissionDefinition.
 * 纯函数，无 IO。调用方负责把行级 reference 文本纳入 source_answers（本函数
 * 已从 private 材料 + rule_reference statement 收集印刷答案原文）。
 */
export function definitionFromContract(contract: NormalizedContract): QuestionAdmissionDefinition {
  const converted = contract.response_spec.slots.map((slot) => ({
    original: slot,
    ...convertSlot(slot),
  }));
  const convertedById = new Map(converted.map((entry) => [entry.original.slot_id, entry] as const));

  const response_spec: QuestionAdmissionDefinition['response_spec'] = {
    slots: converted.map((entry) => entry.slot),
  };

  const originalSlotById = new Map(
    contract.response_spec.slots.map((slot) => [slot.slot_id, slot] as const),
  );
  const units: AdmissionUnitSpec[] = contract.scoring_basis.units.map((unit) => {
    const primarySlotId = unit.slot_refs[0];
    const conversion = primarySlotId != null ? convertedById.get(primarySlotId) : undefined;
    const unitKind: AdmissionUnitKind =
      unit.slot_refs.length !== 1 || conversion == null ? 'unsupported' : conversion.targetKind;
    const { seed, constraint } = seedFor(unitKind, unit.criterion);
    const convertedSlot =
      conversion && conversion.slot !== conversion.original ? conversion.slot : null;
    return {
      scoring_unit_id: unit.scoring_unit_id,
      part_id: conversion?.slot.part_id ?? originalSlotById.get(primarySlotId ?? '')?.part_id ?? '',
      slot_refs: unit.slot_refs,
      material_refs: unit.material_refs,
      evidence_slot_refs: unit.evidence_slot_refs,
      requires_group_evidence: unit.requires_group_evidence,
      points: unit.points,
      unit_kind: unitKind,
      resolved_slot: convertedSlot,
      seeded_criterion: seed,
      seeded_rule: unit.rule ?? null,
      ...(constraint != null ? { seed_constraint: constraint } : {}),
      blank_normalization: unitKind === 'blank' ? blankNormalizationFor(seed) : null,
      printed_rule_md:
        unit.criterion.kind === 'rule_reference' ? unit.criterion.statement_md : undefined,
    };
  });

  // ---- source_answers：印出答案原文（evidence only）。----
  // rule_reference.statement_md 仅当其出处是【印出答案原文】才进
  // source_answers —— rubric/placeholder 来源的 statement 不是答案，拿去做
  // crosscheck 会把「恰好缺答案」的题（本 lane 要解决的对象）冤杀成
  // conflict/unknown。出处经 normalizer 的 rule_statement_origins 显式传递；
  // 未标注的保守排除（不解析 prose）。structure.materials 的私有 plaintext
  // 材料（normalizer 冻结的 'reference solution'，出自真实 answerTexts）按
  // part 归属。
  const source_answers: AdmissionSourceAnswer[] = [];
  const seenTexts = new Set<string>();
  const origins = contract.rule_statement_origins ?? {};
  for (const unit of contract.scoring_basis.units) {
    if (unit.criterion.kind !== 'rule_reference') continue;
    if (origins[unit.scoring_unit_id] !== 'reference') continue;
    const text = unit.criterion.statement_md;
    if (text.trim().length === 0 || seenTexts.has(text)) continue;
    seenTexts.add(text);
    source_answers.push({
      unit_id: unit.scoring_unit_id,
      reference_md: text,
      locator: unit.criterion.rule_id,
    });
  }
  const unitPart = new Map(units.map((unit) => [unit.scoring_unit_id, unit.part_id] as const));
  const unitsByPart = new Map<string, string[]>();
  for (const [unitId, partId] of unitPart) {
    const list = unitsByPart.get(partId) ?? [];
    list.push(unitId);
    unitsByPart.set(partId, list);
  }
  for (const part of contract.structure.parts) {
    for (const materialId of part.material_ids) {
      const material = contract.structure.materials.find(
        (candidate) => candidate.material_id === materialId,
      );
      if (
        material == null ||
        isPublicSharedMaterial(material) ||
        material.content_md == null ||
        material.content_md.trim().length === 0
      ) {
        continue;
      }
      const text = material.content_md;
      if (seenTexts.has(text)) continue;
      seenTexts.add(text);
      for (const unitId of unitsByPart.get(part.part_id) ?? []) {
        source_answers.push({
          unit_id: unitId,
          reference_md: text,
          locator: material.material_id,
        });
      }
    }
  }

  return {
    group_id: contract.group_id,
    base_contract_digest: contract.integrity_digest,
    structure: contract.structure,
    response_spec,
    original_response_spec: contract.response_spec,
    original_units: contract.scoring_basis.units,
    original_plan: contract.execution_plan,
    units,
    aggregation: contract.scoring_basis.aggregation,
    blank_scores_zero: contract.scoring_basis.blank_scores_zero,
    source_answers,
  };
}
