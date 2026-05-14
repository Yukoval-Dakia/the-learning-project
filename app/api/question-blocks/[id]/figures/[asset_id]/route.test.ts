import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { db } from '@/db/client';
import { ingestion_session, question_block, source_document } from '@/db/schema';
import { PATCH } from './route';

async function seedBlock(figures: unknown[], structured: unknown) {
  const sourceDocId = createId();
  const sessionId = createId();
  const blockId = createId();
  const now = new Date();
  await db.insert(source_document).values({
    id: sourceDocId,
    source_asset_ids: [],
    provenance: {},
    created_at: now,
    updated_at: now,
    version: 0,
  });
  await db.insert(ingestion_session).values({
    id: sessionId,
    source_document_id: sourceDocId,
    source_asset_ids: [],
    status: 'partial',
    entrypoint: 'vision_single',
    error_message: null,
    warnings: [],
    created_at: now,
    updated_at: now,
    version: 0,
  });
  await db.insert(question_block).values({
    id: blockId,
    ingestion_session_id: sessionId,
    source_document_id: sourceDocId,
    source_asset_ids: [],
    page_spans: [],
    structured: structured as Record<string, unknown>,
    figures: figures as Record<string, unknown>[],
    layout_quality: 'structured',
    image_refs: [],
    crop_refs: [],
    visual_complexity: 'medium',
    extraction_confidence: 1,
    status: 'draft',
    knowledge_hint: null,
    merged_from_block_ids: [],
    imported_question_id: null,
    imported_mistake_id: null,
    created_at: now,
    updated_at: now,
    version: 0,
  });
  return { sourceDocId, sessionId, blockId };
}

async function cleanup(b: { sourceDocId: string; sessionId: string; blockId: string }) {
  await db.delete(question_block).where(eq(question_block.id, b.blockId));
  await db.delete(ingestion_session).where(eq(ingestion_session.id, b.sessionId));
  await db.delete(source_document).where(eq(source_document.id, b.sourceDocId));
}

describe('PATCH /api/question-blocks/[id]/figures/[asset_id]', () => {
  it('updates attached_to_index, sets confidence=manual + last_reassigned_at, bumps version', async () => {
    const struct = {
      id: 'q-stem',
      role: 'stem',
      prompt_text: '',
      sub_questions: [
        { id: 'sub-1', role: 'sub', prompt_text: '' },
        { id: 'sub-2', role: 'sub', prompt_text: '' },
      ],
    };
    const figures = [
      {
        asset_id: 'fig-1',
        role: 'diagram',
        source_page_index: 0,
        source_bbox: { x: 0.1, y: 0.1, width: 0.3, height: 0.3 },
        attached_to_index: 'q-stem',
        attach_confidence: 'high',
      },
    ];
    const seed = await seedBlock(figures, struct);

    const resp = await PATCH(
      new Request('http://t/x', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ attached_to_index: 'sub-2' }),
      }),
      { params: Promise.resolve({ id: seed.blockId, asset_id: 'fig-1' }) },
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { figures: Array<{ asset_id: string; attach_confidence: string; attached_to_index: string }> };
    expect(body.figures[0].attached_to_index).toBe('sub-2');
    expect(body.figures[0].attach_confidence).toBe('manual');

    const after = await db.select().from(question_block).where(eq(question_block.id, seed.blockId));
    expect(after[0].version).toBe(1);

    await cleanup(seed);
  });

  it('attached_to_index not in tree → 400', async () => {
    const seed = await seedBlock(
      [{ asset_id: 'fig-1', role: 'diagram', source_page_index: 0, source_bbox: { x: 0, y: 0, width: 1, height: 1 }, attached_to_index: 'x', attach_confidence: 'low' }],
      { id: 'x', role: 'standalone', prompt_text: '' },
    );
    const resp = await PATCH(
      new Request('http://t/x', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ attached_to_index: 'does-not-exist' }),
      }),
      { params: Promise.resolve({ id: seed.blockId, asset_id: 'fig-1' }) },
    );
    expect(resp.status).toBe(400);
    await cleanup(seed);
  });

  it('figure asset_id not in block → 404', async () => {
    const seed = await seedBlock([], { id: 'q', role: 'standalone', prompt_text: '' });
    const resp = await PATCH(
      new Request('http://t/x', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ attached_to_index: 'q' }),
      }),
      { params: Promise.resolve({ id: seed.blockId, asset_id: 'never-existed' }) },
    );
    expect(resp.status).toBe(404);
    await cleanup(seed);
  });
});
