// YUK-471 W3-C2 — DB tests for the question_block backfill + hoisted shared gather (testcontainer).
//
// Covers:
//   - genesis backfill (backfillQuestionBlockGenesis): seeds an event-less block, SKIPS one already
//     event-sourced (a runtime question_block_create event), is idempotent (re-run seeds 0), and
//     writes NO materialized_id_index entry (question_block does NOT enter the index, design §5.3).
//   - shared gather (gatherAndFoldQuestionBlock, hoisted from the B2 shell into gather.ts): reproduces
//     the live row for a backfilled block, and — the C2-distinctive bit — the TOP-LEVEL
//     `payload @> {affected_blocks:[{block_id}]}` Q2 containment surfaces an edit event that absorbs a
//     block as a merged_source (the event keyed on a DIFFERENT primary), so the fold flips the
//     absorbed block to status='ignored'. This top-level `@>` form is the shape the W3-C0
//     event_payload_idx GIN accelerates.
//
// Hermetic: resetDb() in beforeEach. question_block is NOT in the index, so no index reset is needed
// for its own rows — but we truncate the index anyway to stay isolated from any leaked state.

import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import type { QuestionBlockRowSnapshotT } from '@/core/schema/event/genesis';
import type { FigureRefT, StructuredQuestionT } from '@/core/schema/structured_question';
import { event, materialized_id_index, question_block } from '@/db/schema';
import { writeEvent } from '@/server/events/queries';
import { backfillQuestionBlockGenesis } from '../../../scripts/backfill-genesis-events';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { gatherAndFoldQuestionBlock } from './gather';

const T0 = new Date('2026-06-01T00:00:00.000Z');

// A minimal valid StructuredQuestion node (standalone leaf) — same shape as the core unit test.
function node(id: string, prompt: string): StructuredQuestionT {
  return { id, role: 'standalone', prompt_text: prompt };
}

async function resetIndex(): Promise<void> {
  await testDb().delete(materialized_id_index);
}

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
      // legacy column still written by old code paths — must NOT enter the snapshot (design §5.2).
      extracted_prompt_md: over.extracted_prompt_md ?? 'legacy prompt md',
      structured: over.structured ?? node(id, 'original'),
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

// Seed a raw create event (the scoping check only reads subject_id, so a minimal payload suffices).
async function seedCreateEvent(id: string, blockId: string): Promise<void> {
  await testDb().insert(event).values({
    id,
    session_id: null,
    actor_kind: 'agent',
    actor_ref: 'ingestion',
    action: 'experimental:question_block_create',
    subject_kind: 'question_block',
    subject_id: blockId,
    outcome: 'success',
    payload: {},
    caused_by_event_id: null,
    task_run_id: null,
    cost_micro_usd: null,
    created_at: T0,
  });
}

// liveQuestionBlock — maps the live row to the snapshot, OMITTING the legacy extracted_prompt_md.
async function liveQuestionBlock(id: string): Promise<QuestionBlockRowSnapshotT | null> {
  const rows = await testDb()
    .select()
    .from(question_block)
    .where(eq(question_block.id, id))
    .limit(1);
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    ingestion_session_id: r.ingestion_session_id,
    source_document_id: r.source_document_id,
    source_asset_ids: r.source_asset_ids ?? [],
    page_spans: r.page_spans ?? [],
    structured: r.structured ?? null,
    figures: r.figures ?? [],
    layout_quality: r.layout_quality,
    reference_md: r.reference_md,
    wrong_answer_md: r.wrong_answer_md,
    image_refs: r.image_refs ?? [],
    crop_refs: r.crop_refs ?? [],
    visual_complexity: r.visual_complexity,
    extraction_confidence: r.extraction_confidence,
    status: r.status,
    knowledge_hint: r.knowledge_hint,
    merged_from_block_ids: r.merged_from_block_ids ?? [],
    imported_question_id: r.imported_question_id,
    imported_attempt_event_id: r.imported_attempt_event_id,
    created_at: r.created_at,
    updated_at: r.updated_at,
    version: r.version,
  };
}

async function genesisCount(subjectId: string): Promise<number> {
  const rows = await testDb()
    .select({ id: event.id })
    .from(event)
    .where(and(eq(event.action, 'experimental:genesis'), eq(event.subject_id, subjectId)));
  return rows.length;
}

describe('backfillQuestionBlockGenesis — scoped to truly event-less blocks', () => {
  beforeEach(async () => {
    await resetDb();
    await resetIndex();
  });

  it('anchors an event-less block but SKIPS one already event-sourced (question_block_create)', async () => {
    const db = testDb();
    await insertBlock('qb_eventless'); // event-less → must be anchored
    await insertBlock('qb_created'); // event-sourced via create → SKIPPED
    await seedCreateEvent('ev_create', 'qb_created');

    const counts = await backfillQuestionBlockGenesis(db, T0);

    expect(counts.seeded).toBe(1);
    expect(counts.skipped).toBe(1);
    expect(await genesisCount('qb_eventless')).toBe(1);
    expect(await genesisCount('qb_created')).toBe(0);
  });

  it('writes NO materialized_id_index entry (question_block does NOT enter the index)', async () => {
    const db = testDb();
    await insertBlock('qb_1');
    await backfillQuestionBlockGenesis(db, T0);
    const idx = await db.select().from(materialized_id_index);
    expect(idx).toHaveLength(0);
  });

  it('is idempotent: a second backfill seeds 0 (no duplicate genesis)', async () => {
    const db = testDb();
    await insertBlock('qb_1');
    const first = await backfillQuestionBlockGenesis(db, T0);
    expect(first.seeded).toBe(1);
    const second = await backfillQuestionBlockGenesis(db, T0);
    expect(second.seeded).toBe(0);
    expect(second.skipped).toBe(1);
    expect(await genesisCount('qb_1')).toBe(1);
  });

  it('the backfilled genesis folds byte-equal to the live row, OMITTING extracted_prompt_md', async () => {
    const db = testDb();
    await insertBlock('qb_1', {
      structured: node('qb_1', 'rich prompt'),
      status: 'draft',
      version: 5,
      extracted_prompt_md: 'this legacy column must be stripped before parse',
    });
    await backfillQuestionBlockGenesis(db, T0);
    const folded = await gatherAndFoldQuestionBlock(db, 'qb_1');
    expect(folded).toEqual(await liveQuestionBlock('qb_1'));
  });
});

describe('gatherAndFoldQuestionBlock — Q2 top-level @> merge containment (hits event_payload_idx)', () => {
  beforeEach(async () => {
    await resetDb();
    await resetIndex();
  });

  it('surfaces an edit keyed on a DIFFERENT primary that absorbs blockId as a merged_source', async () => {
    const db = testDb();
    // Two event-less blocks; backfill anchors both with a genesis seed.
    await insertBlock('qb_primary', { structured: node('qb_primary', 'A') });
    await insertBlock('qb_absorbed', { structured: node('qb_absorbed', 'B'), status: 'draft' });
    await backfillQuestionBlockGenesis(db, T0);

    // The genesis events are stamped at backfill (wall-clock) time — NOT T0 (the `now` arg only sets
    // ingest_at). They sort LAST among earlier events, so the merge edit MUST come AFTER them in
    // event-time (the realistic cutover-then-mutate order). Read back the latest genesis created_at
    // and stamp the edit after it (mirrors the W2 goal db test).
    const genesisRows = await db
      .select({ created_at: event.created_at })
      .from(event)
      .where(eq(event.action, 'experimental:genesis'));
    const base = Math.max(...genesisRows.map((r) => r.created_at.getTime()));

    // A merge edit keyed on qb_primary that ABSORBS qb_absorbed (subject_id = primary, NOT absorbed).
    // gatherAndFoldQuestionBlock('qb_absorbed') Q1 misses it (subject_id !== qb_absorbed); only the
    // top-level `payload @> {affected_blocks:[{block_id:'qb_absorbed'}]}` Q2 containment finds it.
    await writeEvent(db, {
      id: 'ev_merge',
      actor_kind: 'user',
      actor_ref: 'question_block_structured_editor',
      action: 'experimental:edit_question_block_structured',
      subject_kind: 'question_block',
      subject_id: 'qb_primary',
      outcome: 'success',
      payload: {
        op: 'merge_questions',
        affected_blocks: [
          {
            block_id: 'qb_primary',
            role: 'primary',
            structured: node('qb_primary', 'A+B merged'),
            version: 1,
            status: 'draft',
          },
          {
            block_id: 'qb_absorbed',
            role: 'merged_source',
            structured: node('qb_absorbed', 'B'),
            version: 0,
            status: 'ignored',
          },
        ],
      },
      created_at: new Date(base + 1000),
    });

    // The absorbed block: Q2 surfaces the merge → status flips to 'ignored' (version verbatim = 0).
    const absorbed = await gatherAndFoldQuestionBlock(db, 'qb_absorbed');
    expect(absorbed?.status).toBe('ignored');
    expect(absorbed?.version).toBe(0);
    // structured stays at its before-value (a merge does not re-author the absorbed tree).
    expect(absorbed?.structured).toEqual(node('qb_absorbed', 'B'));

    // The primary block: Q1 hits the edit → merged-after tree + absorbed id appended.
    const primary = await gatherAndFoldQuestionBlock(db, 'qb_primary');
    expect(primary?.structured).toEqual(node('qb_primary', 'A+B merged'));
    expect(primary?.status).toBe('draft');
    expect(primary?.version).toBe(1);
    expect(primary?.merged_from_block_ids).toContain('qb_absorbed');
  });
});

// W3-C3 flip-gate hardening (c) — the per-row backfill accumulates parse failures and throws ONCE with
// the FULL list, so the owner fixes EVERY bad-bbox block in one §9.3 data-fix pass (not N reruns).
describe('backfillQuestionBlockGenesis — accumulate per-row failures, throw once', () => {
  beforeEach(async () => {
    await resetDb();
    await resetIndex();
  });

  // A figure whose source_bbox violates the 0-1 normalized BBox refinement (x + width > 1) → the strict
  // QuestionBlockRowSnapshot parse THROWS at writeEvent for this row (fail-loud, NOT clamp).
  const badFigure: FigureRefT = {
    asset_id: 'asset_bad',
    role: 'diagram',
    source_page_index: 0,
    source_bbox: { x: 0.9, y: 0, width: 0.5, height: 0.5 }, // 0.9 + 0.5 = 1.4 > 1 → out of range
    attached_to_index: 'qb_x',
    attach_confidence: 'high',
  };

  it('collects ALL bad rows and throws ONE error naming every bad id (good rows still seed)', async () => {
    const db = testDb();
    await insertBlock('qb_good'); // valid → seeds fine
    await insertBlock('qb_bad1', { figures: [{ ...badFigure }] });
    await insertBlock('qb_bad2', { figures: [{ ...badFigure }] });

    let thrown: Error | null = null;
    try {
      await backfillQuestionBlockGenesis(db, T0);
    } catch (err) {
      thrown = err instanceof Error ? err : new Error(String(err));
    }
    expect(thrown).not.toBeNull();
    // ONE throw lists BOTH bad ids (one pass, not fix-one-rerun-repeat).
    expect(thrown?.message).toContain('qb_bad1');
    expect(thrown?.message).toContain('qb_bad2');
    expect(thrown?.message).toMatch(/2 row\(s\) failed/);
    // The good row's per-row tx committed before the aggregate throw → it IS anchored.
    expect(await genesisCount('qb_good')).toBe(1);
    // The bad rows aborted their own tx → no genesis written.
    expect(await genesisCount('qb_bad1')).toBe(0);
    expect(await genesisCount('qb_bad2')).toBe(0);
  });
});
