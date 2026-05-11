/**
 * Tests for POST /api/ingestion
 *
 * Strategy:
 * - Mock @/server/ingestion/cascade (runOCRCascade) to avoid real AI calls
 * - Mock @/server/r2 (getR2) to avoid R2 network calls
 * - Use testDb() / resetDb() for actual Postgres integration
 */

import { ingestion_session, question_block, source_asset } from '@/db/schema';
import type { CascadeResult } from '@/server/ingestion/cascade';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { memR2 } from '../../../tests/helpers/r2';

// ---- mocks (must be hoisted before importing route) ----
const r2 = memR2();
vi.mock('@/server/r2', () => ({
  getR2: () => r2,
  createR2Client: () => r2,
}));

// Mock cascade so we don't need real OCR/AI
const mockRunOCRCascade = vi.fn<() => Promise<CascadeResult>>();
vi.mock('@/server/ingestion/cascade', () => ({
  runOCRCascade: (...args: unknown[]) => mockRunOCRCascade(...(args as [])),
}));

// Mock recognizeDocument (used in deps but cascade is mocked anyway)
vi.mock('@/server/ingestion/ocr_tencent', () => ({
  recognizeDocument: vi.fn(),
}));

// Mock ai runner
vi.mock('@/server/ai/runner', () => ({
  runTask: vi.fn(),
}));

import { POST } from './route';

function makeVisionCascadeResult(pageIndex: number, seed = 'a'): CascadeResult {
  return {
    blocks: [
      {
        extracted_prompt_md: `Q ${seed}`,
        reference_md: null,
        wrong_answer_md: null,
        page_index: pageIndex,
        bbox: { x: 0, y: 0, width: 1, height: 1 },
        role: 'prompt',
        visual_complexity: 'low',
        extraction_confidence: 0.9,
        knowledge_hint: null,
      },
    ],
    tier_log: [
      { tier: 1, model: 'tencent', blocks_count: 0, confidence_avg: null, took_ms: 10 },
      { tier: 2, model: 'claude-haiku-4-5', blocks_count: 1, confidence_avg: 0.9, took_ms: 100 },
    ],
    final_status: 'extracted',
  };
}

async function insertAsset(db: ReturnType<typeof testDb>, id: string, storageKey: string) {
  await db.insert(source_asset).values({
    id,
    kind: 'image',
    storage_key: storageKey,
    mime_type: 'image/png',
    byte_size: 8,
    sha256: '0'.repeat(64),
    created_at: new Date(),
  });
}

function postBody(overrides: Record<string, unknown> = {}) {
  return new Request('http://localhost/api/ingestion', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      entrypoint: 'vision_single',
      asset_ids: ['asset_1'],
      ...overrides,
    }),
  });
}

describe('POST /api/ingestion', () => {
  beforeEach(async () => {
    r2._store.clear();
    await resetDb();
    mockRunOCRCascade.mockReset();
    vi.clearAllMocks();
  });

  it('happy path 2 assets: inserts session + doc + 2 blocks, returns extracted status', async () => {
    const db = testDb();
    await insertAsset(db, 'asset_1', 'sk_1');
    await insertAsset(db, 'asset_2', 'sk_2');
    r2._store.set('sk_1', new Uint8Array(8));
    r2._store.set('sk_2', new Uint8Array(8));

    mockRunOCRCascade
      .mockResolvedValueOnce(makeVisionCascadeResult(0, '0'))
      .mockResolvedValueOnce(makeVisionCascadeResult(1, '1'));

    const res = await POST(
      new Request('http://localhost/api/ingestion', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ entrypoint: 'vision_single', asset_ids: ['asset_1', 'asset_2'] }),
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      session: {
        id: string;
        source_document_id: string;
        status: string;
        source_asset_ids: string[];
        entrypoint: string;
      };
      blocks: Array<{ block_id: string; source_block_ids: string[] }>;
      failures: unknown[];
    };

    expect(body.session.status).toBe('extracted');
    expect(body.session.entrypoint).toBe('vision_single');
    expect(body.session.source_asset_ids).toEqual(['asset_1', 'asset_2']);
    expect(body.blocks).toHaveLength(2);
    for (const block of body.blocks) {
      expect(block.block_id).toBeTruthy();
      expect(block.source_block_ids).toEqual([block.block_id]);
    }
    expect(body.failures).toHaveLength(0);

    // Verify DB state
    const sessions = await db
      .select()
      .from(ingestion_session)
      .where(eq(ingestion_session.id, body.session.id));
    expect(sessions).toHaveLength(1);
    expect(sessions[0].status).toBe('extracted');

    const qbs = await db
      .select()
      .from(question_block)
      .where(eq(question_block.ingestion_session_id, body.session.id));
    expect(qbs).toHaveLength(2);
  });

  it('unknown asset_id returns 400 with the missing id, no session insert', async () => {
    const db = testDb();
    await insertAsset(db, 'asset_real', 'sk_r');

    const res = await POST(
      new Request('http://localhost/api/ingestion', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          entrypoint: 'vision_single',
          asset_ids: ['asset_real', 'asset_missing'],
        }),
      }),
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toMatch(/asset_missing/);

    const sessions = await db.select().from(ingestion_session);
    expect(sessions).toHaveLength(0);
  });

  it('one R2 object missing: returns 200, blocks from second asset only, status extracted', async () => {
    const db = testDb();
    await insertAsset(db, 'asset_1', 'sk_1');
    await insertAsset(db, 'asset_2', 'sk_2');
    // sk_1 missing from R2
    r2._store.set('sk_2', new Uint8Array(8));

    mockRunOCRCascade.mockResolvedValueOnce(makeVisionCascadeResult(1, '1'));

    const res = await POST(
      new Request('http://localhost/api/ingestion', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ entrypoint: 'vision_single', asset_ids: ['asset_1', 'asset_2'] }),
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      session: { status: string };
      blocks: unknown[];
      failures: Array<{ asset_id: string; reason: string }>;
    };
    expect(body.session.status).toBe('extracted');
    expect(body.blocks).toHaveLength(1);
    expect(body.failures).toHaveLength(1);
    expect(body.failures[0].asset_id).toBe('asset_1');
    expect(body.failures[0].reason).toBe('r2_object_missing');
  });

  it('all R2 missing: returns 200, blocks=[], status=failed', async () => {
    const db = testDb();
    await insertAsset(db, 'asset_1', 'sk_1');
    // sk_1 not in R2

    const res = await POST(postBody());

    expect(res.status).toBe(200);
    const body = (await res.json()) as { session: { status: string }; blocks: unknown[] };
    expect(body.session.status).toBe('failed');
    expect(body.blocks).toHaveLength(0);
  });

  it('cascade throws for all assets: status=failed, blocks=[]', async () => {
    const db = testDb();
    await insertAsset(db, 'asset_1', 'sk_1');
    await insertAsset(db, 'asset_2', 'sk_2');
    r2._store.set('sk_1', new Uint8Array(8));
    r2._store.set('sk_2', new Uint8Array(8));

    mockRunOCRCascade.mockRejectedValue(new Error('ai exploded'));

    const res = await POST(
      new Request('http://localhost/api/ingestion', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ entrypoint: 'vision_single', asset_ids: ['asset_1', 'asset_2'] }),
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { session: { status: string }; blocks: unknown[] };
    expect(body.session.status).toBe('failed');
    expect(body.blocks).toHaveLength(0);
  });

  it('cascade throws for first asset, succeeds for second: status=extracted, 1 block', async () => {
    const db = testDb();
    await insertAsset(db, 'asset_1', 'sk_1');
    await insertAsset(db, 'asset_2', 'sk_2');
    r2._store.set('sk_1', new Uint8Array(8));
    r2._store.set('sk_2', new Uint8Array(8));

    mockRunOCRCascade
      .mockRejectedValueOnce(new Error('first asset exploded'))
      .mockResolvedValueOnce(makeVisionCascadeResult(1, '1'));

    const res = await POST(
      new Request('http://localhost/api/ingestion', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ entrypoint: 'vision_single', asset_ids: ['asset_1', 'asset_2'] }),
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { session: { status: string }; blocks: unknown[] };
    expect(body.session.status).toBe('extracted');
    expect(body.blocks).toHaveLength(1);
  });

  it('body validation: empty asset_ids → 400', async () => {
    const res = await POST(postBody({ asset_ids: [] }));
    expect(res.status).toBe(400);
  });

  it('body validation: asset_ids over max (6) → 400', async () => {
    const res = await POST(postBody({ asset_ids: ['a', 'b', 'c', 'd', 'e', 'f'] }));
    expect(res.status).toBe(400);
  });

  it('body validation: invalid entrypoint → 400', async () => {
    const res = await POST(postBody({ entrypoint: 'not_valid' }));
    expect(res.status).toBe(400);
  });

  it('persists tier_log JSON to session.error_message on success', async () => {
    const db = testDb();
    await insertAsset(db, 'asset_1', 'sk_1');
    r2._store.set('sk_1', new Uint8Array(8));

    mockRunOCRCascade.mockResolvedValueOnce(makeVisionCascadeResult(0, '0'));

    const res = await POST(postBody({ asset_ids: ['asset_1'] }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { session: { id: string } };

    const sessions = await db
      .select()
      .from(ingestion_session)
      .where(eq(ingestion_session.id, body.session.id));
    expect(sessions[0].error_message).toBeTruthy();
    const payload = JSON.parse(sessions[0].error_message ?? '') as {
      tier_logs: Array<{ asset_id: string; log: Array<{ tier: number }> }>;
    };
    expect(payload.tier_logs).toHaveLength(1);
    expect(payload.tier_logs[0].asset_id).toBe('asset_1');
    expect(payload.tier_logs[0].log[0].tier).toBe(1);
    expect(payload.tier_logs[0].log[1].tier).toBe(2);
  });
});
