import { event, event_subscription_checkpoint, event_subscription_delivery } from '@/db/schema';
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../helpers/db';

const EVENT_VALUES = {
  id: 'event-source',
  actor_kind: 'system',
  actor_ref: 'test',
  action: 'experimental:test',
  subject_kind: 'event',
  subject_id: 'source',
  payload: {},
};

beforeEach(() => resetDb());

describe('YUK-751 durable event-subscription schema', () => {
  it('assigns unique non-null dispatch sequences and advances on inserts', async () => {
    await testDb()
      .insert(event)
      .values([
        { ...EVENT_VALUES, id: 'event-a' },
        { ...EVENT_VALUES, id: 'event-b' },
      ]);
    const rows = await testDb()
      .select({ id: event.id, dispatchSeq: event.dispatch_seq })
      .from(event)
      .orderBy(event.dispatch_seq);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.dispatchSeq > 0)).toBe(true);
    expect(new Set(rows.map((row) => row.dispatchSeq)).size).toBe(2);
  });

  it('rejects invalid checkpoint versions, statuses, and partial claims', async () => {
    await expect(
      testDb().execute(sql`insert into event_subscription_checkpoint
        (subscriber_id, subscriber_version, declaration_hash, status)
        values ('bad-version', 0, 'hash', 'active')`),
    ).rejects.toThrow();
    await expect(
      testDb().execute(sql`insert into event_subscription_checkpoint
        (subscriber_id, subscriber_version, declaration_hash, status)
        values ('bad-status', 1, 'hash', 'unknown')`),
    ).rejects.toThrow();
    await expect(
      testDb().execute(sql`insert into event_subscription_checkpoint
        (subscriber_id, subscriber_version, declaration_hash, status, claim_owner)
        values ('partial-claim', 1, 'hash', 'active', 'worker')`),
    ).rejects.toThrow();
  });

  it('enforces delivery state shapes, FKs, and subscriber-local sequence uniqueness', async () => {
    await testDb().insert(event).values(EVENT_VALUES);
    const [source] = await testDb()
      .select({ dispatchSeq: event.dispatch_seq })
      .from(event)
      .where(sql`${event.id} = ${EVENT_VALUES.id}`);
    if (!source) throw new Error('source event was not inserted');
    await testDb().insert(event_subscription_checkpoint).values({
      subscriber_id: 'subscriber',
      subscriber_version: 1,
      declaration_hash: 'hash',
      status: 'active',
    });
    const base = {
      subscriber_id: 'subscriber',
      subscriber_version: 1,
      source_event_id: EVENT_VALUES.id,
      source_dispatch_seq: source.dispatchSeq,
      delivery_seq: 1,
      status: 'pending' as const,
    };
    await testDb().insert(event_subscription_delivery).values(base);

    await testDb()
      .insert(event)
      .values({ ...EVENT_VALUES, id: 'event-other' });
    await expect(
      testDb()
        .insert(event_subscription_delivery)
        .values({
          ...base,
          source_event_id: 'event-other',
        }),
    ).rejects.toThrow();
    await expect(
      testDb().execute(sql`insert into event_subscription_delivery
        (subscriber_id, subscriber_version, source_event_id, source_dispatch_seq, delivery_seq, status)
        values ('subscriber', 1, 'missing-event', 3, 2, 'pending')`),
    ).rejects.toThrow();

    const invalidShapes = [
      sql`insert into event_subscription_delivery
        (subscriber_id, subscriber_version, source_event_id, source_dispatch_seq, delivery_seq, status)
        values ('subscriber', 1, 'event-other', 2, 2, 'claimed')`,
      sql`insert into event_subscription_delivery
        (subscriber_id, subscriber_version, source_event_id, source_dispatch_seq, delivery_seq, status, next_attempt_at)
        values ('subscriber', 1, 'event-other', 2, 2, 'pending', now())`,
      sql`insert into event_subscription_delivery
        (subscriber_id, subscriber_version, source_event_id, source_dispatch_seq, delivery_seq, status)
        values ('subscriber', 1, 'event-other', 2, 2, 'succeeded')`,
      sql`insert into event_subscription_delivery
        (subscriber_id, subscriber_version, source_event_id, source_dispatch_seq, delivery_seq, status, completed_at)
        values ('subscriber', 1, 'event-other', 2, 2, 'pending', now())`,
    ];
    for (const statement of invalidShapes) {
      await expect(testDb().execute(statement)).rejects.toThrow();
    }
  });

  it('enforces effect arrays, enums, FKs, causal identity, and stable job keys', async () => {
    await testDb().insert(event).values(EVENT_VALUES);
    await testDb().execute(sql`insert into artifact
      (id, type, title, body_blocks, attrs, knowledge_ids, intent_source, source, created_at, updated_at, version)
      values ('artifact-1', 'note_atomic', 'Test', '{"type":"doc","content":[]}'::jsonb,
        '{}'::jsonb, '[]'::jsonb, 'system', 'system', now(), now(), 1)`);

    const insertEffect = (id: string, stableKey: string, artifactId = 'artifact-1') =>
      testDb().execute(sql`insert into event_subscription_effect
        (id, attempt_event_id, artifact_id, effect_kind, mastery_event_ids, evidence_ids,
         status, stable_job_key)
        values (${id}, 'event-source', ${artifactId}, 'mastery_change', array['mastery-1'],
          array['evidence-1'], 'reserved', ${stableKey})`);

    await insertEffect('effect-1', 'job-1');
    await expect(insertEffect('effect-causal-duplicate', 'job-2')).rejects.toThrow();
    await expect(
      testDb().execute(sql`insert into event_subscription_effect
        (id, attempt_event_id, artifact_id, effect_kind, mastery_event_ids, evidence_ids,
         status, stable_job_key)
        values ('effect-empty', 'event-source', 'artifact-1', 'mastery_change', array[]::text[],
          array[]::text[], 'reserved', 'job-empty')`),
    ).rejects.toThrow();
    await expect(
      testDb().execute(sql`insert into event_subscription_effect
        (id, attempt_event_id, artifact_id, effect_kind, mastery_event_ids, evidence_ids,
         status, stable_job_key)
        values ('effect-status', 'event-source', 'artifact-1', 'other', array['m'],
          array['e'], 'unknown', 'job-status')`),
    ).rejects.toThrow();
    await testDb().execute(sql`insert into artifact
      (id, type, title, body_blocks, attrs, knowledge_ids, intent_source, source, created_at, updated_at, version)
      values ('artifact-2', 'note_atomic', 'Test 2', '{"type":"doc","content":[]}'::jsonb,
        '{}'::jsonb, '[]'::jsonb, 'system', 'system', now(), now(), 1)`);
    await expect(insertEffect('effect-stable-duplicate', 'job-1', 'artifact-2')).rejects.toThrow();
  });

  it('ships the required constraints and partial indexes without a source cursor', async () => {
    const columns = await testDb().execute<{ column_name: string }>(sql`
      select column_name from information_schema.columns
      where table_name = 'event_subscription_checkpoint'
    `);
    expect(columns.map((row) => row.column_name)).not.toEqual(
      expect.arrayContaining(['source_high_water', 'last_event_id', 'last_dispatch_seq']),
    );

    const indexes = await testDb().execute<{ indexname: string }>(sql`
      select indexname from pg_indexes
      where tablename like 'event_subscription_%' or tablename = 'event'
    `);
    expect(indexes.map((row) => row.indexname)).toEqual(
      expect.arrayContaining([
        'event_action_dispatch_idx',
        'event_subscription_checkpoint_expired_lease_idx',
        'event_subscription_delivery_ready_idx',
        'event_subscription_delivery_expired_claim_idx',
        'event_subscription_delivery_dlq_idx',
        'event_subscription_delivery_history_idx',
        'event_subscription_delivery_discovery_idx',
        'event_subscription_effect_recent_enqueued_idx',
        'event_subscription_effect_provenance_idx',
        'event_subscription_effect_downstream_job_idx',
      ]),
    );
  });
});
