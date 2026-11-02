import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createMigrationFixture } from './migration-fixture';

const fixture = createMigrationFixture('conversation');
const { families, reset, sessions, snapshots, worker, nextId, evidence, verifiedArtifact, sha } =
  fixture;
const caseFamilies: (typeof families)[number][] = [families[0]];
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
  });

for (const family of caseFamilies) {
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
