import { getConstructionPlans } from 'pg-boss';
import postgres from 'postgres';
import { expect, it, vi } from 'vitest';
import { _resetBossForTests, createBoss, getStartedBoss } from './client';

const fixtureClock = vi.hoisted(() => {
  let clock: import('pg-boss').TestClock;
  return {
    install(value: import('pg-boss').TestClock) {
      clock = value;
    },
    tick: (ms: number) => clock.tick(ms),
  };
});
vi.mock('pg-boss', async (importOriginal) => {
  const sdk = await importOriginal<typeof import('pg-boss')>();
  const clock = new sdk.TestClock('2026-10-11T00:00:00Z');
  fixtureClock.install(clock);
  return {
    ...sdk,
    PgBoss: class extends sdk.PgBoss {
      constructor(options: ConstructorParameters<typeof sdk.PgBoss>[0]) {
        super(
          typeof options === 'string'
            ? { connectionString: options, clock }
            : { ...options, clock },
        );
      }
    },
  };
});

// @invariant data: disabled automation leaves queue rows intact while explicit delivery remains usable
// @fails-if a disabled cron, registrar or supervisor mutates a stored row, or explicit fetch/complete stops working
it('keeps queue automation inert while explicit delivery remains available', async () => {
  const url = process.env.DATABASE_URL;
  if (!url || !new URL(url).pathname.startsWith('/test_fork_')) {
    throw new Error('requires disposable per-fork test database');
  }
  const sql = postgres(url, { max: 1 });
  const previous = process.env.RW_BOSS_AUTOMATION;
  process.env.RW_BOSS_AUTOMATION = 'disabled';
  _resetBossForTests();
  const errors: unknown[] = [];
  const boss = createBoss();
  boss.on('error', (error) => errors.push(error));
  const snapshot = async () => {
    const tables = await sql<{ tablename: string }[]>`
      select tablename from pg_tables where schemaname = 'pgboss'
        and tablename <> '__pgboss_test_clock' order by tablename
    `;
    const rows: Record<string, unknown> = {};
    for (const { tablename } of tables) {
      rows[tablename] = await sql.unsafe(
        `select to_jsonb(t) as row from pgboss."${tablename.replaceAll('"', '""')}" t order by to_jsonb(t)::text`,
      );
    }
    return rows;
  };
  try {
    // This schema belongs solely to the disposable fork, never the restored target.
    await sql.unsafe('drop schema if exists pgboss cascade');
    await sql.unsafe(getConstructionPlans('pgboss'));
    const beforeStart = await snapshot();
    await getStartedBoss();
    expect(await snapshot()).toEqual(beforeStart);
    await boss.createQueue('isolated-explicit');
    await boss.schedule('isolated-explicit', '* * * * *', { source: 'must-remain-dormant' });
    const id = await boss.send('isolated-explicit', { source: 'explicit' });
    expect(id).toBeTruthy();
    const beforeIdle = await snapshot();
    // Cross the SDK's 30s registrar/cron and 60s supervisor/cache boundaries.
    await fixtureClock.tick(65_000);
    expect(await snapshot()).toEqual(beforeIdle);
    expect(errors).toEqual([]);
    const jobs = await boss.fetch<{ source: string }>('isolated-explicit');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ id, data: { source: 'explicit' } });
    await boss.complete('isolated-explicit', jobs[0].id);
    const stored = await sql`select state from pgboss.job where id = ${jobs[0].id}`;
    expect(stored[0]?.state).toBe('completed');
    expect(await sql`select * from pgboss.instance`).toHaveLength(0);
    expect(errors).toEqual([]);
  } finally {
    await boss.stop({ graceful: false });
    _resetBossForTests();
    if (previous === undefined) delete process.env.RW_BOSS_AUTOMATION;
    else process.env.RW_BOSS_AUTOMATION = previous;
    await sql.end();
  }
}, 90_000);
