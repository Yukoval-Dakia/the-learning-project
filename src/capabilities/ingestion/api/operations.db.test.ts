import { createHash } from 'node:crypto';

import { createId } from '@paralleldrive/cuid2';
import { and, eq, sql } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { db } from '@/db/client';
import { event, job_events, learning_session, source_document } from '@/db/schema';
import { _resetBossForTests, getStartedBoss } from '@/server/boss/client';
import { reserveIngestionOperation } from '../server/operation-store';
import { POST as legacyExtractPOST } from './extract';
import { POST as legacyImportPOST } from './import';
import { POST as legacyMakePaperPOST } from './make-paper';
import { GET, POST } from './operations';
import { POST as legacyRescuePOST } from './rescue';

let boss: PgBoss;
const sessionIds: string[] = [];
const sourceDocumentIds: string[] = [];

beforeAll(async () => {
  _resetBossForTests();
  boss = await getStartedBoss();
  await boss.createQueue('tencent_ocr_extract');
});

afterAll(async () => {
  await boss.stop({ graceful: false, timeout: 1_000 });
  _resetBossForTests();
});

afterEach(async () => {
  for (const sessionId of sessionIds.splice(0)) {
    await db.delete(event).where(eq(event.session_id, sessionId));
    await db.delete(job_events).where(
      and(
        eq(job_events.business_table, 'ingestion_operation'),
        sql`${job_events.business_id} IN (
            SELECT business_id
            FROM job_events
            WHERE business_table = 'ingestion_operation'
              AND payload->>'session_id' = ${sessionId}
          )`,
      ),
    );
    await db.delete(job_events).where(eq(job_events.business_id, sessionId));
    await db.delete(learning_session).where(eq(learning_session.id, sessionId));
  }
  for (const sourceDocumentId of sourceDocumentIds.splice(0)) {
    await db.delete(source_document).where(eq(source_document.id, sourceDocumentId));
  }
});

async function seedUploadedSession(): Promise<string> {
  const sessionId = createId();
  const sourceDocumentId = createId();
  sessionIds.push(sessionId);
  sourceDocumentIds.push(sourceDocumentId);
  const now = new Date();
  await db.insert(source_document).values({
    id: sourceDocumentId,
    source_asset_ids: [],
    provenance: {},
    created_at: now,
    updated_at: now,
    version: 0,
  });
  await db.insert(learning_session).values({
    id: sessionId,
    type: 'ingestion',
    source_document_id: sourceDocumentId,
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
  return sessionId;
}

describe('POST /api/ingestion-sessions/[id]/operations', () => {
  it('returns 202 + Location and reuses the handle for the same Idempotency-Key', async () => {
    const sessionId = await seedUploadedSession();
    const key = `key_${createId()}`;
    const request = () =>
      new Request(`http://localhost/api/ingestion-sessions/${sessionId}/operations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
        body: JSON.stringify({ kind: 'extract' }),
      });

    const created = await POST(request(), { id: sessionId });
    expect(created.status).toBe(202);
    const location = created.headers.get('Location');
    expect(location).toMatch(/^\/api\/ingestion-operations\/ingop_/);
    const createdBody = (await created.json()) as { id: string; status: string };
    expect(createdBody.status).toBe('queued');

    const replayed = await POST(request(), { id: sessionId });
    expect(replayed.status).toBe(200);
    await expect(replayed.json()).resolves.toMatchObject({ id: createdBody.id });

    const snapshot = await GET(new Request(`http://localhost${location}`), {
      id: createdBody.id,
    });
    expect(snapshot.status).toBe(200);
    await expect(snapshot.json()).resolves.toMatchObject({
      id: createdBody.id,
      operation_kind: 'extract',
      status: 'queued',
      session_id: sessionId,
    });
  });

  it('returns 409 when an Idempotency-Key is reused with different input', async () => {
    const sessionId = await seedUploadedSession();
    const key = `key_${createId()}`;
    const headers = { 'Content-Type': 'application/json', 'Idempotency-Key': key };
    const first = await POST(
      new Request('http://localhost/operations', {
        method: 'POST',
        headers,
        body: JSON.stringify({ kind: 'extract' }),
      }),
      { id: sessionId },
    );
    expect(first.status).toBe(202);

    const conflict = await POST(
      new Request('http://localhost/operations', {
        method: 'POST',
        headers,
        body: JSON.stringify({ kind: 'make_paper' }),
      }),
      { id: sessionId },
    );
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({ error: 'idempotency_conflict' });
  });

  it('recovers an accepted handle left before pg-boss dispatch', async () => {
    const sessionId = await seedUploadedSession();
    const operationId = `ingop_recover_${createId()}`;
    const key = `key_${createId()}`;
    await reserveIngestionOperation(db, {
      operationId,
      sessionId,
      operationKind: 'extract',
      inputHash: createHash('sha256')
        .update(JSON.stringify({ kind: 'extract' }))
        .digest('hex'),
      idempotencyKey: key,
    });

    const recovered = await POST(
      new Request('http://localhost/operations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
        body: JSON.stringify({ kind: 'extract' }),
      }),
      { id: sessionId },
    );

    expect(recovered.status).toBe(200);
    await expect(recovered.json()).resolves.toMatchObject({
      id: operationId,
      status: 'queued',
      job_id: expect.any(String),
    });
  });

  it('keeps legacy verb routes compatible and advertises the successor collection', async () => {
    const sessionId = `missing_${createId()}`;
    const expectedLink = `</api/ingestion-sessions/${sessionId}/operations>; rel="successor-version"`;
    const responses = await Promise.all([
      legacyExtractPOST(new Request('http://localhost/extract', { method: 'POST' }), {
        id: sessionId,
      }),
      legacyImportPOST(
        new Request('http://localhost/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        }),
        { id: sessionId },
      ),
      legacyMakePaperPOST(
        new Request('http://localhost/make-paper', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        }),
        { id: sessionId },
      ),
      legacyRescuePOST(
        new Request('http://localhost/rescue', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        }),
        { id: sessionId },
      ),
    ]);

    for (const response of responses) {
      expect(response.headers.get('Deprecation')).toBe('@1783987200');
      expect(response.headers.get('Link')).toBe(expectedLink);
    }
  });
});
