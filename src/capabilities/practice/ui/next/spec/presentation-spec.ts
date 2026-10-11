// YUK-1473 loft — design sketch, never merged. Owner decided A1–A4 on 2026-10-11 15:51 (photo /
// handwriting first, tap where it is the least effort; constrained generation from blocks; pen
// input graded whole by the AI judge; web pen writing first). Design notes:
// docs/planning/2026-10-11-item-presentation-spec-loft.md.
//
// A presentation spec is a per-item, declarative layout the ingestion agent writes from a small
// closed set of blocks. It is a VIEW over the frozen contract that already exists
// (src/core/schema/assessment): display content lives here, answer shapes stay in ResponseSpec
// (slot_id, options with option_id), scores and methods stay in ScoringUnit. The backend never
// reads this file's types; it only sees slot responses keyed by slot_id and evidence bound to
// scoring units.

import { z } from 'zod';
import type { ResponseSlotT, ResponseSpecT, ScoringUnitT } from '@/core/schema/assessment';

export const PRESENTATION_SPEC_VERSION = 1 as const;

// ── answer slots ─────────────────────────────────────────────────────────────

/**
 * How the learner gives this answer. A1: paper or on-screen handwriting, photographed, is the
 * default; tap stays wherever it is the least effort (choices, and tap blocks the agent generates,
 * such as 断句 gaps); typing is optional and only for short answers. A3: handwriting is stored as
 * strokes/image and graded whole by the admitted AI judge; nothing is parsed out of strokes on the
 * device. A photo is always accepted as a fallback for written answers.
 */
export const SlotInput = z.discriminatedUnion('mode', [
  z.strictObject({
    mode: z.literal('photo_or_handwriting'),
    /** Offer an optional typed answer next to the photo (e.g. a final interval). */
    typedAllowed: z.boolean().default(false),
  }),
  z.strictObject({ mode: z.literal('choice') }),
  z.strictObject({
    mode: z.literal('short_text'),
    maxChars: z.number().int().min(1).max(200).optional(),
  }),
]);
export type SlotInputT = z.infer<typeof SlotInput>;

/** One answer position. `slotId` is ResponseSlot.slot_id; `unitId` is ScoringUnit.scoring_unit_id. */
export const AnswerSlot = z.strictObject({
  slotId: z.string().min(1),
  unitId: z.string().min(1),
  /** Display label only ("(2)", "第 3 空", "第 2 句"); never identity. */
  label: z.string().min(1),
  input: SlotInput,
});
export type AnswerSlotT = z.infer<typeof AnswerSlot>;

// ── blocks (closed set) ──────────────────────────────────────────────────────
//
// Inline answer positions inside text-like blocks are written as `{{slot:<slotId>}}`. They mark a
// position (number + focus link); the input itself renders where the page puts inputs.
// `{{ref:<slotId>|text}}` marks a span (e.g. the wavy-underlined part of a passage) that links to
// a slot placed elsewhere; it is a link anchor, not a placement.

const blockId = z.string().min(1);

const TextBlock = z.strictObject({ kind: z.literal('text'), id: blockId, md: z.string() });

const PassageBlock = z.strictObject({
  kind: z.literal('passage'),
  id: blockId,
  title: z.string().optional(),
  /** Each paragraph may carry `{{slot:..}}` markers; paragraphs are R9 anchors. */
  paragraphs: z.array(z.string()).min(1),
  /** Show line numbers (阅读题引用"第 N 行"). */
  lineNumbers: z.boolean().default(false),
});

const FigureBlock = z.strictObject({
  kind: z.literal('figure'),
  id: blockId,
  materialId: z.string().min(1),
  alt: z.string().min(1),
  caption: z.string().optional(),
});

const TableCell = z.union([z.string(), z.strictObject({ slot: z.string().min(1) })]);
const TableBlock = z.strictObject({
  kind: z.literal('table'),
  id: blockId,
  header: z.array(z.string()).min(1),
  rows: z.array(z.array(TableCell)).min(1),
  caption: z.string().optional(),
});

const FormulaBlock = z.strictObject({ kind: z.literal('formula'), id: blockId, tex: z.string() });

/** Options come from the referenced choice slot in ResponseSpec; this block only lays them out. */
const OptionsBlock = z.strictObject({
  kind: z.literal('options'),
  id: blockId,
  slotId: z.string().min(1),
  arrangement: z.enum(['list', 'grid']).default('list'),
  /** Picture options: option_id -> material_id. */
  optionMedia: z.record(z.string(), z.string()).optional(),
});

/**
 * 连线 (A3): the two columns are display only; the learner draws the lines by hand over them (or on
 * paper and photographs it). `slotId` is an open_response slot; its scoring unit is graded whole by
 * the AI judge with the private pairs as reference. No device-side pair capture.
 */
const MatchingItem = z.strictObject({ id: z.string().min(1), label: z.string(), text: z.string() });
const MatchingBlock = z.strictObject({
  kind: z.literal('matching'),
  id: blockId,
  left: z.array(MatchingItem).min(2),
  right: z.array(MatchingItem).min(2),
  slotId: z.string().min(1),
});

/**
 * 断句 as an agent-generated tap block: an unpunctuated line; tapping the gap between two characters
 * toggles a break. The slot is a multi_choice slot whose options are the gaps (`gap_<i>` = break
 * after character i, 0-based), so taps are structured positions graded deterministically.
 * `candidateGaps` = the paper marks only some gaps (A–H); omitted = every gap is tappable.
 * The key and the partial-credit rule are private (scoring unit), never in this block.
 */
const SentenceBreaksBlock = z.strictObject({
  kind: z.literal('sentence_breaks'),
  id: blockId,
  slotId: z.string().min(1),
  line: z.string().min(2),
  candidateGaps: z.array(z.number().int().min(0)).optional(),
});
const OrderingBlock = z.strictObject({
  kind: z.literal('ordering'),
  id: blockId,
  slotId: z.string(),
});

const AudioBlock = z.strictObject({
  kind: z.literal('audio'),
  id: blockId,
  materialId: z.string().min(1),
  /** Times the learner may play it (exam realism); null = unlimited. */
  maxPlays: z.number().int().min(1).nullable().default(null),
});

const CodeBlock = z.strictObject({
  kind: z.literal('code'),
  id: blockId,
  language: z.string().min(1),
  source: z.string(),
});

/** Rare escape hatch (A2): display only, isolated frame, no network, no learner data, no inputs. */
const SandboxBlock = z.strictObject({
  kind: z.literal('sandbox'),
  id: blockId,
  /** Digest of the frozen HTML bundle; pinned to the item revision. */
  bundleDigest: z.string().min(1),
  height: z.number().int().min(80).max(1200),
  alt: z.string().min(1),
  /** Set by the ingestion preview check; unset = never served. */
  previewApprovedAt: z.string().datetime().optional(),
});

const LeafBlock = z.discriminatedUnion('kind', [
  TextBlock,
  PassageBlock,
  FigureBlock,
  TableBlock,
  FormulaBlock,
  OptionsBlock,
  MatchingBlock,
  SentenceBreaksBlock,
  OrderingBlock,
  AudioBlock,
  CodeBlock,
  SandboxBlock,
]);

/** One level of nesting only: a sub-question holds leaf blocks, never more sub-questions. */
const SubQuestionsBlock = z.strictObject({
  kind: z.literal('subquestions'),
  id: blockId,
  items: z
    .array(
      z.strictObject({
        label: z.string().min(1),
        blocks: z.array(LeafBlock),
        /** Slots answered under this sub-question (photo area per sub-question). */
        slotIds: z.array(z.string().min(1)).default([]),
      }),
    )
    .min(1),
});

export const KnownBlock = z.union([LeafBlock, SubQuestionsBlock]);
export type KnownBlockT = z.infer<typeof KnownBlock>;
export type KnownBlockKind = KnownBlockT['kind'];

/** What an unknown or malformed block degrades to: its readable text, rendered plain. */
export interface FallbackBlock {
  kind: 'fallback';
  id: string;
  originalKind: string;
  plainText: string;
}
export type Block = KnownBlockT | FallbackBlock;

export interface ItemPresentationSpec {
  specVersion: typeof PRESENTATION_SPEC_VERSION;
  /** Published revision this spec is frozen against (spec bytes join the revision digest). */
  revisionId: string;
  blocks: Block[];
  slots: AnswerSlotT[];
}

// ── parse: unknown block -> fallback plain rendering ─────────────────────────

const Envelope = z.strictObject({
  specVersion: z.literal(PRESENTATION_SPEC_VERSION),
  revisionId: z.string().min(1),
  blocks: z.array(z.unknown()),
  slots: z.array(AnswerSlot),
});

function readableText(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) return raw.map(readableText).filter(Boolean).join('\n');
  if (raw && typeof raw === 'object') {
    return Object.entries(raw)
      .filter(([k]) => k !== 'kind' && k !== 'id')
      .map(([, v]) => readableText(v))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

export type ParseResult =
  | { ok: true; spec: ItemPresentationSpec; fallbacks: string[] }
  | { ok: false; error: string };

export function parsePresentationSpec(raw: unknown): ParseResult {
  const env = Envelope.safeParse(raw);
  if (!env.success) return { ok: false, error: env.error.message };
  const fallbacks: string[] = [];
  const blocks = env.data.blocks.map((b, i): Block => {
    const known = KnownBlock.safeParse(b);
    if (known.success) return known.data;
    const obj = (b && typeof b === 'object' ? b : {}) as Record<string, unknown>;
    const id = typeof obj.id === 'string' ? obj.id : `b${i}`;
    fallbacks.push(id);
    return {
      kind: 'fallback',
      id,
      originalKind: typeof obj.kind === 'string' ? obj.kind : 'unknown',
      plainText: readableText(b),
    };
  });
  return {
    ok: true,
    spec: {
      specVersion: PRESENTATION_SPEC_VERSION,
      revisionId: env.data.revisionId,
      blocks,
      slots: env.data.slots,
    },
    fallbacks,
  };
}

// ── validate against the frozen contract (ingestion gate) ────────────────────

export interface ContractView {
  responseSpec: ResponseSpecT;
  scoringUnits: readonly ScoringUnitT[];
  /** Private: normalized reference answers per unit, used only to detect leakage. */
  referenceAnswers: ReadonlyMap<string, readonly string[]>;
}

export type SpecIssue =
  | { code: 'slot_unknown'; slotId: string }
  | { code: 'slot_unplaced'; slotId: string }
  | { code: 'slot_placed_twice'; slotId: string }
  | { code: 'unit_mismatch'; slotId: string; unitId: string }
  | { code: 'unit_without_slot'; unitId: string }
  | { code: 'input_incompatible'; slotId: string; slotKind: ResponseSlotT['kind'] }
  | { code: 'answer_leak'; blockId: string; unitId: string }
  | { code: 'sandbox_unapproved'; blockId: string }
  | { code: 'breaks_line_punctuated'; blockId: string }
  | { code: 'fallback_block'; blockId: string };

const SLOT_MARKER = /\{\{slot:([^}]+)\}\}/g;

function collectBlockText(block: Block): string[] {
  switch (block.kind) {
    case 'text':
      return [block.md];
    case 'passage':
      return [block.title ?? '', ...block.paragraphs];
    case 'table':
      return [...block.header, ...block.rows.flat().map((c) => (typeof c === 'string' ? c : ''))];
    case 'formula':
      return [block.tex];
    case 'code':
      return [block.source];
    case 'figure':
      return [block.alt, block.caption ?? ''];
    case 'subquestions':
      return block.items.flatMap((it) => [it.label, ...it.blocks.flatMap(collectBlockText)]);
    case 'fallback':
      return [block.plainText];
    default:
      return [];
  }
}

/** Blocks that own a slot's input: choice/matching/ordering/break surfaces, table cells, sub-question photo areas. */
function inputSlotIds(block: Block): string[] {
  switch (block.kind) {
    case 'options':
    case 'matching':
    case 'ordering':
    case 'sentence_breaks':
      return [block.slotId];
    case 'table':
      return block.rows.flat().flatMap((c) => (typeof c === 'string' ? [] : [c.slot]));
    case 'subquestions':
      return block.items.flatMap((it) => [...it.slotIds, ...it.blocks.flatMap(inputSlotIds)]);
    default:
      return [];
  }
}

/** Inline `{{slot:..}}` markers. They place a slot only when no block owns its input (e.g. a math blank). */
function markerSlotIds(block: Block): string[] {
  return collectBlockText(block).flatMap((t) => [...t.matchAll(SLOT_MARKER)].map((m) => m[1]));
}

function compatible(input: SlotInputT, slot: ResponseSlotT): boolean {
  const isChoice = slot.kind === 'single_choice' || slot.kind === 'multi_choice';
  if (input.mode === 'choice')
    return isChoice || slot.kind === 'matching' || slot.kind === 'ordering';
  if (isChoice) return false;
  if (input.mode === 'short_text')
    return slot.kind === 'text' || slot.kind === 'numeric' || slot.kind === 'formula';
  return slot.kind !== 'table';
}

const normalize = (s: string) => s.replace(/\s+/g, '').toLowerCase();

export function validatePresentationSpec(
  spec: ItemPresentationSpec,
  contract: ContractView,
): SpecIssue[] {
  const issues: SpecIssue[] = [];
  const contractSlots = new Map(
    contract.responseSpec.slots.filter((s) => s.kind !== 'table').map((s) => [s.slot_id, s]),
  );
  const unitOfSlot = new Map<string, Set<string>>();
  for (const u of contract.scoringUnits) {
    for (const sid of [...u.slot_refs, ...u.evidence_slot_refs]) {
      const set = unitOfSlot.get(sid) ?? new Set<string>();
      set.add(u.scoring_unit_id);
      unitOfSlot.set(sid, set);
    }
  }

  // Every declared slot exists, binds to the unit the contract says, and fits its slot kind.
  for (const s of spec.slots) {
    const cs = contractSlots.get(s.slotId);
    if (!cs) {
      issues.push({ code: 'slot_unknown', slotId: s.slotId });
      continue;
    }
    if (!unitOfSlot.get(s.slotId)?.has(s.unitId)) {
      issues.push({ code: 'unit_mismatch', slotId: s.slotId, unitId: s.unitId });
    }
    if (!compatible(s.input, cs))
      issues.push({ code: 'input_incompatible', slotId: s.slotId, slotKind: cs.kind });
  }

  // Every contract slot is placed exactly once on the page.
  const tally = (ids: string[]) => {
    const m = new Map<string, number>();
    for (const id of ids) m.set(id, (m.get(id) ?? 0) + 1);
    return m;
  };
  const inputs = tally(spec.blocks.flatMap(inputSlotIds));
  const markers = tally(spec.blocks.flatMap(markerSlotIds));
  const counts = new Map<string, number>();
  for (const id of new Set([...inputs.keys(), ...markers.keys()])) {
    counts.set(id, inputs.get(id) ?? markers.get(id) ?? 0);
  }
  for (const id of contractSlots.keys()) {
    const n = counts.get(id) ?? 0;
    if (n === 0) issues.push({ code: 'slot_unplaced', slotId: id });
    if (n > 1) issues.push({ code: 'slot_placed_twice', slotId: id });
  }
  for (const id of counts.keys()) {
    if (!contractSlots.has(id)) issues.push({ code: 'slot_unknown', slotId: id });
  }

  // Every scoring unit is reachable from at least one placed slot (group-evidence-only units excepted).
  for (const u of contract.scoringUnits) {
    const refs = [...u.slot_refs, ...u.evidence_slot_refs];
    if (!u.requires_group_evidence && !refs.some((r) => counts.has(r))) {
      issues.push({ code: 'unit_without_slot', unitId: u.scoring_unit_id });
    }
  }

  // No answer leakage: no block text contains a reference answer (normalized, length >= 2).
  for (const block of spec.blocks) {
    const text = normalize(collectBlockText(block).join(' '));
    for (const [unitId, answers] of contract.referenceAnswers) {
      if (answers.some((a) => normalize(a).length >= 2 && text.includes(normalize(a)))) {
        issues.push({ code: 'answer_leak', blockId: block.id, unitId });
      }
    }
    if (block.kind === 'sentence_breaks' && /[，。、；：？！,.;:?!]/.test(block.line)) {
      issues.push({ code: 'breaks_line_punctuated', blockId: block.id });
    }
    if (block.kind === 'sandbox' && !block.previewApprovedAt)
      issues.push({ code: 'sandbox_unapproved', blockId: block.id });
    if (block.kind === 'fallback') issues.push({ code: 'fallback_block', blockId: block.id });
  }
  return issues;
}

/** Issues that block serving. A fallback block alone does not: it renders as plain text. */
export function isServable(issues: readonly SpecIssue[]): boolean {
  return issues.every((i) => i.code === 'fallback_block');
}

/** R9: any passage block puts the item in the split layout (passage pinned left). Not agent-chosen. */
export function layoutFor(spec: ItemPresentationSpec): 'single' | 'passage_split' {
  return spec.blocks.some((b) => b.kind === 'passage') ? 'passage_split' : 'single';
}

// ── private side (scoring unit), shown here only to pin the shape ────────────

/**
 * Proposed scoring criterion for 断句, stored per item on the private scoring unit, e.g. the real
 * paper's 「每对一处1分、超3处0分」 = { key: [1, 10, 17], scoring: { per_correct: 1,
 * over_mark_limit: 3, over_mark_score: 0 } }. Not a presentation field: the key would leak.
 */
export interface SentenceBreaksCriterion {
  kind: 'sentence_breaks';
  key: number[];
  scoring: { per_correct: number; over_mark_limit: number; over_mark_score: number };
}

/** Deterministic: same marks, same score. More marks than the limit scores over_mark_score. */
export function scoreSentenceBreaks(c: SentenceBreaksCriterion, marks: readonly number[]): number {
  const unique = new Set(marks);
  if (unique.size > c.scoring.over_mark_limit) return c.scoring.over_mark_score;
  const key = new Set(c.key);
  let hits = 0;
  for (const m of unique) if (key.has(m)) hits += 1;
  return hits * c.scoring.per_correct;
}
