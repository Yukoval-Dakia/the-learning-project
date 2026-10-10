import { createHash } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { newId } from '@/core/ids';
import { db } from '@/db/client';
import { job_events, learning_session } from '@/db/schema';
import { resetDb } from '../../../../tests/helpers/db';
import { reserveIngestionOperation } from './operation-store';

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
});
