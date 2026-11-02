import { z } from 'zod';
import { EvidenceAcceptanceRule } from '@/core/schema/assessment/materials';
import {
  ResponseItem,
  ResponseOption,
  ResponseSlot,
  type ResponseSlotT,
  SelectAxisEntry,
  SelectItem,
  SlotPlacement,
  TableSlot,
  validateResponseSpec,
} from '@/core/schema/assessment/response';
import type { QuestionGroupStructureT } from '@/core/schema/assessment/structure';
import type { ReadBankOutputSchema } from './read-bank';

type ReadItem = z.infer<typeof ReadBankOutputSchema>['items'][number];
type AuthorizedSlot = NonNullable<Extract<ReadItem, { status: 'ok' }>['content']>['slots'][number];
type SlotEvidenceSink = {
  add: (passage: { locator: string; text: string; part_ids: string[] }) => void;
  reserve: (chars: number, part_ids: string[], reason: string) => boolean;
  block: (part_ids: string[], reason: string) => void;
};

/** Consume only read_bank's authorized projection. Canonical schemas own slot
 * semantics; strict views additionally reject fields that its normal parser
 * would strip. No content/answer permission decision lives in this adapter. */
export function freezeBankResponseSlots(
  slots: AuthorizedSlot[],
  structure: QuestionGroupStructureT,
  sink: SlotEvidenceSink,
): ResponseSlotT[] {
  const validated: ResponseSlotT[] = [];
  const frozen: ResponseSlotT[] = [];
  for (const source of slots) {
    const raw = {
      ...source.detail,
      slot_id: source.slot_id,
      part_id: source.part_id,
      kind: source.kind,
      ...(source.options === undefined ? {} : { options: source.options }),
    };
    const schema = ResponseSlot.options.find((s) => s.shape.kind.value === source.kind);
    const parsed = schema?.strict().safeParse(raw);
    const partIds = structure.parts.some((part) => part.part_id === source.part_id)
      ? [source.part_id]
      : [];
    if (!parsed?.success) {
      sink.block(partIds, `slot:${source.slot_id}:unsupported_or_malformed_structure`);
      continue;
    }
    const slot = parsed.data;
    // Check original nested objects with the same canonical schemas. Checking
    // only parsed.data would miss unknown fields already stripped by Zod.
    const detail = source.detail ?? {};
    const checks = [
      detail.placement === undefined || SlotPlacement.strict().safeParse(detail.placement).success,
    ];
    switch (slot.kind) {
      case 'single_choice':
      case 'multi_choice':
        checks.push(ResponseOption.strict().array().safeParse(source.options).success);
        break;
      case 'matching':
        checks.push(
          ResponseItem.strict().array().safeParse(detail.left_items).success,
          ResponseOption.strict().array().safeParse(detail.right_options).success,
        );
        break;
      case 'ordering':
        checks.push(ResponseItem.strict().array().safeParse(detail.items).success);
        break;
      case 'select':
        checks.push(
          SelectItem.strict().array().safeParse(detail.items).success,
          detail.axes === undefined ||
            z.record(z.string(), SelectAxisEntry.strict().array()).safeParse(detail.axes).success,
        );
        break;
      case 'table':
        checks.push(TableSlot.shape.cells.element.strict().array().safeParse(detail.cells).success);
        break;
      case 'open_response':
        checks.push(
          detail.accepted_evidence === undefined ||
            EvidenceAcceptanceRule.strict().array().safeParse(detail.accepted_evidence).success,
        );
        break;
    }
    if (checks.some((ok) => !ok)) {
      sink.block(partIds, `slot:${slot.slot_id}:unsupported_or_malformed_nested_structure`);
      continue;
    }
    validated.push(slot);
    // Full canonical objects retain identities, coordinates, gap bindings and
    // table child references. They share the passage budget (including the
    // duplicate literal text), rather than bypassing it as unbounded metadata.
    if (
      !sink.reserve(
        JSON.stringify(slot).length + (frozen.length ? 1 : 2),
        partIds,
        `slot:${slot.slot_id}:structure_character_budget_truncated`,
      )
    )
      continue;
    frozen.push(slot);
    const pointer = (value: string) => value.replaceAll('~', '~0').replaceAll('/', '~1');
    const base = `/parts/${pointer(slot.part_id)}/slots/${pointer(slot.slot_id)}`;
    const text = (path: string, value: string | undefined) => {
      if (value !== undefined)
        sink.add({ locator: `${base}/${path}`, text: value, part_ids: partIds });
    };
    text('placement/label', slot.placement?.label);
    // These are literal source fields, never describeSelectItem or a joined
    // summary. Array indices locate fields; stable ids remain in full slots.
    switch (slot.kind) {
      case 'single_choice':
      case 'multi_choice':
        slot.options.forEach((option, i) => {
          text(`options/${i}/label`, option.label);
          text(`options/${i}/text`, option.text);
        });
        break;
      case 'matching':
        slot.left_items.forEach((item, i) => {
          text(`left_items/${i}/label`, item.label);
          text(`left_items/${i}/text`, item.text);
        });
        slot.right_options.forEach((option, i) => {
          text(`right_options/${i}/label`, option.label);
          text(`right_options/${i}/text`, option.text);
        });
        break;
      case 'ordering':
        slot.items.forEach((item, i) => {
          text(`items/${i}/label`, item.label);
          text(`items/${i}/text`, item.text);
        });
        break;
      case 'select':
        for (const [i, item] of slot.items.entries()) text(`items/${i}/label_md`, item.label_md);
        for (const [axis, entries] of Object.entries(slot.axes ?? {}))
          for (const [i, entry] of entries.entries())
            text(`axes/${pointer(axis)}/${i}/label_md`, entry.label_md);
        text('text', slot.text);
        break;
      case 'sentence_breaks':
        text('text', slot.text);
        break;
      case 'table':
        for (const [i, header] of slot.column_headers.entries())
          text(`column_headers/${i}`, header);
        for (const [i, label] of slot.row_labels.entries()) text(`row_labels/${i}`, label);
        break;
      case 'numeric':
        text('unit_hint', slot.unit_hint);
        break;
      case 'blank': {
        text('unit_hint', slot.unit_hint);
        const value = slot.answer_shape?.value;
        if (value?.kind === 'number') text('answer_shape/value/unit/unit', value.unit?.unit);
        if (value?.kind === 'interval_set') text('answer_shape/value/binding', value.binding);
        if (value?.kind === 'point' || value?.kind === 'finite_set')
          for (const [i, axis] of (value.axes ?? []).entries())
            text(`answer_shape/value/axes/${i}`, axis);
        if (value?.kind === 'affine_line' || value?.kind === 'finite_set')
          for (const [i, variable] of (value.variables ?? []).entries())
            text(`answer_shape/value/variables/${i}`, variable);
        break;
      }
      case 'open_response':
        slot.accepted_evidence.forEach((rule, i) => {
          for (const [j, mime] of rule.allowed_mime_patterns.entries())
            text(`accepted_evidence/${i}/allowed_mime_patterns/${j}`, mime);
        });
        break;
      case 'text':
      case 'formula':
        // Input limits/notation are retained in the canonical slot object;
        // they contain no additional prose requiring a literal passage.
        break;
      default:
        sink.block(partIds, `slot:${source.slot_id}:unsupported_slot_projection`);
    }
  }
  // The canonical whole-spec validator owns duplicate ids, coordinate/gap
  // consistency, part membership and table-to-child links. A broken graph is
  // not enough evidence to isolate an independently complete subtask.
  if (!slots.length)
    sink.block(
      structure.parts.map((part) => part.part_id),
      'response_spec:no_readable_slots',
    );
  for (const issue of validateResponseSpec({ slots: validated }, structure))
    sink.block(
      structure.parts.map((part) => part.part_id),
      `response_spec:${issue.code}:${issue.detail}`,
    );
  return frozen;
}
