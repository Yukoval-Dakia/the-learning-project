import { randomUUID } from 'node:crypto';
import { type SQL, and, eq, sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { unzipSync, zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { capabilities } from '@/capabilities';
import { reserveAndEnqueueMasteryRefineEffect } from '@/capabilities/notes/server/mastery-refine-effect';
import type { Db, Tx } from '@/db/client';
import {
  artifact,
  event_subscription_checkpoint as checkpoint,
  event_subscription_delivery as delivery,
  event_subscription_effect as effect,
  event,
  knowledge,
} from '@/db/schema';
import { loadEventSubscriptionRegistry } from '@/server/event-subscriptions/registry';
import {
  bootstrapSubscription,
  claimNextSubscriptionDelivery,
  claimSubscriptionLease,
  completeSubscriptionDelivery,
  discoverSubscriptionDeliveries,
  renewSubscriptionLease,
} from '@/server/event-subscriptions/runtime';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { createMem0Collection, seedMem0Row } from '../../../tests/helpers/mem0-collection';
import { memR2 } from '../../../tests/helpers/r2';
import { buildBackupArchive, restoreFromArchive } from './archive';

const TABLES = [
  'event_subscription_checkpoint',
  'event_subscription_delivery',
  'event_subscription_effect',
] as const;
const statuses = [
  'succeeded',
  'skipped',
  'bootstrap_skipped',
  'dead_letter',
  'claimed',
  'retry_wait',
  'pending',
] as const;
const collection = 'test_subscription_snapshot_memory';
const now = new Date('2026-10-04T12:00:00Z');
const future = new Date('2099-01-01T00:00:00Z');

async function archive(db = testDb()) {
  const result = await buildBackupArchive({ db, r2: memR2() });
  return new Uint8Array(await new Response(result.stream).arrayBuffer());
}
function decode(bytes: Uint8Array): Record<string, Record<string, unknown>[]> {
  return JSON.parse(new TextDecoder().decode(unzipSync(bytes)['data.json']));
}
function rewrite(bytes: Uint8Array, mutate: (data: ReturnType<typeof decode>) => void) {
  const entries = unzipSync(bytes);
  const data = decode(bytes);
  mutate(data);
  entries['data.json'] = new TextEncoder().encode(JSON.stringify(data));
  return zipSync(entries);
}
async function source(id: string, action: string) {
  const [row] = await testDb()
    .insert(event)
    .values({
      id,
      action,
      actor_kind: 'system',
      actor_ref: 'backup-fixture',
      subject_kind: 'event',
      subject_id: id,
      payload: {
        context: '恢复后须保留的长文本与嵌套来源',
        evidence: { ids: ['a', 'b'], version: 1 },
      },
    })
    .returning();
  return row;
}

async function seedProgress() {
  const db = testDb();
  // Real manifest identities/hashes/actions; transport callbacks are local spies, not model calls.
  const handler = vi.fn(async () => ({ status: 'succeeded' as const }));
  const registry = await loadEventSubscriptionRegistry(
    capabilities.map((c) => ({
      ...c,
      ...(c.subscriptions
        ? {
            subscriptions: {
              ...c.subscriptions,
              handlers: c.subscriptions.handlers.map((s) => ({
                ...s,
                load: async () => () => handler,
              })),
            },
          }
        : {}),
    })),
    db,
  );
  expect(registry.subscriptions).toHaveLength(4);
  const leases = [];
  for (const sub of registry.subscriptions) {
    await bootstrapSubscription(db, registry, sub);
    const lease = await claimSubscriptionLease(db, registry, sub, 'pre-restore-worker');
    if (!lease) throw new Error('fixture lease missing');
    leases.push(lease);
    for (const [index, status] of statuses.entries()) {
      const row = await source(`${sub.id}:${status}`, sub.actions[0]);
      const terminal = index < 4;
      await db.insert(delivery).values({
        subscriber_id: sub.id,
        subscriber_version: sub.version,
        source_event_id: row.id,
        source_dispatch_seq: row.dispatch_seq,
        delivery_seq: index + 1,
        status,
        attempt_count: 2,
        redrive_count: 1,
        last_error: 'retained retry history',
        outcome: terminal ? { status, nested: { proof: [1, 2] } } : null,
        next_attempt_at: status === 'retry_wait' ? future : null,
        claim_owner: status === 'claimed' ? lease.claimOwner : null,
        claim_token: status === 'claimed' ? randomUUID() : null,
        claim_lease_until: status === 'claimed' ? future : null,
        claimed_at: status === 'claimed' ? now : null,
        completed_at: terminal ? now : null,
      });
    }
    await db
      .update(checkpoint)
      .set({ next_delivery_seq: 8 })
      .where(
        and(eq(checkpoint.subscriber_id, sub.id), eq(checkpoint.subscriber_version, sub.version)),
      );
    await source(`${sub.id}:undiscovered`, sub.actions[0]);
  }
  const notes = registry.subscriptions.find((s) => s.id.startsWith('notes.'));
  if (!notes) throw new Error('notes subscriber missing');
  const attempt = await source('effect-attempt', 'attempt');
  for (const status of ['enqueued', 'debounced', 'disabled', 'reserved'] as const) {
    const artifactId = `backup-note-${status}`;
    await db.insert(artifact).values({
      id: artifactId,
      type: 'note_atomic',
      title: `恢复笔记 ${status}`,
      knowledge_ids: ['kc-backup'],
      generation_status: 'ready',
      intent_source: 'test',
      source: 'test',
      verification_status: 'not_required',
      created_at: now,
      updated_at: now,
    });
    await db.insert(effect).values({
      id: `effect-${status}`,
      attempt_event_id: attempt.id,
      artifact_id: artifactId,
      effect_kind: 'mastery_change',
      subscriber_id: notes.id,
      subscriber_version: notes.version,
      source_event_id: `${notes.id}:succeeded`,
      mastery_event_ids: [`${notes.id}:succeeded`, 'additional-mastery-evidence'],
      evidence_ids: [attempt.id, `${notes.id}:succeeded`],
      question_id: 'original-question',
      status,
      stable_job_key: `job-key-${status}`,
      downstream_job_id: status === 'enqueued' ? 'archived-downstream-job' : null,
      enqueued_at: status === 'enqueued' ? now : null,
      completed_at: status === 'debounced' || status === 'disabled' ? now : null,
      outcome: status === 'disabled' ? { reason: 'disabled at source time' } : null,
    });
  }
  return { registry, leases, handler, notes };
}

describe('YUK-766 subscription progress backup', () => {
  beforeEach(resetDb);
  afterEach(async () => {
    vi.unstubAllEnvs();
    await testDb().execute(sql`DROP TABLE IF EXISTS test_subscription_snapshot_memory`);
  });

  it('archives all four live subscriber identities, seven delivery states and effect provenance', async () => {
    await seedProgress();
    const data = decode(await archive());
    expect(data.event_subscription_checkpoint).toHaveLength(4);
    expect(data.event_subscription_delivery).toHaveLength(28);
    expect(data.event_subscription_effect).toHaveLength(4);
    expect(data.event_subscription_effect.find((r) => r.status === 'enqueued')).toMatchObject({
      downstream_job_id: 'archived-downstream-job',
      completed_at: null,
      mastery_event_ids: [
        'notes.mastery-progress-note-refine:succeeded',
        'additional-mastery-evidence',
      ],
    });
  });

  it('restores progress, fences old leases and preserves terminal/effect idempotency', async () => {
    const db = testDb();
    const { registry, leases, notes } = await seedProgress();
    const effectsBefore = await db.select().from(effect).orderBy(effect.id);
    const [oldDelivery] = await db
      .select()
      .from(delivery)
      .where(
        and(eq(delivery.subscriber_id, leases[0].subscriberId), eq(delivery.status, 'claimed')),
      );
    if (!oldDelivery.claim_token) throw new Error('fixture delivery claim missing');
    const oldClaim = {
      ...leases[0],
      sourceEventId: oldDelivery.source_event_id,
      deliverySeq: BigInt(oldDelivery.delivery_seq),
      claimToken: oldDelivery.claim_token,
      checkpointClaimOwner: leases[0].claimOwner,
      checkpointClaimToken: leases[0].claimToken,
    };
    const result = await restoreFromArchive({ db, r2: memR2(), bytes: await archive() });
    expect(result).toMatchObject({ status: 200 });
    const checkpoints = await db.select().from(checkpoint);
    expect(checkpoints).toHaveLength(4);
    for (const row of checkpoints) {
      expect(row).toMatchObject({
        claim_owner: null,
        claim_token: null,
        claim_lease_until: null,
        next_delivery_seq: 8,
      });
    }
    for (const lease of leases) expect(await renewSubscriptionLease(db, lease)).toBe(false);
    expect(await completeSubscriptionDelivery(db, oldClaim, { status: 'succeeded' })).toBe(false);
    expect(await db.select().from(effect).orderBy(effect.id)).toEqual(effectsBefore);
    const send = vi.fn(async () => 'must-not-enqueue');
    const replay = await db.transaction((tx) =>
      reserveAndEnqueueMasteryRefineEffect({
        tx,
        bossSend: send,
        attemptEventId: 'effect-attempt',
        artifactId: 'backup-note-enqueued',
        masteryEventIds: [`${notes.id}:succeeded`],
        subscriberId: notes.id,
        subscriberVersion: notes.version,
        sourceEventId: `${notes.id}:succeeded`,
      }),
    );
    expect(replay.status).toBe('already_processed');
    expect(send).not.toHaveBeenCalled();

    for (const sub of registry.subscriptions) {
      await bootstrapSubscription(db, registry, sub);
      const lease = await claimSubscriptionLease(db, registry, sub, 'post-restore-worker');
      if (!lease) throw new Error('restored checkpoint unavailable');
      const rows = await db
        .select()
        .from(delivery)
        .where(eq(delivery.subscriber_id, sub.id))
        .orderBy(delivery.delivery_seq);
      expect(rows.map((r) => r.status)).toEqual([
        'succeeded',
        'skipped',
        'bootstrap_skipped',
        'dead_letter',
        'pending',
        'retry_wait',
        'pending',
      ]);
      expect(rows[4]).toMatchObject({
        claim_owner: null,
        claim_token: null,
        claim_lease_until: null,
        claimed_at: null,
        attempt_count: 2,
        redrive_count: 1,
        last_error: 'retained retry history',
      });
      expect(rows[5].next_attempt_at).toEqual(future);
      const first = await claimNextSubscriptionDelivery(db, registry, sub, lease);
      expect(first?.sourceEventId).toBe(`${sub.id}:claimed`);
      if (!first) throw new Error('restored claim missing');
      expect(await completeSubscriptionDelivery(db, first, { status: 'succeeded' })).toBe(true);
      expect(await claimNextSubscriptionDelivery(db, registry, sub, lease)).toBeNull();
      await db
        .update(delivery)
        .set({ next_attempt_at: now })
        .where(and(eq(delivery.subscriber_id, sub.id), eq(delivery.status, 'retry_wait')));
      for (const status of ['retry_wait', 'pending']) {
        const claim = await claimNextSubscriptionDelivery(db, registry, sub, lease);
        expect(claim?.sourceEventId).toBe(`${sub.id}:${status}`);
        if (!claim) throw new Error('restored delivery missing');
        await completeSubscriptionDelivery(db, claim, { status: 'succeeded' });
      }
      await discoverSubscriptionDeliveries(db, registry, sub, lease);
      const unseen = await claimNextSubscriptionDelivery(db, registry, sub, lease);
      expect(unseen?.sourceEventId).toBe(`${sub.id}:undiscovered`);
    }
  });

  it('keeps a paused checkpoint paused and its declaration hash unchanged', async () => {
    const db = testDb();
    const { registry } = await seedProgress();
    const sub = registry.subscriptions[0];
    await db
      .update(checkpoint)
      .set({ status: 'paused', paused_at: now })
      .where(eq(checkpoint.subscriber_id, sub.id));
    expect((await restoreFromArchive({ db, r2: memR2(), bytes: await archive() })).status).toBe(
      200,
    );
    const [row] = await db.select().from(checkpoint).where(eq(checkpoint.subscriber_id, sub.id));
    expect(row).toMatchObject({
      status: 'paused',
      paused_at: now,
      declaration_hash: sub.declarationHash,
    });
    await expect(claimSubscriptionLease(db, registry, sub, 'new-owner')).rejects.toThrow('paused');
  });

  it.each(TABLES)('rejects a missing %s before wiping the database', async (table) => {
    const bytes = rewrite(await archive(), (data) => {
      delete data[table];
    });
    await source('live-canary', 'test:canary');
    const result = await restoreFromArchive({ db: testDb(), r2: memR2(), bytes });
    expect(result.status).toBe(400);
    expect(await testDb().select().from(event).where(eq(event.id, 'live-canary'))).toHaveLength(1);
  });

  it('rolls back progress and business rows together when restored delivery violates its event FK', async () => {
    const db = testDb();
    await seedProgress();
    const bytes = rewrite(await archive(), (data) => {
      const rows = data.event_subscription_delivery;
      expect(rows).toHaveLength(28);
      rows[0].source_dispatch_seq = -1;
    });
    await source('rollback-canary', 'test:canary');
    const before = await db
      .select()
      .from(delivery)
      .orderBy(delivery.subscriber_id, delivery.delivery_seq);
    const result = await restoreFromArchive({ db, r2: memR2(), bytes });
    expect(result.status).toBe(500);
    expect(
      await db.select().from(delivery).orderBy(delivery.subscriber_id, delivery.delivery_seq),
    ).toEqual(before);
    expect(await db.select().from(event).where(eq(event.id, 'rollback-canary'))).toHaveLength(1);
  });

  it('captures business tables and mem0 in one snapshot despite a committed concurrent writer', async () => {
    const db = testDb();
    vi.stubEnv('MEM0_PGVECTOR_COLLECTION', collection);
    await createMem0Collection(db, collection, 3);
    await seedMem0Row(
      db,
      collection,
      '7e013ff0-0906-4c87-a98c-5deea7f44c11',
      { version: 'before' },
      [0.1, 0.2, 0.3],
    );
    await db.insert(knowledge).values({
      id: 'snapshot-kc',
      name: 'before',
      domain: 'yuwen',
      created_at: now,
      updated_at: now,
    });
    await source('snapshot-event', 'test:snapshot');
    await db
      .update(event)
      .set({ payload: { version: 'before' } })
      .where(eq(event.id, 'snapshot-event'));
    const dialect = new PgDialect();
    let interleaved = false;
    function observe<T extends Db | Tx>(handle: T): T {
      return new Proxy(handle, {
        get(target, property) {
          if (property === 'transaction')
            return (fn: (tx: Tx) => Promise<unknown>, config?: Parameters<Db['transaction']>[1]) =>
              target.transaction((tx) => fn(observe(tx)), config);
          if (property === 'execute')
            return async (query: SQL) => {
              const rows = await target.execute(query);
              if (!interleaved && dialect.sqlToQuery(query).sql === 'select * from "knowledge"') {
                interleaved = true;
                await db.transaction(async (tx) => {
                  await tx
                    .update(knowledge)
                    .set({ name: 'after' })
                    .where(eq(knowledge.id, 'snapshot-kc'));
                  await tx
                    .update(event)
                    .set({ payload: { version: 'after' } })
                    .where(eq(event.id, 'snapshot-event'));
                  await tx.execute(
                    sql`UPDATE test_subscription_snapshot_memory SET payload = '{"version":"after"}'::jsonb`,
                  );
                });
              }
              return rows;
            };
          const value = Reflect.get(target, property);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    }
    const data = decode(await archive(observe(db)));
    expect(interleaved).toBe(true);
    expect(data.knowledge.find((r) => r.id === 'snapshot-kc')?.name).toBe('before');
    expect(data.event.find((r) => r.id === 'snapshot-event')?.payload).toEqual({
      version: 'before',
    });
    expect(data[collection][0].payload).toEqual({ version: 'before' });
    const [live] = await db.select().from(knowledge).where(eq(knowledge.id, 'snapshot-kc'));
    expect(live.name).toBe('after');
  });
});
