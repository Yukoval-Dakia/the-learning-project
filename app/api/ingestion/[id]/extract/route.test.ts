import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { db } from '@/db/client';
import { ingestion_session, source_document } from '@/db/schema';
import { startTestWorker } from '../../../../../tests/helpers/worker';
import { POST as extractRoute } from './route';

describe('POST /api/ingestion/[id]/extract', () => {
  let teardown: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const w = await startTestWorker(db);
    teardown = w.teardown;
  });

  afterAll(async () => {
    if (teardown) await teardown();
  });

  it('uploaded → queued + returns { businessId, jobId }', async () => {
    const sessionId = createId();
    const sourceDocId = createId();
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
      source_asset_ids: ['fake_asset'],
      status: 'uploaded',
      entrypoint: 'vision_single',
      error_message: null,
      warnings: [],
      created_at: now,
      updated_at: now,
      version: 0,
    });

    const resp = await extractRoute(new Request('http://t/x', { method: 'POST' }), {
      params: Promise.resolve({ id: sessionId }),
    });
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { businessId: string; jobId: string };
    expect(body.businessId).toBe(sessionId);
    expect(typeof body.jobId).toBe('string');

    const rows = await db
      .select()
      .from(ingestion_session)
      .where(eq(ingestion_session.id, sessionId));
    expect(rows[0].status).toBe('queued');

    await db.delete(ingestion_session).where(eq(ingestion_session.id, sessionId));
    await db.delete(source_document).where(eq(source_document.id, sourceDocId));
  });

  it('non-uploaded state returns 409', async () => {
    const sessionId = createId();
    const sourceDocId = createId();
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
      source_asset_ids: ['fake_asset'],
      status: 'extracting',
      entrypoint: 'vision_single',
      error_message: null,
      warnings: [],
      created_at: now,
      updated_at: now,
      version: 0,
    });

    const resp = await extractRoute(new Request('http://t/x', { method: 'POST' }), {
      params: Promise.resolve({ id: sessionId }),
    });
    expect(resp.status).toBe(409);

    await db.delete(ingestion_session).where(eq(ingestion_session.id, sessionId));
    await db.delete(source_document).where(eq(source_document.id, sourceDocId));
  });

  it('missing session returns 404', async () => {
    const resp = await extractRoute(new Request('http://t/x', { method: 'POST' }), {
      params: Promise.resolve({ id: 'never-existed' }),
    });
    expect(resp.status).toBe(404);
  });
});
