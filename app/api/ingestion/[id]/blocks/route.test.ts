// Phase 1c.2 Vision MVP — GET /api/ingestion/[id]/blocks
//
// Reads question_block rows for one session, returns them ordered by
// created_at asc so the UI shows them in extraction order.

import { learning_session, question_block } from '@/db/schema';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../../tests/helpers/db';
import { GET } from './route';

async function seedSession(id: string): Promise<void> {
  const db = testDb();
  const now = new Date();
  await db.insert(learning_session).values({
    id,
    type: 'ingestion',
    status: 'extracted',
    source_document_id: null,
    source_asset_ids: [],
    entrypoint: 'vision_single',
    warnings: [],
    error_message: null,
    summary_md: null,
    goal_id: null,
    started_at: now,
    ended_at: null,
    version: 0,
    created_at: now,
    updated_at: now,
  });
}

async function seedBlock(opts: {
  id: string;
  session_id: string;
  prompt?: string;
  layout?: 'structured' | 'partial' | 'text_only';
  created_at?: Date;
  source_asset_ids?: string[];
  image_refs?: string[];
}): Promise<void> {
  const db = testDb();
  const now = opts.created_at ?? new Date();
  await db.insert(question_block).values({
    id: opts.id,
    ingestion_session_id: opts.session_id,
    source_document_id: null,
    source_asset_ids: opts.source_asset_ids ?? [],
    page_spans: [],
    extracted_prompt_md: opts.prompt ?? null,
    structured: null,
    figures: [],
    layout_quality: opts.layout ?? 'structured',
    reference_md: null,
    wrong_answer_md: null,
    image_refs: opts.image_refs ?? [],
    crop_refs: [],
    visual_complexity: 'low',
    extraction_confidence: 0.9,
    status: 'draft',
    knowledge_hint: null,
    merged_from_block_ids: [],
    imported_question_id: null,
    imported_mistake_id: null,
    created_at: now,
    updated_at: now,
    version: 0,
  });
}

async function getBlocks(sessionId: string): Promise<Response> {
  return GET(new Request(`http://localhost/api/ingestion/${sessionId}/blocks`, { method: 'GET' }), {
    params: Promise.resolve({ id: sessionId }),
  });
}

describe('GET /api/ingestion/[id]/blocks', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('returns empty rows when session has no blocks', async () => {
    await seedSession('sess1');
    const res = await getBlocks('sess1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: unknown[] };
    expect(body.rows).toEqual([]);
  });

  it('returns blocks for the given session ordered by created_at asc', async () => {
    await seedSession('sess1');
    const t0 = new Date('2026-05-16T12:00:00Z');
    await seedBlock({
      id: 'b2',
      session_id: 'sess1',
      prompt: 'second',
      created_at: new Date(t0.getTime() + 1000),
    });
    await seedBlock({
      id: 'b1',
      session_id: 'sess1',
      prompt: 'first',
      created_at: t0,
    });

    const res = await getBlocks('sess1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rows: Array<{ id: string; extracted_prompt_md: string | null; created_at: number }>;
    };
    expect(body.rows.map((r) => r.id)).toEqual(['b1', 'b2']);
    expect(body.rows[0].extracted_prompt_md).toBe('first');
    expect(typeof body.rows[0].created_at).toBe('number');
  });

  it('does not leak blocks from other sessions', async () => {
    await seedSession('sess1');
    await seedSession('sess2');
    await seedBlock({ id: 'a', session_id: 'sess1' });
    await seedBlock({ id: 'b', session_id: 'sess2' });

    const res = await getBlocks('sess1');
    const body = (await res.json()) as { rows: Array<{ id: string }> };
    expect(body.rows.map((r) => r.id)).toEqual(['a']);
  });

  it('surfaces layout_quality + image_refs + source_asset_ids on the wire', async () => {
    await seedSession('sess1');
    await seedBlock({
      id: 'b1',
      session_id: 'sess1',
      layout: 'partial',
      source_asset_ids: ['asset_a', 'asset_b'],
      image_refs: ['asset_a'],
    });
    const res = await getBlocks('sess1');
    const body = (await res.json()) as {
      rows: Array<{
        layout_quality: string;
        image_refs: string[];
        source_asset_ids: string[];
      }>;
    };
    expect(body.rows[0].layout_quality).toBe('partial');
    expect(body.rows[0].image_refs).toEqual(['asset_a']);
    expect(body.rows[0].source_asset_ids).toEqual(['asset_a', 'asset_b']);
  });
});
