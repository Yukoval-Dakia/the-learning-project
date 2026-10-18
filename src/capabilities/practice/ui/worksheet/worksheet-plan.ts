// YUK-1528 — export state → what goes on paper. Pure: no DOM, no React.
//
// Each issued item becomes an ordered list of blocks (question header, stem text, figures,
// choice rows, writing panels, notes for parts answered in Loom). The paper surface of a slot is
// decided by the same function the archive validator uses (region-map-validate `slotSurface`),
// so the printed regions and the backend never disagree about choice / writing / web-only.
//
// Coverage rule (layout doc §3): every (issuance, scoring unit) lands either on a printed
// region or in `web_only_units`. `buildWorksheetPlan` checks it and fails instead of printing a
// sheet that silently drops a unit.

import type { WorksheetExportStateT } from '@/capabilities/practice/api/worksheet-contracts';
import {
  type FrozenIssuanceScope,
  presentationBinders,
  slotSurface,
  worksheetQrPayload,
} from '@/capabilities/practice/server/worksheet/region-map-validate';
import type { PracticeIssuanceDtoT, PublicMaterialViewT } from '@/core/schema/assessment/dto';
import {
  Presentation,
  type PresentationBlockT,
  type PresentationPrintHintT,
} from '@/core/schema/assessment/presentation';
import type { ResponseSlotT } from '@/core/schema/assessment/response';

import {
  COLUMN_MM,
  GRID_PITCH_MM,
  PANEL_INSET_MM,
  RULE_PITCH_MM,
  type SheetOrientation,
} from './worksheet-geometry';

export type WritingMark = 'dots' | 'squares' | 'ruled';

export interface PlanOption {
  optionId: string;
  /** Position in the frozen option order (0-based). */
  order: number;
  /** Printed letter inside the circle; for people only. */
  label: string;
  md: string;
}

interface AnswerRef {
  issuanceId: string;
  slotId: string;
  /** Scoring units bound to this slot (normally exactly one). */
  unitIds: string[];
  /** Coral ring number shared by the stem and the answer area; null when the item has one answer. */
  ring: number | null;
}

export type PlanBlock =
  | { type: 'head'; key: string; number: number; meta: string | null }
  | { type: 'text'; key: string; md: string; ring: number | null }
  | { type: 'figure'; key: string; assetId: string; caption?: string; alt?: string }
  | { type: 'note'; key: string; text: string; ring: number | null }
  | ({ type: 'choice'; key: string; options: PlanOption[]; columns: 1 | 2 | 4 } & AnswerRef)
  | ({
      type: 'writing';
      key: string;
      mark: WritingMark;
      /** Full panel height (marks inset included), before any split across pages. */
      panelMm: number;
      label: string;
    } & AnswerRef);

export interface PlanItem {
  key: string;
  number: number;
  /** Quiet note next to the question number (e.g. multiple answers allowed). */
  meta: string | null;
  /** MathMarkdown notation for this item: KaTeX only when its text carries formula delimiters. */
  notation: 'katex' | null;
  /** Passage questions print landscape: head + passage on the left, `blocks` on the right. */
  passage: { key: string; md: string } | null;
  blocks: PlanBlock[];
}

export interface WorksheetPlan {
  token: string;
  shortCode: string;
  /** Header line after 「作答卷」: source title and the issue date. */
  sourceLine: string;
  items: PlanItem[];
  webOnlyUnits: string[];
}

export type WorksheetPlanResult = { ok: true; plan: WorksheetPlan } | { ok: false; detail: string };

type IssuedItem = WorksheetExportStateT['issued'][number];

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

function letterFor(index: number): string {
  if (index < LETTERS.length) return LETTERS[index] ?? String(index + 1);
  return `${LETTERS[Math.floor(index / LETTERS.length) - 1] ?? ''}${LETTERS[index % LETTERS.length]}`;
}

// Formula delimiters MathMarkdown understands: \( \), \[ \], $$ $$ and $…$ with no space inside
// the opening dollar. Text without them renders as plain markdown, so a stray "$" in a non-math
// subject never turns into a broken formula.
const MATH_HINT = /\\\(|\\\[|\$\$|\$[^\s$][^$\n]*\$/;

function itemTexts(dto: PracticeIssuanceDtoT): string[] {
  const out: string[] = [];
  for (const face of dto.faces) out.push(face.prompt_md);
  for (const material of dto.materials) if (material.content_md) out.push(material.content_md);
  for (const slot of dto.response_spec.slots) {
    if (slot.kind === 'single_choice' || slot.kind === 'multi_choice') {
      for (const option of slot.options) out.push(option.text);
    } else if (slot.kind === 'select') {
      for (const item of slot.items) if (item.label_md) out.push(item.label_md);
    }
  }
  return out;
}

function formatIssueDate(iso: string | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日`;
}

function isMathSlot(slot: ResponseSlotT, notation: 'katex' | null): boolean {
  if (slot.kind === 'formula' || slot.kind === 'numeric') return true;
  if (slot.kind === 'blank') return slot.format === 'math';
  return notation === 'katex';
}

function ruledPanel(lines: number): number {
  return lines * RULE_PITCH_MM + PANEL_INSET_MM * 2;
}

/** Mark and default panel height per slot kind; a presentation print hint overrides the height. */
function writingShape(
  slot: ResponseSlotT,
  notation: 'katex' | null,
  orientation: SheetOrientation,
  hint: { print?: PresentationPrintHintT; minLines?: number } | undefined,
): { mark: WritingMark; panelMm: number; label: string } {
  const innerWidth = COLUMN_MM[orientation] - PANEL_INSET_MM * 2;
  const math = isMathSlot(slot, notation);
  const unitHint =
    (slot.kind === 'blank' || slot.kind === 'numeric') && slot.unit_hint
      ? `（单位：${slot.unit_hint}）`
      : '';
  let shape: { mark: WritingMark; panelMm: number; label: string };
  switch (slot.kind) {
    case 'blank':
    case 'numeric':
      shape = { mark: math ? 'dots' : 'ruled', panelMm: 22, label: `填写答案${unitHint}` };
      break;
    case 'formula':
      shape = { mark: 'dots', panelMm: 34, label: '写出式子' };
      break;
    case 'text': {
      const perLine = Math.max(10, Math.floor(innerWidth / 4.2));
      const lines = Math.min(20, Math.max(2, Math.ceil((slot.max_chars ?? 120) / perLine)));
      shape = { mark: math ? 'dots' : 'ruled', panelMm: ruledPanel(lines), label: '作答' };
      break;
    }
    case 'open_response': {
      if (math) {
        shape = { mark: 'dots', panelMm: 72, label: '作答' };
      } else if ((slot.max_chars ?? 0) >= 300) {
        // Long Chinese writing gets the 5mm character grid, sized to hold max_chars.
        const columns = Math.floor(innerWidth / GRID_PITCH_MM);
        const rows = Math.ceil((slot.max_chars ?? 0) / columns);
        shape = {
          mark: 'squares',
          panelMm: rows * GRID_PITCH_MM + PANEL_INSET_MM * 2,
          label: '作答',
        };
      } else {
        const perLine = Math.max(10, Math.floor(innerWidth / 4.2));
        const lines = Math.min(16, Math.max(4, Math.ceil((slot.max_chars ?? 200) / perLine)));
        shape = { mark: 'ruled', panelMm: ruledPanel(lines), label: '作答' };
      }
      break;
    }
    default:
      shape = { mark: math ? 'dots' : 'ruled', panelMm: 40, label: '作答' };
  }
  if (hint?.minLines != null && hint.minLines > 0 && shape.mark === 'ruled') {
    shape.panelMm = Math.max(shape.panelMm, ruledPanel(hint.minLines));
  }
  if (hint?.print?.height_mm != null && hint.print.height_mm > 0) {
    shape.panelMm = Math.max(14, hint.print.height_mm);
  }
  return shape;
}

function choiceColumns(options: PlanOption[], orientation: SheetOrientation): 1 | 2 | 4 {
  const longest = Math.max(0, ...options.map((option) => [...option.md].length));
  if (orientation === 'landscape') return longest <= 12 ? 2 : 1;
  if (longest <= 6 && options.length <= 4) return 4;
  return longest <= 18 ? 2 : 1;
}

function choiceOptions(slot: ResponseSlotT, marker: 'letter' | 'number'): PlanOption[] | null {
  if (slot.kind === 'single_choice' || slot.kind === 'multi_choice') {
    // The projection already serves the options in the issuance's frozen order.
    return slot.options.map((option, order) => ({
      optionId: option.option_id,
      order,
      label: option.label || letterFor(order),
      md: option.text,
    }));
  }
  if (slot.kind === 'select') {
    return slot.items.map((item, order) => ({
      optionId: item.item_id,
      order,
      label: marker === 'number' ? String(order + 1) : letterFor(order),
      md: item.label_md ?? '',
    }));
  }
  return null;
}

function isMulti(slot: ResponseSlotT): boolean {
  return slot.kind === 'multi_choice' || (slot.kind === 'select' && slot.pick === 'many');
}

interface InputHint {
  print?: PresentationPrintHintT;
  minLines?: number;
  marker?: 'letter' | 'number' | 'none';
}

function planItem(
  issued: IssuedItem,
  number: number,
  webOnly: Set<string>,
  paperUnits: Map<string, string>,
): { item: PlanItem } | { error: string } {
  const dto = issued.practice_dto;
  const issuanceId = issued.issuance_id;
  const notation: 'katex' | null = itemTexts(dto).some((text) => MATH_HINT.test(text))
    ? 'katex'
    : null;
  const presentation = (() => {
    if (dto.presentation == null) return null;
    const parsed = Presentation.safeParse(dto.presentation);
    return parsed.success ? parsed.data : null;
  })();

  const slots = dto.response_spec.slots;
  const slotById = new Map(slots.map((slot) => [slot.slot_id, slot] as const));
  const scope: FrozenIssuanceScope = {
    issuance_id: issuanceId,
    group_id: issued.group_id,
    part_ids: issued.issuance.binding.part_ids,
    slots: new Map(slots.map((slot) => [slot.slot_id, { part_id: slot.part_id, kind: slot.kind }])),
    units: issued.units,
    optionOrder: new Map(
      issued.issuance.binding.option_order.map((entry) => [entry.slot_id, entry.option_ids]),
    ),
    presentationBinders: presentation ? presentationBinders(presentation.root) : undefined,
  };

  // Units per slot; a unit must bind exactly one issued slot (the archive validator rejects any
  // other shape, so stop here rather than print a region that can never be archived).
  const unitsBySlot = new Map<string, string[]>();
  for (const unit of issued.units) {
    const [slotId, ...rest] = unit.slot_refs;
    if (slotId == null || rest.length > 0) {
      return {
        error: `issuance ${issuanceId} unit ${unit.scoring_unit_id} binds ${unit.slot_refs.length} slots`,
      };
    }
    if (!slotById.has(slotId)) {
      return {
        error: `issuance ${issuanceId} unit ${unit.scoring_unit_id} binds unknown slot ${slotId}`,
      };
    }
    unitsBySlot.set(slotId, [...(unitsBySlot.get(slotId) ?? []), unit.scoring_unit_id]);
  }

  // Ring numbers: one per answered slot, in response_spec order, only when there are several.
  const answered = slots.filter((slot) => (unitsBySlot.get(slot.slot_id)?.length ?? 0) > 0);
  const ringBySlot = new Map<string, number>();
  if (answered.length > 1) {
    for (const [index, slot] of answered.entries()) ringBySlot.set(slot.slot_id, index + 1);
  }
  const ringForPart = (partId: string): number | null => {
    const inPart = answered.filter((slot) => slot.part_id === partId);
    const only = inPart.length === 1 ? inPart[0] : undefined;
    return only ? (ringBySlot.get(only.slot_id) ?? null) : null;
  };

  const blocks: PlanBlock[] = [];
  const placedSlots = new Set<string>();
  const usedMaterials = new Set<string>();
  const materialById = new Map(dto.materials.map((m) => [m.material_id, m] as const));
  const faceById = new Map(dto.faces.map((face) => [face.part_id, face] as const));
  let passage: PlanItem['passage'] = null;
  let itemOrientation: SheetOrientation = 'portrait';

  // Passage: a left-column reading text (presentation passage_layout, or an old revision's
  // passage material with inline text).
  let passageMaterial: PublicMaterialViewT | undefined;
  if (presentation) {
    const findPassage = (block: PresentationBlockT): PublicMaterialViewT | undefined => {
      if (block.kind === 'passage_layout' && block.layout === 'passage_left_questions_right') {
        const material = materialById.get(block.material_ref);
        if (material?.content_md !== undefined) return material;
      }
      if (block.kind === 'stack' || block.kind === 'passage_layout') {
        for (const child of block.children) {
          const found = findPassage(child);
          if (found) return found;
        }
      }
      return undefined;
    };
    passageMaterial = findPassage(presentation.root);
  } else {
    passageMaterial = dto.materials.find(
      (material) => material.kind === 'passage' && material.content_md !== undefined,
    );
  }
  if (passageMaterial?.content_md !== undefined) {
    usedMaterials.add(passageMaterial.material_id);
    passage = { key: `${issuanceId}/passage`, md: passageMaterial.content_md };
    itemOrientation = 'landscape';
  }

  const pushMaterial = (material: PublicMaterialViewT) => {
    if (usedMaterials.has(material.material_id)) return;
    usedMaterials.add(material.material_id);
    const key = `${issuanceId}/m/${material.material_id}`;
    if (material.content_md !== undefined) {
      blocks.push({ type: 'text', key, md: material.content_md, ring: null });
    } else if (material.kind === 'figure' || material.kind === 'table') {
      blocks.push({
        type: 'figure',
        key,
        assetId: material.asset_id,
        caption: material.caption,
        alt: material.alt_text,
      });
    } else {
      blocks.push({
        type: 'note',
        key,
        text: '这份材料是音频、视频或文件，请在 Loom 里打开查看。',
        ring: null,
      });
    }
  };

  const pushSlot = (slotId: string, hint?: InputHint) => {
    if (placedSlots.has(slotId)) return;
    const slot = slotById.get(slotId);
    if (!slot || slot.kind === 'table') return;
    const unitIds = unitsBySlot.get(slotId) ?? [];
    if (unitIds.length === 0) return;
    placedSlots.add(slotId);
    const ring = ringBySlot.get(slotId) ?? null;
    const key = `${issuanceId}/s/${slotId}`;
    const surface = slotSurface(scope, slotId);
    if (surface === 'choice') {
      const options = choiceOptions(slot, hint?.marker === 'number' ? 'number' : 'letter');
      if (options && options.length > 0) {
        blocks.push({
          type: 'choice',
          key,
          issuanceId,
          slotId,
          unitIds,
          ring,
          options,
          columns: choiceColumns(options, itemOrientation),
        });
        for (const unitId of unitIds) paperUnits.set(unitId, key);
        return;
      }
    }
    if (surface === 'writing') {
      const shape = writingShape(slot, notation, itemOrientation, hint);
      blocks.push({ type: 'writing', key, issuanceId, slotId, unitIds, ring, ...shape });
      for (const unitId of unitIds) paperUnits.set(unitId, key);
      return;
    }
    // Tap-only answers (matching, ordering, sentence breaks, sandboxed blocks): not on paper.
    blocks.push({
      type: 'note',
      key,
      text: isMulti(slot)
        ? '这一问要在 Loom 里点选作答，纸上不用写。'
        : '这一问要在 Loom 里作答，纸上不用写。',
      ring,
    });
    for (const unitId of unitIds) webOnly.add(unitId);
  };

  const pushFaceText = (partId: string) => {
    const face = faceById.get(partId);
    if (!face) return;
    for (const materialId of face.material_ids) {
      const material = materialById.get(materialId);
      if (material && material !== passageMaterial) pushMaterial(material);
    }
    blocks.push({
      type: 'text',
      key: `${issuanceId}/p/${partId}`,
      md: face.prompt_md,
      ring: ringForPart(partId),
    });
  };

  if (presentation) {
    const walk = (block: PresentationBlockT) => {
      switch (block.kind) {
        case 'stack':
          for (const child of block.children) walk(child);
          return;
        case 'passage_layout': {
          const material = materialById.get(block.material_ref);
          if (material && material !== passageMaterial) pushMaterial(material);
          for (const child of block.children) walk(child);
          return;
        }
        case 'text_math': {
          if (block.part_ref) {
            const face = faceById.get(block.part_ref);
            if (face) {
              blocks.push({
                type: 'text',
                key: `${issuanceId}/b/${block.block_id}`,
                md: face.prompt_md,
                ring: ringForPart(face.part_id),
              });
            }
          } else if (block.material_ref) {
            const material = materialById.get(block.material_ref);
            if (material && material !== passageMaterial) pushMaterial(material);
          }
          return;
        }
        case 'figure': {
          const material = materialById.get(block.material_ref);
          if (material) pushMaterial(material);
          return;
        }
        case 'custom':
          for (const bind of block.binds) pushSlot(bind.slot_id);
          return;
        case 'option_list':
          pushSlot(block.bind.slot_id, {
            print: block.print,
            marker: block.marker,
          });
          return;
        case 'free_area':
          pushSlot(block.bind.slot_id, { print: block.print, minLines: block.min_lines });
          return;
        default:
          pushSlot(block.bind.slot_id, { print: block.print });
      }
    };
    walk(presentation.root);
  } else {
    for (const material of dto.materials) {
      const referenced = dto.faces.some((face) => face.material_ids.includes(material.material_id));
      if (!referenced && material !== passageMaterial) pushMaterial(material);
    }
    for (const face of dto.faces) {
      pushFaceText(face.part_id);
      for (const slot of slots) if (slot.part_id === face.part_id) pushSlot(slot.slot_id);
    }
  }
  // Anything answerable the tree did not place still gets its answer area at the end.
  for (const slot of slots) pushSlot(slot.slot_id);

  const multi = answered.some(
    (slot) => isMulti(slot) && slotSurface(scope, slot.slot_id) === 'choice',
  );
  const meta = multi ? '选择题可多选' : null;
  const head: PlanBlock = { type: 'head', key: `${issuanceId}/head`, number, meta };

  return {
    item: {
      key: issuanceId,
      number,
      meta,
      notation,
      passage,
      // A passage item's header sits above the passage in the left column.
      blocks: passage ? blocks : [head, ...blocks],
    },
  };
}

export function buildWorksheetPlan(state: WorksheetExportStateT): WorksheetPlanResult {
  const issued = [...state.issued].sort((a, b) => a.position - b.position);
  if (issued.length === 0) return { ok: false, detail: 'export has no issued items' };
  const webOnly = new Set<string>();
  const items: PlanItem[] = [];
  const paperIssuanceUnits = new Set<string>();
  for (const [index, entry] of issued.entries()) {
    const paperUnits = new Map<string, string>();
    const result = planItem(entry, index + 1, webOnly, paperUnits);
    if ('error' in result) return { ok: false, detail: result.error };
    items.push(result.item);
    for (const unitId of paperUnits.keys())
      paperIssuanceUnits.add(`${entry.issuance_id}\0${unitId}`);
  }

  // Coverage (layout doc §3): every (issuance, unit) is on paper or web-only — never both,
  // never neither. web_only is keyed by unit id, so a unit printed in one issuance and web-only
  // in another would be rejected by the archive.
  for (const entry of issued) {
    for (const unit of entry.units) {
      const onPaper = paperIssuanceUnits.has(`${entry.issuance_id}\0${unit.scoring_unit_id}`);
      const isWebOnly = webOnly.has(unit.scoring_unit_id);
      if (onPaper && isWebOnly) {
        return {
          ok: false,
          detail: `unit ${unit.scoring_unit_id} is printed in issuance ${entry.issuance_id} but web-only elsewhere`,
        };
      }
      if (!onPaper && !isWebOnly) {
        return {
          ok: false,
          detail: `issuance ${entry.issuance_id} unit ${unit.scoring_unit_id} has no place on the sheet`,
        };
      }
    }
  }

  const earliest = issued
    .map((entry) => entry.practice_dto.issued_at)
    .sort()
    .at(0);
  const sourceLine = [state.title.trim(), formatIssueDate(earliest)].filter(Boolean).join(' · ');

  return {
    ok: true,
    plan: {
      token: state.export_token,
      shortCode: state.short_code,
      sourceLine,
      items,
      webOnlyUnits: [...webOnly].sort(),
    },
  };
}

export { worksheetQrPayload };
