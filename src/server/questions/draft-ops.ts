import { z } from 'zod';
import { BlankAnswerShape } from '@/core/schema/assessment';
import { VersionedAssetRef } from '@/core/schema/assessment/materials';
import type { ScoringRuleT } from '@/core/schema/assessment/scoring-rule';
import { ScoringRule } from '@/core/schema/assessment/scoring-rule';
import type {
  DraftMaterialT,
  DraftPartT,
  DraftRubricCriterionT,
  DraftSelectItemT,
  DraftUnitT,
  QuestionDraftDocumentT,
} from '@/core/schema/question-draft';
import {
  DraftMaterial,
  DraftPart,
  DraftRubricCriterion,
  DraftSelectItem,
  DraftUnit,
  DraftUnitKey,
  QuestionDraftDocument,
  mintDraftAssetId,
  mintDraftItemId,
  mintDraftMaterialId,
  sha256Hex,
} from '@/core/schema/question-draft';

// edit_question ops engine (pure, no IO).
//
// Targets are addressed by stable id, never array index or display label. A batch is
// atomic: any failure discards all ops. Rewriting semantic content (item text, material
// content) remints the content-addressed id and cascades refs in the same op; direct
// *_id writes are identity_change_attempt. Metadata cannot self-grant authority fields.
// Incomplete drafts can be saved; only newly introduced dangling refs or duplicates
// are op errors.

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

// ---------- ops ----------

export const EditOp = z.discriminatedUnion('op', [
  z
    .object({ op: z.literal('set'), target: EditTarget, fields: z.record(z.string(), z.unknown()) })
    .strict(),
  z.object({ op: z.literal('clear'), target: EditTarget, field: z.string().min(1) }).strict(),
  z
    .object({
      op: z.literal('add'),
      target: EditTarget,
      collection: z.string().min(1),
      value: z.unknown(),
    })
    .strict(),
  z
    .object({
      op: z.literal('remove'),
      target: EditTarget,
      collection: z.string().min(1),
      id: z.string().min(1),
    })
    .strict(),
  z
    .object({
      op: z.literal('replace_all'),
      target: EditTarget,
      collection: z.string().min(1),
      values: z.array(z.unknown()),
    })
    .strict(),
  z
    .object({
      op: z.literal('replace_text'),
      target: EditTarget,
      field: z.string().min(1),
      old: z.string().min(1),
      new: z.string(),
    })
    .strict(),
  z
    .object({
      op: z.literal('set_metadata'),
      target: EditTarget,
      values: z.record(z.string(), z.unknown()),
    })
    .strict(),
  z
    .object({
      op: z.literal('unset_metadata'),
      target: EditTarget,
      keys: z.array(z.string().min(1)).min(1),
    })
    .strict(),
  z
    .object({
      op: z.literal('move'),
      target: EditTarget,
      /** Target part when moving a unit; omitted for reorders. */
      parent_id: z.string().min(1).optional(),
      before_id: z.string().min(1).optional(),
      after_id: z.string().min(1).optional(),
    })
    .strict(),
]);
export type EditOpT = z.infer<typeof EditOp>;

// ---------- 结果 ----------

export interface OpIssue {
  code:
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
  detail: string;
  target?: EditTargetT;
  locations?: { offset: number }[];
}

export interface AppliedChange {
  op: EditOpT['op'];
  target: EditTargetT;
  /** Changed fields/collections for the save receipt. */
  fields: string[];
  /** Semantic identity remint (item/material content change → new id + cascaded refs). */
  identity_remap?: { from: string; to: string };
}

export type ApplyOpsResult =
  | { ok: true; document: QuestionDraftDocumentT; changes: AppliedChange[]; noop: boolean }
  | { ok: false; issues: OpIssue[] };

// ---------- 保留字段 ----------

/** Authority/scoring/admission fields that metadata must not self-grant. */
const RESERVED_METADATA_KEYS = new Set([
  'id',
  'part_id',
  'unit_id',
  'slot_id',
  'item_id',
  'material_id',
  'key',
  'accepted_item_ids',
  'points',
  'rule',
  'method',
  'rubric',
  'reference_md',
  'response_class',
  'response_spec',
  'admission',
  'gold_certified',
  'serving_admission',
  'claim_policy',
  'verified',
  'published_by',
]);

/** Per-kind set whitelist; *_id and structural fields are absent by design. */
const SETTABLE_FIELDS: Record<EditTargetT['kind'], ReadonlySet<string>> = {
  question: new Set(['source']),
  part: new Set(['prompt_md', 'question_no', 'explanation_md', 'material_ids', 'blank_order']),
  unit: new Set([
    'points',
    'key',
    'reference_md',
    'rubric',
    'rule',
    'method',
    'material_refs',
    'response_spec',
    'response_class',
    'slot_id',
    'answer_shape',
  ]),
  item: new Set(['label_md', 'coordinates', 'gap_after_codepoint']),
  material: new Set(['content_md', 'caption', 'alt_text', 'visibility', 'kind', 'asset']),
  criterion: new Set(['statement_md', 'max', 'allowed_awards']),
  block: new Set(),
};

/** Per-kind clear whitelist. */
const CLEARABLE_FIELDS: Record<EditTargetT['kind'], ReadonlySet<string>> = {
  question: new Set(['knowledge_ids']),
  part: new Set(['prompt_md', 'question_no', 'explanation_md', 'material_ids', 'blank_order']),
  unit: new Set([
    'points',
    'key',
    'reference_md',
    'rubric',
    'rule',
    'material_refs',
    'answer_shape',
  ]),
  item: new Set(['label_md', 'coordinates', 'gap_after_codepoint']),
  material: new Set(['caption', 'alt_text', 'content_md']),
  criterion: new Set(['statement_md', 'allowed_awards']),
  block: new Set(),
};

function clearValueFor(value: unknown): unknown {
  if (Array.isArray(value)) return [];
  if (typeof value === 'string') return '';
  return undefined;
}

// ---------- 寻址 ----------

interface Located {
  part?: DraftPartT;
  unit?: DraftUnitT;
  partIndex?: number;
  unitIndex?: number;
}

function locate(doc: QuestionDraftDocumentT, target: EditTargetT): Located | null {
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
function requirePart(located: Located): DraftPartT {
  if (located.part == null) fail('target_not_found', 'part of target not found');
  return located.part;
}

function requireUnit(located: Located): DraftUnitT {
  if (located.unit == null) fail('target_not_found', 'unit of target not found');
  return located.unit;
}

function requireItem(unit: DraftUnitT, id: string): DraftSelectItemT {
  const item = itemOf(unit, id);
  if (item == null) fail('target_not_found', `item '${id}' not found`);
  return item;
}

function requireCriterion(unit: DraftUnitT, id: string): DraftRubricCriterionT {
  const criterion = criterionOf(unit, id);
  if (criterion == null) fail('target_not_found', `criterion '${id}' not found`);
  return criterion;
}

function requireMaterial(doc: QuestionDraftDocumentT, id: string): DraftMaterialT {
  const material = materialOf(doc, id);
  if (material == null) fail('target_not_found', `material '${id}' not found`);
  return material;
}

function findPresentationBlock(node: unknown, id: string): Record<string, unknown> | null {
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
function remintItemId(unit: DraftUnitT, oldId: string, newText: string): string {
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
function remintMaterialId(doc: QuestionDraftDocumentT, oldId: string, next: DraftMaterialT): void {
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

class OpError extends Error {
  constructor(
    public code: OpIssue['code'],
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

function integrityIssues(doc: QuestionDraftDocumentT): DocIntegrityIssue[] {
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

// ---------- op 实施 ----------

function fail(code: OpIssue['code'], detail: string, locations?: { offset: number }[]): never {
  throw new OpError(code, detail, locations);
}

function applySet(
  doc: QuestionDraftDocumentT,
  target: EditTargetT,
  fields: Record<string, unknown>,
  changes: AppliedChange[],
): void {
  const allowed = SETTABLE_FIELDS[target.kind];
  const changedFields: string[] = [];
  const identityRemaps: { from: string; to: string }[] = [];
  for (const [field, value] of Object.entries(fields)) {
    if (!allowed.has(field)) {
      fail(
        field.endsWith('_id') || field === 'id' ? 'identity_change_attempt' : 'forbidden_field',
        `field '${field}' cannot be set on target kind '${target.kind}'`,
      );
    }
    const located = locate(doc, target);
    if (located == null) fail('target_not_found', `target ${target.kind} not found`);
    switch (target.kind) {
      case 'question': {
        if (field === 'source') {
          const parsed = z
            .object({
              kind: z.enum([
                'generated',
                'adapted',
                'owner_material',
                'photo_ingest',
                'jyeoo_fetch',
                'sourcing_web',
                'manual',
              ]),
              adapted_from_question_id: z.string().optional(),
              ref: z.string().optional(),
              note: z.string().optional(),
            })
            .safeParse(value);
          if (!parsed.success) fail('invalid_value', `invalid source: ${parsed.error.message}`);
          doc.source = parsed.data;
        }
        break;
      }
      case 'part': {
        const part = requirePart(located);
        if (field === 'material_ids') {
          const parsed = z.array(z.string().min(1)).safeParse(value);
          if (!parsed.success) fail('invalid_value', 'material_ids must be string[]');
          part.material_ids = parsed.data;
        } else if (field === 'blank_order') {
          // Explicit logical order (slot ids); null/undefined clears the declaration.
          // Coverage is validated by integrityIssues and the publish barrier.
          if (value == null) {
            part.blank_order = undefined;
          } else {
            const parsed = z.array(z.string().min(1)).min(1).safeParse(value);
            if (!parsed.success) {
              fail(
                'invalid_value',
                'blank_order must be a non-empty string[] of slot ids (or null to clear)',
              );
            }
            part.blank_order = parsed.data;
          }
        } else if (field === 'question_no' || field === 'explanation_md') {
          if (value !== undefined && typeof value !== 'string')
            fail('invalid_value', `${field} must be a string`);
          (part as Record<string, unknown>)[field] = value;
        } else {
          if (typeof value !== 'string') fail('invalid_value', `${field} must be a string`);
          (part as Record<string, unknown>)[field] = value;
        }
        break;
      }
      case 'unit': {
        const unit = requireUnit(located);
        applyUnitSet(unit, field, value);
        break;
      }
      case 'item': {
        const unit = requireUnit(located);
        const item = requireItem(unit, target.id);
        if (field === 'label_md') {
          if (typeof value !== 'string') fail('invalid_value', 'label_md must be a string');
          item.label_md = value;
          const newId = remintItemId(unit, target.id, item.label_md ?? item.item_id);
          if (newId !== target.id) {
            item.item_id = newId;
            identityRemaps.push({ from: target.id, to: newId });
            target = { ...target, id: newId };
          }
        } else if (field === 'coordinates') {
          const parsed = z.record(z.string(), z.string().min(1)).nullable().safeParse(value);
          if (!parsed.success) fail('invalid_value', 'coordinates must be a record or null');
          (item as Record<string, unknown>).coordinates = parsed.data ?? undefined;
        } else {
          const parsed = z.number().int().min(1).nullable().safeParse(value);
          if (!parsed.success) fail('invalid_value', 'gap_after_codepoint must be int>=1 or null');
          (item as Record<string, unknown>).gap_after_codepoint = parsed.data ?? undefined;
        }
        break;
      }
      case 'material': {
        const material = requireMaterial(doc, target.id);
        if (field === 'content_md') {
          if (value != null && typeof value !== 'string')
            fail('invalid_value', 'content_md must be a string or null');
          // Inline text material: recompute asset identity from content so it never
          // points at old bytes. Binary material requires a matching asset ref.
          const inline = material.content_md != null || material.asset.asset_id.startsWith('txt_');
          if (inline) {
            material.content_md = (value as string | undefined) ?? undefined;
            material.asset = {
              asset_id: mintDraftAssetId('txt', material.content_md ?? ''),
              digest: sha256Hex(material.content_md ?? ''),
            };
          } else {
            const supplied = VersionedAssetRef.safeParse(fields.asset);
            if (!supplied.success) {
              fail(
                'invalid_value',
                "binary-asset material: content_md edit requires a matching 'asset' ref {asset_id,digest} in the same set op",
              );
            }
            material.content_md = (value as string | undefined) ?? undefined;
            material.asset = supplied.data;
          }
          remintMaterialId(doc, target.id, material);
          if (material.material_id !== target.id) {
            identityRemaps.push({ from: target.id, to: material.material_id });
          }
        } else if (field === 'asset') {
          // Explicit byte swap: validate {asset_id,digest} and remint the identity.
          const parsedRef = VersionedAssetRef.safeParse(value);
          if (!parsedRef.success) fail('invalid_value', 'asset must be { asset_id, digest }');
          material.asset = parsedRef.data;
          remintMaterialId(doc, target.id, material);
          if (material.material_id !== target.id) {
            identityRemaps.push({ from: target.id, to: material.material_id });
          }
        } else if (field === 'kind') {
          (material as Record<string, unknown>)[field] = value;
          remintMaterialId(doc, target.id, material);
          if (material.material_id !== target.id) {
            identityRemaps.push({ from: target.id, to: material.material_id });
          }
        } else if (field === 'visibility') {
          const parsed = z.enum(['public', 'private']).nullable().safeParse(value);
          if (!parsed.success) fail('invalid_value', "visibility must be 'public'|'private'|null");
          (material as Record<string, unknown>).visibility = parsed.data ?? undefined;
        } else {
          if (value !== undefined && typeof value !== 'string')
            fail('invalid_value', `${field} must be a string`);
          (material as Record<string, unknown>)[field] = value;
        }
        break;
      }
      case 'criterion': {
        const criterion = requireCriterion(requireUnit(located), target.id);
        if (field === 'max') {
          if (typeof value !== 'number') fail('invalid_value', 'max must be a number');
          criterion.max = value;
        } else if (field === 'allowed_awards') {
          const parsed = z.array(z.number()).nullable().safeParse(value);
          if (!parsed.success) fail('invalid_value', 'allowed_awards must be number[]|null');
          criterion.allowed_awards = parsed.data ?? undefined;
        } else {
          if (value !== undefined && typeof value !== 'string')
            fail('invalid_value', `${field} must be a string`);
          criterion.statement_md = value as string | undefined;
        }
        break;
      }
      case 'block':
        fail('forbidden_field', 'presentation blocks only support metadata ops in this lane');
    }
    changedFields.push(field);
  }
  for (const remap of identityRemaps) {
    changes.push({ op: 'set', target, fields: changedFields, identity_remap: remap });
    return;
  }
  changes.push({ op: 'set', target, fields: changedFields });
}

/**
 * Inherit an existing normalization when a key edit omits one, so re-saving a seeded
 * draft does not fall back to the new-question defaults. Explicit case/trim wins.
 */
function inheritOmittedBlankNormalization(
  previous: DraftUnitT['key'],
  next: DraftUnitT['key'],
): DraftUnitT['key'] {
  if (next == null || next.kind !== 'blank' || next.key.kind !== 'text') return next;
  const inherited =
    next.key.normalization ??
    (previous?.kind === 'blank' && previous.key.kind === 'text'
      ? previous.key.normalization
      : undefined);
  if (inherited == null) return next;
  return {
    kind: 'blank',
    key: {
      ...next.key,
      normalization: {
        ...inherited,
        ...(next.key.case_sensitive === false ? { casefold: true } : {}),
        ...(next.key.case_sensitive === true ? { casefold: false } : {}),
        ...(next.key.trim === false ? { trim_outer: false } : {}),
        ...(next.key.trim === true ? { trim_outer: true } : {}),
      },
    },
  };
}

function applyUnitSet(unit: DraftUnitT, field: string, value: unknown): void {
  switch (field) {
    case 'points': {
      if (value !== null && (typeof value !== 'number' || value < 0)) {
        fail('invalid_value', 'points must be a non-negative number or null');
      }
      unit.points = value as number | null;
      return;
    }
    case 'slot_id':
    case 'unit_id':
      fail('identity_change_attempt', `field '${field}' is identity — cannot be rewritten`);
      return;
    case 'key': {
      if (value == null) {
        unit.key = undefined;
        return;
      }
      const parsed = DraftUnitKey.safeParse(value);
      if (!parsed.success) fail('invalid_value', `invalid key: ${parsed.error.message}`);
      unit.key = inheritOmittedBlankNormalization(unit.key, parsed.data);
      return;
    }
    case 'rule': {
      if (value == null) {
        unit.rule = undefined;
        return;
      }
      const parsed = ScoringRule.safeParse(value);
      if (!parsed.success) fail('invalid_value', `invalid rule: ${parsed.error.message}`);
      unit.rule = parsed.data;
      return;
    }
    case 'method': {
      const parsed = z
        .object({
          kind: z.enum(['set-compare', 'exact', 'jev', 'ai-rubric', 'human_review']),
          version: z.string().optional(),
          binding: z.string().optional(),
          task_kind: z.string().optional(),
        })
        .safeParse(value);
      if (!parsed.success) fail('invalid_value', `invalid method: ${parsed.error.message}`);
      unit.method = parsed.data;
      return;
    }
    case 'reference_md': {
      if (value !== undefined && typeof value !== 'string') {
        fail('invalid_value', 'reference_md must be a string');
      }
      unit.reference_md = value as string | undefined;
      return;
    }
    case 'rubric': {
      if (value == null) {
        unit.rubric = undefined;
        return;
      }
      const parsed = z
        .object({
          criteria: z.array(DraftRubricCriterion),
          guidance_md: z.string().optional(),
        })
        .safeParse(value);
      if (!parsed.success) fail('invalid_value', `invalid rubric: ${parsed.error.message}`);
      unit.rubric = parsed.data;
      return;
    }
    case 'material_refs': {
      const parsed = z.array(z.string().min(1)).safeParse(value);
      if (!parsed.success) fail('invalid_value', 'material_refs must be string[]');
      unit.material_refs = parsed.data;
      return;
    }
    case 'response_spec': {
      const parsed = z
        .discriminatedUnion('kind', [
          z.object({ kind: z.literal('select') }).passthrough(),
          z.object({ kind: z.literal('blank') }).passthrough(),
          z.object({ kind: z.literal('free') }).passthrough(),
        ])
        .safeParse(value);
      if (!parsed.success) fail('invalid_value', 'response_spec.kind must be select|blank|free');
      // Full shape is revalidated by the document-level parse at batch end.
      unit.response_spec = value as DraftUnitT['response_spec'];
      return;
    }
    case 'response_class': {
      const parsed = z.enum(['select', 'blank', 'free']).safeParse(value);
      if (!parsed.success) fail('invalid_value', 'response_class must be select|blank|free');
      unit.response_class = parsed.data;
      return;
    }
    case 'answer_shape': {
      // answer_shape belongs to blank units; null/undefined clears it. Unknown
      // versions must fail parse rather than be stripped into "undeclared".
      if (unit.response_spec.kind !== 'blank') {
        fail(
          'invalid_value',
          `answer_shape only applies to blank units — unit '${unit.unit_id}' has response_spec.kind '${unit.response_spec.kind}'`,
        );
        return;
      }
      if (value == null) {
        unit.response_spec.answer_shape = undefined;
        return;
      }
      const parsed = BlankAnswerShape.safeParse(value);
      if (!parsed.success) {
        fail(
          'invalid_value',
          `invalid answer_shape: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`,
        );
      }
      unit.response_spec.answer_shape = parsed.data;
      return;
    }
    default:
      fail('forbidden_field', `field '${field}' cannot be set on a unit`);
  }
}

function applyClear(
  doc: QuestionDraftDocumentT,
  target: EditTargetT,
  field: string,
  changes: AppliedChange[],
): void {
  if (!CLEARABLE_FIELDS[target.kind].has(field)) {
    fail('forbidden_field', `field '${field}' cannot be cleared on target kind '${target.kind}'`);
  }
  const located = locate(doc, target);
  if (located == null) fail('target_not_found', `target ${target.kind} not found`);
  switch (target.kind) {
    case 'question':
      if (field === 'knowledge_ids') doc.knowledge_ids = [];
      break;
    case 'part': {
      const part = requirePart(located);
      if (field === 'material_ids') part.material_ids = [];
      else
        (part as Record<string, unknown>)[field] = clearValueFor(
          (part as Record<string, unknown>)[field],
        );
      break;
    }
    case 'unit': {
      const unit = requireUnit(located);
      if (field === 'points') unit.points = null;
      else if (field === 'material_refs') unit.material_refs = [];
      else if (field === 'answer_shape') {
        if (unit.response_spec.kind !== 'blank') {
          fail(
            'forbidden_field',
            `answer_shape only applies to blank units — unit '${unit.unit_id}' has response_spec.kind '${unit.response_spec.kind}'`,
          );
        }
        unit.response_spec.answer_shape = undefined;
      } else (unit as unknown as Record<string, unknown>)[field] = undefined;
      break;
    }
    case 'item': {
      const item = requireItem(requireUnit(located), target.id);
      (item as Record<string, unknown>)[field] = undefined;
      break;
    }
    case 'material': {
      const material = requireMaterial(doc, target.id);
      (material as Record<string, unknown>)[field] = undefined;
      break;
    }
    case 'criterion': {
      const criterion = requireCriterion(requireUnit(located), target.id);
      (criterion as Record<string, unknown>)[field] = undefined;
      break;
    }
    case 'block':
      fail('forbidden_field', 'presentation blocks only support metadata ops in this lane');
  }
  changes.push({ op: 'clear', target, fields: [field] });
}

function collectionEntries(
  doc: QuestionDraftDocumentT,
  target: EditTargetT,
  collection: string,
): {
  owner: string;
  list: unknown[] | null;
  itemKind: 'part' | 'unit' | 'item' | 'material' | 'criterion' | 'knowledge' | 'ref' | 'evidence';
} | null {
  const located = locate(doc, target);
  if (located == null) return null;
  switch (target.kind) {
    case 'question':
      if (collection === 'parts') return { owner: 'question', list: doc.parts, itemKind: 'part' };
      if (collection === 'materials')
        return { owner: 'question', list: doc.materials, itemKind: 'material' };
      if (collection === 'knowledge_ids')
        return { owner: 'question', list: doc.knowledge_ids, itemKind: 'knowledge' };
      return null;
    case 'part':
      if (collection === 'units')
        return { owner: 'part', list: requirePart(located).units, itemKind: 'unit' };
      if (collection === 'material_ids')
        return { owner: 'part', list: requirePart(located).material_ids, itemKind: 'ref' };
      return null;
    case 'unit': {
      const unit = requireUnit(located);
      if (collection === 'items') {
        return unit.response_spec.kind === 'select'
          ? { owner: 'unit', list: unit.response_spec.items, itemKind: 'item' }
          : null;
      }
      if (collection === 'material_refs')
        return { owner: 'unit', list: unit.material_refs, itemKind: 'ref' };
      if (collection === 'criteria') {
        if (unit.rubric == null) return null;
        return { owner: 'unit', list: unit.rubric.criteria, itemKind: 'criterion' };
      }
      return null;
    }
    default:
      return null;
  }
}

function parseCollectionValue(
  itemKind: string,
  value: unknown,
): { id: string | null; parsed: unknown } {
  switch (itemKind) {
    case 'part': {
      const p = DraftPart.safeParse(value);
      if (!p.success) fail('invalid_value', `invalid part: ${p.error.message}`);
      return { id: p.data.part_id, parsed: p.data };
    }
    case 'unit': {
      const u = DraftUnit.safeParse(value);
      if (!u.success) fail('invalid_value', `invalid unit: ${u.error.message}`);
      return { id: u.data.unit_id, parsed: u.data };
    }
    case 'item': {
      const i = DraftSelectItem.safeParse(value);
      if (!i.success) fail('invalid_value', `invalid item: ${i.error.message}`);
      return { id: i.data.item_id, parsed: i.data };
    }
    case 'material': {
      const m = DraftMaterial.safeParse(value);
      if (!m.success) fail('invalid_value', `invalid material: ${m.error.message}`);
      return { id: m.data.material_id, parsed: m.data };
    }
    case 'criterion': {
      const c = DraftRubricCriterion.safeParse(value);
      if (!c.success) fail('invalid_value', `invalid criterion: ${c.error.message}`);
      return { id: c.data.criterion_id, parsed: c.data };
    }
    case 'knowledge':
    case 'ref': {
      if (typeof value !== 'string' || value.length === 0)
        fail('invalid_value', 'collection value must be a non-empty id string');
      return { id: value, parsed: value };
    }
    default:
      fail('invalid_value', `unknown collection kind '${itemKind}'`);
  }
}

function collectionIdOf(_itemKind: string, value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value != null && typeof value === 'object') {
    const v = value as Record<string, unknown>;
    return (v.item_id ?? v.unit_id ?? v.part_id ?? v.material_id ?? v.criterion_id ?? null) as
      | string
      | null;
  }
  return null;
}

function applyAdd(
  doc: QuestionDraftDocumentT,
  target: EditTargetT,
  collection: string,
  value: unknown,
  changes: AppliedChange[],
): void {
  if (target.kind === 'unit' && collection === 'criteria') {
    const unit = locate(doc, target)?.unit;
    if (unit != null && unit.rubric == null) unit.rubric = { criteria: [] };
  }
  const entries = collectionEntries(doc, target, collection);
  if (entries == null || entries.list == null) {
    fail(
      'unsupported_op',
      `collection '${collection}' does not exist on target kind '${target.kind}'`,
    );
  }
  const { id, parsed } = parseCollectionValue(entries.itemKind, value);
  if (id != null && entries.list.some((v) => collectionIdOf(entries.itemKind, v) === id)) {
    fail('duplicate_id', `collection '${collection}' already contains id '${id}'`);
  }
  entries.list.push(parsed);
  changes.push({ op: 'add', target, fields: [collection] });
}

function applyRemove(
  doc: QuestionDraftDocumentT,
  target: EditTargetT,
  collection: string,
  id: string,
  changes: AppliedChange[],
): void {
  const entries = collectionEntries(doc, target, collection);
  if (entries == null || entries.list == null) {
    fail(
      'unsupported_op',
      `collection '${collection}' does not exist on target kind '${target.kind}'`,
    );
  }
  const index = entries.list.findIndex((v) => collectionIdOf(entries.itemKind, v) === id);
  if (index < 0) fail('target_not_found', `'${id}' not found in collection '${collection}'`);
  entries.list.splice(index, 1);
  changes.push({ op: 'remove', target, fields: [collection] });
}

function applyReplaceAll(
  doc: QuestionDraftDocumentT,
  target: EditTargetT,
  collection: string,
  values: unknown[],
  changes: AppliedChange[],
): void {
  if (target.kind === 'unit' && collection === 'criteria') {
    const unit = locate(doc, target)?.unit;
    if (unit != null && unit.rubric == null) unit.rubric = { criteria: [] };
  }
  const entries = collectionEntries(doc, target, collection);
  if (entries == null || entries.list == null) {
    fail(
      'unsupported_op',
      `collection '${collection}' does not exist on target kind '${target.kind}'`,
    );
  }
  const parsed = values.map((v) => parseCollectionValue(entries.itemKind, v).parsed);
  const seen = new Set<string>();
  for (const v of parsed) {
    const id = collectionIdOf(entries.itemKind, v);
    if (id != null) {
      if (seen.has(id)) fail('duplicate_id', `duplicate id '${id}' in replace_all '${collection}'`);
      seen.add(id);
    }
  }
  entries.list.splice(0, entries.list.length, ...parsed);
  changes.push({ op: 'replace_all', target, fields: [collection] });
}

const REPLACEABLE_TEXT_FIELDS: Record<EditTargetT['kind'], ReadonlySet<string>> = {
  question: new Set(),
  part: new Set(['prompt_md', 'explanation_md']),
  unit: new Set(['reference_md']),
  item: new Set(['label_md']),
  material: new Set(['content_md', 'caption', 'alt_text']),
  criterion: new Set(['statement_md']),
  block: new Set(),
};

function textFieldOf(
  doc: QuestionDraftDocumentT,
  target: EditTargetT,
  field: string,
): {
  get: () => string | undefined;
  set: (v: string | undefined) => void;
  unit?: DraftUnitT;
  material?: DraftMaterialT;
  reminted?: () => string | undefined;
} | null {
  const located = locate(doc, target);
  if (located == null) return null;
  switch (target.kind) {
    case 'part': {
      const part = requirePart(located);
      return {
        get: () => (part as Record<string, unknown>)[field] as string | undefined,
        set: (v) => ((part as Record<string, unknown>)[field] = v),
      };
    }
    case 'unit': {
      const unit = requireUnit(located);
      return {
        get: () => unit.reference_md,
        set: (v) => (unit.reference_md = v),
        unit,
      };
    }
    case 'item': {
      const unit = requireUnit(located);
      const item = requireItem(unit, target.id);
      let remintedId: string | undefined;
      return {
        get: () => item.label_md,
        set: (v) => {
          item.label_md = v;
          const newId = remintItemId(unit, target.id, v ?? item.item_id);
          if (newId !== target.id) {
            item.item_id = newId;
            remintedId = newId;
          }
        },
        reminted: () => remintedId,
        unit,
      };
    }
    case 'material': {
      const material = requireMaterial(doc, target.id);
      return {
        get: () => (material as Record<string, unknown>)[field] as string | undefined,
        set: (v) => {
          (material as Record<string, unknown>)[field] = v;
          // Inline text asset identity is the content fingerprint, so recompute it;
          // replace_text can only reach inline text, never binary material.
          if (field === 'content_md') {
            material.asset = {
              asset_id: mintDraftAssetId('txt', v ?? ''),
              digest: sha256Hex(v ?? ''),
            };
          }
          remintMaterialId(doc, target.id, material);
        },
        material,
      };
    }
    case 'criterion': {
      const criterion = requireCriterion(requireUnit(located), target.id);
      return {
        get: () => criterion.statement_md,
        set: (v) => (criterion.statement_md = v),
        unit: located.unit,
      };
    }
    default:
      return null;
  }
}

function applyReplaceText(
  doc: QuestionDraftDocumentT,
  target: EditTargetT,
  field: string,
  oldText: string,
  newText: string,
  changes: AppliedChange[],
): void {
  if (!REPLACEABLE_TEXT_FIELDS[target.kind].has(field)) {
    fail('forbidden_field', `field '${field}' is not replace_text-able on '${target.kind}'`);
  }
  const handle = textFieldOf(doc, target, field);
  if (handle == null) fail('target_not_found', `target ${target.kind} not found`);
  const current = handle.get();
  if (current == null || !current.includes(oldText)) {
    fail('text_anchor_not_found', `anchor not found in ${target.kind}.${field}`);
  }
  const locations: { offset: number }[] = [];
  let from = 0;
  for (;;) {
    const at = current.indexOf(oldText, from);
    if (at < 0) break;
    locations.push({ offset: at });
    from = at + oldText.length;
  }
  if (locations.length !== 1) {
    throw new OpError(
      'ambiguous_text_anchor',
      `anchor occurs ${locations.length} times in ${target.kind}.${field}`,
      locations,
    );
  }
  const at = locations[0].offset;
  handle.set(current.slice(0, at) + newText + current.slice(at + oldText.length));
  const remap =
    target.kind === 'material' && handle.material != null
      ? handle.material.material_id !== target.id
        ? { from: target.id, to: handle.material.material_id }
        : undefined
      : target.kind === 'item' && handle.reminted?.() != null
        ? // Item label is derived identity; report the remint so rule checks invalidate.
          { from: target.id, to: handle.reminted() as string }
        : undefined;
  changes.push({
    op: 'replace_text',
    target,
    fields: [field],
    ...(remap ? { identity_remap: remap } : {}),
  });
}

function metadataContainer(
  doc: QuestionDraftDocumentT,
  target: EditTargetT,
): Record<string, unknown> | null {
  const located = locate(doc, target);
  if (located == null) return null;
  switch (target.kind) {
    case 'question':
      return doc.metadata;
    case 'part':
      return requirePart(located).metadata;
    case 'unit':
      return requireUnit(located).metadata;
    case 'item': {
      const item = requireItem(requireUnit(located), target.id);
      item.metadata ??= {};
      return item.metadata;
    }
    case 'material': {
      const material = requireMaterial(doc, target.id);
      material.metadata ??= {};
      return material.metadata;
    }
    case 'criterion': {
      const criterion = requireCriterion(requireUnit(located), target.id);
      criterion.metadata ??= {};
      return criterion.metadata;
    }
    case 'block': {
      const block = findPresentationBlock(doc.presentation, target.id);
      if (block == null) fail('target_not_found', `presentation block '${target.id}' not found`);
      block.metadata ??= {};
      return block.metadata as Record<string, unknown>;
    }
  }
}

function applySetMetadata(
  doc: QuestionDraftDocumentT,
  target: EditTargetT,
  values: Record<string, unknown>,
  changes: AppliedChange[],
): void {
  const container = metadataContainer(doc, target);
  if (container == null) fail('target_not_found', `target ${target.kind} not found`);
  for (const key of Object.keys(values)) {
    if (RESERVED_METADATA_KEYS.has(key)) {
      fail('forbidden_field', `metadata key '${key}' is a reserved authority field`);
    }
  }
  for (const [key, value] of Object.entries(values)) container[key] = value;
  changes.push({ op: 'set_metadata', target, fields: Object.keys(values) });
}

function applyUnsetMetadata(
  doc: QuestionDraftDocumentT,
  target: EditTargetT,
  keys: string[],
  changes: AppliedChange[],
): void {
  const container = metadataContainer(doc, target);
  if (container == null) fail('target_not_found', `target ${target.kind} not found`);
  for (const key of keys) delete container[key];
  changes.push({ op: 'unset_metadata', target, fields: keys });
}

function reorder<T>(
  list: T[],
  fromIndex: number,
  anchor: { before_id?: string; after_id?: string },
  idOf: (v: T) => string | null,
): void {
  const item = list.splice(fromIndex, 1)[0];
  let index = list.length;
  if (anchor.before_id != null) {
    const at = list.findIndex((v) => idOf(v) === anchor.before_id);
    if (at < 0) fail('target_not_found', `before_id '${anchor.before_id}' not found`);
    index = at;
  } else if (anchor.after_id != null) {
    const at = list.findIndex((v) => idOf(v) === anchor.after_id);
    if (at < 0) fail('target_not_found', `after_id '${anchor.after_id}' not found`);
    index = at + 1;
  }
  list.splice(index, 0, item);
}

function applyMove(
  doc: QuestionDraftDocumentT,
  target: EditTargetT,
  parentId: string | undefined,
  anchor: { before_id?: string; after_id?: string },
  changes: AppliedChange[],
): void {
  if (anchor.before_id != null && anchor.after_id != null) {
    fail('invalid_value', 'move accepts before_id XOR after_id');
  }
  switch (target.kind) {
    case 'part': {
      const index = doc.parts.findIndex((p) => p.part_id === target.id);
      if (index < 0) fail('target_not_found', `part '${target.id}' not found`);
      if (parentId != null) fail('forbidden_field', 'parts cannot be re-parented (top-level)');
      reorder(doc.parts, index, anchor, (p) => p.part_id);
      changes.push({ op: 'move', target, fields: ['order'] });
      return;
    }
    case 'unit': {
      const located = locate(doc, target);
      if (located?.unit == null) fail('target_not_found', `unit '${target.id}' not found`);
      const unit = requireUnit(located);
      const fromPart = requirePart(located);
      const toPart = parentId != null ? doc.parts.find((p) => p.part_id === parentId) : fromPart;
      if (toPart == null) fail('target_not_found', `target part '${parentId}' not found`);
      // Crossing parts changes slot.part_id, but slot_id is stable identity and is
      // not derived from the part prefix.
      if (toPart !== fromPart) {
        fromPart.units.splice(fromPart.units.indexOf(unit), 1);
        toPart.units.push(unit);
      }
      const units = toPart.units;
      const index = units.indexOf(unit);
      reorder(units, index, anchor, (u) => u.unit_id);
      changes.push({ op: 'move', target, fields: ['parent', 'order'] });
      return;
    }
    case 'item': {
      const located = locate(doc, target);
      if (located?.unit == null) fail('target_not_found', `item '${target.id}' not found`);
      const unit = requireUnit(located);
      if (unit.response_spec.kind !== 'select') fail('invalid_value', 'unit has no item universe');
      const items = unit.response_spec.items;
      const index = items.findIndex((i) => i.item_id === target.id);
      reorder(items, index, anchor, (i) => i.item_id);
      changes.push({ op: 'move', target, fields: ['order'] });
      return;
    }
    default:
      fail('unsupported_op', `move is not supported for target kind '${target.kind}'`);
  }
}

// ---------- 主入口 ----------

/**
 * Apply a batch to a deep copy of the document. Any failure returns issues and the
 * caller discards the result; integrity and full-document validation run at batch end.
 */
export function applyEditOps(doc: QuestionDraftDocumentT, ops: EditOpT[]): ApplyOpsResult {
  const beforeIssues = new Set(integrityIssues(doc).map((i) => `${i.code}:${i.detail}`));
  const next = QuestionDraftDocument.parse(JSON.parse(JSON.stringify(doc)));
  const changes: AppliedChange[] = [];
  const issues: OpIssue[] = [];
  for (const op of ops) {
    try {
      switch (op.op) {
        case 'set':
          applySet(next, op.target, op.fields, changes);
          break;
        case 'clear':
          applyClear(next, op.target, op.field, changes);
          break;
        case 'add':
          applyAdd(next, op.target, op.collection, op.value, changes);
          break;
        case 'remove':
          applyRemove(next, op.target, op.collection, op.id, changes);
          break;
        case 'replace_all':
          applyReplaceAll(next, op.target, op.collection, op.values, changes);
          break;
        case 'replace_text':
          applyReplaceText(next, op.target, op.field, op.old, op.new, changes);
          break;
        case 'set_metadata':
          applySetMetadata(next, op.target, op.values, changes);
          break;
        case 'unset_metadata':
          applyUnsetMetadata(next, op.target, op.keys, changes);
          break;
        case 'move':
          applyMove(
            next,
            op.target,
            op.parent_id,
            { before_id: op.before_id, after_id: op.after_id },
            changes,
          );
          break;
      }
    } catch (err) {
      if (err instanceof OpError) {
        issues.push({
          code: err.code,
          detail: err.message,
          target: op.target,
          locations: err.locations,
        });
        break; // Atomic: stop at the first error.
      }
      throw err;
    }
  }
  if (issues.length > 0) return { ok: false, issues };

  const reparsed = QuestionDraftDocument.safeParse(next);
  if (!reparsed.success) {
    return {
      ok: false,
      issues: [
        { code: 'invalid_value', detail: `document invalid after ops: ${reparsed.error.message}` },
      ],
    };
  }
  const afterIssues = integrityIssues(reparsed.data).filter(
    (i) => !beforeIssues.has(`${i.code}:${i.detail}`),
  );
  if (afterIssues.length > 0) {
    return {
      ok: false,
      issues: afterIssues.map((i) => ({
        code:
          i.code === 'duplicate_id'
            ? 'duplicate_id'
            : i.code === 'blank_order_coverage'
              ? 'invalid_value'
              : 'dangling_reference',
        detail: i.detail,
      })),
    };
  }
  const noop = changes.length === 0 || JSON.stringify(reparsed.data) === JSON.stringify(doc);
  return { ok: true, document: reparsed.data, changes, noop };
}

// ---------- 失效域（edit-impact 表） ----------

export interface InvalidatedScope {
  /** Independent solve/calibration units to rerun. */
  solve_units: string[];
  calibration_units: string[];
  /** Rule verification units to rerun. */
  rule_verification_units: string[];
  /** Retrieval fields to reindex. */
  retrieval_fields: string[];
  /** Parts to re-render. */
  display_parts: string[];
  /** Whether presentation needs revalidation. */
  presentation_validation: boolean;
}

const SOLVE_AFFECTING = new Set([
  'prompt_md',
  'label_md',
  'items',
  'key',
  'reference_md',
  'response_spec',
  'material_refs',
  'material_ids',
  'content_md',
  'coordinates',
  'gap_after_codepoint',
  'axes',
  'text',
  // answer_shape changes response semantics, so it counts as a scoring input.
  'answer_shape',
]);
const RULE_AFFECTING = new Set([
  'points',
  'rule',
  'rubric',
  'criteria',
  'statement_md',
  'max',
  'allowed_awards',
]);
const METHOD_AFFECTING = new Set(['method']);
const RETRIEVAL_FIELDS = new Set(['knowledge_ids', 'explanation_md', 'kind']);
const PRESENTATION_AFFECTING = new Set(['block', 'presentation']);

/** CAS relevant_changes: current server values for op targets.
 * field = '<kind>:<id>[.<op-field>]'; current = value or null. */
export function relevantChangesForOps(
  doc: QuestionDraftDocumentT,
  ops: EditOpT[] | undefined,
): { field: string; current: unknown }[] {
  const out: { field: string; current: unknown }[] = [];
  for (const op of ops ?? []) {
    const target = 'target' in op ? op.target : null;
    if (target == null) continue;
    const targetId = 'id' in target ? target.id : 'root';
    const located = locate(doc, target);
    const node = nodeOfLocated(doc, target, located);
    const fieldNames =
      op.op === 'set'
        ? Object.keys(op.fields)
        : op.op === 'clear' || op.op === 'replace_text'
          ? [op.field]
          : null;
    if (fieldNames == null) {
      out.push({ field: `${target.kind}:${targetId}`, current: node ?? null });
      continue;
    }
    for (const fieldName of fieldNames) {
      out.push({
        field: `${target.kind}:${targetId}.${fieldName}`,
        current: node != null ? ((node as Record<string, unknown>)[fieldName] ?? null) : null,
      });
    }
  }
  return out;
}

/** Target → current server node for relevant_changes; null when missing. */
function nodeOfLocated(
  doc: QuestionDraftDocumentT,
  target: EditTargetT,
  located: Located | null,
): unknown {
  if (located == null) return null;
  switch (target.kind) {
    case 'question':
      return doc;
    case 'part':
      return located.part ?? null;
    case 'unit':
      return located.unit ?? null;
    case 'item':
      return (
        (located.unit?.response_spec.kind === 'select'
          ? located.unit.response_spec.items.find((i) => i.item_id === target.id)
          : null) ?? null
      );
    case 'criterion':
      return located.unit?.rubric?.criteria?.find((cr) => cr.criterion_id === target.id) ?? null;
    case 'material':
      return doc.materials.find((m) => m.material_id === target.id) ?? null;
    case 'block':
      return findPresentationBlock(doc.presentation, target.id) ?? null;
  }
}

export function computeInvalidatedScope(changes: AppliedChange[]): InvalidatedScope {
  const solve = new Set<string>();
  const calibration = new Set<string>();
  const ruleVerify = new Set<string>();
  const retrieval = new Set<string>();
  const display = new Set<string>();
  let presentation = false;
  for (const change of changes) {
    const target = change.target;
    const partId =
      target.kind === 'part'
        ? target.id
        : target.kind === 'unit' || target.kind === 'item' || target.kind === 'criterion'
          ? undefined
          : undefined;
    const unitId =
      target.kind === 'unit'
        ? target.id
        : target.kind === 'item' || target.kind === 'criterion'
          ? target.unit_id
          : undefined;
    for (const field of change.fields) {
      if (
        SOLVE_AFFECTING.has(field) ||
        field === 'units' ||
        field === 'parts' ||
        field === 'materials' ||
        field === 'order' ||
        field === 'parent'
      ) {
        if (unitId != null) {
          solve.add(unitId);
          calibration.add(unitId);
        }
        if (target.kind === 'part' || field === 'parts' || field === 'units') {
          if (partId != null) display.add(partId);
        }
        if (
          target.kind === 'material' ||
          field === 'materials' ||
          field === 'material_ids' ||
          field === 'material_refs'
        ) {
          if (unitId != null) {
            solve.add(unitId);
            calibration.add(unitId);
          }
        }
      }
      if (RULE_AFFECTING.has(field)) {
        if (unitId != null) {
          ruleVerify.add(unitId);
          calibration.add(unitId);
        }
      }
      if (METHOD_AFFECTING.has(field) && unitId != null) calibration.add(unitId);
      if (RETRIEVAL_FIELDS.has(field)) retrieval.add(field);
      if (PRESENTATION_AFFECTING.has(field) || target.kind === 'block') presentation = true;
      // blank_order only affects display/DTO order and the default presentation.
      if (field === 'blank_order') {
        if (partId != null) display.add(partId);
        presentation = true;
      }
      if (target.kind === 'item' || target.kind === 'unit' || target.kind === 'criterion') {
        if (unitId != null && SOLVE_AFFECTING.has(field)) display.add('');
      }
    }
    if (target.kind === 'part') display.add(target.id);
    if (change.identity_remap != null) {
      if (unitId != null) {
        solve.add(unitId);
        calibration.add(unitId);
        ruleVerify.add(unitId);
      }
    }
  }
  display.delete('');
  return {
    solve_units: [...solve],
    calibration_units: [...calibration],
    rule_verification_units: [...ruleVerify],
    retrieval_fields: [...retrieval],
    display_parts: [...display],
    presentation_validation: presentation,
  };
}
