import type { QuestionDraftDocumentT } from '@/core/schema/question-draft';
import type { AppliedChange, EditOpT } from '@/server/questions/draft-ops';
import {
  type EditTargetT,
  type Located,
  findPresentationBlock,
  locate,
} from '@/server/questions/draft-target';

// Which solve, calibration, rule, retrieval, and display work an accepted edit
// invalidates, and the CAS snapshot of the fields that batch is about to change.

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
