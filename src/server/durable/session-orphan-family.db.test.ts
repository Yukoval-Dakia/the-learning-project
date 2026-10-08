import { and, eq, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { learning_session, session_orphan_receipt, session_orphan_tick } from '@/db/schema';
import {
  effects,
  families,
  legacyTask,
  native,
  resetOrphans,
  startSession,
} from '../../../tests/dbos-session-orphan/support';
import { testDb } from '../../../tests/helpers/db';
import {
  inspectSessionOrphanAdmission,
  inspectSessionOrphanOutcome,
  runSessionOrphanTick,
  sessionOrphanKey,
} from './session-orphan-family';

beforeEach(() => resetOrphans());
afterEach(() => resetOrphans('pg-boss'));
for (const family of families)
  describe(family, () => {
    it('uses strict microsecond cutoff, preserves long data and excludes other types/terminal rows', async () => {
      await startSession(family, 'old');
      await startSession(family, 'equal', '2026-10-08 18:00:00.000000+00');
      await startSession(family, 'new', '2026-10-08 18:00:00.000001+00');
      await startSession(
        family,
        'terminal',
        '2026-10-08 12:00:00+00',
        family === families[0] ? 'ended' : 'completed',
      );
      await startSession(family === families[0] ? families[1] : families[0], 'other-type');
      const before = await testDb().select().from(learning_session).orderBy(learning_session.id);
      expect(await runSessionOrphanTick(testDb(), native(family))).toMatchObject({
        family,
        kind: 'complete',
        candidates: 1,
        abandoned: 1,
        skipped: 0,
        deferred: 0,
      });
      const after = await testDb().select().from(learning_session).orderBy(learning_session.id);
      for (const row of before) {
        const current = after.find((r) => r.id === row.id);
        expect(current).toBeDefined();
        if (row.id !== 'old') expect(current).toEqual(row);
        else
          expect(current).toMatchObject({
            version: 8,
            status: 'abandoned',
            summary_md: row.summary_md,
            source_asset_ids: row.source_asset_ids,
            warnings: row.warnings,
            started_at: row.started_at,
          });
      }
      expect(await effects(family, 'old')).toEqual([
        expect.objectContaining({
          payload: family === families[0] ? { from_status: 'active', reason: 'orphan_cron' } : {},
        }),
      ]);
    });
    it('freezes the whole sorted set and reuses committed receipts after phase and domain changes', async () => {
      for (const id of ['c', 'a', 'b']) await startSession(family, id);
      const request = native(family);
      await expect(
        runSessionOrphanTick(testDb(), request, async (event) => {
          if (event.kind === 'row-committed' && event.sessionId === 'a')
            throw new Error('checkpoint lost');
        }),
      ).rejects.toThrow('checkpoint lost');
      await startSession(family, 'later');
      await testDb().execute(sql`update learning_session set version = 100 where id = 'a'`);
      await testDb().execute(
        sql`update session_orphan_control set phase = 'draining-dbos' where family = ${family}`,
      );
      expect(await runSessionOrphanTick(testDb(), request)).toMatchObject({ abandoned: 3 });
      const [header] = await testDb()
        .select()
        .from(session_orphan_tick)
        .where(eq(session_orphan_tick.family, family));
      expect(header.candidates.map((r) => r.sessionId)).toEqual(['a', 'b', 'c']);
      expect(await effects(family, 'a')).toHaveLength(1);
      expect(await effects(family, 'later')).toHaveLength(0);
      expect(
        (await testDb().select().from(learning_session).where(eq(learning_session.id, 'a')))[0]
          .version,
      ).toBe(100);
      await testDb().execute(
        sql`update session_orphan_control set phase = 'pg-boss' where family = ${family}`,
      );
      expect(await runSessionOrphanTick(testDb(), request)).toMatchObject({ abandoned: 3 });
    });
    it('serializes duplicate executors and overlapping native ticks', async () => {
      await startSession(family, 'duplicate');
      const request = native(family);
      const result = await Promise.all([
        runSessionOrphanTick(testDb(), request),
        runSessionOrphanTick(testDb(), request),
      ]);
      expect(result[0]).toEqual(result[1]);
      expect(await effects(family, 'duplicate')).toHaveLength(1);
      await startSession(family, 'overlap');
      let selected = 0;
      let release: () => void = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const boundary = async (event: { kind: string }) => {
        if (event.kind === 'selection-committed') {
          if (++selected === 2) release();
          await held;
        }
      };
      const overlapping = await Promise.all([
        runSessionOrphanTick(testDb(), native(family, 1), boundary),
        runSessionOrphanTick(testDb(), native(family, 2), boundary),
      ]);
      expect(overlapping.map((r) => r.abandoned).sort()).toEqual([0, 1]);
      expect(overlapping.map((r) => r.skipped).sort()).toEqual([0, 1]);
      expect(await effects(family, 'overlap')).toHaveLength(1);
    });
    it('rolls back effect/event/notification when receipt fails, defers once and proceeds with the next row', async () => {
      await startSession(family, 'failure-a');
      await startSession(family, 'failure-b');
      const notifications: string[] = [];
      const listener = postgres(process.env.TEST_DATABASE_URL ?? '', { max: 1 });
      await listener.listen('job_status', (payload) => notifications.push(payload));
      await testDb().execute(
        sql`create function yuk1394_fail_receipt() returns trigger language plpgsql as $$ begin if new.session_id = 'failure-a' and new.outcome->>'kind' = 'abandoned' then raise exception 'receipt insertion failed after original effect'; end if; return new; end $$`,
      );
      await testDb().execute(
        sql`create trigger yuk1394_fail_receipt before insert on session_orphan_receipt for each row execute function yuk1394_fail_receipt()`,
      );
      try {
        expect(await runSessionOrphanTick(testDb(), native(family))).toMatchObject({
          kind: 'completed-with-deferred',
          deferred: 1,
          abandoned: 1,
        });
        expect(await effects(family, 'failure-a')).toHaveLength(0);
        const [failed] = await testDb()
          .select()
          .from(learning_session)
          .where(eq(learning_session.id, 'failure-a'));
        expect(failed).toMatchObject({
          status: family === families[0] ? 'active' : 'started',
          version: 7,
          ended_at: null,
        });
        await expect.poll(() => notifications.length).toBe(1);
        expect(JSON.parse(notifications[0]).business_id).toBe('failure-b');
        expect(await runSessionOrphanTick(testDb(), native(family))).toMatchObject({
          deferred: 1,
          abandoned: 1,
        });
      } finally {
        await testDb().execute(sql`drop trigger yuk1394_fail_receipt on session_orphan_receipt`);
        await testDb().execute(sql`drop function yuk1394_fail_receipt()`);
        await listener.end();
      }
      expect(await runSessionOrphanTick(testDb(), native(family, 1))).toMatchObject({
        abandoned: 1,
        deferred: 0,
      });
    });
    it('revalidates missing, wrong type, terminal and changed age under the domain lock', async () => {
      for (const id of ['missing', 'wrong-type', 'terminal', 'new-age'])
        await startSession(family, id);
      expect(
        await runSessionOrphanTick(testDb(), native(family), async (event) => {
          if (event.kind !== 'selection-committed') return;
          await testDb().delete(learning_session).where(eq(learning_session.id, 'missing'));
          await testDb().execute(
            sql`update learning_session set type = 'review' where id = 'wrong-type'`,
          );
          await testDb().execute(
            sql`update learning_session set status = ${family === families[0] ? 'ended' : 'completed'} where id = 'terminal'`,
          );
          await testDb().execute(
            sql`update learning_session set started_at = '2026-10-08T18:00:00Z' where id = 'new-age'`,
          );
        }),
      ).toMatchObject({ abandoned: 0, skipped: 4 });
      const receipts = await testDb()
        .select()
        .from(session_orphan_receipt)
        .orderBy(session_orphan_receipt.session_id);
      expect(receipts.map((r) => r.outcome)).toEqual([
        { kind: 'skipped', reason: 'missing' },
        { kind: 'skipped', reason: 'not-old' },
        { kind: 'skipped', reason: 'terminal' },
        { kind: 'skipped', reason: 'missing' },
      ]);
    });
    it('fails corrupt domain states as tasks without a deferred/success receipt', async () => {
      await startSession(family, 'corrupt');
      await expect(
        runSessionOrphanTick(testDb(), native(family), async (event) => {
          if (event.kind === 'selection-committed')
            await testDb().execute(
              sql`update learning_session set status = 'unrecognized' where id = 'corrupt'`,
            );
        }),
      ).rejects.toThrow('Corrupt');
      expect(await testDb().select().from(session_orphan_receipt)).toHaveLength(0);
    });
    it('fences unadmitted ticks during drain and never converts a fenced tick on redelivery', async () => {
      await startSession(family, 'drained');
      const admitted = native(family);
      await expect(
        runSessionOrphanTick(testDb(), admitted, async (e) => {
          if (e.kind === 'selection-committed') throw new Error('selected');
        }),
      ).rejects.toThrow('selected');
      await testDb().execute(
        sql`update session_orphan_control set phase = 'draining-dbos' where family = ${family}`,
      );
      expect(await runSessionOrphanTick(testDb(), admitted)).toMatchObject({ abandoned: 1 });
      const fenced = native(family, 1);
      expect(await runSessionOrphanTick(testDb(), fenced)).toMatchObject({
        kind: 'fenced',
        candidates: 0,
      });
      await testDb().execute(
        sql`update session_orphan_control set phase = 'dbos' where family = ${family}`,
      );
      expect(await runSessionOrphanTick(testDb(), fenced)).toMatchObject({ kind: 'fenced' });
    });
    it('preserves evidence after session deletion and refuses mutation or an outside candidate', async () => {
      await startSession(family, 'retained');
      const request = native(family);
      await runSessionOrphanTick(testDb(), request);
      const receipts = await testDb().select().from(session_orphan_receipt);
      const ticks = await testDb().select().from(session_orphan_tick);
      const immutableError = {
        cause: { code: 'P0001', message: 'session orphan execution evidence is immutable' },
      };
      await expect(testDb().delete(session_orphan_receipt)).rejects.toMatchObject(immutableError);
      expect(await testDb().select().from(session_orphan_receipt)).toEqual(receipts);
      await expect(
        testDb().update(session_orphan_tick).set({ candidates: [] }),
      ).rejects.toMatchObject(immutableError);
      expect(await testDb().select().from(session_orphan_tick)).toEqual(ticks);
      await testDb().delete(learning_session).where(eq(learning_session.id, 'retained'));
      const key = sessionOrphanKey(request);
      expect(
        await inspectSessionOrphanOutcome(testDb(), { ...key, sessionId: 'retained' }),
      ).toMatchObject({ kind: 'committed', outcome: { kind: 'abandoned' } });
      await expect(
        inspectSessionOrphanOutcome(testDb(), { ...key, sessionId: 'outside' }),
      ).rejects.toThrow('outside');
      expect(await inspectSessionOrphanAdmission(testDb(), request)).toMatchObject({
        kind: 'committed',
      });
    });
    it('corroborates real legacy ownership, saves first admission DB clock and reuses it after queue retention', async () => {
      await testDb().execute(sql`update session_orphan_control set phase = 'pg-boss'`);
      await startSession(family, 'legacy', '2000-01-01T00:00:00Z');
      const request = await legacyTask(family);
      const [before] = await testDb().execute(sql`select clock_timestamp() as at`);
      const result = await runSessionOrphanTick(testDb(), request);
      expect(result).toMatchObject({ abandoned: 1 });
      const [header] = await testDb()
        .select()
        .from(session_orphan_tick)
        .where(eq(session_orphan_tick.family, family));
      expect(header).toMatchObject({
        provenance: 'legacy-first-admission',
        tick_id: `legacy:${request.source.jobId}`,
      });
      expect(header.tick_at.getTime()).toBeGreaterThanOrEqual(
        new Date(String(before.at)).getTime() - 1,
      );
      const other = family === families[0] ? families[1] : families[0];
      await expect(runSessionOrphanTick(testDb(), { ...request, family: other })).rejects.toThrow(
        'another family',
      );
      await testDb().execute(sql`delete from pgboss.job where id = ${request.source.jobId}::uuid`);
      expect(await runSessionOrphanTick(testDb(), request)).toEqual(result);
      expect(
        await testDb()
          .select()
          .from(session_orphan_tick)
          .where(eq(session_orphan_tick.family, other)),
      ).toHaveLength(0);
    });
    it('drains admitted legacy lists and fences actual accepted but unadmitted jobs', async () => {
      await testDb().execute(sql`update session_orphan_control set phase = 'pg-boss'`);
      await startSession(family, 'legacy-drain', '2000-01-01T00:00:00Z');
      const admitted = await legacyTask(family),
        unadmitted = await legacyTask(family);
      await expect(
        runSessionOrphanTick(testDb(), admitted, async (e) => {
          if (e.kind === 'selection-committed') throw new Error('held');
        }),
      ).rejects.toThrow('held');
      await testDb().execute(
        sql`update session_orphan_control set phase = 'draining-pg-boss' where family = ${family}`,
      );
      expect(await runSessionOrphanTick(testDb(), unadmitted)).toMatchObject({ kind: 'fenced' });
      expect(await runSessionOrphanTick(testDb(), admitted)).toMatchObject({ abandoned: 1 });
    });
  });
it('one family drain does not block the other and composite receipt identity never crosses families', async () => {
  await startSession(families[0], 'conversation');
  await startSession(families[1], 'placement');
  await testDb().execute(
    sql`update session_orphan_control set phase = 'draining-dbos' where family = ${families[0]}`,
  );
  expect(await runSessionOrphanTick(testDb(), native(families[0]))).toMatchObject({
    kind: 'fenced',
  });
  expect(await runSessionOrphanTick(testDb(), native(families[1]))).toMatchObject({ abandoned: 1 });
  const key = sessionOrphanKey(native(families[1]));
  expect(
    await inspectSessionOrphanOutcome(testDb(), {
      family: families[0],
      tickId: key.tickId,
      sessionId: 'placement',
    }),
  ).toEqual({ kind: 'not-committed' });
  expect(
    await testDb()
      .select()
      .from(session_orphan_receipt)
      .where(
        and(
          eq(session_orphan_receipt.family, families[0]),
          eq(session_orphan_receipt.session_id, 'placement'),
        ),
      ),
  ).toHaveLength(0);
});

it('the same raw legacy UUID in storage cannot satisfy another family receipt or frozen membership', async () => {
  const id = 'legacy:00000000-0000-4000-8000-000000000003';
  for (const family of families) {
    await testDb().execute(sql`insert into session_orphan_tick (family,tick_id,backend,provenance,tick_at,cutoff,admission,candidates,contract_version)
      values (${family},${id},'pg-boss','legacy-first-admission','2026-10-09T00:00:00Z','2026-10-08T18:00:00Z','admitted','[{"sessionId":"same-id","selectedStartedAt":"2026-10-08T12:00:00Z","selectedVersion":4}]',1)`);
  }
  await testDb().execute(
    sql`insert into session_orphan_receipt (family,tick_id,session_id,outcome) values (${families[0]},${id},'same-id','{"kind":"skipped","reason":"missing"}')`,
  );
  expect(
    await inspectSessionOrphanOutcome(testDb(), {
      family: families[0],
      tickId: id,
      sessionId: 'same-id',
    }),
  ).toMatchObject({ kind: 'committed' });
  expect(
    await inspectSessionOrphanOutcome(testDb(), {
      family: families[1],
      tickId: id,
      sessionId: 'same-id',
    }),
  ).toEqual({ kind: 'not-committed' });
});
it('a primary lock wait establishes noncommit only after the original transaction actually rolls back', async () => {
  const { drizzle } = await import('drizzle-orm/postgres-js');
  const schema = await import('@/db/schema');
  const { lockSessionOrphanControl, lockSessionOrphanTick } = await import(
    './session-orphan-family'
  );
  const family = families[0];
  await startSession(family, 'held');
  const request = native(family),
    key = sessionOrphanKey(request);
  await expect(
    runSessionOrphanTick(testDb(), request, async (e) => {
      if (e.kind === 'selection-committed') throw new Error('selected');
    }),
  ).rejects.toThrow('selected');
  const primary = postgres(process.env.TEST_DATABASE_URL ?? '', { max: 1 });
  const lockedDb = drizzle(primary, { schema });
  let release: () => void = () => {},
    signal: () => void = () => {};
  const held = new Promise<void>((r) => {
    release = r;
  });
  const acquired = new Promise<void>((r) => {
    signal = r;
  });
  const owner = lockedDb
    .transaction(
      async (tx) => {
        await lockSessionOrphanControl(tx, family);
        await lockSessionOrphanTick(tx, key);
        signal();
        await held;
        throw new Error('original rolled back');
      },
      { isolationLevel: 'read committed' },
    )
    .catch((error: unknown) => {
      expect(String(error)).toContain('original rolled back');
    });
  await acquired;
  let settled = false;
  const inspection = inspectSessionOrphanOutcome(testDb(), { ...key, sessionId: 'held' }).then(
    (r) => {
      settled = true;
      return r;
    },
  );
  try {
    await expect
      .poll(
        async () =>
          (
            await testDb().execute(
              sql`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event = 'advisory'`,
            )
          )[0].n,
      )
      .toBeGreaterThan(0);
    expect(settled).toBe(false);
    release();
    await owner;
    expect(await inspection).toEqual({ kind: 'not-committed' });
  } finally {
    release();
    await owner;
    await primary.end();
  }
});
it('a cancelled primary lock wait remains unknown rather than proving absence', async () => {
  const { drizzle } = await import('drizzle-orm/postgres-js');
  const schema = await import('@/db/schema');
  const { lockSessionOrphanControl, lockSessionOrphanTick } = await import(
    './session-orphan-family'
  );
  const family = families[1];
  await startSession(family, 'held');
  const request = native(family),
    key = sessionOrphanKey(request);
  await expect(
    runSessionOrphanTick(testDb(), request, async (e) => {
      if (e.kind === 'selection-committed') throw new Error('selected');
    }),
  ).rejects.toThrow('selected');
  const primary = postgres(process.env.TEST_DATABASE_URL ?? '', {
    max: 1,
    connection: { lock_timeout: 500 },
  });
  const inspectingDb = drizzle(primary, { schema });
  let release: () => void = () => {},
    signal: () => void = () => {};
  const held = new Promise<void>((r) => {
      release = r;
    }),
    acquired = new Promise<void>((r) => {
      signal = r;
    });
  const owner = testDb().transaction(async (tx) => {
    await lockSessionOrphanControl(tx, family);
    await lockSessionOrphanTick(tx, key);
    signal();
    await held;
  });
  await acquired;
  try {
    expect(
      await inspectSessionOrphanOutcome(inspectingDb, { ...key, sessionId: 'held' }),
    ).toMatchObject({ kind: 'unknown' });
  } finally {
    release();
    await owner;
    await primary.end();
  }
});
