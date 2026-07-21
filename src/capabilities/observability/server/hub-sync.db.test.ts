// YUK-384 — durable hub-sync reconciler health read model (Task 10).
// Real Postgres (testcontainer): seed a mixed cursor population, assert the
// single-aggregate health snapshot.

import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { artifact } from '@/db/schema';

import { resetDb, testDb } from '../../../../tests/helpers/db';
import { readHubSyncHealth } from './hub-sync';

const NOW = new Date('2026-07-21T00:00:00Z');

async function seedArtifact(id: string) {
  await testDb()
    .insert(artifact)
    .values({
      id,
      // Non-hub type so the topology trigger does not auto-create a cursor; the
      // fixture inserts cursors with exact field values below.
      type: 'note',
      title: id,
      knowledge_ids: [],
      intent_source: 'learning_intent',
      source: 'ai_generated',
      body_blocks: { type: 'doc', content: [] } as never,
      attrs: {} as never,
      generation_status: 'ready',
      verification_status: 'verified',
      history: [],
      created_at: NOW,
      updated_at: NOW,
      version: 0,
    });
}

async function seedHubSyncHealthFixture() {
  await seedArtifact('h-a');
  await seedArtifact('h-b');
  await seedArtifact('h-c');
  await testDb().execute(sql`
    insert into hub_sync_reconciliation (
      artifact_id, generation, acknowledged_generation, status, consecutive_failure_count,
      next_attempt_at, last_dirty_at, last_error_class, last_error_at, acknowledged_at,
      last_repair_key, updated_at, created_at
    )
    values
      ('h-a', 5, 1, 'pending', 0,
       clock_timestamp(), clock_timestamp() - interval '600 seconds',
       null, null, null, null, clock_timestamp(), clock_timestamp()),
      ('h-b', 3, 2, 'retry_wait', 3,
       clock_timestamp() + interval '30 seconds', clock_timestamp() - interval '100 seconds',
       'invalid_document', clock_timestamp() - interval '120 seconds', null, null,
       clock_timestamp(), clock_timestamp()),
      ('h-c', 2, 2, 'acknowledged', 0,
       clock_timestamp(), clock_timestamp() - interval '50 seconds',
       null, null, clock_timestamp() - interval '10 seconds', 'nightly:2026-07-21',
       clock_timestamp(), clock_timestamp())
  `);
}

describe('readHubSyncHealth', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('reports cursor health, lag, age, failures, and latest ack/repair', async () => {
    await seedHubSyncHealthFixture();
    expect(await readHubSyncHealth(testDb())).toEqual({
      by_status: {
        pending: 1,
        claimed: 0,
        applying: 0,
        retry_wait: 1,
        acknowledged: 1,
        cancelled: 0,
      },
      dirty_count: 2,
      ready_count: 1,
      expired_lease_count: 0,
      invalid_document_count: 1,
      oldest_dirty_age_seconds: 600,
      oldest_invalid_age_seconds: 120,
      max_consecutive_failure_count: 3,
      max_generation_lag: '4',
      last_acknowledged_at: expect.any(String),
      last_repair_key: 'nightly:2026-07-21',
    });
  });

  it('YUK-384: a cancelled cursor is terminal — excluded from dirty_count, oldest_dirty_age, and max_generation_lag', async () => {
    await seedArtifact('h-cancel');
    await seedArtifact('h-live');
    await testDb().execute(sql`
      insert into hub_sync_reconciliation (
        artifact_id, generation, acknowledged_generation, status, consecutive_failure_count,
        next_attempt_at, last_dirty_at, updated_at, created_at
      )
      values
        -- Cancelled with a huge gen/ack gap and the oldest dirty age. The coverage-repair
        -- cancel bumps generation past ack and never acks, so acknowledged_generation <
        -- generation holds forever — but it is TERMINAL, not backlog, so it must NOT count.
        ('h-cancel', 99, 0, 'cancelled', 0,
         clock_timestamp(), clock_timestamp() - interval '9000 seconds',
         clock_timestamp(), clock_timestamp()),
        -- One genuinely dirty live cursor: the only thing the metrics should reflect.
        ('h-live', 5, 3, 'pending', 0,
         clock_timestamp(), clock_timestamp() - interval '300 seconds',
         clock_timestamp(), clock_timestamp())
    `);
    const health = await readHubSyncHealth(testDb());
    expect(health.by_status.cancelled).toBe(1);
    expect(health.dirty_count).toBe(1); // only h-live
    expect(health.oldest_dirty_age_seconds).toBe(300); // h-live's 300s, not h-cancel's 9000s
    expect(health.max_generation_lag).toBe('2'); // h-live 5-3, not h-cancel 99-0
  });

  it('returns a zeroed snapshot on an empty cursor table', async () => {
    expect(await readHubSyncHealth(testDb())).toEqual({
      by_status: {
        pending: 0,
        claimed: 0,
        applying: 0,
        retry_wait: 0,
        acknowledged: 0,
        cancelled: 0,
      },
      dirty_count: 0,
      ready_count: 0,
      expired_lease_count: 0,
      invalid_document_count: 0,
      oldest_dirty_age_seconds: null,
      oldest_invalid_age_seconds: null,
      max_consecutive_failure_count: 0,
      max_generation_lag: '0',
      last_acknowledged_at: null,
      last_repair_key: null,
    });
  });
});
