// YUK-1497 — view values ↔ response envelopes for the presentation block tree (spec §2, §1.2.2).
// Pure functions, no React. The draft is the envelope list itself (ResponseSet.entries), so the
// page keeps one source of truth for autosave and submit.
//
// Rules:
// - select: item_ids go out in universe order (slot.items), whatever the display order was.
// - autosave: an empty select / blank / open answer writes no entry ("not answered").
// - submit: a bound blank with no text becomes { state: 'blank', text: '' } (an active blank);
//   selects and open answers without content stay absent.
// - self_confidence on an existing entry is carried over untouched.
import type { PresentationBlockT, PresentationT } from '@/core/schema/assessment/presentation';
import type { ResponseSlotT, SelectSlotT, SlotResponseT } from '@/core/schema/assessment/response';

export type SelectEntryT = Extract<SlotResponseT, { kind: 'select' }>;
export type BlankEntryT = Extract<SlotResponseT, { kind: 'blank' }>;
export type OpenEntryT = Extract<SlotResponseT, { kind: 'open' }>;
export type OpenEvidenceT = OpenEntryT['evidence'][number];

function find<K extends SlotResponseT['kind']>(
  entries: readonly SlotResponseT[],
  slotId: string,
  kind: K,
): Extract<SlotResponseT, { kind: K }> | undefined {
  const entry = entries.find((e) => e.slot_id === slotId);
  return entry?.kind === kind ? (entry as Extract<SlotResponseT, { kind: K }>) : undefined;
}

/** Replace (or drop, when `next` is null) the entry for one slot; other entries keep their order. */
function put(
  entries: readonly SlotResponseT[],
  slotId: string,
  next: SlotResponseT | null,
): SlotResponseT[] {
  const at = entries.findIndex((e) => e.slot_id === slotId);
  if (at < 0) return next ? [...entries, next] : [...entries];
  const copy = [...entries];
  if (next) copy[at] = next;
  else copy.splice(at, 1);
  return copy;
}

// ---------- reads (envelope → view value) ----------

export function readSelect(entries: readonly SlotResponseT[], slotId: string): string[] {
  return find(entries, slotId, 'select')?.item_ids ?? [];
}

export function readBlank(entries: readonly SlotResponseT[], slotId: string): string {
  return find(entries, slotId, 'blank')?.text ?? '';
}

export function readOpen(
  entries: readonly SlotResponseT[],
  slotId: string,
): { text_md: string | null; evidence: OpenEvidenceT[] } {
  const entry = find(entries, slotId, 'open');
  return { text_md: entry ? entry.text_md : null, evidence: entry?.evidence ?? [] };
}

// ---------- writes (view value → envelope, draft rules) ----------

/** Universe order: the order of slot.items, never the display order. */
export function inUniverseOrder(slot: SelectSlotT, ids: readonly string[]): string[] {
  const chosen = new Set(ids);
  return slot.items.filter((item) => chosen.has(item.item_id)).map((item) => item.item_id);
}

export function writeSelect(
  entries: readonly SlotResponseT[],
  slot: SelectSlotT,
  ids: readonly string[],
): SlotResponseT[] {
  const item_ids = inUniverseOrder(slot, ids);
  if (item_ids.length === 0) return put(entries, slot.slot_id, null);
  const prev = find(entries, slot.slot_id, 'select');
  return put(entries, slot.slot_id, {
    slot_id: slot.slot_id,
    kind: 'select',
    state: 'answered',
    item_ids,
    self_confidence: prev?.self_confidence,
  });
}

export function writeBlank(
  entries: readonly SlotResponseT[],
  slotId: string,
  text: string,
): SlotResponseT[] {
  // Raw text, untouched; only a truly empty string means "no entry" while drafting.
  if (text === '') return put(entries, slotId, null);
  const prev = find(entries, slotId, 'blank');
  return put(entries, slotId, {
    slot_id: slotId,
    kind: 'blank',
    state: 'answered',
    text,
    self_confidence: prev?.self_confidence,
  });
}

export function writeOpen(
  entries: readonly SlotResponseT[],
  slotId: string,
  value: { text_md: string; evidence: OpenEvidenceT[] },
): SlotResponseT[] {
  if (value.text_md === '' && value.evidence.length === 0) return put(entries, slotId, null);
  const prev = find(entries, slotId, 'open');
  return put(entries, slotId, {
    slot_id: slotId,
    kind: 'open',
    text_md: value.text_md,
    evidence: value.evidence,
    self_confidence: prev?.self_confidence,
  });
}

// ---------- submit ----------

/** Every slot an input block in the tree binds, in tree order. Custom blocks are listed too. */
export function boundSlots(
  presentation: PresentationT,
): { slot_id: string; kind: PresentationBlockT['kind'] }[] {
  const out: { slot_id: string; kind: PresentationBlockT['kind'] }[] = [];
  const walk = (block: PresentationBlockT) => {
    switch (block.kind) {
      case 'stack':
      case 'passage_layout':
        for (const child of block.children) walk(child);
        return;
      case 'text_math':
      case 'figure':
        return;
      case 'custom':
        for (const bind of block.binds) out.push({ slot_id: bind.slot_id, kind: 'custom' });
        return;
      default:
        out.push({ slot_id: block.bind.slot_id, kind: block.kind });
    }
  };
  walk(presentation.root);
  return out;
}

/**
 * The envelope to submit: draft entries plus an explicit `blank` for every bound blank_input that
 * has no text. Only slots in the issued spec are touched.
 */
export function entriesForSubmit(
  presentation: PresentationT,
  slots: readonly ResponseSlotT[],
  entries: readonly SlotResponseT[],
): SlotResponseT[] {
  const issued = new Set(slots.map((slot) => slot.slot_id));
  let out = [...entries];
  for (const bound of boundSlots(presentation)) {
    if (bound.kind !== 'blank_input' || !issued.has(bound.slot_id)) continue;
    const prev = find(out, bound.slot_id, 'blank');
    if (prev && prev.text !== '') continue;
    out = put(out, bound.slot_id, {
      slot_id: bound.slot_id,
      kind: 'blank',
      state: 'blank',
      text: '',
      self_confidence: prev?.self_confidence,
    });
  }
  return out;
}
