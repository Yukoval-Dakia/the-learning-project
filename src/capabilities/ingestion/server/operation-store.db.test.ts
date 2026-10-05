import { createHash } from 'node:crypto';

import { eq } from 'drizzle-orm';
import type { Job } from 'pg-boss';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  type IngestionOperationJobData,
  buildIngestionOperationHandler,
} from '@/capabilities/ingestion/jobs/ingestion_operation';
import { newId } from '@/core/ids';
import { db } from '@/db/client';
import { job_events, learning_session } from '@/db/schema';
import { resetDb } from '../../../../tests/helpers/db';
import {
  INGESTION_OPERATION_TABLE,
  readIngestionOperation,
  reserveIngestionOperation,
  writeIngestionOperationEvent,
} from './operation-store';

const operationIds: string[] = [];
const sessionIds: string[] = [];

function newOperationId(): string {
  const id = `ingop_test_${newId()}`;
  operationIds.push(id);
  return id;
}

afterEach(async () => {
  for (const operationId of operationIds.splice(0)) {
    await db.delete(job_events).where(eq(job_events.business_id, operationId));
  }
  for (const sessionId of sessionIds.splice(0)) {
    await db.delete(learning_session).where(eq(learning_session.id, sessionId));
  }
});

describe('ingestion operation store', () => {
  beforeEach(resetDb);

  describe.each(['extract', 'make_paper'] as const)('%s persisted errors', (operationKind) => {
    it.each([
      null,
      'failure text',
      [],
      {},
      { code: 'broken', message: 'bad status type', status: '500' },
      { code: 'broken', message: 123, status: 500 },
      { message: 'missing code', status: 500 },
    ])('falls back for malformed payload %j', async (error) => {
      const operationId = newOperationId();
      await reserveIngestionOperation(db, {
        operationId,
        sessionId: `session_${newId()}`,
        operationKind,
        inputHash: 'malformed-error',
      });
      await writeIngestionOperationEvent(db, {
        operationId,
        eventType: 'operation.failed',
        payload: { error },
      });
      expect(await readIngestionOperation(db, operationId)).toMatchObject({
        status: 'failed',
        error: {
          code: operationKind === 'extract' ? 'extraction_failed' : 'operation_failed',
          message: operationKind === 'extract' ? 'Extraction failed' : 'Operation failed',
          status: 500,
        },
      });
    });

    it('preserves a complete error and its extra diagnostic fields', async () => {
      const operationId = newOperationId();
      const error = {
        code: 'source_unavailable',
        message: '上游未返回可用结构，请保留原始材料。',
        status: 503,
        diagnostic: { stage: 'source', retryable: true },
      };
      await reserveIngestionOperation(db, {
        operationId,
        sessionId: `session_${newId()}`,
        operationKind,
        inputHash: 'complete-error',
      });
      await writeIngestionOperationEvent(db, {
        operationId,
        eventType: 'operation.failed',
        payload: { error },
      });
      expect((await readIngestionOperation(db, operationId))?.error).toEqual(error);
    });
  });

  it('reuses the same idempotency key and rejects a different input hash', async () => {
    const operationId = newOperationId();
    const base = {
      operationId,
      sessionId: `session_${newId()}`,
      operationKind: 'make_paper' as const,
      inputHash: createHash('sha256').update('same').digest('hex'),
      idempotencyKey: `key_${newId()}`,
    };

    await expect(reserveIngestionOperation(db, base)).resolves.toEqual({
      outcome: 'created',
      operationId,
    });
    await expect(
      reserveIngestionOperation(db, { ...base, operationId: newOperationId() }),
    ).resolves.toEqual({ outcome: 'reused', operationId });
    await expect(
      reserveIngestionOperation(db, {
        ...base,
        operationId: newOperationId(),
        inputHash: createHash('sha256').update('different').digest('hex'),
      }),
    ).resolves.toEqual({ outcome: 'conflict', operationId });
  });

  it('projects queued, running and completed events into a pollable resource', async () => {
    const operationId = newOperationId();
    const sessionId = `session_${newId()}`;
    await reserveIngestionOperation(db, {
      operationId,
      sessionId,
      operationKind: 'make_paper',
      inputHash: 'hash',
    });
    await writeIngestionOperationEvent(db, {
      operationId,
      eventType: 'operation.queued',
      payload: { job_id: 'job_1' },
    });
    await writeIngestionOperationEvent(db, {
      operationId,
      eventType: 'operation.running',
    });
    await writeIngestionOperationEvent(db, {
      operationId,
      eventType: 'operation.completed',
      payload: { result: { artifact_id: 'paper_1' } },
    });

    await expect(readIngestionOperation(db, operationId)).resolves.toMatchObject({
      id: operationId,
      operation_kind: 'make_paper',
      status: 'succeeded',
      session_id: sessionId,
      job_id: 'job_1',
      result: { artifact_id: 'paper_1' },
    });
  });

  it('keeps an extract operation terminal when the same session starts a later retry', async () => {
    const operationId = newOperationId();
    const sessionId = `session_${newId()}`;
    sessionIds.push(sessionId);
    const now = new Date();
    await db.insert(learning_session).values({
      id: sessionId,
      type: 'ingestion',
      status: 'queued',
      source_asset_ids: [],
      warnings: [],
      started_at: now,
      created_at: now,
      updated_at: now,
      version: 0,
    });
    await reserveIngestionOperation(db, {
      operationId,
      sessionId,
      operationKind: 'extract',
      inputHash: 'hash',
    });
    await writeIngestionOperationEvent(db, {
      operationId,
      eventType: 'operation.failed',
      payload: {
        error: { code: 'extraction_failed', message: 'Extraction failed', status: 500 },
      },
    });

    await expect(readIngestionOperation(db, operationId)).resolves.toMatchObject({
      status: 'failed',
    });
  });

  it('worker adapter records the legacy result without changing its business response', async () => {
    const operationId = newOperationId();
    const sessionId = `session_${newId()}`;
    const request = { kind: 'make_paper' as const, input: {} };
    await reserveIngestionOperation(db, {
      operationId,
      sessionId,
      operationKind: request.kind,
      inputHash: 'hash',
    });

    const handler = buildIngestionOperationHandler(db, {
      executeOperation: async () => Response.json({ artifact_id: 'paper_2' }),
    });
    await handler([
      {
        id: 'job_2',
        data: { operationId, sessionId, request },
      } as Job<IngestionOperationJobData>,
    ]);

    await expect(readIngestionOperation(db, operationId)).resolves.toMatchObject({
      status: 'succeeded',
      result: { artifact_id: 'paper_2' },
    });
  });
});
