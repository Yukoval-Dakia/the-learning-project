import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { type Socket, createConnection, createServer } from 'node:net';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { DBOSClient } from '@dbos-inc/dbos-sdk';
import { PgBoss } from 'pg-boss';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

const OLD_BASE = '6aaf8ca89eaf5feb5af5c00b7c5b3bd90cd953ea';
const REVIEW_BASE = '3be966000e53842dc9592df60c367b5af14660fb';
const families = ['prune_orphan_conversation_sessions', 'prune_orphan_placement_sessions'] as const;
let selectedFamily: (typeof families)[number] = families[0];
const scheduledAt = '2026-10-09T00:00:00.000Z';
const nextId = () =>
  `sched-${selectedFamily}-${new Date(Date.parse(scheduledAt) + ++serial).toISOString()}`;
let serial = 0;
const exec = promisify(execFile);
const bundle = resolve(`.cache/yuk1394-session-${process.pid}.cjs`);
const children = new Set<ChildProcess>();
const logs: unknown[] = [];
const evidence: unknown[] = [];
let db: ReturnType<typeof postgres>;
const messageSchema = z
  .object({ kind: z.string(), boundary: z.string().optional(), error: z.string().optional() })
  .passthrough();
const buildArgs = [
  '--bundle',
  '--platform=node',
  '--target=node24',
  '--format=cjs',
  '--external:pg-native',
  '--external:sharp',
  '--external:better-sqlite3',
  '--external:bufferutil',
  '--external:utf-8-validate',
  '--external:winston',
  '--external:winston-transport',
];
function safeUrl() {
  const url = new URL(z.url().parse(process.env.TEST_DATABASE_URL));
  if (
    !/^\/test_fork_\d+$/.test(url.pathname) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  )
    throw new Error('Disposable loopback TEST_DATABASE_URL required; never default DATABASE_URL');
  return url;
}
const sha = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
function worker(
  options: {
    id?: string;
    pauseAt?: string;
    recover?: boolean;
    appUrl?: string;
    oldBundle?: string;
    pruneId?: string;
    reviewId?: string;
    scheduledAt?: string;
  } = {},
) {
  const child = spawn(process.execPath, [options.oldBundle ?? bundle], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: {
      PATH: process.env.PATH,
      NODE_PATH: resolve('node_modules'),
      NODE_ENV: 'test',
      DATABASE_URL: safeUrl().toString(),
      TLP_SESSION_TEST_PROCESS: '1',
      TLP_SESSION_FAMILY: selectedFamily,
      TLP_SESSION_SCHEDULED_AT:
        options.scheduledAt ??
        (options.id?.startsWith('sched-')
          ? options.id.slice(`sched-${selectedFamily}-`.length)
          : scheduledAt),
      TLP_REVIEW_TEST_PROCESS: '1',
      TLP_REVIEW_WORKFLOW_ID: options.reviewId,
      TLP_REVIEW_PAUSE_AT: options.reviewId ? 'row-committed' : undefined,
      TLP_SESSION_WORKFLOW_ID: options.id,
      TLP_SESSION_PAUSE_AT: options.pauseAt,
      TLP_SESSION_RECOVER: options.recover ? '1' : '0',
      TLP_SESSION_APP_DATABASE_URL: options.appUrl,
      TLP_SESSION_APP_PROXY: options.appUrl ? '1' : '0',
      TLP_PRUNE_TEST_PROCESS: '1',
      TLP_PRUNE_WORKFLOW_ID: options.pruneId,
      TLP_PRUNE_PAUSE_AT: options.oldBundle ? 'business-committed' : undefined,
    },
  });
  children.add(child);
  const exited = once(child, 'exit');
  const messages: z.infer<typeof messageSchema>[] = [];
  const record = {
    pid: child.pid,
    stdout: '',
    stderr: '',
    messages: [] as unknown[],
    exit: null as unknown,
  };
  logs.push(record);
  child.stdout?.on('data', (c) => {
    record.stdout += String(c);
  });
  child.stderr?.on('data', (c) => {
    record.stderr += String(c);
  });
  child.on('message', (m) => {
    messages.push(messageSchema.parse(m));
    record.messages.push(m);
  });
  child.on('exit', (code, signal) => {
    children.delete(child);
    record.exit = { code, signal };
  });
  async function wait(kind: string) {
    let found: z.infer<typeof messageSchema> | undefined;
    await expect
      .poll(
        () => {
          const index = messages.findIndex((m) => m.kind === kind);
          if (index >= 0) found = messages.splice(index, 1)[0];
          if (found) return true;
          const error = messages.find((m) => m.kind === 'failure');
          if (error) throw new Error(`${error.error}\n${record.stderr}`);
          if (!found && (child.exitCode !== null || child.signalCode !== null))
            throw new Error(`Child exited: ${record.stderr}`);
          return !!found;
        },
        { timeout: 30000, interval: 25 },
      )
      .toBe(true);
    return messageSchema.parse(found);
  }
  async function kill() {
    child.kill('SIGKILL');
    expect(await exited).toEqual([null, 'SIGKILL']);
  }
  async function stop() {
    child.send({ kind: 'stop' });
    expect(await exited).toEqual([0, null]);
  }
  return { child, exited, wait, kill, stop };
}
async function reset() {
  await db`truncate session_orphan_disposition, session_orphan_receipt, session_orphan_tick, learning_session, job_events cascade`;
  await db`update session_orphan_control set phase = 'dbos', legacy_not_before = null, phase_changed_at = clock_timestamp()`;
  await db`update prune_job_events_control set phase = 'pg-boss'`;
  await db`update review_orphan_control set phase = 'pg-boss'`;
  await db`delete from pgboss.job where name in (${families[0]},${families[1]},'__pgboss__send-it')`;
}
async function sessions() {
  for (const id of ['crash-a', 'crash-b', 'crash-c'])
    await db`insert into learning_session (id,type,status,started_at,version) values (${id},${selectedFamily === families[0] ? 'conversation' : 'placement'},${selectedFamily === families[0] ? 'active' : 'started'},'2026-10-08T12:00:00.123456Z',0)`;
}
async function snapshots(id: string) {
  return {
    tick: await db`select * from session_orphan_tick where family = ${selectedFamily} and tick_id = ${id}`,
    receipts:
      await db`select * from session_orphan_receipt where family = ${selectedFamily} and tick_id = ${id} order by session_id`,
    sessions: await db`select id,status,version,started_at::text from learning_session order by id`,
    events:
      await db`select business_id,event_type from job_events where event_type = ${selectedFamily === families[0] ? 'conversation.abandoned' : 'placement.abandoned'} order by business_id`,
    workflow:
      await db`select workflow_uuid,status,recovery_attempts from tlp_dbos.workflow_status where workflow_uuid = ${id}`,
  };
}

// Actual PostgreSQL wire fault. Observe the server's COMMIT CommandComplete, then
// drop its response; alternatively drop the frontend COMMIT before forwarding it.
// This proxy exists only in this acceptance fixture and never listens outside loopback.
async function commitFault(
  mode: 'after-server-commit' | 'before-server-commit' | 'after-server-commit-and-unavailable',
  targetKind: 'admission' | 'row' | 'deferred' = 'row',
) {
  const target = safeUrl();
  const sockets = new Set<Socket>();
  let fired = false;
  const server = createServer((downstream) => {
    if (fired && mode === 'after-server-commit-and-unavailable') {
      downstream.destroy();
      return;
    }
    const upstream = createConnection({ host: target.hostname, port: Number(target.port || 5432) });
    sockets.add(downstream);
    sockets.add(upstream);
    let front = Buffer.alloc(0);
    let back = Buffer.alloc(0);
    let startup = true;
    let receiptTx = false;
    const statements = new Map<string, string>();
    const close = () => {
      downstream.destroy();
      upstream.destroy();
      sockets.delete(downstream);
      sockets.delete(upstream);
    };
    downstream.on('error', close);
    upstream.on('error', close);
    downstream.on('close', () => upstream.destroy());
    upstream.on('close', () => downstream.destroy());
    downstream.on('data', (chunk) => {
      front = Buffer.concat([front, typeof chunk === 'string' ? Buffer.from(chunk) : chunk]);
      while (front.length >= (startup ? 4 : 5)) {
        const size = startup ? front.readInt32BE(0) : front.readInt32BE(1) + 1;
        if (front.length < size) break;
        const packet = front.subarray(0, size);
        front = front.subarray(size);
        if (startup) {
          startup = false;
          upstream.write(packet);
          continue;
        }
        const tag = String.fromCharCode(packet[0]);
        let query = '';
        if (tag === 'Q') query = packet.subarray(5, -1).toString();
        if (tag === 'P') {
          const end = packet.indexOf(0, 5);
          query = packet.subarray(end + 1, packet.indexOf(0, end + 1)).toString();
          statements.set(packet.subarray(5, end).toString(), query);
        }
        if (tag === 'B') {
          const end = packet.indexOf(0, 5);
          query =
            statements.get(packet.subarray(end + 1, packet.indexOf(0, end + 1)).toString()) ?? '';
        }
        if (
          (targetKind === 'admission' && /insert into "session_orphan_tick"/i.test(query)) ||
          (targetKind !== 'admission' && /insert into "session_orphan_receipt"/i.test(query))
        )
          receiptTx = true;
        if (
          !fired &&
          receiptTx &&
          /^commit\b/i.test(query.trim()) &&
          mode === 'before-server-commit'
        ) {
          fired = true;
          evidence.push({ fault: mode, at: new Date().toISOString(), query });
          close();
          return;
        }
        upstream.write(packet);
      }
    });
    upstream.on('data', (chunk) => {
      back = Buffer.concat([back, typeof chunk === 'string' ? Buffer.from(chunk) : chunk]);
      while (back.length >= 5) {
        const size = back.readInt32BE(1) + 1;
        if (back.length < size) break;
        const packet = back.subarray(0, size);
        back = back.subarray(size);
        const tag = String.fromCharCode(packet[0]);
        const command = tag === 'C' ? packet.subarray(5, -1).toString() : '';
        if (!fired && receiptTx && command === 'COMMIT' && mode !== 'before-server-commit') {
          fired = true;
          evidence.push({ fault: mode, at: new Date().toISOString(), serverCommand: command });
          close();
          return;
        }
        if (command === 'COMMIT' || command === 'ROLLBACK') receiptTx = false;
        downstream.write(packet);
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing proxy port');
  const url = new URL(target);
  url.hostname = '127.0.0.1';
  url.port = String(address.port);
  url.searchParams.set('sslmode', 'disable');
  return {
    url: url.toString(),
    fired: () => fired,
    async stop() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}

beforeAll(async () => {
  // CI must provide full checkout history or the separately verified old artifact.
  // Fail before opening any pool/worker when the required immutable source is absent.
  await exec('git', ['cat-file', '-e', `${OLD_BASE}^{commit}`]);
  await exec('git', ['cat-file', '-e', `${REVIEW_BASE}^{commit}`]);
  db = postgres(safeUrl().toString(), { max: 3 });
  await exec(resolve('node_modules/.bin/esbuild'), [
    'tests/dbos-session-orphan/worker.ts',
    ...buildArgs,
    `--outfile=${bundle}`,
  ]);
  await db`delete from contract_epoch`;
}, 60000);
afterAll(async () => {
  for (const child of children) {
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
  }
  if (process.env.TLP_SESSION_EVIDENCE_PATH)
    await writeFile(
      process.env.TLP_SESSION_EVIDENCE_PATH,
      JSON.stringify(
        {
          capturedAt: new Date().toISOString(),
          node: process.version,
          execPath: process.execPath,
          bundle,
          bundleSha256: sha(await readFile(bundle)),
          logs,
          evidence,
        },
        null,
        2,
      ),
    );
  if (db) {
    await db`update session_orphan_control set phase = 'pg-boss', legacy_not_before = null`;
    await db.end();
  }
});

for (const family of families)
  describe(`actual ${family} crash and recovery`, () => {
    beforeEach(() => {
      selectedFamily = family;
    });
    for (const pauseAt of [
      'admission-uncommitted',
      'selection-committed',
      'row-uncommitted',
      'row-committed',
      'checkpoint-saved',
    ]) {
      it(`SIGKILL at ${pauseAt} recovers the same inputs and frozen candidates`, async () => {
        const seed = worker();
        await seed.wait('ready');
        await seed.stop();
        await reset();
        await sessions();
        const id = nextId();
        const first = worker({ id, pauseAt });
        await first.wait('ready');
        await first.wait('boundary');
        await first.kill();
        const before = await snapshots(id);
        if (pauseAt === 'row-committed' || pauseAt === 'checkpoint-saved') {
          await db`update learning_session set version = version + 1 where id = 'crash-a'`;
          // The user's existing writer is exercised separately by the SQL/domain suite.
        }
        if (pauseAt !== 'admission-uncommitted')
          await db`insert into learning_session (id,type,status,started_at,version) values ('later-d',${selectedFamily === families[0] ? 'conversation' : 'placement'},${selectedFamily === families[0] ? 'active' : 'started'},'2026-10-08T10:00:00Z',0)`;
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
      it(`reconciles ${mode} through the authoritative lock`, async () => {
        const seed = worker();
        await seed.wait('ready');
        await seed.stop();
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
    it('holds an unavailable primary as unknown and does not resume a terminal DBOS ERROR', async () => {
      const seed = worker();
      await seed.wait('ready');
      await seed.stop();
      await reset();
      await sessions();
      const proxy = await commitFault('after-server-commit-and-unavailable');
      const id = nextId();
      const first = worker({ id, appUrl: proxy.url });
      try {
        await first.wait('ready');
        // Unlike ordinary wait(), this fixture expects the failure message itself.
        await expect
          .poll(
            async () =>
              (await db`select status from tlp_dbos.workflow_status where workflow_uuid = ${id}`)[0]
                ?.status,
            { timeout: 60000 },
          )
          .toBe('ERROR');
        expect(proxy.fired()).toBe(true);
        const before = await snapshots(id);
        expect(before.receipts).toHaveLength(1);
        const retry = worker({ id, recover: true });
        await retry.wait('ready');
        expect((await retry.wait('failure')).error).toContain(
          `Session orphan outcome unknown: ${selectedFamily}/${id}/crash-a`,
        );
        await expect
          .poll(
            async () =>
              (await db`select status from tlp_dbos.workflow_status where workflow_uuid = ${id}`)[0]
                ?.status,
          )
          .toBe('ERROR');
        const after = await snapshots(id);
        expect(after.receipts).toEqual(before.receipts);
        expect(after.events).toEqual(before.events);
        const { inspectSessionOrphanOutcome } = await import(
          '@/server/durable/session-orphan-family'
        );
        const { testDb } = await import('../helpers/db');
        expect(
          await inspectSessionOrphanOutcome(testDb(), { family, tickId: id, sessionId: 'crash-a' }),
        ).toMatchObject({ kind: 'committed', outcome: { kind: 'abandoned' } });
        expect(
          await inspectSessionOrphanOutcome(testDb(), { family, tickId: id, sessionId: 'crash-b' }),
        ).toEqual({ kind: 'not-committed' });
        const { sessionOrphanObligations } = await import(
          '@/server/durable/session-orphan-backend'
        );
        const obligations = await sessionOrphanObligations(testDb(), { family, backend: 'dbos' });
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
            testDb(),
            clientBoss,
            { family, target: 'draining-dbos' },
            scheduleClient,
          );
          await expect(
            backend.changeSessionOrphanPhase(
              testDb(),
              clientBoss,
              { family, target: 'pg-boss' },
              scheduleClient,
            ),
          ).rejects.toThrow('Drain blocked');
          await backend.attestSessionOrphanQuiescence(testDb(), {
            family,
            reason: `Observed unknown-outcome owner PID ${first.child.pid} and retrieval PID ${retry.child.pid} exited; no other owners in disposable DB`,
          });
          await expect(
            backend.retireFailedSessionOrphan(testDb(), {
              kind: 'terminal-task',
              family,
              backend: 'dbos',
              taskId: id,
              reason: 'Observed ERROR owner exited',
            }),
          ).rejects.toThrow('rows before');
          for (const sessionId of ['crash-b', 'crash-c'])
            await backend.retireFailedSessionOrphan(testDb(), {
              kind: 'terminal-row',
              family,
              backend: 'dbos',
              taskId: id,
              tickId: id,
              sessionId,
              reason: 'Known stopped ERROR owner, no replay',
            });
          await backend.retireFailedSessionOrphan(testDb(), {
            kind: 'terminal-task',
            family,
            backend: 'dbos',
            taskId: id,
            reason: 'Explicit failed task disposition after rows',
          });
          expect(
            (await backend.sessionOrphanObligations(testDb(), { family, backend: 'dbos' })).filter(
              (r) => r.task_id === id,
            ),
          ).toHaveLength(0);
          const { runSessionOrphanTick } = await import('@/server/durable/session-orphan-family');
          await expect(
            runSessionOrphanTick(testDb(), {
              family,
              source: {
                kind: 'dbos',
                workflowId: id,
                scheduledAt: new Date(id.slice(`sched-${family}-`.length)),
              },
            }),
          ).rejects.toThrow('Disposition');
          expect(
            await db`select * from session_orphan_receipt where family = ${family} and tick_id = ${id} order by session_id`,
          ).toEqual(before.receipts);
          expect(
            (await db`select status from tlp_dbos.workflow_status where workflow_uuid = ${id}`)[0]
              .status,
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

async function verifiedArtifact(kind: 'prune' | 'review' | 'conversation' | 'placement') {
  const base = kind === 'prune' ? OLD_BASE : REVIEW_BASE;
  const directory =
    kind === 'prune' ? '/tmp/yuk1393-old-prune-6aaf8ca89' : '/tmp/yuk1394-old-review-3be966000';
  const name = kind === 'prune' || kind === 'review' ? 'worker.cjs' : `${kind}-handler.cjs`;
  const expected = {
    prune: '606251411ff3c003e2a5c8fe8ae435b05298a547dd25f5f928d88c2afa7d1444',
    review: 'b2d2df1c679b7b9b0275fbd972ef9a869f5975fde090421ac2f6efed7a615108',
    conversation: '474b4a903d792fd240f8c409b8cdd4e830caacba2cbfe16b04d13b0235660386',
    placement: 'f159cf837c055297740a1166b76b1be324dbb632acd19734b170ed51d2b23018',
  }[kind];
  const artifact = `${directory}/${name}`;
  let available = true;
  try {
    await readFile(artifact);
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    available = false;
  }
  if (available) {
    expect(sha(await readFile(artifact))).toBe(expected);
    const manifestRaw: unknown = JSON.parse(
      await readFile(
        `${directory}/${kind === 'conversation' || kind === 'placement' ? 'old-consumer-manifest.json' : 'source-manifest.json'}`,
        'utf8',
      ),
    );
    const schema = z
      .object({
        base: z.literal(base),
        files: z.record(z.string(), z.string()).optional(),
        sourceFiles: z.record(z.string(), z.string()).optional(),
        consumers: z
          .array(
            z
              .object({ family: z.string(), sourceFiles: z.record(z.string(), z.string()) })
              .passthrough(),
          )
          .optional(),
      })
      .passthrough();
    const manifest = schema.parse(manifestRaw);
    const sources =
      manifest.sourceFiles ??
      manifest.files ??
      manifest.consumers?.find((r) => r.family === kind)?.sourceFiles;
    if (!sources) throw new Error('Archive source manifest missing');
    for (const [path, digest] of Object.entries(sources)) {
      const original = await exec('git', ['show', `${base}:${path}`], {
        maxBuffer: 24 * 1024 * 1024,
      });
      expect(sha(original.stdout), path).toBe(digest);
    }
    expect(sha(await readFile('pnpm-lock.yaml'))).toBe(
      sha(
        (await exec('git', ['show', `${base}:pnpm-lock.yaml`], { maxBuffer: 24 * 1024 * 1024 }))
          .stdout,
      ),
    );
    evidence.push({ kind, base, artifact, expected, manifest });
    return artifact;
  }
  // CI with full history can compile the genuine predecessor, never reconstructed domain code.
  const archived = resolve(`.cache/yuk1394-${kind}-${process.pid}`);
  await mkdir(archived, { recursive: true });
  const entry =
    kind === 'prune'
      ? 'tests/dbos-prune/worker.ts'
      : kind === 'review'
        ? 'tests/dbos-review-orphan/worker.ts'
        : `src/server/boss/handlers/prune_orphan_${kind}_sessions.ts`;
  const archive = await exec(
    'git',
    [
      'archive',
      '--format=tar',
      base,
      'src',
      entry,
      'package.json',
      'pnpm-lock.yaml',
      'tsconfig.json',
    ],
    { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 },
  );
  await writeFile(`${archived}/source.tar`, archive.stdout);
  await exec('tar', ['-xf', `${archived}/source.tar`, '-C', archived]);
  await symlink(resolve('node_modules'), `${archived}/node_modules`, 'dir');
  expect(sha(await readFile(`${archived}/pnpm-lock.yaml`))).toBe(
    sha(await readFile('pnpm-lock.yaml')),
  );
  const path = `${archived}/${name}`;
  await exec(
    resolve('node_modules/.bin/esbuild'),
    [entry, ...buildArgs, `--outfile=${path}`, `--metafile=${archived}/metafile.json`],
    { cwd: archived },
  );
  const inputs = z
    .object({ inputs: z.record(z.string(), z.unknown()) })
    .passthrough()
    .parse(JSON.parse(await readFile(`${archived}/metafile.json`, 'utf8')));
  const sources: Record<string, string> = {};
  for (const file of Object.keys(inputs.inputs).filter((p) => !p.includes('node_modules'))) {
    sources[file] = sha(await readFile(`${archived}/${file}`));
    expect(sources[file]).toBe(
      sha((await exec('git', ['show', `${base}:${file}`], { maxBuffer: 24 * 1024 * 1024 })).stdout),
    );
  }
  evidence.push({
    kind,
    base,
    artifact: path,
    artifactSha256: sha(await readFile(path)),
    archiveSha256: sha(archive.stdout),
    sources,
  });
  return path;
}
for (const family of families) {
  it(`drops admission and deferred receipt COMMIT packets for ${family} without blind effect retry`, async () => {
    selectedFamily = family;
    const seed = worker();
    await seed.wait('ready');
    await seed.stop();
    for (const targetKind of ['admission', 'deferred'] as const) {
      await reset();
      await sessions();
      if (targetKind === 'deferred') {
        await db`create function yuk1394_process_fail_receipt() returns trigger language plpgsql as $$ begin if new.session_id = 'crash-a' and new.outcome->>'kind' = 'abandoned' then raise exception 'effect rollback'; end if; return new; end $$`;
        await db`create trigger yuk1394_process_fail_receipt before insert on session_orphan_receipt for each row execute function yuk1394_process_fail_receipt()`;
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
          await db`drop trigger yuk1394_process_fail_receipt on session_orphan_receipt`;
          await db`drop function yuk1394_process_fail_receipt()`;
        }
      }
    }
  }, 180000);
  it(`observes actual archived ${family} selected handler exit before attestation`, async () => {
    selectedFamily = family;
    const seed = worker();
    await seed.wait('ready');
    await seed.stop();
    await reset();
    await db`update session_orphan_control set phase = 'pg-boss'`;
    const domain = family === families[0] ? 'conversation' : 'placement';
    const artifact = await verifiedArtifact(domain);
    const id = `old-selected-${randomUUID()}`;
    await db`insert into learning_session (id,type,status,started_at) values (${id},${domain},${domain === 'conversation' ? 'active' : 'started'},clock_timestamp() - interval '7 hours')`;
    const directory = resolve(`.cache/yuk1394-old-actor-${domain}-${process.pid}`);
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
    expect((await db`select status from learning_session where id = ${id}`)[0].status).toBe(
      'abandoned',
    );
    expect(
      await db`select * from session_orphan_receipt where family = ${family} and session_id = ${id}`,
    ).toHaveLength(0);
    expect(
      await db`select * from job_events where business_id = ${id} and event_type = ${`${domain}.abandoned`}`,
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
it('recovers genuine old prune and review partial ledgers before and after both new-family admissions', async () => {
  const { runSessionOrphanTick } = await import('@/server/durable/session-orphan-family');
  const { testDb } = await import('../helpers/db');
  selectedFamily = families[0];
  const seed = worker();
  await seed.wait('ready');
  await seed.stop();
  const pruneArtifact = await verifiedArtifact('prune'),
    reviewArtifact = await verifiedArtifact('review');
  for (const kind of ['prune', 'review'] as const)
    for (const admitted of [false, true]) {
      await reset();
      const id = `${kind}-genuine-${randomUUID()}`;
      if (kind === 'prune') {
        await db`update prune_job_events_control set phase = 'dbos'`;
        await db`insert into job_events (business_table,business_id,event_type,payload,occurred_at) values ('echo_jobs','old','echo.queued','{}','2026-01-01T00:00:00Z')`;
      } else {
        await db`truncate review_orphan_disposition, review_orphan_receipt, review_orphan_tick`;
        await db`update review_orphan_control set phase = 'dbos'`;
        for (const sessionId of ['review-old-a', 'review-old-b'])
          await db`insert into learning_session (id,type,status,started_at) values (${sessionId},'review','started','2026-10-08T12:00:00Z')`;
      }
      const old = worker({
        oldBundle: kind === 'prune' ? pruneArtifact : reviewArtifact,
        pruneId: kind === 'prune' ? id : undefined,
        reviewId: kind === 'review' ? id : undefined,
      });
      await old.wait('ready');
      await old.wait('boundary');
      await old.kill();
      const before =
        kind === 'prune'
          ? await db`select * from prune_job_events_receipt where workflow_id = ${id}`
          : await db`select * from review_orphan_receipt where tick_id = ${id} order by session_id`;
      expect(before).toHaveLength(1);
      if (admitted)
        for (const family of families) {
          selectedFamily = family;
          const nativeId = nextId();
          // Actual bounded runner with a valid scheduled identity. No SDK enqueue exists while old code runs.
          await runSessionOrphanTick(testDb(), {
            family,
            source: {
              kind: 'dbos',
              workflowId: nativeId,
              scheduledAt: new Date(nativeId.slice(`sched-${family}-`.length)),
            },
          });
        }
      const current = worker();
      await current.wait('ready');
      await expect
        .poll(
          async () =>
            (await db`select status from tlp_dbos.workflow_status where workflow_uuid = ${id}`)[0]
              ?.status,
          { timeout: 30000 },
        )
        .toBe('SUCCESS');
      const after =
        kind === 'prune'
          ? await db`select * from prune_job_events_receipt where workflow_id = ${id}`
          : await db`select * from review_orphan_receipt where tick_id = ${id} order by session_id`;
      if (kind === 'prune') expect(after).toEqual(before);
      else {
        expect(after).toHaveLength(2);
        expect(after[0]).toEqual(before[0]);
        expect(
          await db`select * from job_events where event_type = 'review.abandoned'`,
        ).toHaveLength(2);
      }
      const step = kind === 'prune' ? 'prune-business-commit' : 'review-orphan-sweep-v1';
      expect(
        await db`select function_name from tlp_dbos.operation_outputs where workflow_uuid = ${id} and function_name = ${step}`,
      ).toHaveLength(1);
      evidence.push({ kind, admitted, id, oldPid: old.child.pid, before, after, step });
      await current.stop();
    }
}, 240000);
