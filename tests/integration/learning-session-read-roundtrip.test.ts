import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { db } from '@/db/client';
import {
  learning_session,
  ingestion_session as legacy_ingestion_session,
  source_asset,
  source_document,
} from '@/db/schema';
import { resetDb } from '../helpers/db';

// Phase 1c.1 Step 5 — read-path roundtrip smoke. Seeds a learning_session
// (type='ingestion') directly and exercises a real route handler against it.
// Verifies the Step 5 caller migration actually reads from learning_session
// (not from the legacy ingestion_session table — that path is retired in Step 9).
//
// What this test specifically protects against: any route that "looks fine" in
// code review but still has a stale `db.select().from(ingestion_session)` SELECT
// that would silently 404 / 409 post-migration.

vi.mock('@/server/boss/client', () => ({
  createBoss: () => ({
    send: vi.fn(async () => 'mock-job-id'),
  }),
}));

async function seedSession(opts: {
  status: 'uploaded' | 'extracted' | 'reviewed';
}): Promise<{ sessionId: string; sourceDocId: string }> {
  const sessionId = createId();
  const sourceDocId = createId();
  const now = new Date();
  await db.insert(source_asset).values({
    id: 'a_seed',
    kind: 'image',
    storage_key: 'sk_seed',
    mime_type: 'image/png',
    byte_size: 8,
    sha256: '0'.repeat(64),
    created_at: now,
  });
  await db.insert(source_document).values({
    id: sourceDocId,
    title: null,
    source_asset_ids: ['a_seed'],
    body_md: null,
    provenance: {},
    created_at: now,
    updated_at: now,
    version: 0,
  });
  await db.insert(learning_session).values({
    id: sessionId,
    type: 'ingestion',
    source_document_id: sourceDocId,
    source_asset_ids: ['a_seed'],
    status: opts.status,
    entrypoint: 'vision_single',
    error_message: null,
    warnings: [],
    started_at: now,
    created_at: now,
    updated_at: now,
    version: 0,
  });
  return { sessionId, sourceDocId };
}

describe('learning_session read-path roundtrip (post-Step-5 callers)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('POST /api/ingestion/[id]/extract reads learning_session(type=ingestion) and transitions uploaded → queued', async () => {
    const { sessionId } = await seedSession({ status: 'uploaded' });
    const { POST } = await import('@/../app/api/ingestion/[id]/extract/route');
    const resp = await POST(new Request('http://t/x', { method: 'POST' }), {
      params: Promise.resolve({ id: sessionId }),
    });
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { businessId: string; jobId: string };
    expect(body.businessId).toBe(sessionId);

    const rows = await db.select().from(learning_session).where(eq(learning_session.id, sessionId));
    expect(rows[0].status).toBe('queued');
  });

  it('extract route returns 404 for a row that lives ONLY in legacy ingestion_session', async () => {
    // Seed the legacy table only (no learning_session row). Post-Step-5 routes
    // read learning_session, so a legacy-only row is correctly invisible —
    // the migration runbook (Step 8) backfills these before the new code
    // activates in prod.
    const legacyId = createId();
    const sourceDocId = createId();
    const now = new Date();
    await db.insert(source_document).values({
      id: sourceDocId,
      title: null,
      source_asset_ids: [],
      body_md: null,
      provenance: {},
      created_at: now,
      updated_at: now,
      version: 0,
    });
    await db.insert(legacy_ingestion_session).values({
      id: legacyId,
      source_document_id: sourceDocId,
      source_asset_ids: ['a'],
      status: 'uploaded',
      entrypoint: 'vision_single',
      error_message: null,
      warnings: [],
      created_at: now,
      updated_at: now,
      version: 0,
    });

    const { POST } = await import('@/../app/api/ingestion/[id]/extract/route');
    const resp = await POST(new Request('http://t/x', { method: 'POST' }), {
      params: Promise.resolve({ id: legacyId }),
    });
    expect(resp.status).toBe(404);
  });

  it('extract route refuses to load a row that is NOT type=ingestion (cross-type guard)', async () => {
    const id = createId();
    const now = new Date();
    await db.insert(learning_session).values({
      id,
      type: 'review',
      status: 'started',
      source_document_id: null,
      source_asset_ids: [],
      entrypoint: null,
      warnings: [],
      error_message: null,
      started_at: now,
      created_at: now,
      updated_at: now,
      version: 0,
    });
    const { POST } = await import('@/../app/api/ingestion/[id]/extract/route');
    const resp = await POST(new Request('http://t/x', { method: 'POST' }), {
      params: Promise.resolve({ id }),
    });
    expect(resp.status).toBe(404);
  });
});
