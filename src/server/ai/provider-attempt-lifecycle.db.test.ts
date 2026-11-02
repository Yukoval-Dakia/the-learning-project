import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProviderRequestIdentity } from '@/core/schema/provider-attempt';
import type { Db } from '@/db/client';
import * as schema from '@/db/schema';
import { resetDb } from '../../../tests/helpers/db';
import { createProviderAttemptLifecycle } from './provider-attempt-lifecycle';

interface IndependentDb {
  readonly db: Db;
  close(): Promise<void>;
}

const opened: IndependentDb[] = [];

function openIndependentDb(): IndependentDb {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL not set');
  const client = postgres(url, { max: 1 });
  const handle: IndependentDb = {
    db: drizzle(client, { schema }),
    close: () => client.end(),
  };
  opened.push(handle);
  return handle;
}

const identity = (attemptId: string, caller: 'api' | 'worker' = 'api') =>
  ProviderRequestIdentity.parse({
    attemptId,
    operationId: '00000000-0000-4000-8000-000000000852',
    attemptKind: 'wire',
    provider: 'xiaomi',
    model: 'mimo-v2.5',
    lane: 'generation',
    protocol: 'anthropic-compatible',
    endpointClass: 'messages',
    caller,
    operationKind: 'QuestionGenerateTask',
  });

const _identityForOperation = (attemptId: string, operationId: string) =>
  ProviderRequestIdentity.parse({ ...identity(attemptId), operationId });

const _unknownEvidence = {
  terminal: 'unknown' as const,
  reason: 'provider did not expose terminal accounting',
  wireCount: null,
  usage: {
    basis: 'unknown' as const,
    unit: null,
    input: null,
    output: null,
    total: null,
    source: 'provider:no-usage',
  },
  cost: {
    basis: 'unknown' as const,
    amount: null,
    currency: null,
    source: 'pricebook:no-entry',
  },
};

beforeEach(async () => {
  await resetDb();
});

afterEach(async () => {
  await Promise.all(opened.splice(0).map((handle) => handle.close()));
});

describe('ProviderAttemptLifecycle', () => {
  it('keeps acquire idempotent on one lifecycle and rejects an independently owned active duplicate', async () => {
    // Given two independent clients for one attempt identity.
    const firstDb = openIndependentDb();
    const secondDb = openIndependentDb();
    const attemptIdentity = identity('00000000-0000-4000-8000-000000000855');
    const deadlineAt = new Date(Date.now() + 60_000);
    const first = createProviderAttemptLifecycle({
      mode: 'enforce',
      identity: attemptIdentity,
      deadlineAt,
      db: firstDb.db,
    });
    const second = createProviderAttemptLifecycle({
      mode: 'enforce',
      identity: attemptIdentity,
      deadlineAt,
      db: secondDb.db,
    });

    // When the independent owners race acquisition.
    const results = await Promise.allSettled([first.acquire(), second.acquire()]);

    // Then exactly one owns the lease and its repeated acquire returns the same handle.
    const winner = results.find((result) => result.status === 'fulfilled');
    const loser = results.find((result) => result.status === 'rejected');
    expect(winner?.status).toBe('fulfilled');
    expect(loser).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({ reason: 'active_duplicate' }),
    });
    if (winner?.status !== 'fulfilled') throw new Error('expected one acquired lifecycle');
    const owningLifecycle = results[0].status === 'fulfilled' ? first : second;
    expect(await owningLifecycle.acquire()).toBe(winner.value);
  });
});
