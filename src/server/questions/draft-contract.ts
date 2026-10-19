import type {
  BlankSlotT,
  ExecutionPlanT,
  ExecutorAssignmentT,
  PublishedQuestionRevisionT,
  QuestionGroupStructureT,
  ResponseSlotT,
  ResponseSpecT,
  ScoringBasisT,
  ScoringUnitCriterionT,
  ScoringUnitT,
  SelectSlotT,
} from '@/core/schema/assessment';
import {
  BlankNormalization,
  ExecutionPlan,
  QuestionGroupStructure,
  ResponseSpec,
  ScoringBasis,
} from '@/core/schema/assessment';
import type { BlankNormalizationT } from '@/core/schema/assessment/scoring';
import type {
  DraftBlankTextKeyT,
  DraftMaterialT,
  DraftPartT,
  DraftUnitT,
  QuestionDraftDocumentT,
} from '@/core/schema/question-draft';
import {
  QuestionDraftDocument,
  blankTextKeyConflict,
  isDraftDocumentV2,
} from '@/core/schema/question-draft';
import { contractIntegrityDigest } from '@/kernel/records/assessment-normalization';

// ====================================================================
// YUK-1468 — v2 草稿文档 ↔ 评估契约四层
// ====================================================================
//
// 提交（submit_question）时草稿直接映射到四层契约：
//   - materials/parts       → structure（剥掉草稿期的 source_ref/metadata ——
//                             契约层没有对应字段，不塞进 caption 冒充）；
//   - unit.response_spec    → response_spec.slots（slot_id 稳定透传）；
//   - unit.key/reference/rule → scoring_basis.units；
//   - unit.method           → execution_plan.assignments（模型方法携带
//                             admitted binding；未准入如实 null ⇒ withhold）。
//
// fail-honest：缺 key / 缺 rule / 缺分值 / 缺材料 / 断引用都记入
// conversion_issues；有 issue 的文档 submit 不铸 revision（发布侧 validators
// 会抛）——返回 withheld + 逐 unit 原因，由调用方先补全。

/** 提交前的文档级未决项（不混入 normalization 的 ConversionIssue code 词表）。 */
export interface DraftConversionIssue {
  code:
    | 'missing_key'
    | 'missing_rule'
    | 'missing_reference'
    | 'missing_prompt'
    | 'points_not_printed'
    | 'empty_universe'
    | 'duplicate_id'
    | 'unresolved_material_ref'
    | 'unresolved_key_item'
    | 'rule_invalid';
  part_id?: string;
  unit_id?: string;
  detail: string;
}

export interface DraftContract {
  structure: QuestionGroupStructureT;
  response_spec: ResponseSpecT;
  scoring_basis: ScoringBasisT;
  execution_plan: ExecutionPlanT;
  integrity_digest: string;
  conversion_issues: DraftConversionIssue[];
  /** 逐 unit 的可判性摘要（admission/response 用）。 */
  unit_summary: {
    unit_id: string;
    response_class: DraftUnitT['response_class'];
    executor_kind: 'deterministic' | 'model_executor' | 'human_review';
    judgeable_today: boolean;
    withheld_reason?: string;
  }[];
}

/** 材料 → 契约 SharedMaterial（剥草稿期字段）。 */
function contractMaterial(material: DraftMaterialT) {
  return {
    material_id: material.material_id,
    kind: material.kind,
    asset: material.asset,
    ...(material.visibility != null ? { visibility: material.visibility } : {}),
    ...(material.caption != null ? { caption: material.caption } : {}),
    ...(material.alt_text != null ? { alt_text: material.alt_text } : {}),
    ...(material.content_md != null ? { content_md: material.content_md } : {}),
  };
}

function slotFor(unit: DraftUnitT, partId: string): ResponseSlotT {
  const spec = unit.response_spec;
  if (spec.kind === 'select') {
    return {
      slot_id: unit.slot_id,
      part_id: partId,
      kind: 'select',
      items: spec.items.map((item) => ({
        item_id: item.item_id,
        ...(item.label_md != null ? { label_md: item.label_md } : {}),
        ...(item.coordinates != null ? { coordinates: item.coordinates } : {}),
        ...(item.gap_after_codepoint != null
          ? { gap_after_codepoint: item.gap_after_codepoint }
          : {}),
      })),
      ...(spec.axes != null ? { axes: spec.axes } : {}),
      ...(spec.at_most_per_coordinate != null
        ? { at_most_per_coordinate: spec.at_most_per_coordinate }
        : {}),
      ...(spec.text != null ? { text: spec.text } : {}),
      pick: spec.pick ?? 'many',
    } satisfies SelectSlotT;
  }
  if (spec.kind === 'blank') {
    return {
      slot_id: unit.slot_id,
      part_id: partId,
      kind: 'blank',
      format: spec.format ?? 'text',
      ...(spec.unit_hint != null ? { unit_hint: spec.unit_hint } : {}),
      ...(spec.max_chars != null ? { max_chars: spec.max_chars } : {}),
      // YUK-1568：声明原样进冻结槽位（参与 integrity digest）；不注入默认值。
      ...(spec.answer_shape != null ? { answer_shape: spec.answer_shape } : {}),
    } satisfies BlankSlotT;
  }
  return {
    slot_id: unit.slot_id,
    part_id: partId,
    kind: 'open_response',
    accepted_evidence: spec.accepts ?? [],
    evidence_required: spec.evidence_required ?? false,
    ...(spec.max_chars != null ? { max_chars: spec.max_chars } : {}),
  };
}

interface CriterionBuild {
  criterion: ScoringUnitCriterionT;
  /** K1 规则只有 select_key/blank_key 判据允许携带。 */
  attachRule: boolean;
  issues: DraftConversionIssue[];
}

function ruleProvenance(doc: QuestionDraftDocumentT): 'official' | 'system_proposed' | 'manual' {
  const kind = doc.source?.kind;
  if (kind === 'manual' || kind === 'owner_material') return 'manual';
  if (kind === 'jyeoo_fetch' || kind === 'sourcing_web') return 'official';
  return 'system_proposed';
}

function criterionFor(
  unit: DraftUnitT,
  doc: QuestionDraftDocumentT,
  partId: string,
): CriterionBuild {
  const issues: DraftConversionIssue[] = [];
  const fallback = (code: DraftConversionIssue['code'], detail: string): CriterionBuild => {
    issues.push({ code, part_id: partId, unit_id: unit.unit_id, detail });
    return {
      criterion: {
        kind: 'rule_reference',
        rule_id: `${unit.unit_id}::ref`,
        statement_md: detail,
        source: 'system_proposed',
      },
      attachRule: false,
      issues,
    };
  };
  if (unit.response_class === 'select') {
    if (unit.key?.kind !== 'select' || unit.key.accepted_item_ids.length === 0) {
      return fallback('missing_key', `unit '${unit.unit_id}' has no select answer key`);
    }
    if (unit.rule == null) {
      return fallback(
        'missing_rule',
        `unit '${unit.unit_id}' has a select key but no printed scoring rule`,
      );
    }
    return {
      criterion: { kind: 'select_key', accepted_item_ids: unit.key.accepted_item_ids },
      attachRule: true,
      issues,
    };
  }
  if (unit.response_class === 'blank') {
    if (unit.key?.kind !== 'blank') {
      return fallback('missing_key', `unit '${unit.unit_id}' has no blank answer key`);
    }
    if (unit.rule == null) {
      return fallback(
        'missing_rule',
        `unit '${unit.unit_id}' has a blank key but no printed scoring rule`,
      );
    }
    const key = unit.key.key;
    if (key.kind === 'text') {
      return {
        criterion: {
          kind: 'blank_key',
          key: {
            kind: 'text',
            accepted: key.accepted,
            normalization: blankTextNormalization(key, issues, {
              partId,
              unitId: unit.unit_id,
            }),
          },
        },
        attachRule: true,
        issues,
      };
    }
    if (key.equivalent_forms != null && key.equivalent_forms.length > 0) {
      issues.push({
        code: 'rule_invalid',
        part_id: partId,
        unit_id: unit.unit_id,
        detail: `unit '${unit.unit_id}' numeric equivalent_forms 无契约承载（保持草稿待契约扩展）`,
      });
    }
    // 契约 tolerance 必填：草稿缺省时按最严 absolute 0 承载并如实报 issue
    //（issue 已令 publishable=false，编辑方须显式印容差或确认 strict）。
    if (key.tolerance == null) {
      issues.push({
        code: 'missing_key',
        part_id: partId,
        unit_id: unit.unit_id,
        detail: `unit '${unit.unit_id}' numeric key lacks tolerance — 以 absolute 0 承印，请显式印容差`,
      });
    }
    return {
      criterion: {
        kind: 'blank_key',
        key: {
          kind: 'numeric',
          expected: key.value,
          tolerance: key.tolerance ?? { kind: 'absolute', value: 0 },
          ...(key.unit != null ? { expected_unit: key.unit } : {}),
        },
      },
      attachRule: true,
      issues,
    };
  }
  // free：答案权威 = reference_md 原文 + rubric（与 normalizer 同语义，
  // rubric 序列化进 rule statement，绝不冒充 official —— provenance 按答案证据来源）。
  const rubricText = unit.rubric != null ? JSON.stringify(unit.rubric, null, 0) : null;
  const statement = [unit.reference_md ?? null, rubricText].filter(Boolean).join('\n\n');
  if (statement.length === 0) {
    return fallback(
      'missing_reference',
      `unit '${unit.unit_id}' free unit has neither reference answer nor rubric`,
    );
  }
  return {
    criterion: {
      kind: 'rule_reference',
      rule_id: `${unit.unit_id}::ref`,
      statement_md: statement,
      source: ruleProvenance(doc),
    },
    attachRule: false,
    issues,
  };
}

/**
 * 已带归一化的草稿带着整段进契约。作者在同一把键上写了 case_sensitive / trim
 * 时，这两项盖过段内的 casefold / trim_outer。两者互相矛盾则记为未决，提交不铸
 * revision。没带归一化的新题仍用当前默认：v1，nfkc 与折叠空白关闭。
 */
function blankTextNormalization(
  key: DraftBlankTextKeyT,
  issues: DraftConversionIssue[],
  loc: { partId: string; unitId: string },
): BlankNormalizationT {
  const conflict = blankTextKeyConflict(key);
  if (conflict != null) {
    issues.push({
      code: 'rule_invalid',
      part_id: loc.partId,
      unit_id: loc.unitId,
      detail: `unit '${loc.unitId}' ${conflict}`,
    });
  }
  if (key.normalization == null) {
    return BlankNormalization.parse({
      version: 'v1',
      nfkc: false,
      trim_outer: key.trim ?? true,
      casefold: key.case_sensitive === false,
      collapse_whitespace: false,
      ignore_punctuation: false,
      character_variants: [],
    });
  }
  const parsed = BlankNormalization.parse(key.normalization);
  if (conflict != null) return parsed;
  return BlankNormalization.parse({
    ...parsed,
    ...(key.case_sensitive === false ? { casefold: true } : {}),
    ...(key.case_sensitive === true ? { casefold: false } : {}),
    ...(key.trim === false ? { trim_outer: false } : {}),
    ...(key.trim === true ? { trim_outer: true } : {}),
  });
}

function executorFor(unit: DraftUnitT): ExecutorAssignmentT['executor'] {
  switch (unit.method.kind) {
    case 'set-compare':
      return { kind: 'deterministic', comparator: 'set_compare' };
    case 'exact':
      return { kind: 'deterministic', comparator: 'blank_exact' };
    case 'jev':
    case 'ai-rubric':
      return {
        kind: 'model_executor',
        task_kind: unit.method.task_kind ?? 'AssessmentRuleJudgeTask',
        // D17：未声明准入切片 ⇒ null（发布 withhold，绝不执行）。
        admitted_slice_id: unit.method.binding ?? null,
      };
    case 'human_review':
      return { kind: 'human_review' };
  }
}

/**
 * 草稿文档 → 契约四层 + 未决项清单。纯函数（无 IO）。
 * conversion_issues 非空 ⇒ submit 不铸 revision（结构/判分未决）。
 */
export function draftDocumentToContract(
  doc: QuestionDraftDocumentT,
  groupId: string,
): DraftContract {
  const issues: DraftConversionIssue[] = [];
  const materialIds = new Set(doc.materials.map((m) => m.material_id));
  if (new Set(doc.materials.map((m) => m.material_id)).size !== doc.materials.length) {
    issues.push({ code: 'duplicate_id', detail: 'duplicate material_id in document' });
  }
  const partIds = new Set<string>();
  const unitIds = new Set<string>();
  const slotIds = new Set<string>();
  for (const part of doc.parts) {
    if (partIds.has(part.part_id)) {
      issues.push({
        code: 'duplicate_id',
        part_id: part.part_id,
        detail: `duplicate part_id '${part.part_id}'`,
      });
    }
    partIds.add(part.part_id);
    for (const materialId of part.material_ids) {
      if (!materialIds.has(materialId)) {
        issues.push({
          code: 'unresolved_material_ref',
          part_id: part.part_id,
          detail: `part '${part.part_id}' references unknown material '${materialId}'`,
        });
      }
    }
    for (const unit of part.units) {
      if (unitIds.has(unit.unit_id)) {
        issues.push({
          code: 'duplicate_id',
          part_id: part.part_id,
          unit_id: unit.unit_id,
          detail: `duplicate unit_id '${unit.unit_id}'`,
        });
      }
      unitIds.add(unit.unit_id);
      if (slotIds.has(unit.slot_id)) {
        issues.push({
          code: 'duplicate_id',
          part_id: part.part_id,
          unit_id: unit.unit_id,
          detail: `duplicate slot_id '${unit.slot_id}'`,
        });
      }
      slotIds.add(unit.slot_id);
      for (const ref of unit.material_refs) {
        if (!materialIds.has(ref)) {
          issues.push({
            code: 'unresolved_material_ref',
            part_id: part.part_id,
            unit_id: unit.unit_id,
            detail: `unit '${unit.unit_id}' references unknown material '${ref}'`,
          });
        }
      }
      if (unit.response_class === 'select' && unit.response_spec.kind === 'select') {
        if (unit.response_spec.items.length === 0) {
          issues.push({
            code: 'empty_universe',
            part_id: part.part_id,
            unit_id: unit.unit_id,
            detail: `unit '${unit.unit_id}' select universe is empty`,
          });
        }
        const itemIds = new Set(unit.response_spec.items.map((i) => i.item_id));
        if (itemIds.size !== unit.response_spec.items.length) {
          issues.push({
            code: 'duplicate_id',
            part_id: part.part_id,
            unit_id: unit.unit_id,
            detail: `unit '${unit.unit_id}' has duplicate item_id`,
          });
        }
        if (unit.key?.kind === 'select') {
          for (const id of unit.key.accepted_item_ids) {
            if (!itemIds.has(id)) {
              issues.push({
                code: 'unresolved_key_item',
                part_id: part.part_id,
                unit_id: unit.unit_id,
                detail: `unit '${unit.unit_id}' key references item '${id}' not in universe`,
              });
            }
          }
        }
      }
      if (unit.points == null) {
        issues.push({
          code: 'points_not_printed',
          part_id: part.part_id,
          unit_id: unit.unit_id,
          detail: `unit '${unit.unit_id}' has no printed points`,
        });
      }
      if (unit.response_class !== unit.response_spec.kind) {
        issues.push({
          code: 'rule_invalid',
          part_id: part.part_id,
          unit_id: unit.unit_id,
          detail: `unit '${unit.unit_id}' response_class '${unit.response_class}' does not match response_spec.kind '${unit.response_spec.kind}'`,
        });
      }
    }
    if (part.prompt_md.trim().length === 0 && part.units.length === 0) {
      issues.push({
        code: 'missing_prompt',
        part_id: part.part_id,
        detail: `part '${part.part_id}' has no prompt and no units`,
      });
    }
  }

  const structure = QuestionGroupStructure.parse({
    group_id: groupId,
    materials: doc.materials.map(contractMaterial),
    parts: doc.parts.map((part) => ({
      part_id: part.part_id,
      prompt_md: part.prompt_md,
      ...(part.question_no != null ? { question_no: part.question_no } : {}),
      material_ids: part.material_ids,
      // YUK-1568：显式 blank_order 原样入 structure（交叉校验在发布 barrier）。
      ...(part.blank_order != null ? { blank_order: part.blank_order } : {}),
    })),
  });

  const slots: ResponseSlotT[] = [];
  const units: ScoringUnitT[] = [];
  const assignments: ExecutorAssignmentT[] = [];
  const unitSummary: DraftContract['unit_summary'] = [];
  for (const part of doc.parts) {
    for (const unit of part.units) {
      slots.push(slotFor(unit, part.part_id));
      const built = criterionFor(unit, doc, part.part_id);
      issues.push(...built.issues);
      units.push({
        scoring_unit_id: unit.unit_id,
        slot_refs: [unit.slot_id],
        material_refs: unit.material_refs,
        evidence_slot_refs: [],
        requires_group_evidence: false,
        criterion: built.criterion,
        points: unit.points ?? null,
        ...(built.attachRule && unit.rule != null ? { rule: unit.rule } : {}),
      });
      const executor = executorFor(unit);
      assignments.push({ scoring_unit_ids: [unit.unit_id], executor });
      const executorKind = executor.kind;
      // YUK-1568（第 1 片）：声明了 answer_shape 的 blank 单元尚无已准入的数学
      // 比较器（第 2 片接入）—— judgeable_today 如实 false，发布制 withheld /
      // 暂扣，绝不回退普通 exact 自动判分。
      const shapeDeclared =
        unit.response_class === 'blank' &&
        unit.response_spec.kind === 'blank' &&
        unit.response_spec.answer_shape != null;
      const judgeable =
        !shapeDeclared &&
        built.issues.length === 0 &&
        (executorKind === 'deterministic' ||
          (executorKind === 'model_executor' && executor.admitted_slice_id != null));
      unitSummary.push({
        unit_id: unit.unit_id,
        response_class: unit.response_class,
        executor_kind: executorKind,
        judgeable_today: judgeable,
        ...(judgeable
          ? {}
          : {
              withheld_reason: shapeDeclared
                ? 'declared_answer_shape_comparator_pending'
                : built.issues.length > 0
                  ? built.issues[0].code
                  : executorKind === 'model_executor'
                    ? 'no_admitted_executor'
                    : 'human_review',
            }),
      });
    }
  }

  const response_spec = ResponseSpec.parse({ slots });
  const scoring_basis = ScoringBasis.parse({
    units,
    aggregation: { kind: 'sum' },
    blank_scores_zero: true,
  });
  const execution_plan = ExecutionPlan.parse({
    plan_version: 1,
    assignments,
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
    conversion_issues: issues,
    unit_summary: unitSummary,
  };
}

// ---------- published revision → 草稿（编辑已发布题的草稿种子） ----------

function draftSpecFromSlot(slot: ResponseSlotT): DraftUnitT['response_spec'] | null {
  switch (slot.kind) {
    case 'select':
      return {
        kind: 'select',
        items: slot.items.map((item) => ({
          item_id: item.item_id,
          ...(item.label_md != null ? { label_md: item.label_md } : {}),
          ...(item.coordinates != null ? { coordinates: item.coordinates } : {}),
          ...(item.gap_after_codepoint != null
            ? { gap_after_codepoint: item.gap_after_codepoint }
            : {}),
        })),
        ...(slot.axes != null ? { axes: slot.axes } : {}),
        ...(slot.at_most_per_coordinate != null
          ? { at_most_per_coordinate: slot.at_most_per_coordinate }
          : {}),
        ...(slot.text != null ? { text: slot.text } : {}),
        ...(slot.pick != null ? { pick: slot.pick } : {}),
      };
    case 'blank':
      return {
        kind: 'blank',
        ...(slot.format != null ? { format: slot.format } : {}),
        ...(slot.unit_hint != null ? { unit_hint: slot.unit_hint } : {}),
        ...(slot.max_chars != null ? { max_chars: slot.max_chars } : {}),
        // YUK-1568：冻结声明原样回草稿（draft→contract→draft 往返保字段）。
        ...(slot.answer_shape != null ? { answer_shape: slot.answer_shape } : {}),
      };
    case 'open_response':
      return {
        kind: 'free',
        ...(slot.accepted_evidence != null ? { accepts: slot.accepted_evidence } : {}),
        ...(slot.evidence_required != null ? { evidence_required: slot.evidence_required } : {}),
        ...(slot.max_chars != null ? { max_chars: slot.max_chars } : {}),
      };
    case 'single_choice':
      return {
        kind: 'select',
        pick: 'one',
        items: slot.options.map((option) => ({
          item_id: option.option_id,
          ...(option.text.length > 0 ? { label_md: option.text } : {}),
        })),
      };
    case 'multi_choice':
      return {
        kind: 'select',
        pick: 'many',
        items: slot.options.map((option) => ({
          item_id: option.option_id,
          ...(option.text.length > 0 ? { label_md: option.text } : {}),
        })),
      };
    default:
      // 其余 legacy 槽（text/numeric/matching/...）无法还原成统一类别时留
      // unmapped 标记。选择题已在上面映成 select。
      return null;
  }
}

/**
 * 已发布 revision → v2 草稿（编辑已发布题的草稿种子）。part/unit/material
 * 身份原样保留。选择题（single_choice / multi_choice + option_set_key）映成
 * select 与答案键；其余无法还原的 legacy 槽在 unit.metadata.unmapped_slot_kind
 * 留痕，提交前须改写成统一类别。
 */
export function revisionToDraftDocument(
  revision: Pick<
    PublishedQuestionRevisionT,
    'revision_id' | 'group_id' | 'structure' | 'response_spec' | 'scoring_basis' | 'execution_plan'
  > & { presentation?: PublishedQuestionRevisionT['presentation'] | null },
  opts: { knowledge_ids?: string[] } = {},
): QuestionDraftDocumentT {
  const executorByUnit = new Map<string, ExecutorAssignmentT['executor']>();
  for (const assignment of revision.execution_plan.assignments) {
    for (const unitId of assignment.scoring_unit_ids) {
      executorByUnit.set(unitId, assignment.executor);
    }
  }
  const slotById = new Map(revision.response_spec.slots.map((s) => [s.slot_id, s] as const));
  const partById = new Map(revision.structure.parts.map((p) => [p.part_id, p] as const));

  const parts = new Map<string, DraftPartT>();
  for (const part of revision.structure.parts) {
    parts.set(part.part_id, {
      part_id: part.part_id,
      prompt_md: part.prompt_md,
      ...(part.question_no != null ? { question_no: part.question_no } : {}),
      material_ids: [...part.material_ids],
      // YUK-1568：冻结 blank_order 原样回草稿（编辑已声明题不丢声明）。
      ...(part.blank_order != null ? { blank_order: [...part.blank_order] } : {}),
      units: [],
      metadata: {},
    });
  }
  for (const unit of revision.scoring_basis.units) {
    const slotId = unit.slot_refs[0];
    const slot = slotId != null ? slotById.get(slotId) : undefined;
    const partId = slot?.part_id;
    const part = partId != null ? parts.get(partId) : undefined;
    const executor = executorByUnit.get(unit.scoring_unit_id);
    const draft: DraftUnitT = {
      unit_id: unit.scoring_unit_id,
      slot_id: slotId ?? `${unit.scoring_unit_id}::r`,
      response_class:
        slot?.kind === 'select' || slot?.kind === 'single_choice' || slot?.kind === 'multi_choice'
          ? 'select'
          : slot?.kind === 'blank'
            ? 'blank'
            : slot?.kind === 'open_response'
              ? 'free'
              : 'free',
      response_spec: (slot != null ? draftSpecFromSlot(slot) : null) ?? { kind: 'free' },
      points: unit.points,
      ...keyAndReferenceFor(unit.criterion),
      method: methodFor(executor, unit.criterion),
      ...(unit.rule != null ? { rule: unit.rule } : {}),
      material_refs: [...unit.material_refs],
      metadata:
        slot != null && draftSpecFromSlot(slot) == null ? { unmapped_slot_kind: slot.kind } : {},
    };
    if (
      draft.key?.kind === 'select' &&
      draft.rule == null &&
      unit.criterion.kind === 'option_set_key'
    ) {
      // exact_option_set 是集合相等：全中且无错选得满分，否则 0。补一条印出的
      // 规则，提交侧才不会把已有选择题判成 missing_rule。
      draft.rule = printedLegacyChoiceRule(unit.points);
    }
    if (part != null) {
      part.units.push(draft);
    } else if (partById.has(slot?.part_id ?? '')) {
      partById.get(slot?.part_id ?? '') && parts.get(slot?.part_id ?? '')?.units.push(draft);
    } else if (parts.size > 0) {
      [...parts.values()][0].units.push(draft);
    } else {
      parts.set('p1', {
        part_id: 'p1',
        prompt_md: '',
        material_ids: [],
        units: [draft],
        metadata: {},
      });
    }
  }
  return {
    schema_version: 2,
    parts: [...parts.values()],
    materials: revision.structure.materials.map((m) => ({
      material_id: m.material_id,
      kind: m.kind,
      asset: m.asset,
      ...(m.visibility != null ? { visibility: m.visibility } : {}),
      ...(m.caption != null ? { caption: m.caption } : {}),
      ...(m.alt_text != null ? { alt_text: m.alt_text } : {}),
      ...(m.content_md != null ? { content_md: m.content_md } : {}),
    })),
    knowledge_ids: opts.knowledge_ids ?? [],
    metadata: {},
    ...(revision.presentation != null ? { presentation: revision.presentation } : {}),
    base: { question_id: revision.group_id, revision_id: revision.revision_id },
  };
}

/** 旧选择题没有 K1 规则对象。集合相等的给分写成显式规则，不靠提交时再猜。 */
function printedLegacyChoiceRule(points: number | null): NonNullable<DraftUnitT['rule']> {
  const award = points != null && Number.isFinite(points) && points >= 0 ? points : 0;
  return {
    version: 1,
    source: {
      statement: '命中全部正确选项且没有错选得满分，否则不得分',
      locator: 'legacy:option_set_key',
    },
    cases: [
      {
        when: { wrong: { eq: 0 }, miss: { eq: 0 } },
        award: { points: award },
      },
    ],
    otherwise: { points: 0 },
  };
}

function keyAndReferenceFor(
  criterion: ScoringUnitCriterionT,
): Pick<DraftUnitT, 'key' | 'reference_md' | 'rubric'> {
  if (criterion.kind === 'select_key') {
    return { key: { kind: 'select', accepted_item_ids: criterion.accepted_item_ids } };
  }
  if (criterion.kind === 'option_set_key') {
    return { key: { kind: 'select', accepted_item_ids: [...criterion.accepted_option_ids] } };
  }
  if (criterion.kind === 'blank_key') {
    const key = criterion.key;
    return {
      key: {
        kind: 'blank',
        key:
          key.kind === 'text'
            ? {
                kind: 'text',
                accepted: [...key.accepted],
                normalization: {
                  version: key.normalization.version,
                  nfkc: key.normalization.nfkc,
                  trim_outer: key.normalization.trim_outer,
                  casefold: key.normalization.casefold,
                  collapse_whitespace: key.normalization.collapse_whitespace,
                  ignore_punctuation: key.normalization.ignore_punctuation,
                  character_variants: key.normalization.character_variants.map(
                    (pair) => [pair[0], pair[1]] as [string, string],
                  ),
                },
              }
            : {
                kind: 'numeric',
                value: key.expected,
                ...(key.tolerance != null ? { tolerance: key.tolerance } : {}),
                ...(key.expected_unit != null ? { unit: key.expected_unit } : {}),
              },
      },
    };
  }
  if (criterion.kind === 'rule_reference') {
    // rule statement 里可能序列化着 rubric；如实回填 reference，rubric 不猜解析。
    return { reference_md: criterion.statement_md };
  }
  // legacy 判据（option_set_key/text_key/numeric_key/matching_pairs_key/
  // position_set_key/holistic_level）—— 无统一 key 等价物时把原文放进
  // reference_md，unit.metadata 需另行标注（由调用方在 metadata.unmapped 处理）。
  return {};
}

function methodFor(
  executor: ExecutorAssignmentT['executor'] | undefined,
  criterion: ScoringUnitCriterionT,
): DraftUnitT['method'] {
  if (
    criterion.kind === 'option_set_key' ||
    (executor?.kind === 'deterministic' && executor.comparator === 'exact_option_set')
  ) {
    return { kind: 'set-compare' };
  }
  if (executor?.kind === 'deterministic') {
    if (executor.comparator === 'set_compare') return { kind: 'set-compare' };
    if (executor.comparator === 'blank_exact') return { kind: 'exact' };
    // legacy 只读比较器（exact_option_set / numeric_* / matching / position）：
    // 最接近的统一类别如实回写，原 comparator 留在 unit.metadata 由调用方决定。
    return { kind: 'exact' };
  }
  if (executor?.kind === 'model_executor') {
    return {
      kind: 'ai-rubric',
      ...(executor.admitted_slice_id != null ? { binding: executor.admitted_slice_id } : {}),
      ...(executor.task_kind != null ? { task_kind: executor.task_kind } : {}),
    };
  }
  return criterion.kind === 'select_key' || criterion.kind === 'blank_key'
    ? { kind: criterion.kind === 'select_key' ? 'set-compare' : 'exact' }
    : { kind: 'human_review' };
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
      ? Object.keys(v)
          .sort()
          .reduce<Record<string, unknown>>((acc, k) => {
            acc[k] = (v as Record<string, unknown>)[k];
            return acc;
          }, {})
      : v,
  );
}

function executorByUnit(plan: ExecutionPlanT): Map<string, ExecutorAssignmentT['executor']> {
  const out = new Map<string, ExecutorAssignmentT['executor']>();
  for (const assignment of plan.assignments) {
    for (const unitId of assignment.scoring_unit_ids) out.set(unitId, assignment.executor);
  }
  return out;
}

function legacyChoiceSlotFaithful(stored: ResponseSlotT, canonical: ResponseSlotT): boolean {
  if (stored.kind !== 'single_choice' && stored.kind !== 'multi_choice') return false;
  if (canonical.kind !== 'select') return false;
  if (stored.placement != null || canonical.placement != null) return false;
  if (stored.kind === 'multi_choice') {
    if (stored.min_select !== 1 || stored.max_select !== stored.options.length) return false;
  }
  if (canonical.pick !== (stored.kind === 'single_choice' ? 'one' : 'many')) return false;
  if (
    canonical.axes != null ||
    canonical.text != null ||
    canonical.at_most_per_coordinate != null
  ) {
    return false;
  }
  if (canonical.items.length !== stored.options.length) return false;
  return stored.options.every((option, index) => {
    const item = canonical.items[index];
    return (
      item != null && item.item_id === option.option_id && (item.label_md ?? '') === option.text
    );
  });
}

function legacyChoiceUnitFaithful(stored: ScoringUnitT, canonical: ScoringUnitT): boolean {
  if (stored.criterion.kind !== 'option_set_key' || canonical.criterion.kind !== 'select_key') {
    return false;
  }
  if (
    stableJson(stored.criterion.accepted_option_ids) !==
    stableJson(canonical.criterion.accepted_item_ids)
  ) {
    return false;
  }
  if (stored.points !== canonical.points) return false;
  if (stableJson(stored.slot_refs) !== stableJson(canonical.slot_refs)) return false;
  if (stableJson(stored.material_refs) !== stableJson(canonical.material_refs)) return false;
  if (stored.evidence_slot_refs.length > 0 || canonical.evidence_slot_refs.length > 0) return false;
  if (stored.requires_group_evidence || canonical.requires_group_evidence) return false;
  if (stored.level_points != null || canonical.level_points != null) return false;
  const expectedRule = stored.rule ?? printedLegacyChoiceRule(stored.points);
  return stableJson(expectedRule) === stableJson(canonical.rule);
}

/**
 * 往返必须保住已存判分层。旧选择题改写成 select_key + 印出的集合规则是唯一允许的
 * 表示变化；答案键、选项文本、分值和默认的单选/全选界都要一致。其余任何字段
 * 被丢掉或改写都算判分变了。
 */
export function scoringRoundTripIsFaithful(
  stored: Pick<PublishedQuestionRevisionT, 'response_spec' | 'scoring_basis' | 'execution_plan'>,
  canonical: Pick<DraftContract, 'response_spec' | 'scoring_basis' | 'execution_plan'>,
): boolean {
  const storedSlots = new Map(stored.response_spec.slots.map((slot) => [slot.slot_id, slot]));
  const canonicalSlots = new Map(canonical.response_spec.slots.map((slot) => [slot.slot_id, slot]));
  if (stableJson([...storedSlots.keys()]) !== stableJson([...canonicalSlots.keys()])) return false;
  const canonicalUnits = new Map(
    canonical.scoring_basis.units.map((unit) => [unit.scoring_unit_id, unit]),
  );
  if (stored.scoring_basis.units.length !== canonicalUnits.size) return false;
  const legacyUnitIds = new Set<string>();
  const legacySlotIds = new Set<string>();
  for (const storedUnit of stored.scoring_basis.units) {
    const nextUnit = canonicalUnits.get(storedUnit.scoring_unit_id);
    const slotId = storedUnit.slot_refs[0];
    const storedSlot = slotId != null ? storedSlots.get(slotId) : undefined;
    const nextSlot = slotId != null ? canonicalSlots.get(slotId) : undefined;
    if (nextUnit == null || storedSlot == null || nextSlot == null) return false;
    const legacy =
      storedUnit.criterion.kind === 'option_set_key' &&
      (storedSlot.kind === 'single_choice' || storedSlot.kind === 'multi_choice');
    if (legacy) {
      if (!legacyChoiceUnitFaithful(storedUnit, nextUnit)) return false;
      if (!legacyChoiceSlotFaithful(storedSlot, nextSlot)) return false;
      legacyUnitIds.add(storedUnit.scoring_unit_id);
      legacySlotIds.add(storedSlot.slot_id);
    } else if (
      stableJson(storedUnit) !== stableJson(nextUnit) ||
      stableJson(storedSlot) !== stableJson(nextSlot)
    ) {
      return false;
    }
  }
  for (const [slotId, storedSlot] of storedSlots) {
    const nextSlot = canonicalSlots.get(slotId);
    if (nextSlot == null) return false;
    const legacyShape = storedSlot.kind === 'single_choice' || storedSlot.kind === 'multi_choice';
    if (legacyShape) {
      if (!legacySlotIds.has(slotId)) return false;
      continue;
    }
    if (stableJson(storedSlot) !== stableJson(nextSlot)) return false;
  }
  if (
    stableJson(stored.scoring_basis.aggregation) !==
      stableJson(canonical.scoring_basis.aggregation) ||
    stored.scoring_basis.blank_scores_zero !== canonical.scoring_basis.blank_scores_zero
  ) {
    return false;
  }
  if (stored.execution_plan.plan_version !== canonical.execution_plan.plan_version) return false;
  if (
    stableJson(stored.execution_plan.escalation) !== stableJson(canonical.execution_plan.escalation)
  ) {
    return false;
  }
  if (
    (stored.execution_plan.max_total_cost_usd_micros ?? null) !==
    (canonical.execution_plan.max_total_cost_usd_micros ?? null)
  ) {
    return false;
  }
  const storedGroups = stored.execution_plan.assignments.map((a) => a.scoring_unit_ids);
  const nextGroups = canonical.execution_plan.assignments.map((a) => a.scoring_unit_ids);
  if (stableJson(storedGroups) !== stableJson(nextGroups)) return false;
  const storedExec = executorByUnit(stored.execution_plan);
  const nextExec = executorByUnit(canonical.execution_plan);
  for (const [unitId, executor] of storedExec) {
    const next = nextExec.get(unitId);
    if (next == null) return false;
    if (legacyUnitIds.has(unitId)) {
      if (
        next.kind !== 'deterministic' ||
        next.comparator !== 'set_compare' ||
        executor.kind !== 'deterministic' ||
        (executor.comparator !== 'exact_option_set' && executor.comparator !== 'set_compare')
      ) {
        return false;
      }
    } else if (stableJson(executor) !== stableJson(next)) {
      return false;
    }
  }
  return storedExec.size === nextExec.size;
}

const SCORING_ROUND_TRIP_LOSSY = {
  action: 'refuse' as const,
  code: 'scoring_round_trip_lossy' as const,
  detail: 'stored scoring layers do not survive the draft round trip',
};

export type ScoringEditPlan =
  | { action: 'passthrough' }
  | { action: 'preserve' }
  | { action: 'author'; copyUnitIds: readonly string[] }
  | typeof SCORING_ROUND_TRIP_LOSSY;

type StoredScoringRevision = Pick<
  PublishedQuestionRevisionT,
  'revision_id' | 'group_id' | 'structure' | 'response_spec' | 'scoring_basis' | 'execution_plan'
> & { presentation?: PublishedQuestionRevisionT['presentation'] | null };

function draftUnitsById(doc: QuestionDraftDocumentT): Map<string, DraftUnitT> {
  const units = new Map<string, DraftUnitT>();
  for (const part of doc.parts) {
    for (const unit of part.units) units.set(unit.unit_id, unit);
  }
  return units;
}

function unitScoringSnapshot(unit: DraftUnitT): unknown {
  return {
    response_class: unit.response_class,
    response_spec: unit.response_spec,
    key: unit.key ?? null,
    rule: unit.rule ?? null,
    points: unit.points ?? null,
    method: unit.method,
    reference_md: unit.reference_md ?? null,
    rubric: unit.rubric ?? null,
    slot_id: unit.slot_id,
    material_refs: [...unit.material_refs],
  };
}

function authorTouchedUnitIds(
  seeded: QuestionDraftDocumentT,
  doc: QuestionDraftDocumentT,
): Set<string> | 'structure' {
  const before = draftUnitsById(seeded);
  const after = draftUnitsById(doc);
  const beforeIds = [...before.keys()].sort();
  const afterIds = [...after.keys()].sort();
  if (beforeIds.length !== afterIds.length) return 'structure';
  if (beforeIds.some((id, index) => id !== afterIds[index])) return 'structure';
  const touched = new Set<string>();
  for (const [id, next] of after) {
    const prev = before.get(id);
    const prevSnap = prev == null ? null : stableJson(unitScoringSnapshot(prev));
    if (prevSnap !== stableJson(unitScoringSnapshot(next))) touched.add(id);
  }
  return touched;
}

function storedUnitIsUnrepresentable(revision: StoredScoringRevision): boolean {
  for (const unit of revision.scoring_basis.units) {
    const kind = unit.criterion.kind;
    if (
      kind === 'rule_reference' ||
      kind === 'text_key' ||
      kind === 'numeric_key' ||
      kind === 'matching_pairs_key' ||
      kind === 'position_set_key' ||
      kind === 'holistic_level'
    ) {
      return true;
    }
  }
  for (const slot of revision.response_spec.slots) {
    if (
      slot.kind !== 'select' &&
      slot.kind !== 'blank' &&
      slot.kind !== 'open_response' &&
      slot.kind !== 'single_choice' &&
      slot.kind !== 'multi_choice'
    ) {
      return true;
    }
  }
  return false;
}

/**
 * 已存判分层走草稿往返时会不会丢字段，以及这次编辑有没有亲手改判分。
 * 作者没改判分、丢的又是编码器硬写的字段（聚合、空白计零、费用上限、选择界）
 * 时拒绝发布。旧的 rule_reference 一类无法表示的层，题面编辑改为原样拷贝。
 * 作者改了键或题型时放行。作者没碰的单元整份拷回已存判分层，不重新编码。
 */
export function scoringEditPlan(
  revision: StoredScoringRevision,
  doc: QuestionDraftDocumentT,
): ScoringEditPlan {
  let seeded: QuestionDraftDocumentT;
  try {
    seeded = QuestionDraftDocument.parse(
      revisionToDraftDocument(revision, { knowledge_ids: doc.knowledge_ids }),
    );
  } catch {
    return SCORING_ROUND_TRIP_LOSSY;
  }
  let canonical: DraftContract;
  try {
    canonical = draftDocumentToContract(seeded, revision.group_id);
  } catch {
    return authorPlan(revision, seeded, doc, 'unrepresentable');
  }
  if (canonical.conversion_issues.length > 0) {
    return authorPlan(revision, seeded, doc, 'unrepresentable');
  }
  if (scoringRoundTripIsFaithful(revision, canonical)) return { action: 'passthrough' };
  const loss = storedUnitIsUnrepresentable(revision) ? 'unrepresentable' : 'field_drop';
  return authorPlan(revision, seeded, doc, loss);
}

function authorPlan(
  revision: StoredScoringRevision,
  seeded: QuestionDraftDocumentT,
  doc: QuestionDraftDocumentT,
  loss: 'unrepresentable' | 'field_drop',
): ScoringEditPlan {
  const touched = authorTouchedUnitIds(seeded, doc);
  // 单元集合变了就无法原样拷贝已存层，也不再靠编码器重写后发布。
  if (touched === 'structure') return SCORING_ROUND_TRIP_LOSSY;
  if (touched.size === 0) {
    return loss === 'field_drop' ? SCORING_ROUND_TRIP_LOSSY : { action: 'preserve' };
  }
  if (dropsUntouchedSlot(revision, seeded, doc, touched)) return SCORING_ROUND_TRIP_LOSSY;
  const copyUnitIds = revision.scoring_basis.units
    .map((unit) => unit.scoring_unit_id)
    .filter((id) => !touched.has(id));
  return { action: 'author', copyUnitIds };
}

function dropsUntouchedSlot(
  revision: StoredScoringRevision,
  seeded: QuestionDraftDocumentT,
  doc: QuestionDraftDocumentT,
  touched: Set<string>,
): boolean {
  const seededUnits = draftUnitsById(seeded);
  const docUnits = draftUnitsById(doc);
  let encoded: DraftContract;
  try {
    encoded = draftDocumentToContract(doc, revision.group_id);
  } catch {
    return true;
  }
  const encodedSlots = new Map(encoded.response_spec.slots.map((slot) => [slot.slot_id, slot]));
  const storedSlots = new Map(revision.response_spec.slots.map((slot) => [slot.slot_id, slot]));
  for (const id of touched) {
    const prev = seededUnits.get(id);
    const next = docUnits.get(id);
    if (prev == null || next == null) return true;
    if (stableJson(prev.response_spec) !== stableJson(next.response_spec)) continue;
    const storedSlot = storedSlots.get(next.slot_id);
    const encodedSlot = encodedSlots.get(next.slot_id);
    if (storedSlot == null || encodedSlot == null) return true;
    if (storedSlot.kind !== encodedSlot.kind) return true;
    if (
      storedSlot.placement != null &&
      stableJson(storedSlot.placement) !== stableJson(encodedSlot.placement ?? null)
    ) {
      return true;
    }
  }
  return false;
}

/** 作者改了判分单元时，仍把草稿表达不了的依据字段从已存 revision 原样带回。 */
export function overlayAuthorScoring<T extends DraftContract>(
  encoded: T,
  stored: Pick<StoredScoringRevision, 'scoring_basis' | 'execution_plan'>,
): T {
  const storedPlan = stored.execution_plan;
  return {
    ...encoded,
    scoring_basis: {
      ...encoded.scoring_basis,
      aggregation: stored.scoring_basis.aggregation,
      blank_scores_zero: stored.scoring_basis.blank_scores_zero,
    },
    execution_plan: {
      ...encoded.execution_plan,
      plan_version: storedPlan.plan_version,
      escalation: storedPlan.escalation,
      ...(storedPlan.max_total_cost_usd_micros != null
        ? { max_total_cost_usd_micros: storedPlan.max_total_cost_usd_micros }
        : {}),
    },
  };
}

/**
 * 一个执行器只覆盖这一个单元时，才能把已存 assignment 原样换回去。
 * 共用 assignment 或重复覆盖都无法按单元字节拷贝。
 */
function dedicatedAssignmentIndex(
  assignments: readonly { scoring_unit_ids: readonly string[] }[],
  unitId: string,
): number | null {
  let found: number | null = null;
  for (let index = 0; index < assignments.length; index += 1) {
    const ids = assignments[index]?.scoring_unit_ids;
    if (ids == null || !ids.includes(unitId)) continue;
    if (found != null || ids.length !== 1) return null;
    found = index;
  }
  return found;
}

/**
 * 作者没碰的单元不走编码器。槽、计分单元和专属执行器都换成已存对象。
 * 槽被改过的单元共用，或执行器不是单单元专属时，返回 null，调用方拒绝发布。
 */
function spliceUntouchedUnits(
  encoded: DraftContract,
  stored: StoredScoringRevision,
  copyUnitIds: readonly string[],
): DraftContract | null {
  if (copyUnitIds.length === 0) return encoded;
  const copyIds = new Set(copyUnitIds);
  const storedUnits = new Map(
    stored.scoring_basis.units.map((unit) => [unit.scoring_unit_id, unit]),
  );
  const encodedUnitIds = new Set(encoded.scoring_basis.units.map((unit) => unit.scoring_unit_id));
  const storedSlots = new Map(stored.response_spec.slots.map((slot) => [slot.slot_id, slot]));
  const encodedSlotIds = new Set(encoded.response_spec.slots.map((slot) => slot.slot_id));
  const touchedSlotIds = new Set<string>();
  for (const unit of encoded.scoring_basis.units) {
    if (copyIds.has(unit.scoring_unit_id)) continue;
    for (const slotId of [...unit.slot_refs, ...unit.evidence_slot_refs]) {
      touchedSlotIds.add(slotId);
    }
  }
  const slotReplacements = new Map<string, ResponseSlotT>();
  const unitReplacements = new Map<string, ScoringUnitT>();
  const assignmentReplacements = new Map<number, ExecutorAssignmentT>();
  for (const unitId of copyUnitIds) {
    const storedUnit = storedUnits.get(unitId);
    if (storedUnit == null || !encodedUnitIds.has(unitId)) return null;
    for (const slotId of [...storedUnit.slot_refs, ...storedUnit.evidence_slot_refs]) {
      if (touchedSlotIds.has(slotId)) return null;
      const storedSlot = storedSlots.get(slotId);
      if (storedSlot == null || !encodedSlotIds.has(slotId)) return null;
      slotReplacements.set(slotId, storedSlot);
    }
    unitReplacements.set(unitId, storedUnit);
    const storedIndex = dedicatedAssignmentIndex(stored.execution_plan.assignments, unitId);
    const encodedIndex = dedicatedAssignmentIndex(encoded.execution_plan.assignments, unitId);
    if (storedIndex == null || encodedIndex == null) return null;
    const storedAssignment = stored.execution_plan.assignments[storedIndex];
    if (storedAssignment == null) return null;
    assignmentReplacements.set(encodedIndex, storedAssignment);
  }
  return {
    ...encoded,
    response_spec: {
      ...encoded.response_spec,
      slots: encoded.response_spec.slots.map((slot) => slotReplacements.get(slot.slot_id) ?? slot),
    },
    scoring_basis: {
      ...encoded.scoring_basis,
      units: encoded.scoring_basis.units.map(
        (unit) => unitReplacements.get(unit.scoring_unit_id) ?? unit,
      ),
    },
    execution_plan: {
      ...encoded.execution_plan,
      assignments: encoded.execution_plan.assignments.map(
        (assignment, index) => assignmentReplacements.get(index) ?? assignment,
      ),
    },
  };
}

/**
 * 提交和校验共用这一步。preserve 用已存的三层判分替换编码器产出，题面仍用草稿。
 * author 拷回聚合、空白计零和计划级字段，并把作者没碰的单元原样换回。
 * 换不回去或 refuse 时不发布。
 */
export function applyScoringEditPlan(
  revision: StoredScoringRevision | null,
  doc: QuestionDraftDocumentT,
  encoded: DraftContract,
): { contract: DraftContract; plan: ScoringEditPlan } {
  if (revision == null) return { contract: encoded, plan: { action: 'passthrough' } };
  const plan = scoringEditPlan(revision, doc);
  if (plan.action === 'refuse') return { contract: encoded, plan };
  if (plan.action === 'preserve') {
    return {
      plan,
      contract: {
        ...encoded,
        response_spec: revision.response_spec,
        scoring_basis: revision.scoring_basis,
        execution_plan: revision.execution_plan,
        conversion_issues: [],
      },
    };
  }
  if (plan.action === 'author') {
    const spliced = spliceUntouchedUnits(
      overlayAuthorScoring(encoded, revision),
      revision,
      plan.copyUnitIds,
    );
    if (spliced == null) return { contract: encoded, plan: SCORING_ROUND_TRIP_LOSSY };
    return { plan, contract: spliced };
  }
  return { contract: encoded, plan };
}

// ---------- 与 question.canonical_content_hash 对齐的内容身份 ----------
//
// 旧供给链的指纹只含 prompt / reference / choices / rubric（外加 composite
// 判别），不含 source、知识点。草稿提交必须投出同一组字段，精确去重才能
// 跨来源、跨知识点命中已有行。哈希本身由 canonicalQuestionContentHash 计算。

function projectPrompt(doc: QuestionDraftDocumentT): string {
  if (doc.parts.length === 1) return doc.parts[0].prompt_md;
  const stem = doc.parts
    .flatMap((p) => p.material_ids)
    .map((id) => doc.materials.find((m) => m.material_id === id))
    .find((m) => m != null && m.caption === 'stem/shared context');
  if (stem?.content_md != null) return stem.content_md;
  return doc.parts
    .map((p) => p.prompt_md)
    .filter((t) => t.trim().length > 0)
    .join('\n\n');
}

function projectReference(doc: QuestionDraftDocumentT): string | null {
  const texts: string[] = [];
  for (const part of doc.parts) {
    for (const unit of part.units) {
      if (unit.key?.kind === 'blank') {
        texts.push(
          unit.key.key.kind === 'text'
            ? unit.key.key.accepted.join(' / ')
            : String(unit.key.key.value),
        );
      } else if (unit.key?.kind === 'select') {
        const labels = unit.key.accepted_item_ids
          .map((id) =>
            unit.response_spec.kind === 'select'
              ? unit.response_spec.items.findIndex((item) => item.item_id === id)
              : -1,
          )
          .filter((index) => index >= 0)
          .map((index) => String.fromCharCode(65 + index));
        if (labels.length > 0) texts.push(labels.join(''));
      } else if (unit.reference_md != null) {
        texts.push(unit.reference_md);
      }
    }
  }
  return texts.length > 0 ? texts.join('\n\n') : null;
}

function projectChoices(doc: QuestionDraftDocumentT): string[] | null {
  const unit = doc.parts.flatMap((p) => p.units).find((u) => u.response_spec.kind === 'select');
  if (unit == null || unit.response_spec.kind !== 'select') return null;
  return unit.response_spec.items.map((item) => item.label_md ?? item.item_id);
}

/** 供 canonicalQuestionContentHash 使用的内容身份。source 与知识点不参与。 */
export function draftCanonicalIdentity(doc: QuestionDraftDocumentT): {
  promptMd: string;
  referenceMd: string | null;
  choicesMd: string[] | null;
  rubricJson: unknown;
  composite?: boolean;
} {
  const classes = new Set(
    doc.parts.flatMap((part) => part.units.map((unit) => unit.response_class)),
  );
  const composite = doc.parts.length > 1 || classes.size > 1;
  const rubrics = doc.parts.flatMap((part) =>
    part.units.map((unit) => unit.rubric).filter((rubric) => rubric != null),
  );
  return {
    promptMd: projectPrompt(doc),
    referenceMd: projectReference(doc),
    choicesMd: projectChoices(doc),
    rubricJson: rubrics.length === 0 ? null : rubrics.length === 1 ? rubrics[0] : rubrics,
    ...(composite ? { composite: true as const } : {}),
  };
}

export { isDraftDocumentV2 };
