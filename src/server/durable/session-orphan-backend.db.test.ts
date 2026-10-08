import { sql } from 'drizzle-orm';
import { PgBoss } from 'pg-boss';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  families,
  native,
  resetOrphans,
  startSession,
} from '../../../tests/dbos-session-orphan/support';
import { testDb } from '../../../tests/helpers/db';
import {
  attestSessionOrphanQuiescence,
  changeSessionOrphanPhase,
  installSessionOrphanProducerFence,
  retireFailedSessionOrphan,
  sessionOrphanObligations,
} from './session-orphan-backend';
import { runSessionOrphanTick } from './session-orphan-family';

let boss: PgBoss;
const schedules = { getSchedule: async () => null, pauseSchedule: async () => {} };
function disposableForkUrl() {
  const url = new URL(z.url().parse(process.env.TEST_DATABASE_URL));
  if (
    !/^\/test_fork_\d+$/.test(url.pathname) ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  )
    throw new Error('Disposable fork required');
  return url;
}
beforeAll(async () => {
  const url = disposableForkUrl();
  boss = new PgBoss({
    connectionString: url.toString(),
    max: 2,
    schedule: false,
    supervise: false,
  });
  boss.on('error', () => {});
  await boss.start();
  for (const family of families) {
    await boss.createQueue(family);
    await boss.createQueue(`${family}_dlq`);
  }
  await boss.createQueue('__pgboss__send-it');
  await installSessionOrphanProducerFence(testDb());
});
async function resetBackendFixture() {
  const url = disposableForkUrl();
  const [database] = await testDb().execute(sql`select current_database() as name`);
  if (database?.name !== url.pathname.slice(1)) throw new Error('Disposable fork target mismatch');
  await testDb().execute(
    sql`delete from pgboss.job where name in (${families[0]},${families[1]},${`${families[0]}_dlq`},${`${families[1]}_dlq`},'__pgboss__send-it')`,
  );
  await testDb().execute(
    sql`delete from pgboss.schedule where name in (${families[0]},${families[1]})`,
  );
  await resetOrphans('pg-boss');
}
beforeEach(resetBackendFixture);
afterEach(resetBackendFixture);
afterAll(async () => {
  await boss.stop();
});
for (const family of families)
  describe(`independent ownership ${family}`, () => {
    const change = (target: 'pg-boss' | 'draining-pg-boss' | 'dbos' | 'draining-dbos') =>
      changeSessionOrphanPhase(testDb(), boss, { family, target }, schedules);
    const quiesce = () =>
      attestSessionOrphanQuiescence(testDb(), {
        family,
        reason:
          'Disposable fixture has no consumer; task executor and forwarder owners observed absent',
      });
    it('fences job/schedule production, preserves accepted state updates and requires barrier proof', async () => {
      const taskId = z.uuid().parse(await boss.send(family, {}));
      const other = family === families[0] ? families[1] : families[0];
      const before = await testDb().execute(
        sql`select * from session_orphan_control where family = ${other}`,
      );
      await change('draining-pg-boss');
      await expect(boss.send(family, {})).rejects.toThrow('producer fenced');
      await expect(boss.schedule(family, '* * * * *')).rejects.toThrow('producer fenced');
      await expect(change('dbos')).rejects.toThrow('Drain blocked');
      await testDb().execute(
        sql`update pgboss.job set state = 'failed' where id = ${taskId}::uuid`,
      );
      await expect(
        retireFailedSessionOrphan(testDb(), {
          kind: 'terminal-task',
          family,
          backend: 'pg-boss',
          taskId,
          reason: 'failed without proof',
        }),
      ).rejects.toThrow('quiescence');
      await quiesce();
      await retireFailedSessionOrphan(testDb(), {
        kind: 'terminal-task',
        family,
        backend: 'pg-boss',
        taskId,
        reason: 'Observed real failed task and absent owner',
      });
      await change('dbos');
      expect(
        await testDb().execute(sql`select * from session_orphan_control where family = ${other}`),
      ).toEqual(before);
      expect(await boss.send(other, {})).toBeTruthy();
    });
    it('requires row-before-task retirement and refuses disposed gaps on redelivery', async () => {
      const taskId = z.uuid().parse(await boss.send(family, {}));
      await startSession(family, 'gap', '2000-01-01T00:00:00Z');
      const request = { family, source: { kind: 'pg-boss', jobId: taskId } } as const;
      await expect(
        runSessionOrphanTick(testDb(), request, async (e) => {
          if (e.kind === 'selection-committed') throw new Error('owner stopped');
        }),
      ).rejects.toThrow('owner stopped');
      await change('draining-pg-boss');
      await quiesce();
      await testDb().execute(
        sql`update pgboss.job set state = 'failed' where id = ${taskId}::uuid`,
      );
      const base = {
        family,
        backend: 'pg-boss',
        taskId,
        reason: 'Known stopped owner; no replay',
      } as const;
      await expect(
        retireFailedSessionOrphan(testDb(), { ...base, kind: 'terminal-task' }),
      ).rejects.toThrow('rows before');
      await retireFailedSessionOrphan(testDb(), {
        ...base,
        kind: 'terminal-row',
        tickId: `legacy:${taskId}`,
        sessionId: 'gap',
      });
      await expect(runSessionOrphanTick(testDb(), request)).rejects.toThrow('Disposition');
      await retireFailedSessionOrphan(testDb(), { ...base, kind: 'terminal-task' });
      expect(await sessionOrphanObligations(testDb(), { family, backend: 'pg-boss' })).toHaveLength(
        0,
      );
      await change('dbos');
      expect(
        await testDb().execute(sql`select * from session_orphan_receipt where family = ${family}`),
      ).toHaveLength(0);
      expect(
        (await testDb().execute(sql`select state from pgboss.job where id = ${taskId}::uuid`))[0]
          .state,
      ).toBe('failed');
    });
    it('blocks live tasks, missing tasks, unexpected DLQ and malformed/unknown forwarders', async () => {
      const active = z.uuid().parse(await boss.send(family, {}));
      const dlq = z.uuid().parse(await boss.send(`${family}_dlq`, {}));
      await testDb().execute(sql`update pgboss.job set state = 'failed' where id = ${dlq}::uuid`);
      for (const data of [{}, { name: 7 }, { name: 'unknown-target' }, { name: family }])
        await boss.send('__pgboss__send-it', data);
      const other = family === families[0] ? families[1] : families[0];
      await boss.send('__pgboss__send-it', { name: other });
      await change('draining-pg-boss');
      await quiesce();
      for (const taskId of [active, dlq, '00000000-0000-4000-8000-000000000000'])
        await expect(
          retireFailedSessionOrphan(testDb(), {
            kind: 'terminal-task',
            family,
            backend: 'pg-boss',
            taskId,
            reason: 'Cannot settle unknown/live/DLQ',
          }),
        ).rejects.toThrow('terminal failure');
      expect(
        (await sessionOrphanObligations(testDb(), { family, backend: 'pg-boss' })).filter(
          (r) => r.kind === 'forwarder',
        ),
      ).toHaveLength(4);
      await expect(change('dbos')).rejects.toThrow('Drain blocked');
    });
    it('rejects another family proof, stale barrier, skipped phase and catch-up schedule policy', async () => {
      const other = family === families[0] ? families[1] : families[0];
      await expect(change('dbos')).rejects.toThrow('Invalid transition');
      await boss.schedule(family, '* * * * *', {}, { missed: 'once' });
      await expect(change('draining-pg-boss')).rejects.toThrow('missed=skip');
      await boss.unschedule(family);
      await change('draining-pg-boss');
      await changeSessionOrphanPhase(
        testDb(),
        boss,
        { family: other, target: 'draining-pg-boss' },
        schedules,
      );
      await attestSessionOrphanQuiescence(testDb(), { family: other, reason: 'Other owner proof' });
      await expect(change('dbos')).rejects.toThrow('quiescence');
      await quiesce();
      await testDb().execute(
        sql`update session_orphan_control set phase_changed_at = phase_changed_at + interval '1 microsecond' where family = ${family}`,
      );
      await expect(change('dbos')).rejects.toThrow('quiescence');
      await quiesce();
      await change('dbos');
    });
    it('fails closed with a missing family control and keeps unrelated queue producers working', async () => {
      await testDb().execute(sql`delete from session_orphan_control where family = ${family}`);
      try {
        await expect(boss.send(family, {})).rejects.toThrow();
        await expect(runSessionOrphanTick(testDb(), native(family))).rejects.toThrow(
          'Missing control',
        );
        await boss.createQueue('session-fixture-unrelated');
        expect(await boss.send('session-fixture-unrelated', {})).toBeTruthy();
      } finally {
        await testDb().execute(
          sql`insert into session_orphan_control (family,phase) values (${family},'pg-boss')`,
        );
      }
    });
  });
