/**
 * Tests for POST /api/ingestion (Sub 0c migration —— just creates session,
 * no sync extract). 抽取走 POST /api/ingestion/[id]/extract + worker.
 */

import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { learning_session, source_asset, source_document } from '@/db/schema';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { POST } from './route';

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
    await resetDb();
  });

  it('creates ingestion_session(status=uploaded) + source_document, returns session', async () => {
    const db = testDb();
    await insertAsset(db, 'asset_1', 'sk_1');
    await insertAsset(db, 'asset_2', 'sk_2');

    const res = await POST(postBody({ asset_ids: ['asset_1', 'asset_2'] }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      session: {
        id: string;
        source_document_id: string;
        status: string;
        source_asset_ids: string[];
        entrypoint: string;
      };
    };
    expect(body.session.status).toBe('uploaded');
    expect(body.session.entrypoint).toBe('vision_single');
    expect(body.session.source_asset_ids).toEqual(['asset_1', 'asset_2']);
    expect(body.session.id).toBeTruthy();
    expect(body.session.source_document_id).toBeTruthy();

    const sessions = await db
      .select()
      .from(learning_session)
      .where(eq(learning_session.id, body.session.id));
    expect(sessions).toHaveLength(1);
    expect(sessions[0].status).toBe('uploaded');

    const docs = await db
      .select()
      .from(source_document)
      .where(eq(source_document.id, body.session.source_document_id));
    expect(docs).toHaveLength(1);
    expect(docs[0].source_asset_ids).toEqual(['asset_1', 'asset_2']);
  });

  it('unknown asset_id → 400 with missing id, no session insert', async () => {
    const db = testDb();
    await insertAsset(db, 'asset_real', 'sk_r');

    const res = await POST(postBody({ asset_ids: ['asset_real', 'asset_missing'] }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toMatch(/asset_missing/);

    const sessions = await db.select().from(learning_session);
    expect(sessions).toHaveLength(0);
  });

  it('empty asset_ids → 400', async () => {
    const res = await POST(postBody({ asset_ids: [] }));
    expect(res.status).toBe(400);
  });

  // YUK-250 — the asset_ids cap rose 5 → 15 to admit a fully-expanded 15-page
  // PDF. 15 is accepted (real rows so it reaches session create); 16 is rejected
  // by Zod before any DB work. This locks the .max(MAX_PDF_PAGES) change.
  it('asset_ids at cap (15) → accepted', async () => {
    const db = testDb();
    const ids: string[] = [];
    for (let i = 0; i < 15; i++) {
      const id = `cap_${i}`;
      await insertAsset(db, id, `sk_cap_${i}`);
      ids.push(id);
    }
    const res = await POST(postBody({ asset_ids: ids }));
    expect(res.status).toBe(200);
  });

  it('asset_ids over cap (16) → 400 before DB', async () => {
    const ids = Array.from({ length: 16 }, (_, i) => `over_${i}`);
    const res = await POST(postBody({ asset_ids: ids }));
    expect(res.status).toBe(400);
  });

  it('invalid entrypoint → 400', async () => {
    const res = await POST(postBody({ entrypoint: 'not_valid' }));
    expect(res.status).toBe(400);
  });
});
