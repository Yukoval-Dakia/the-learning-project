// YUK-195 — DB-partition tests for the 6 question structure-edit DomainTools.
//
// Covers: registry (all 6 registered + summarized), and per-tool written +
// skipped:* soft-failure branches against a real Postgres testcontainer.
// Design note: docs/archive/superpowers/specs/2026-06-01-question-edit-domaintools-design.md
// allow: SIZE_OK — one inherited DB contract matrix keeps shared fixtures and cross-tool parity.

import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import type { FigureRefT, StructuredQuestionT } from '@/core/schema/structured_question';
import { job_events, question_block } from '@/db/schema';
import { __resetRegistryForTests } from '@/server/ai/tools/registry';
import { gatherAndFoldQuestionBlock } from '@/server/projections/gather';
import { questionBlockLiveRowToSnapshot } from '@/server/projections/parity';
import { backfillQuestionBlockGenesis } from '../../../../../scripts/backfill-genesis-events';
import { resetDb, testDb } from '../../../../../tests/helpers/db';
import { mergeQuestionsTool } from './question-block-structural-edits';
import type { ToolContext } from './types';

function ctx(): ToolContext {
  return {
    db: testDb(),
    taskRunId: 'tr_yuk195',
    callerActor: { kind: 'agent', ref: 'agent:ingestion_block_edit' },
  };
}

interface SeedOpts {
  prepareHistory?: boolean;
  status?: string;
  structured?: StructuredQuestionT | null;
  figures?: FigureRefT[];
  sessionId?: string;
}

async function seedBlock(opts: SeedOpts = {}): Promise<{ blockId: string; sessionId: string }> {
  const db = testDb();
  const blockId = createId();
  const sessionId = opts.sessionId ?? createId();
  const now = new Date();
  await db.insert(question_block).values({
    id: blockId,
    ingestion_session_id: sessionId,
    source_document_id: null,
    source_asset_ids: [],
    page_spans: [],
    structured: opts.structured ?? null,
    figures: opts.figures ?? [],
    layout_quality: 'structured',
    image_refs: [],
    crop_refs: [],
    visual_complexity: 'low',
    extraction_confidence: 1,
    status: opts.status ?? 'draft',
    knowledge_hint: null,
    merged_from_block_ids: [],
    imported_question_id: null,
    imported_attempt_event_id: null,
    created_at: now,
    updated_at: now,
    version: 0,
  });
  if (opts.prepareHistory !== false) await backfillQuestionBlockGenesis(db, now);
  return { blockId, sessionId };
}

async function readBlock(blockId: string) {
  const rows = await testDb().select().from(question_block).where(eq(question_block.id, blockId));
  return rows[0];
}

async function countEditEvents(blockId: string): Promise<number> {
  const rows = await testDb().select().from(job_events).where(eq(job_events.business_id, blockId));
  return rows.length;
}

beforeEach(async () => {
  await resetDb();
  __resetRegistryForTests();
});

// ---------------------------------------------------------------------------
// add_option (§4.2)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// split_stem (§4.4)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// merge_questions (§4.5)
// ---------------------------------------------------------------------------

describe('merge_questions', () => {
  it('rejects an unprepared secondary and rolls back every block and transport event', async () => {
    const { blockId: primary, sessionId } = await seedBlock({
      structured: { id: 'p', role: 'standalone', prompt_text: '保留原问题' },
    });
    const { blockId: secondary } = await seedBlock({
      sessionId,
      prepareHistory: false,
      structured: { id: 's', role: 'standalone', prompt_text: '保留次问题和条件' },
    });
    const before = await Promise.all([readBlock(primary), readBlock(secondary)]);
    await expect(
      mergeQuestionsTool.execute(ctx(), {
        primary_block_id: primary,
        merge_block_ids: [secondary],
      }),
    ).rejects.toThrow('requires complete history');
    expect(await Promise.all([readBlock(primary), readBlock(secondary)])).toEqual(before);
    expect(await countEditEvents(primary)).toBe(0);
    expect(await countEditEvents(secondary)).toBe(0);
  });
  it('absorbs sibling blocks, marks them ignored, records merged_from_block_ids', async () => {
    const sessionId = createId();
    const { blockId: primary } = await seedBlock({
      sessionId,
      structured: { id: 'p', role: 'standalone', prompt_text: 'primary' },
    });
    const { blockId: m1 } = await seedBlock({
      sessionId,
      structured: { id: 'm1', role: 'standalone', prompt_text: 'merge1' },
    });
    const { blockId: m2 } = await seedBlock({
      sessionId,
      structured: { id: 'm2', role: 'standalone', prompt_text: 'merge2' },
    });

    const out = await mergeQuestionsTool.execute(ctx(), {
      primary_block_id: primary,
      merge_block_ids: [m1, m2],
    });
    expect(out.status).toBe('written');

    const primaryBlock = await readBlock(primary);
    expect(primaryBlock.structured?.role).toBe('stem');
    const subIds = primaryBlock.structured?.sub_questions?.map((s) => s.id) ?? [];
    // primary's own node first, then absorbed nodes in caller-supplied order.
    expect(subIds).toEqual(['p', 'm1', 'm2']);
    expect(primaryBlock.merged_from_block_ids).toEqual([m1, m2]);
    expect(primaryBlock.version).toBe(1);

    expect((await readBlock(m1)).status).toBe('ignored');
    expect((await readBlock(m2)).status).toBe('ignored');
    for (const id of [primary, m1, m2]) {
      expect(await gatherAndFoldQuestionBlock(testDb(), id)).toEqual(
        questionBlockLiveRowToSnapshot(await readBlock(id)),
      );
    }
  });
});
