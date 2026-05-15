import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';

import { db } from '@/db/client';
import { ingestion_session, question_block, source_asset, source_document } from '@/db/schema';
import { ApiError } from '@/server/http/errors';
import type { R2Client } from '@/server/r2';
import { runRescue } from './rescue';

async function seed() {
  const sourceDocId = createId();
  const sessionId = createId();
  const assetId = createId();
  const blockId = createId();
  const now = new Date();
  await db.insert(source_document).values({
    id: sourceDocId,
    source_asset_ids: [assetId],
    provenance: {},
    created_at: now,
    updated_at: now,
    version: 0,
  });
  await db.insert(source_asset).values({
    id: assetId,
    kind: 'image',
    storage_key: `key-${assetId}`,
    mime_type: 'image/png',
    byte_size: 100,
    sha256: 'x',
    provenance: {},
    created_at: now,
  });
  await db.insert(ingestion_session).values({
    id: sessionId,
    source_document_id: sourceDocId,
    source_asset_ids: [assetId],
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
    source_asset_ids: [assetId],
    page_spans: [],
    structured: {
      id: 'q-stale',
      role: 'standalone',
      prompt_text: 'stale content',
    },
    figures: [],
    layout_quality: 'partial',
    image_refs: [assetId],
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
  return { sourceDocId, sessionId, assetId, blockId };
}

function makeR2(buf: Uint8Array): R2Client {
  return {
    async get() {
      return buf;
    },
    async put() {},
    async delete() {},
  };
}

describe('runRescue', () => {
  it('tier=2 calls VisionExtractTask, updates block.structured, version++', async () => {
    const { sourceDocId, sessionId, assetId, blockId } = await seed();
    const runTaskFn = vi.fn(async (kind: string, _input: unknown, _ctx: unknown) => {
      expect(kind).toBe('VisionExtractTask');
      return {
        text: JSON.stringify({
          blocks: [
            {
              extracted_prompt_md: 'rescued prompt',
              reference_md: '正确答案',
              wrong_answer_md: '错答',
              page_index: 0,
              bbox: { x: 0.1, y: 0.1, width: 0.5, height: 0.2 },
              role: 'prompt',
              visual_complexity: 'medium',
              extraction_confidence: 0.9,
              knowledge_hint: null,
            },
          ],
        }),
      };
    });

    const result = await runRescue({
      db,
      r2: makeR2(new Uint8Array([1, 2, 3])),
      sessionId,
      blockId,
      page: 0,
      tier: 2,
      runTaskFn,
    });

    expect(result.structured.role).toBe('standalone');
    expect(result.structured.prompt_text).toBe('rescued prompt');
    expect(result.structured.source).toBe('vision_rescue');

    const after = await db.select().from(question_block).where(eq(question_block.id, blockId));
    expect(after[0].version).toBe(1);

    // cleanup
    await db.delete(question_block).where(eq(question_block.id, blockId));
    await db.delete(ingestion_session).where(eq(ingestion_session.id, sessionId));
    await db.delete(source_asset).where(eq(source_asset.id, assetId));
    await db.delete(source_document).where(eq(source_document.id, sourceDocId));
  });

  it('tier=3 calls VisionExtractTaskHeavy', async () => {
    const { sourceDocId, sessionId, assetId, blockId } = await seed();
    const runTaskFn = vi.fn(async (kind: string) => {
      expect(kind).toBe('VisionExtractTaskHeavy');
      return {
        text: JSON.stringify({
          blocks: [
            {
              extracted_prompt_md: 'heavy rescued',
              reference_md: null,
              wrong_answer_md: null,
              page_index: 0,
              bbox: { x: 0, y: 0, width: 1, height: 1 },
              role: 'prompt',
              visual_complexity: 'high',
              extraction_confidence: 0.7,
              knowledge_hint: null,
            },
          ],
        }),
      };
    });

    await runRescue({
      db,
      r2: makeR2(new Uint8Array([1])),
      sessionId,
      blockId,
      page: 0,
      tier: 3,
      runTaskFn,
    });
    expect(runTaskFn).toHaveBeenCalled();

    await db.delete(question_block).where(eq(question_block.id, blockId));
    await db.delete(ingestion_session).where(eq(ingestion_session.id, sessionId));
    await db.delete(source_asset).where(eq(source_asset.id, assetId));
    await db.delete(source_document).where(eq(source_document.id, sourceDocId));
  });

  it('strategy != extract → 501 not_implemented', async () => {
    await expect(
      runRescue({
        db,
        r2: makeR2(new Uint8Array([1])),
        sessionId: 'whatever',
        blockId: 'whatever',
        page: 0,
        tier: 2,
        strategy: 'restructure_cloze',
        runTaskFn: vi.fn(),
      }),
    ).rejects.toMatchObject({ code: 'not_implemented', status: 501 });
  });

  it('block not found → 404', async () => {
    await expect(
      runRescue({
        db,
        r2: makeR2(new Uint8Array([1])),
        sessionId: 'fake',
        blockId: 'fake',
        page: 0,
        tier: 2,
        runTaskFn: vi.fn(),
      }),
    ).rejects.toBeInstanceOf(ApiError);
  });
});
