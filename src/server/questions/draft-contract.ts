import { createHash } from 'node:crypto';
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
  ExecutionPlan,
  QuestionGroupStructure,
  ResponseSpec,
  ScoringBasis,
} from '@/core/schema/assessment';
import type {
  DraftMaterialT,
  DraftPartT,
  DraftUnitT,
  QuestionDraftDocumentT,
} from '@/core/schema/question-draft';
import { isDraftDocumentV2 } from '@/core/schema/question-draft';
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
            normalization: {
              version: 'v1',
              nfkc: false,
              trim_outer: key.trim ?? true,
              casefold: key.case_sensitive === false,
              collapse_whitespace: false,
              ignore_punctuation: false,
              character_variants: [],
            },
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
      const judgeable =
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
              withheld_reason:
                built.issues.length > 0
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
      };
    case 'open_response':
      return {
        kind: 'free',
        ...(slot.accepted_evidence != null ? { accepts: slot.accepted_evidence } : {}),
        ...(slot.evidence_required != null ? { evidence_required: slot.evidence_required } : {}),
        ...(slot.max_chars != null ? { max_chars: slot.max_chars } : {}),
      };
    default:
      // legacy slot kinds（single_choice/text/numeric/matching/...）—— 以
      // metadata 如实保留形状说明；映射为最接近的统一类别，原槽字段无法
      // 还原时调用方会收到 unmapped 标记。
      return null;
  }
}

/**
 * 已发布 revision → v2 草稿（编辑已发布题的草稿种子）。part/unit/material
 * 身份原样保留（语义连续性由发布侧 diff 裁决）；legacy slot kinds（非统一
 * 三类）在 unit.metadata.unmapped_slot 留痕，由编辑者改写为统一类别后才可
 * 提交（draftDocumentToContract 不接受 unmapped 标记——见下面提交路径）。
 */
export function revisionToDraftDocument(
  revision: Pick<
    PublishedQuestionRevisionT,
    'revision_id' | 'group_id' | 'structure' | 'response_spec' | 'scoring_basis' | 'execution_plan'
  >,
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
        slot?.kind === 'select'
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
    base: { question_id: revision.group_id, revision_id: revision.revision_id },
  };
}

function keyAndReferenceFor(
  criterion: ScoringUnitCriterionT,
): Pick<DraftUnitT, 'key' | 'reference_md' | 'rubric'> {
  if (criterion.kind === 'select_key') {
    return { key: { kind: 'select', accepted_item_ids: criterion.accepted_item_ids } };
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
                ...(key.normalization.casefold ? { case_sensitive: false } : {}),
                ...(key.normalization.trim_outer === false ? { trim: false } : {}),
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

// ---------- 可复现指纹（非 fetch 来源的去重键；绝不伪造 extraction_hash） ----------

/** JSON 键序稳定序列化（与 contractIntegrityDigest 同一纪律）。 */
function canonicalize(value: unknown): string {
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

/**
 * 草稿内容指纹 → question.canonical_content_hash。内容寻址：覆盖
 * parts/units/materials/knowledge_ids/source 内容；metadata/presentation 不参与
 * （非判分语义）。同内容 ⇒ 同指纹 ⇒ live 去重 claim。
 */
export function draftCanonicalContentHash(doc: QuestionDraftDocumentT): string {
  const canonical = canonicalize({
    parts: doc.parts,
    materials: doc.materials.map(contractMaterial),
    knowledge_ids: [...doc.knowledge_ids].sort(),
    source: doc.source ?? null,
  });
  // 列约定为裸 hex（extraction_hash.slice('sha256:'.length) 同款）—— 不带前缀。
  return createHash('sha256').update(canonical).digest('hex');
}

export { isDraftDocumentV2 };
