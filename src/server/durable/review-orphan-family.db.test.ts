import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { PgBoss } from 'pg-boss';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  contract_epoch,
  job_events,
  learning_session,
  review_orphan_receipt,
  review_orphan_tick,
} from '@/db/schema';
import { Review } from '@/server/session';
import { resetDb, testDb } from '../../../tests/helpers/db';
import {
  REVIEW_ORPHAN_FAMILY,
  attestReviewOrphanQuiescence,
  changeReviewOrphanPhase,
  inspectReviewOrphanOutcome,
  installReviewOrphanProducerFence,
  retireFailedReviewOrphan,
  reviewOrphanObligations,
  runReviewOrphanTick,
} from './review-orphan-family';

const at = new Date('2026-10-09T00:00:00Z');
const native = (id = randomUUID()) => ({ kind: 'dbos', workflowId: id, scheduledAt: at }) as const;
async function start(id?: string, timestamp = '2026-10-08 17:59:59.999999+00') {
  const { sessionId } = await Review.startReviewSession(testDb());
  await testDb().execute(
    sql`update learning_session set id = ${id ?? sessionId}, started_at = ${timestamp}::timestamptz where id = ${sessionId}`,
  );
  return id ?? sessionId;
}
async function effects(id: string) {
  return testDb()
    .select()
    .from(job_events)
    .where(and(eq(job_events.business_id, id), eq(job_events.event_type, 'review.abandoned')));
}
async function resetFamily() {
  await testDb().execute(
    sql`truncate review_orphan_disposition, review_orphan_receipt, review_orphan_tick`,
  );
  await testDb().execute(
    sql`update review_orphan_control set phase = 'pg-boss', legacy_not_before = null, phase_changed_at = clock_timestamp()`,
  );
}
beforeEach(async () => {
  await resetDb();
  await resetFamily();
  await testDb().execute(sql`update review_orphan_control set phase = 'dbos'`);
});
afterEach(resetFamily);

describe('immutable review orphan ticks and row receipts', () => {
  it('freezes sorted complete candidates and excludes later insertions/backdating on partial replay', async () => {
    await start('orphan-a');
    await start('orphan-b');
    await start('orphan-c');
    const input = native();
    await expect(
      runReviewOrphanTick(testDb(), input, async (event) => {
        if (event.kind === 'row-committed' && event.sessionId === 'orphan-a')
          throw new Error('checkpoint lost');
      }),
    ).rejects.toThrow('checkpoint lost');
    await Review.reopenAbandonedReviewSession(testDb(), 'orphan-a');
    await start('orphan-d');
    const result = await runReviewOrphanTick(testDb(), input);
    expect(result).toMatchObject({ kind: 'complete', candidates: 3, abandoned: 3 });
    const [header] = await testDb().select().from(review_orphan_tick);
    expect(header.candidates.map((r) => r.sessionId)).toEqual(['orphan-a', 'orphan-b', 'orphan-c']);
    const [reopened] = await testDb()
      .select()
      .from(learning_session)
      .where(eq(learning_session.id, 'orphan-a'));
    expect(reopened).toMatchObject({ status: 'started', version: 2 });
    expect(await effects('orphan-a')).toHaveLength(1);
    expect(await effects('orphan-d')).toHaveLength(0);
    expect(await testDb().select().from(review_orphan_receipt)).toHaveLength(3);
    await expect(
      runReviewOrphanTick(testDb(), { ...input, scheduledAt: new Date(at.getTime() + 1) }),
    ).rejects.toThrow('timestamp conflict');
  });
  it('serializes duplicate executors and overlapping ticks without duplicate transition effects', async () => {
    const id = await start();
    const input = native();
    const duplicates = await Promise.all([
      runReviewOrphanTick(testDb(), input),
      runReviewOrphanTick(testDb(), input),
    ]);
    expect(duplicates[0]).toEqual(duplicates[1]);
    expect(await effects(id)).toHaveLength(1);
    const second = await start();
    let selected = 0;
    let release: () => void = () => {};
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const boundary = async (event: { kind: string }) => {
      if (event.kind === 'selection-committed') {
        if (++selected === 2) release();
        await barrier;
      }
    };
    const results = await Promise.all([
      runReviewOrphanTick(testDb(), native(), boundary),
      runReviewOrphanTick(testDb(), native(), boundary),
    ]);
    expect(results.map((r) => r.abandoned).sort()).toEqual([0, 1]);
    expect(results.map((r) => r.skipped).sort()).toEqual([0, 1]);
    expect(await effects(second)).toHaveLength(1);
  });
  it('records rollback as a deferred row, continues B, and preserves the next daily backstop', async () => {
    await start('failure-a');
    await start('failure-b');
    await testDb().execute(
      sql`create function yuk1393_fail_receipt() returns trigger language plpgsql as $$ begin if new.session_id = 'failure-a' and new.outcome->>'kind' = 'abandoned' then raise exception 'row receipt failed after transition and event'; end if; return new; end $$`,
    );
    await testDb().execute(
      sql`create trigger yuk1393_fail_receipt before insert on review_orphan_receipt for each row execute function yuk1393_fail_receipt()`,
    );
    try {
      const result = await runReviewOrphanTick(testDb(), native());
      expect(result).toMatchObject({ kind: 'completed-with-deferred', abandoned: 1, deferred: 1 });
      const [a] = await testDb()
        .select()
        .from(learning_session)
        .where(eq(learning_session.id, 'failure-a'));
      expect(a).toMatchObject({ status: 'started', version: 0 });
      expect(await effects('failure-a')).toHaveLength(0);
    } finally {
      await testDb().execute(sql`drop trigger yuk1393_fail_receipt on review_orphan_receipt`);
      await testDb().execute(sql`drop function yuk1393_fail_receipt()`);
    }
    const next = await runReviewOrphanTick(testDb(), {
      ...native(),
      scheduledAt: new Date(at.getTime() + 86400000),
    });
    expect(next.abandoned).toBe(1);
    expect(await effects('failure-a')).toHaveLength(1);
  });
  it('finishes admitted rows during drain and fences new and late native admissions explicitly', async () => {
    const id = await start();
    const input = native();
    await expect(
      runReviewOrphanTick(testDb(), input, async (e) => {
        if (e.kind === 'selection-committed') throw new Error('selected');
      }),
    ).rejects.toThrow('selected');
    await testDb().execute(sql`update review_orphan_control set phase = 'draining-dbos'`);
    expect(await runReviewOrphanTick(testDb(), input)).toMatchObject({
      kind: 'complete',
      abandoned: 1,
    });
    expect(await runReviewOrphanTick(testDb(), native())).toMatchObject({
      kind: 'fenced',
      candidates: 0,
    });
    expect(await effects(id)).toHaveLength(1);
    const fenced = native();
    await testDb().execute(sql`update review_orphan_control set phase = 'pg-boss'`);
    expect(await runReviewOrphanTick(testDb(), fenced)).toMatchObject({ kind: 'fenced' });
    await testDb().execute(sql`update review_orphan_control set phase = 'dbos'`);
    expect(await runReviewOrphanTick(testDb(), fenced)).toMatchObject({ kind: 'fenced' });
  });
  it('persists actual legacy identity and first-admission time without inventing a cron timestamp', async () => {
    await testDb().execute(sql`update review_orphan_control set phase = 'pg-boss'`);
    const id = await start();
    await testDb().execute(
      sql`update learning_session set started_at = clock_timestamp() - interval '7 hours' where id = ${id}`,
    );
    const jobId = randomUUID();
    const first = await runReviewOrphanTick(testDb(), { kind: 'pg-boss', jobId });
    expect(first.abandoned).toBe(1);
    await Review.reopenAbandonedReviewSession(testDb(), id);
    expect(await runReviewOrphanTick(testDb(), { kind: 'pg-boss', jobId })).toEqual(first);
    const [header] = await testDb().select().from(review_orphan_tick);
    expect(header).toMatchObject({
      tick_id: `legacy:${jobId}`,
      provenance: 'legacy-first-admission',
    });
    expect(
      await inspectReviewOrphanOutcome(testDb(), { tickId: header.tick_id, sessionId: id }),
    ).toMatchObject({ kind: 'committed', outcome: { kind: 'abandoned' } });
    expect(
      await inspectReviewOrphanOutcome(testDb(), { tickId: header.tick_id, sessionId: 'absent' }),
    ).toEqual({ kind: 'not-committed' });
  });
  it('finishes admitted legacy rows but fences unadmitted deliveries throughout drain and later redelivery', async () => {
    await testDb().execute(sql`update review_orphan_control set phase = 'pg-boss'`);
    const id = await start();
    await testDb().execute(
      sql`update learning_session set started_at = clock_timestamp() - interval '7 hours' where id = ${id}`,
    );
    const admitted = { kind: 'pg-boss', jobId: randomUUID() } as const;
    await expect(
      runReviewOrphanTick(testDb(), admitted, async (event) => {
        if (event.kind === 'selection-committed') throw new Error('selected');
      }),
    ).rejects.toThrow('selected');
    await testDb().execute(sql`update review_orphan_control set phase = 'draining-pg-boss'`);
    expect(await runReviewOrphanTick(testDb(), admitted)).toMatchObject({
      kind: 'complete',
      abandoned: 1,
    });
    const next = await start();
    await testDb().execute(
      sql`update learning_session set started_at = clock_timestamp() - interval '7 hours' where id = ${next}`,
    );
    const unadmitted = { kind: 'pg-boss', jobId: randomUUID() } as const;
    expect(await runReviewOrphanTick(testDb(), unadmitted)).toMatchObject({
      kind: 'fenced',
      candidates: 0,
    });
    await testDb().execute(sql`update review_orphan_control set phase = 'dbos'`);
    const late = { kind: 'pg-boss', jobId: randomUUID() } as const;
    expect(await runReviewOrphanTick(testDb(), late)).toMatchObject({ kind: 'fenced' });
    await testDb().execute(sql`update review_orphan_control set phase = 'pg-boss'`);
    expect(await runReviewOrphanTick(testDb(), unadmitted)).toMatchObject({ kind: 'fenced' });
    expect(await runReviewOrphanTick(testDb(), late)).toMatchObject({ kind: 'fenced' });
    expect(await effects(next)).toHaveLength(0);
    expect(
      await runReviewOrphanTick(testDb(), { kind: 'pg-boss', jobId: randomUUID() }),
    ).toMatchObject({
      kind: 'complete',
      abandoned: 1,
    });
    expect(await effects(id)).toHaveLength(1);
    expect(await effects(next)).toHaveLength(1);
  });
  it('preserves legacy drain at an older active epoch and fences maintenance between rows', async () => {
    await testDb().execute(sql`update review_orphan_control set phase = 'pg-boss'`);
    await testDb()
      .insert(contract_epoch)
      .values({ seq: 0, epoch: 'legacy', state: 'active', entered_by: 'test' });
    await start('epoch-a');
    await start('epoch-b');
    for (const id of ['epoch-a', 'epoch-b'])
      await testDb().execute(
        sql`update learning_session set started_at = clock_timestamp() - interval '7 hours' where id = ${id}`,
      );
    const jobId = randomUUID();
    await expect(
      runReviewOrphanTick(testDb(), { kind: 'pg-boss', jobId }, async (event) => {
        if (event.kind === 'row-committed' && event.sessionId === 'epoch-a')
          await testDb().update(contract_epoch).set({ state: 'preparing' });
      }),
    ).rejects.toThrow(/epoch/i);
    expect(await effects('epoch-a')).toHaveLength(1);
    expect(await effects('epoch-b')).toHaveLength(0);
    await testDb().update(contract_epoch).set({ state: 'active' });
    expect(await runReviewOrphanTick(testDb(), { kind: 'pg-boss', jobId })).toMatchObject({
      abandoned: 2,
    });
  });

  it('rejects mutation/deletion of execution evidence without cascading session deletion', async () => {
    const id = await start();
    const input = native();
    await runReviewOrphanTick(testDb(), input);
    await expect(testDb().delete(review_orphan_receipt)).rejects.toThrow();
    await expect(testDb().update(review_orphan_tick).set({ candidates: [] })).rejects.toThrow();
    await testDb().delete(learning_session).where(eq(learning_session.id, id));
    expect(
      await inspectReviewOrphanOutcome(testDb(), { tickId: input.workflowId, sessionId: id }),
    ).toMatchObject({ kind: 'committed' });
  });
});

describe('family phase and producer fences', () => {
  let boss: PgBoss;
  const schedules = { getSchedule: async () => null, pauseSchedule: async () => {} };
  beforeAll(async () => {
    const url = new URL(z.url().parse(process.env.TEST_DATABASE_URL));
    if (
      !/^\/test_fork_\d+$/.test(url.pathname) ||
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    )
      throw new Error('Disposable fork DB required');
    boss = new PgBoss({
      connectionString: url.toString(),
      max: 2,
      supervise: false,
      schedule: false,
    });
    boss.on('error', () => {});
    await boss.start();
    await boss.createQueue(REVIEW_ORPHAN_FAMILY);
    await installReviewOrphanProducerFence(testDb());
  });
  afterEach(async () => {
    await testDb().execute(
      sql`delete from pgboss.job where name in ('prune_orphan_review_sessions','prune_orphan_review_sessions_dlq','__pgboss__send-it')`,
    );
  });
  afterAll(async () => {
    await boss.stop();
  });
  it('keeps accepted tasks drainable but fences new producers and requires quiescence proof', async () => {
    await testDb().execute(sql`update review_orphan_control set phase = 'pg-boss'`);
    const jobId = await boss.send(REVIEW_ORPHAN_FAMILY, {});
    expect(jobId).toBeTruthy();
    await changeReviewOrphanPhase(testDb(), boss, 'draining-pg-boss', schedules);
    await expect(boss.send(REVIEW_ORPHAN_FAMILY, {})).rejects.toThrow('producer fenced');
    await expect(changeReviewOrphanPhase(testDb(), boss, 'dbos', schedules)).rejects.toThrow(
      'drain blocked',
    );
    await testDb().execute(sql`update pgboss.job set state = 'failed' where id::text = ${jobId}`);
    await retireFailedReviewOrphan(testDb(), {
      backend: 'pg-boss',
      taskId: z.string().parse(jobId),
      reason: 'Synthetic task never executed; observed terminal state',
    });
    await expect(changeReviewOrphanPhase(testDb(), boss, 'dbos', schedules)).rejects.toThrow(
      'quiescence',
    );
    await attestReviewOrphanQuiescence(
      testDb(),
      'No old consumers; synthetic terminal task and no in-flight forwarders',
    );
    await changeReviewOrphanPhase(testDb(), boss, 'dbos', schedules);
    await expect(boss.schedule(REVIEW_ORPHAN_FAMILY, '15 4 * * *')).rejects.toThrow(
      'producer fenced',
    );
  });
  it('does not dispose active tasks, unknown SEND_IT payloads, or unexpected DLQ rows', async () => {
    await testDb().execute(sql`update review_orphan_control set phase = 'pg-boss'`);
    const live = await boss.send(REVIEW_ORPHAN_FAMILY, {});
    await expect(
      retireFailedReviewOrphan(testDb(), {
        backend: 'pg-boss',
        taskId: z.string().parse(live),
        reason: 'Cannot retire live',
      }),
    ).rejects.toThrow('terminal');
    await boss.createQueue('__pgboss__send-it');
    await boss.send('__pgboss__send-it', {});
    const malformedName = await boss.send('__pgboss__send-it', { name: 7 });
    const forwarders = (await reviewOrphanObligations(testDb(), 'pg-boss')).filter(
      (r) => r.kind === 'forwarder',
    );
    expect(forwarders).toHaveLength(2);
    expect(forwarders.some((r) => r.task_id === malformedName)).toBe(true);
    await boss.createQueue('prune_orphan_review_sessions_dlq');
    const dlq = await boss.send('prune_orphan_review_sessions_dlq', {});
    await testDb().execute(sql`update pgboss.job set state = 'failed' where id::text = ${dlq}`);
    await expect(
      retireFailedReviewOrphan(testDb(), {
        backend: 'pg-boss',
        taskId: z.string().parse(dlq),
        reason: 'Unknown DLQ remains held',
      }),
    ).rejects.toThrow('DLQ');
  });
});
