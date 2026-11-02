import { z } from 'zod';
import type { ScoringRuleT } from '@/core/schema/assessment/scoring-rule';
import type {
  DraftMaterialT,
  DraftPartT,
  DraftRubricCriterionT,
  DraftSelectItemT,
  DraftUnitT,
  QuestionDraftDocumentT,
} from '@/core/schema/question-draft';
import { mintDraftItemId, mintDraftMaterialId } from '@/core/schema/question-draft';

// Stable-id addressing for a question draft: never array index or display label.
// Rewriting item text or material content remints the content-addressed id and
// cascades refs in the same edit. Integrity reports dangling refs and duplicate
// ids; the op batch treats only newly introduced ones as errors.

// ---------- target ----------

const TargetQuestion = z.object({ kind: z.literal('question') }).strict();
const TargetPart = z.object({ kind: z.literal('part'), id: z.string().min(1) }).strict();
const TargetUnit = z.object({ kind: z.literal('unit'), id: z.string().min(1) }).strict();
const TargetItem = z
  .object({ kind: z.literal('item'), unit_id: z.string().min(1), id: z.string().min(1) })
  .strict();
const TargetMaterial = z.object({ kind: z.literal('material'), id: z.string().min(1) }).strict();
const TargetCriterion = z
  .object({ kind: z.literal('criterion'), unit_id: z.string().min(1), id: z.string().min(1) })
  .strict();
/** Presentation block; this lane allows metadata ops only. */
const TargetBlock = z.object({ kind: z.literal('block'), id: z.string().min(1) }).strict();

export const EditTarget = z.discriminatedUnion('kind', [
  TargetQuestion,
  TargetPart,
  TargetUnit,
  TargetItem,
  TargetMaterial,
  TargetCriterion,
  TargetBlock,
]);
export type EditTargetT = z.infer<typeof EditTarget>;

export type OpIssueCode =
  | 'target_not_found'
  | 'ambiguous_text_anchor'
  | 'text_anchor_not_found'
  | 'dangling_reference'
  | 'forbidden_field'
  | 'identity_change_attempt'
  | 'invalid_value'
  | 'duplicate_id'
  | 'unresolved_reference'
  | 'unsupported_op';

// ---------- 寻址 ----------

export interface Located {
  part?: DraftPartT;
  unit?: DraftUnitT;
  partIndex?: number;
  unitIndex?: number;
}

export function locate(doc: QuestionDraftDocumentT, target: EditTargetT): Located | null {
  switch (target.kind) {
    case 'question':
      return {};
    case 'part': {
      const partIndex = doc.parts.findIndex((p) => p.part_id === target.id);
      return partIndex >= 0 ? { part: doc.parts[partIndex], partIndex } : null;
    }
    case 'unit': {
      for (const [partIndex, part] of doc.parts.entries()) {
        const unitIndex = part.units.findIndex((u) => u.unit_id === target.id);
        if (unitIndex >= 0) return { part, unit: part.units[unitIndex], partIndex, unitIndex };
      }
      return null;
    }
    case 'item':
    case 'criterion': {
      for (const [partIndex, part] of doc.parts.entries()) {
        const unitIndex = part.units.findIndex((u) => u.unit_id === target.unit_id);
        if (unitIndex >= 0) {
          const unit = part.units[unitIndex];
          if (target.kind === 'item') {
            if (unit.response_spec.kind !== 'select') return null;
            return unit.response_spec.items.some((i) => i.item_id === target.id)
              ? { part, unit, partIndex, unitIndex }
              : null;
          }
          return (unit.rubric?.criteria ?? []).some((c) => c.criterion_id === target.id)
            ? { part, unit, partIndex, unitIndex }
            : null;
        }
      }
      return null;
    }
    case 'material': {
      return doc.materials.some((m) => m.material_id === target.id) ? {} : null;
    }
    case 'block': {
      return findPresentationBlock(doc.presentation, target.id) != null ? {} : null;
    }
  }
}

function materialOf(doc: QuestionDraftDocumentT, id: string): DraftMaterialT | undefined {
  return doc.materials.find((m) => m.material_id === id);
}

function itemOf(unit: DraftUnitT, id: string) {
  if (unit.response_spec.kind !== 'select') return undefined;
  return unit.response_spec.items.find((i) => i.item_id === id);
}

function criterionOf(unit: DraftUnitT, id: string) {
  return unit.rubric?.criteria.find((c) => c.criterion_id === id);
}

/** locate guarantees existence here; throw OpFailure instead of using non-null asserts. */
export function requirePart(located: Located): DraftPartT {
  if (located.part == null) fail('target_not_found', 'part of target not found');
  return located.part;
}

export function requireUnit(located: Located): DraftUnitT {
  if (located.unit == null) fail('target_not_found', 'unit of target not found');
  return located.unit;
}

export function requireItem(unit: DraftUnitT, id: string): DraftSelectItemT {
  const item = itemOf(unit, id);
  if (item == null) fail('target_not_found', `item '${id}' not found`);
  return item;
}

export function requireCriterion(unit: DraftUnitT, id: string): DraftRubricCriterionT {
  const criterion = criterionOf(unit, id);
  if (criterion == null) fail('target_not_found', `criterion '${id}' not found`);
  return criterion;
}

export function requireMaterial(doc: QuestionDraftDocumentT, id: string): DraftMaterialT {
  const material = materialOf(doc, id);
  if (material == null) fail('target_not_found', `material '${id}' not found`);
  return material;
}

export function findPresentationBlock(node: unknown, id: string): Record<string, unknown> | null {
  if (node == null || typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;
  if (obj.block_id === id) return obj;
  for (const value of Object.values(obj)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = findPresentationBlock(item, id);
        if (found != null) return found;
      }
    } else if (value != null && typeof value === 'object') {
      const found = findPresentationBlock(value, id);
      if (found != null) return found;
    }
  }
  return null;
}

// ---------- 身份重铸级联 ----------

/** Item text change → new content-addressed id; cascade the unit key and per_item rule. */
export function remintItemId(unit: DraftUnitT, oldId: string, newText: string): string {
  const newId = mintDraftItemId(newText);
  if (newId === oldId) return oldId;
  if (unit.response_spec.kind !== 'select') return newId;
  if (unit.response_spec.items.some((i) => i.item_id === newId)) {
    throw new OpError('duplicate_id', `reminted item_id '${newId}' collides with an existing item`);
  }
  if (unit.key?.kind === 'select') {
    unit.key.accepted_item_ids = unit.key.accepted_item_ids.map((id) =>
      id === oldId ? newId : id,
    );
  }
  if (unit.rule != null) {
    unit.rule = remapRuleItemIds(unit.rule, oldId, newId);
  }
  return newId;
}

/** Material content change → new content-addressed id; cascade part/unit refs. */
export function remintMaterialId(
  doc: QuestionDraftDocumentT,
  oldId: string,
  next: DraftMaterialT,
): void {
  const newId = mintDraftMaterialId(
    next.kind,
    next.content_md ?? next.asset.digest ?? next.asset.asset_id,
  );
  if (newId === oldId) return;
  if (doc.materials.some((m) => m.material_id === newId && m !== next)) {
    throw new OpError(
      'duplicate_id',
      `reminted material_id '${newId}' collides with an existing material`,
    );
  }
  next.material_id = newId;
  for (const part of doc.parts) {
    part.material_ids = part.material_ids.map((id) => (id === oldId ? newId : id));
    for (const unit of part.units) {
      unit.material_refs = unit.material_refs.map((id) => (id === oldId ? newId : id));
    }
  }
}

function remapRuleItemIds(rule: ScoringRuleT, oldId: string, newId: string): ScoringRuleT {
  const remapOutcome = (outcome: ScoringRuleT['otherwise']): ScoringRuleT['otherwise'] => {
    if (!('per_item' in outcome)) return outcome;
    const per_item: Record<string, number> = {};
    for (const [id, points] of Object.entries(outcome.per_item) as [string, number][]) {
      per_item[id === oldId ? newId : id] = points;
    }
    return { ...outcome, per_item };
  };
  return {
    ...rule,
    cases: rule.cases.map((ruleCase) => ({ ...ruleCase, award: remapOutcome(ruleCase.award) })),
    otherwise: remapOutcome(rule.otherwise),
  };
}

export class OpError extends Error {
  constructor(
    public code: OpIssueCode,
    detail: string,
    public locations?: { offset: number }[],
  ) {
    super(detail);
  }
}

// ---------- 引用完整性与重复身份 ----------

interface DocIntegrityIssue {
  code:
    | 'unresolved_material_ref'
    | 'unresolved_key_item'
    | 'duplicate_id'
    | 'unresolved_blank_order_slot'
    | 'blank_order_coverage';
  detail: string;
}

export function integrityIssues(doc: QuestionDraftDocumentT): DocIntegrityIssue[] {
  const issues: DocIntegrityIssue[] = [];
  const materialIds = new Set<string>();
  for (const m of doc.materials) {
    if (materialIds.has(m.material_id)) {
      issues.push({ code: 'duplicate_id', detail: `duplicate material_id '${m.material_id}'` });
    }
    materialIds.add(m.material_id);
  }
  const partIds = new Set<string>();
  const slotIds = new Set<string>();
  const unitIds = new Set<string>();
  for (const part of doc.parts) {
    if (partIds.has(part.part_id)) {
      issues.push({ code: 'duplicate_id', detail: `duplicate part_id '${part.part_id}'` });
    }
    partIds.add(part.part_id);
    for (const id of part.material_ids) {
      if (!materialIds.has(id)) {
        issues.push({
          code: 'unresolved_material_ref',
          detail: `part '${part.part_id}' references missing material '${id}'`,
        });
      }
    }
    // blank_order must cover each blank slot of this part exactly once; only this
    // part's slot ids count.
    if (part.blank_order != null) {
      const seen = new Set<string>();
      const blankSlotIds = new Set<string>();
      for (const unit of part.units) {
        if (unit.response_class === 'blank' && unit.response_spec.kind === 'blank') {
          blankSlotIds.add(unit.slot_id);
        }
      }
      for (const slotId of part.blank_order) {
        if (seen.has(slotId)) {
          issues.push({
            code: 'duplicate_id',
            detail: `part '${part.part_id}' blank_order lists slot '${slotId}' more than once`,
          });
          continue;
        }
        seen.add(slotId);
        if (!blankSlotIds.has(slotId)) {
          issues.push({
            code: 'unresolved_blank_order_slot',
            detail: `part '${part.part_id}' blank_order references '${slotId}', which is not a blank slot of this part`,
          });
        }
      }
      const missing = [...blankSlotIds].filter((id) => !seen.has(id));
      if (missing.length > 0) {
        issues.push({
          code: 'blank_order_coverage',
          detail: `part '${part.part_id}' declares blank_order but does not cover its blank slot(s): ${missing.join(', ')}`,
        });
      }
    }
    for (const unit of part.units) {
      if (unitIds.has(unit.unit_id)) {
        issues.push({ code: 'duplicate_id', detail: `duplicate unit_id '${unit.unit_id}'` });
      }
      unitIds.add(unit.unit_id);
      if (slotIds.has(unit.slot_id)) {
        issues.push({ code: 'duplicate_id', detail: `duplicate slot_id '${unit.slot_id}'` });
      }
      slotIds.add(unit.slot_id);
      for (const ref of unit.material_refs) {
        if (!materialIds.has(ref)) {
          issues.push({
            code: 'unresolved_material_ref',
            detail: `unit '${unit.unit_id}' references missing material '${ref}'`,
          });
        }
      }
      if (unit.response_spec.kind === 'select') {
        const itemIds = new Set(unit.response_spec.items.map((i) => i.item_id));
        if (itemIds.size !== unit.response_spec.items.length) {
          issues.push({
            code: 'duplicate_id',
            detail: `unit '${unit.unit_id}' has duplicate item_id`,
          });
        }
        if (unit.key?.kind === 'select') {
          for (const id of unit.key.accepted_item_ids) {
            if (!itemIds.has(id)) {
              issues.push({
                code: 'unresolved_key_item',
                detail: `unit '${unit.unit_id}' key references item '${id}' not in universe`,
              });
            }
          }
        }
      }
    }
  }
  return issues;
}

export function fail(code: OpIssueCode, detail: string, locations?: { offset: number }[]): never {
  throw new OpError(code, detail, locations);
}
