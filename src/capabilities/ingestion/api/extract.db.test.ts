import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { db } from '@/db/client';
import { event, learning_session, source_document } from '@/db/schema';
import { startTestWorker } from '../../../../tests/helpers/worker';
import { POST as extractRoute } from './extract';

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
    await db.insert(learning_session).values({
      id: sessionId,
      type: 'ingestion',
      source_document_id: sourceDocId,
      source_asset_ids: ['fake_asset'],
      status: 'uploaded',
      entrypoint: 'vision_single',
      error_message: null,
      warnings: [],
      started_at: now,
      created_at: now,
      updated_at: now,
      version: 0,
    });

    const resp = await extractRoute(new Request('http://t/x', { method: 'POST' }), {
      id: sessionId,
    });
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { businessId: string; jobId: string };
    expect(body.businessId).toBe(sessionId);
    expect(typeof body.jobId).toBe('string');

    const rows = await db.select().from(learning_session).where(eq(learning_session.id, sessionId));
    expect(rows[0].status).toBe('queued');

    await db.delete(event).where(eq(event.session_id, sessionId));
    await db.delete(learning_session).where(eq(learning_session.id, sessionId));
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
    await db.insert(learning_session).values({
      id: sessionId,
      type: 'ingestion',
      source_document_id: sourceDocId,
      source_asset_ids: ['fake_asset'],
      status: 'extracting',
      entrypoint: 'vision_single',
      error_message: null,
      warnings: [],
      started_at: now,
      created_at: now,
      updated_at: now,
      version: 0,
    });

    const resp = await extractRoute(new Request('http://t/x', { method: 'POST' }), {
      id: sessionId,
    });
    expect(resp.status).toBe(409);

    await db.delete(event).where(eq(event.session_id, sessionId));
    await db.delete(learning_session).where(eq(learning_session.id, sessionId));
    await db.delete(source_document).where(eq(source_document.id, sourceDocId));
  });

  it('missing session returns 404', async () => {
    const resp = await extractRoute(new Request('http://t/x', { method: 'POST' }), {
      id: 'never-existed',
    });
    expect(resp.status).toBe(404);
  });
});
