import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DBOSClient } from '@dbos-inc/dbos-sdk';
import { PgBoss } from 'pg-boss';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createMigrationFixture } from './migration-fixture';

const fixture = createMigrationFixture('placement');
const {
  families,
  reset,
  sessions,
  snapshots,
  commitFault,
  worker,
  nextId,
  safeUrl,
  evidence,
  verifiedArtifact,
  sha,
} = fixture;
const caseFamilies: (typeof families)[number][] = [families[1]];
beforeAll(fixture.setup, 60000);
beforeEach(fixture.beforeCase);
afterEach(fixture.afterCase);
afterAll(fixture.teardown);

for (const family of caseFamilies)
  describe(`actual ${family} crash and recovery`, () => {
    beforeEach(() => {
      fixture.selectedFamily = family;
    });
    for (const pauseAt of [
      'admission-uncommitted',
      'selection-committed',
      'row-uncommitted',
      'row-committed',
      'checkpoint-saved',
    ]) {
      // @invariant data: crash recovery retains frozen candidates and committed session effects
      // @fails-if a restarted owner changes admitted inputs or emits a second event for an already committed session
      it(`SIGKILL at ${pauseAt} recovers the same inputs and frozen candidates`, async () => {
        await reset();
        await sessions();
        const id = nextId();
        const first = worker({ id, pauseAt });
        await first.wait('ready');
        await first.wait('boundary');
        await first.kill();
        const before = await snapshots(id);
        if (pauseAt === 'row-committed' || pauseAt === 'checkpoint-saved') {
          await fixture.db`update learning_session set version = version + 1 where id = 'crash-a'`;
          // The user's existing writer is exercised separately by the SQL/domain suite.
        }
        if (pauseAt !== 'admission-uncommitted')
          await fixture.db`insert into learning_session (id,type,status,started_at,version) values ('later-d',${fixture.selectedFamily === families[0] ? 'conversation' : 'placement'},${fixture.selectedFamily === families[0] ? 'active' : 'started'},'2026-10-08T10:00:00Z',0)`;
        const second = worker({ id, recover: true });
        const duplicate = worker();
        await second.wait('ready');
        await duplicate.wait('ready');
        await second.wait('done');
        const after = await snapshots(id);
        evidence.push({ pauseAt, id, before, after });
        expect(after.receipts).toHaveLength(3);
        expect(after.events).toHaveLength(3);
        if (pauseAt !== 'admission-uncommitted')
          expect(
            after.tick[0].candidates.map((r: { sessionId: string }) => r.sessionId),
          ).not.toContain('later-d');
        if (pauseAt === 'row-committed' || pauseAt === 'checkpoint-saved')
          expect(after.sessions.find((r) => r.id === 'crash-a')).toMatchObject({
            status: 'abandoned',
            version: 2,
          });
        await second.stop();
        await duplicate.stop();
      }, 120000);
    }
    for (const mode of ['after-server-commit', 'before-server-commit'] as const) {
      // @invariant data: lost COMMIT acknowledgement is reconciled from the authoritative database ledger
      // @fails-if recovery treats a committed receipt as missing or reruns its session effect after acknowledgement loss
      it(`reconciles ${mode} through the authoritative lock`, async () => {
        await reset();
        await sessions();
        const proxy = await commitFault(mode);
        const id = nextId();
        const child = worker({ id, appUrl: proxy.url });
        try {
          await child.wait('ready');
          await child.wait('done');
          expect(proxy.fired()).toBe(true);
          const after = await snapshots(id);
          evidence.push({ mode, id, after });
          expect(after.receipts).toHaveLength(3);
          expect(after.events).toHaveLength(mode === 'after-server-commit' ? 3 : 2);
          expect(
            after.receipts.filter((r) => r.outcome.kind === 'deferred-known-failure'),
          ).toHaveLength(mode === 'before-server-commit' ? 1 : 0);
          await child.stop();
        } finally {
          await proxy.stop();
        }
      }, 120000);
    }
    // @invariant data: unavailable commit outcomes remain unknown without terminal workflow replay
    // @fails-if an unresolved primary outcome is retried blindly or a terminal DBOS ERROR resumes business effects
    it('holds an unavailable primary as unknown and does not resume a terminal DBOS ERROR', async () => {
      await reset();
      await sessions();
      const proxy = await commitFault('after-server-commit-and-unavailable');
      const id = nextId();
      const first = worker({ id, appUrl: proxy.url });
      try {
        await first.wait('ready');
        // This fixture expects the failure message itself, after the workflow becomes ERROR.
        await first.wait('failure');
        await expect
          .poll(
            async () =>
              (
                await fixture.db`select status from tlp_dbos.workflow_status where workflow_uuid = ${id}`
              )[0]?.status,
            { timeout: 60000 },
          )
          .toBe('ERROR');
        expect(proxy.fired()).toBe(true);
        const before = await snapshots(id);
        expect(before.receipts).toHaveLength(1);
        const retry = worker({ id, recover: true });
        await retry.wait('ready');
        expect((await retry.wait('failure')).error).toContain(
          `Session orphan outcome unknown: ${fixture.selectedFamily}/${id}/crash-a`,
        );
        await expect
          .poll(
            async () =>
              (
                await fixture.db`select status from tlp_dbos.workflow_status where workflow_uuid = ${id}`
              )[0]?.status,
          )
          .toBe('ERROR');
        const after = await snapshots(id);
        expect(after.receipts).toEqual(before.receipts);
        expect(after.events).toEqual(before.events);
        const { inspectSessionOrphanOutcome } = await import(
          '@/server/durable/session-orphan-family'
        );

        expect(
          await inspectSessionOrphanOutcome(fixture.appDb, {
            family,
            tickId: id,
            sessionId: 'crash-a',
          }),
        ).toMatchObject({ kind: 'committed', outcome: { kind: 'abandoned' } });
        expect(
          await inspectSessionOrphanOutcome(fixture.appDb, {
            family,
            tickId: id,
            sessionId: 'crash-b',
          }),
        ).toEqual({ kind: 'not-committed' });
        const { sessionOrphanObligations } = await import(
          '@/server/durable/session-orphan-backend'
        );
        const obligations = await sessionOrphanObligations(fixture.appDb, {
          family,
          backend: 'dbos',
        });
        expect(obligations).toContainEqual(
          expect.objectContaining({ family, task_id: id, state: 'ERROR', kind: 'task' }),
        );
        expect(obligations.filter((r) => r.task_id === id && r.kind === 'receipt')).toHaveLength(2);
        evidence.push({ unknownId: id, before, after, terminalErrorWasNotRetried: true });
        expect(await retry.exited).toEqual([1, null]);
        if (first.child.exitCode === null && first.child.signalCode === null) await first.kill();
        else await first.exited;
        const backend = await import('@/server/durable/session-orphan-backend');
        const clientBoss = new PgBoss({
          connectionString: safeUrl().toString(),
          schedule: false,
          supervise: false,
          migrate: false,
          max: 1,
        });
        clientBoss.on('error', () => {});
        const scheduleClient = await DBOSClient.create({
          systemDatabaseUrl: safeUrl().toString(),
          systemDatabaseSchemaName: 'tlp_dbos',
          systemDatabasePoolSize: 1,
          applicationName: 'tlp-housekeeping',
        });
        try {
          await clientBoss.start();
          await backend.changeSessionOrphanPhase(
            fixture.appDb,
            clientBoss,
            { family, target: 'draining-dbos' },
            scheduleClient,
          );
          await expect(
            backend.changeSessionOrphanPhase(
              fixture.appDb,
              clientBoss,
              { family, target: 'pg-boss' },
              scheduleClient,
            ),
          ).rejects.toThrow('Drain blocked');
          await backend.attestSessionOrphanQuiescence(fixture.appDb, {
            family,
            reason: `Observed unknown-outcome owner PID ${first.child.pid} and retrieval PID ${retry.child.pid} exited; no other owners in disposable DB`,
          });
          await expect(
            backend.retireFailedSessionOrphan(fixture.appDb, {
              kind: 'terminal-task',
              family,
              backend: 'dbos',
              taskId: id,
              reason: 'Observed ERROR owner exited',
            }),
          ).rejects.toThrow('rows before');
          for (const sessionId of ['crash-b', 'crash-c'])
            await backend.retireFailedSessionOrphan(fixture.appDb, {
              kind: 'terminal-row',
              family,
              backend: 'dbos',
              taskId: id,
              tickId: id,
              sessionId,
              reason: 'Known stopped ERROR owner, no replay',
            });
          await backend.retireFailedSessionOrphan(fixture.appDb, {
            kind: 'terminal-task',
            family,
            backend: 'dbos',
            taskId: id,
            reason: 'Explicit failed task disposition after rows',
          });
          expect(
            (
              await backend.sessionOrphanObligations(fixture.appDb, { family, backend: 'dbos' })
            ).filter((r) => r.task_id === id),
          ).toHaveLength(0);
          const { runSessionOrphanTick } = await import('@/server/durable/session-orphan-family');
          await expect(
            runSessionOrphanTick(fixture.appDb, {
              family,
              source: {
                kind: 'dbos',
                workflowId: id,
                scheduledAt: new Date(id.slice(`sched-${family}-`.length)),
              },
            }),
          ).rejects.toThrow('Disposition');
          expect(
            await fixture.db`select * from session_orphan_receipt where family = ${family} and tick_id = ${id} order by session_id`,
          ).toEqual(before.receipts);
          expect(
            (
              await fixture.db`select status from tlp_dbos.workflow_status where workflow_uuid = ${id}`
            )[0].status,
          ).toBe('ERROR');
        } finally {
          await scheduleClient.destroy();
          await clientBoss.stop();
        }
      } finally {
        if (first.child.exitCode === null && first.child.signalCode === null)
          first.child.kill('SIGKILL');
        await first.exited;
        await proxy.stop();
      }
    }, 120000);
  });

for (const family of caseFamilies) {
  // @invariant data: admission and deferred receipts survive COMMIT-response loss without effect retry
  // @fails-if wire acknowledgement loss changes the committed admission or repeats a deferred session effect
  it(`drops admission and deferred receipt COMMIT packets for ${family} without blind effect retry`, async () => {
    fixture.selectedFamily = family;
    for (const targetKind of ['admission', 'deferred'] as const) {
      await reset();
      await sessions();
      if (targetKind === 'deferred') {
        await fixture.db`create function yuk1394_process_fail_receipt() returns trigger language plpgsql as $$ begin if new.session_id = 'crash-a' and new.outcome->>'kind' = 'abandoned' then raise exception 'effect rollback'; end if; return new; end $$`;
        await fixture.db`create trigger yuk1394_process_fail_receipt before insert on session_orphan_receipt for each row execute function yuk1394_process_fail_receipt()`;
      }
      const proxy = await commitFault('after-server-commit', targetKind);
      const id = nextId(),
        current = worker({ id, appUrl: proxy.url });
      try {
        await current.wait('ready');
        await current.wait('done');
        expect(proxy.fired()).toBe(true);
        const after = await snapshots(id);
        expect(after.receipts).toHaveLength(3);
        expect(after.events).toHaveLength(targetKind === 'deferred' ? 2 : 3);
        expect(
          after.receipts.filter((r) => r.outcome.kind === 'deferred-known-failure'),
        ).toHaveLength(targetKind === 'deferred' ? 1 : 0);
        evidence.push({ targetKind, family, id, after });
        await current.stop();
      } finally {
        if (current.child.exitCode === null && current.child.signalCode === null)
          await current.kill();
        await proxy.stop();
        if (targetKind === 'deferred') {
          await fixture.db`drop trigger yuk1394_process_fail_receipt on session_orphan_receipt`;
          await fixture.db`drop function yuk1394_process_fail_receipt()`;
        }
      }
    }
  }, 180000);
  // @invariant concurrency: archived consumers must exit before new-family quiescence can be attested
  // @fails-if a running archived handler is treated as stopped or consumes a session after new-family admission
  it(`observes actual archived ${family} selected handler exit before attestation`, async () => {
    fixture.selectedFamily = family;
    await reset();
    await fixture.db`update session_orphan_control set phase = 'pg-boss'`;
    const domain = family === families[0] ? 'conversation' : 'placement';
    const artifact = await verifiedArtifact(domain);
    const id = `old-selected-${randomUUID()}`;
    await fixture.db`insert into learning_session (id,type,status,started_at) values (${id},${domain},${domain === 'conversation' ? 'active' : 'started'},clock_timestamp() - interval '7 hours')`;
    const directory = resolve(`.cache/yuk1394-old-actor-${domain}-${fixture.identity}`);
    await mkdir(directory, { recursive: true });
    const actor = `${directory}/actor.cjs`;
    // Instrument only the SELECT promise around the genuine archived exported handler.
    const source = `
      (async () => {
        const url = new URL(process.env.DATABASE_URL);
        if (process.env.TLP_SESSION_TEST_PROCESS !== '1' || !/^\\/test_fork_\\d+$/.test(url.pathname) || !['localhost','127.0.0.1'].includes(url.hostname)) throw new Error('Disposable DB required');
        const postgres = require('postgres'); const { drizzle } = require('drizzle-orm/postgres-js');
        const db = drizzle(postgres(url.toString(), {max:2,ssl:false}));
        const original = require(${JSON.stringify(artifact)});
        let release; const held = new Promise(resolve => release = resolve);
        process.on('message', message => { if (message.kind === 'release') release(); });
        const select = db.select.bind(db); db.select = (...args) => {
          const builder = select(...args); const from = builder.from.bind(builder);
          builder.from = (...tables) => { const selection = from(...tables); const where = selection.where.bind(selection);
            selection.where = (...conditions) => { const query = where(...conditions); const then = query.then.bind(query);
              query.then = (fulfilled,rejected) => then(async rows => { process.send({kind:'old-selected',ids:rows.map(r=>r.id)}); await held; return fulfilled(rows); },rejected); return query; };
            return selection; }; return builder; };
        const result = await original.${domain === 'conversation' ? 'runPruneOrphanConversationSessions' : 'runPruneOrphanPlacementSessions'}(db);
        await new Promise(resolve => process.send({kind:'old-done',result},resolve)); await db.$client.end(); process.disconnect();
      })().catch(error => {process.send({kind:'failure',error:String(error)});process.exit(1);});`;
    await writeFile(actor, source);
    const old = worker({ oldBundle: actor });
    await old.wait('old-selected');
    const current = worker();
    await current.wait('ready');
    current.child.send({ kind: 'transition', family, phase: 'draining-pg-boss' });
    await current.wait('ack');
    current.child.send({ kind: 'transition', family, phase: 'dbos' });
    expect((await current.wait('rejected')).error).toContain('quiescence');
    old.child.send({ kind: 'release' });
    await old.wait('old-done');
    expect(await old.exited).toEqual([0, null]);
    expect((await fixture.db`select status from learning_session where id = ${id}`)[0].status).toBe(
      'abandoned',
    );
    expect(
      await fixture.db`select * from session_orphan_receipt where family = ${family} and session_id = ${id}`,
    ).toHaveLength(0);
    expect(
      await fixture.db`select * from job_events where business_id = ${id} and event_type = ${`${domain}.abandoned`}`,
    ).toHaveLength(1);
    current.child.send({
      kind: 'quiesce',
      family,
      reason: `Observed PID ${old.child.pid} actual archived handler exit; no other old/suspended producers in this disposable test`,
    });
    await current.wait('ack');
    current.child.send({ kind: 'transition', family, phase: 'dbos' });
    await current.wait('ack');
    evidence.push({
      family,
      oldPid: old.child.pid,
      archive: artifact,
      actorSha256: sha(await readFile(actor)),
      oldExit: [0, null],
      id,
    });
    await current.stop();
  }, 180000);
}
