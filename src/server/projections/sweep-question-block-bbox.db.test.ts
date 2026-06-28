// YUK-471 W3-D §P3 (YUK-502) — DB tests for the one-shot question_block bbox clamp sweep.
//
// A LEGACY (pre-C1-δ) question_block can persist a `structured`/`figures` bbox that overflows the
// canonical 0-1 normalized BBox (component out of [0,1], or sum-unsafe x+width>1 / y+height>1).
// backfillQuestionBlockGenesis snapshots the live row and validates it at writeEvent's strict
// QuestionBlockRowSnapshot barrier → an overflow bbox makes it FAIL LOUD (batched), blocking the
// SoT flip. sweepQuestionBlockBBox clamps every overflow bbox using the SAME rule C1-δ's flat8ToBBox
// applies to new extractions (width=min(w,1-x), height=min(h,1-y)); legal bboxes are left untouched;
// it is idempotent; and after it, the backfill seeds clean. Hermetic: resetDb() in beforeEach.

import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import type { FigureRefT, StructuredQuestionT } from '@/core/schema/structured_question';
import { event, question_block } from '@/db/schema';
import { backfillQuestionBlockGenesis } from '../../../scripts/backfill-genesis-events';
import { sweepQuestionBlockBBox } from '../../../scripts/sweep-question-block-bbox';
import { resetDb, testDb } from '../../../tests/helpers/db';

const T0 = new Date('2026-06-01T00:00:00.000Z');

// Insert a question_block row (mirror question_block.db.test.ts insertBlock — explicit on every
// notNull column; jsonb bbox is a TS-only type, so an overflow quad inserts unvalidated).
async function insertBlock(
  id: string,
  over: Partial<typeof question_block.$inferSelect> = {},
): Promise<void> {
  await testDb()
    .insert(question_block)
    .values({
      id,
      ingestion_session_id: over.ingestion_session_id ?? 'sess_1',
      source_document_id: over.source_document_id ?? null,
      source_asset_ids: over.source_asset_ids ?? [],
      page_spans: over.page_spans ?? [],
      extracted_prompt_md: over.extracted_prompt_md ?? 'legacy prompt md',
      structured: over.structured ?? { id, role: 'standalone', prompt_text: 'original' },
      figures: over.figures ?? [],
      layout_quality: over.layout_quality ?? 'structured',
      reference_md: over.reference_md ?? null,
      wrong_answer_md: over.wrong_answer_md ?? null,
      image_refs: over.image_refs ?? [],
      crop_refs: over.crop_refs ?? [],
      visual_complexity: over.visual_complexity ?? 'low',
      extraction_confidence: over.extraction_confidence ?? 1,
      status: over.status ?? 'draft',
      knowledge_hint: over.knowledge_hint ?? null,
      merged_from_block_ids: over.merged_from_block_ids ?? [],
      imported_question_id: over.imported_question_id ?? null,
      imported_attempt_event_id: over.imported_attempt_event_id ?? null,
      created_at: over.created_at ?? T0,
      updated_at: over.updated_at ?? T0,
      version: over.version ?? 0,
    });
}

async function readBlock(id: string): Promise<typeof question_block.$inferSelect | undefined> {
  const rows = await testDb().select().from(question_block).where(eq(question_block.id, id));
  return rows[0];
}

// ── fixtures ────────────────────────────────────────────────────────────────────────────────────
// All numeric components are exactly-representable doubles (multiples of 0.25 / 0.5), so `1 - x` and
// the clamp results are EXACT — no float-equality flake (e.g. `1 - 0.9 === 0.09999999999999998`,
// NOT 0.1, which would make a naive expectation fail).
//
// The overflow stem exercises BOTH clamp paths: its own bbox overflows the SUM bound (x+width=1.25>1
// → width capped to 1-x=0.5), a handwriting bbox overflows a COMPONENT bound (width=2>1 → 1), and a
// nested sub bbox is LEGAL (the untouched control).
const OVERFLOW_STRUCTURED: StructuredQuestionT = {
  id: 'q1',
  role: 'stem',
  prompt_text: 'stem',
  bbox: { x: 0.5, y: 0, width: 0.75, height: 0.5 }, // sum overflow → width 0.75 -> 0.5
  extraction_evidence: {
    handwriting: [{ text: 'hw', bbox: { x: 0, y: 0, width: 2, height: 0.5 } }], // component → width 2 -> 1
  },
  sub_questions: [
    {
      id: 'q1a',
      role: 'sub',
      prompt_text: 'sub',
      bbox: { x: 0.25, y: 0.25, width: 0.25, height: 0.25 },
    }, // legal
  ],
};
const OVERFLOW_FIGURES: FigureRefT[] = [
  {
    asset_id: 'asset1',
    role: 'diagram',
    source_page_index: 0,
    source_bbox: { x: 0.5, y: 0.5, width: 0.75, height: 0.75 }, // sum overflow → width/height -> 0.5
    attached_to_index: 'q1',
    attach_confidence: 'high',
  },
  {
    asset_id: 'asset2',
    role: 'diagram',
    source_page_index: 0,
    source_bbox: { x: 0, y: 0, width: 0.5, height: 0.5 }, // legal → untouched
    attached_to_index: 'q1',
    attach_confidence: 'high',
  },
];

// A fully-legal block (every bbox in range + sum-safe) — the sweep must leave it byte-identical.
const LEGAL_STRUCTURED: StructuredQuestionT = {
  id: 'q2',
  role: 'standalone',
  prompt_text: 'legal',
  bbox: { x: 0.25, y: 0.25, width: 0.25, height: 0.25 },
};
const LEGAL_FIGURES: FigureRefT[] = [
  {
    asset_id: 'asset3',
    role: 'diagram',
    source_page_index: 0,
    source_bbox: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
    attached_to_index: 'q2',
    attach_confidence: 'high',
  },
];

describe('sweepQuestionBlockBBox', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('clamps every out-of-range structured/figure/handwriting bbox, leaves legal ones untouched', async () => {
    const db = testDb();
    await insertBlock('blk_overflow', {
      structured: OVERFLOW_STRUCTURED,
      figures: OVERFLOW_FIGURES,
    });

    const counts = await sweepQuestionBlockBBox(db, { apply: true });
    expect(counts.scanned).toBe(1);
    expect(counts.rowsWithOverflow).toBe(1);
    // 3 clamped: stem bbox + handwriting bbox + figure asset1 source_bbox. (sub bbox + asset2 legal.)
    expect(counts.bboxesClamped).toBe(3);
    expect(counts.applied).toBe(true);

    const row = await readBlock('blk_overflow');
    const s = row?.structured as StructuredQuestionT;
    // stem bbox clamped sum-safe (width capped at 1-x=0.5); x/y/height unchanged.
    expect(s.bbox).toEqual({ x: 0.5, y: 0, width: 0.5, height: 0.5 });
    // handwriting bbox clamped (component width 2 -> 1).
    expect(s.extraction_evidence?.handwriting?.[0]?.bbox).toEqual({
      x: 0,
      y: 0,
      width: 1,
      height: 0.5,
    });
    // LEGAL sub bbox left byte-identical.
    expect(s.sub_questions?.[0]?.bbox).toEqual({ x: 0.25, y: 0.25, width: 0.25, height: 0.25 });
    // figure asset1 clamped sum-safe; asset2 untouched.
    const figs = row?.figures as FigureRefT[];
    expect(figs[0]?.source_bbox).toEqual({ x: 0.5, y: 0.5, width: 0.5, height: 0.5 });
    expect(figs[1]?.source_bbox).toEqual({ x: 0, y: 0, width: 0.5, height: 0.5 });
  });

  it('leaves a fully-legal block byte-identical (no overflow → no write)', async () => {
    const db = testDb();
    await insertBlock('blk_legal', { structured: LEGAL_STRUCTURED, figures: LEGAL_FIGURES });
    const before = await readBlock('blk_legal');

    const counts = await sweepQuestionBlockBBox(db, { apply: true });
    expect(counts.scanned).toBe(1);
    expect(counts.rowsWithOverflow).toBe(0);
    expect(counts.bboxesClamped).toBe(0);

    const after = await readBlock('blk_legal');
    expect(after?.structured).toEqual(before?.structured);
    expect(after?.figures).toEqual(before?.figures);
  });

  it('is idempotent — a second apply run clamps nothing', async () => {
    const db = testDb();
    await insertBlock('blk_overflow', {
      structured: OVERFLOW_STRUCTURED,
      figures: OVERFLOW_FIGURES,
    });

    expect((await sweepQuestionBlockBBox(db, { apply: true })).bboxesClamped).toBe(3);
    const second = await sweepQuestionBlockBBox(db, { apply: true });
    expect(second.bboxesClamped).toBe(0);
    expect(second.rowsWithOverflow).toBe(0);
  });

  it('dry run (default) reports the clamp count but writes nothing', async () => {
    const db = testDb();
    await insertBlock('blk_overflow', {
      structured: OVERFLOW_STRUCTURED,
      figures: OVERFLOW_FIGURES,
    });
    const before = await readBlock('blk_overflow');

    const counts = await sweepQuestionBlockBBox(db); // default: apply omitted
    expect(counts.applied).toBe(false);
    expect(counts.rowsWithOverflow).toBe(1);
    expect(counts.bboxesClamped).toBe(3);

    // DB row is unchanged — dry run never persists.
    const after = await readBlock('blk_overflow');
    expect(after?.structured).toEqual(before?.structured);
    expect(after?.figures).toEqual(before?.figures);
  });

  // The acceptance contract: the genesis backfill FAILS LOUD on an overflow block (strict snapshot
  // barrier), but seeds CLEAN once the sweep has clamped it. This is the §P3 flip prerequisite.
  it('unblocks backfillQuestionBlockGenesis — throws before sweep, seeds clean after', async () => {
    const db = testDb();
    await insertBlock('blk_overflow', {
      structured: OVERFLOW_STRUCTURED,
      figures: OVERFLOW_FIGURES,
    });

    // BEFORE: the overflow bbox fails the strict QuestionBlockRowSnapshot at writeEvent → batched throw.
    await expect(backfillQuestionBlockGenesis(db, T0)).rejects.toThrow(/genesis parse barrier/);
    // The bad row's per-row tx rolled back — no genesis event persisted, block still event-less.
    const before = await db.select().from(event).where(eq(event.subject_id, 'blk_overflow'));
    expect(before).toHaveLength(0);

    // Clamp, then the backfill seeds the (now-legal) block without throwing.
    await sweepQuestionBlockBBox(db, { apply: true });
    const counts = await backfillQuestionBlockGenesis(db, T0);
    expect(counts.seeded).toBe(1);
    expect(counts.skipped).toBe(0);
    const after = await db.select().from(event).where(eq(event.subject_id, 'blk_overflow'));
    expect(after.map((e) => e.action)).toEqual(['experimental:genesis']);
  });
});
