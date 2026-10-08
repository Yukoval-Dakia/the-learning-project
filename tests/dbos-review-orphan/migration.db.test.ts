import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { type Socket, createConnection, createServer } from 'node:net';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { DBOSClient } from '@dbos-inc/dbos-sdk';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

const OLD_BASE = '6aaf8ca89eaf5feb5af5c00b7c5b3bd90cd953ea';
const exec = promisify(execFile);
const bundle = resolve(`.cache/yuk1393-review-${process.pid}.cjs`);
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
  } = {},
) {
  const child = spawn(process.execPath, [options.oldBundle ?? bundle], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: {
      PATH: process.env.PATH,
      NODE_PATH: resolve('node_modules'),
      NODE_ENV: 'test',
      DATABASE_URL: safeUrl().toString(),
      TLP_REVIEW_TEST_PROCESS: '1',
      TLP_REVIEW_WORKFLOW_ID: options.id,
      TLP_REVIEW_PAUSE_AT: options.pauseAt,
      TLP_REVIEW_RECOVER: options.recover ? '1' : '0',
      TLP_REVIEW_APP_DATABASE_URL: options.appUrl,
      TLP_REVIEW_APP_PROXY: options.appUrl ? '1' : '0',
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
          const error = messages.find((m) => m.kind === 'failure');
          if (error) throw new Error(`${error.error}\n${record.stderr}`);
          const index = messages.findIndex((m) => m.kind === kind);
          if (index >= 0) found = messages.splice(index, 1)[0];
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
  return { child, wait, kill, stop };
}
async function reset() {
  await db`truncate review_orphan_disposition, review_orphan_receipt, review_orphan_tick, learning_session, job_events cascade`;
  await db`update review_orphan_control set phase = 'dbos', legacy_not_before = null, phase_changed_at = clock_timestamp()`;
  await db`update prune_job_events_control set phase = 'pg-boss'`;
}
async function sessions() {
  for (const id of ['crash-a', 'crash-b', 'crash-c'])
    await db`insert into learning_session (id,type,status,started_at,version) values (${id},'review','started','2026-10-08T12:00:00.123456Z',0)`;
}
async function snapshots(id: string) {
  return {
    tick: await db`select * from review_orphan_tick where tick_id = ${id}`,
    receipts:
      await db`select * from review_orphan_receipt where tick_id = ${id} order by session_id`,
    sessions: await db`select id,status,version,started_at::text from learning_session order by id`,
    events:
      await db`select business_id,event_type from job_events where event_type = 'review.abandoned' order by business_id`,
    workflow:
      await db`select workflow_uuid,status,recovery_attempts from tlp_dbos.workflow_status where workflow_uuid = ${id}`,
  };
}

// Actual PostgreSQL wire fault. Observe the server's COMMIT CommandComplete, then
// drop its response; alternatively drop the frontend COMMIT before forwarding it.
// This proxy exists only in this acceptance fixture and never listens outside loopback.
async function commitFault(
  mode: 'after-server-commit' | 'before-server-commit' | 'after-server-commit-and-unavailable',
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
        if (/insert into "review_orphan_receipt"/i.test(query)) receiptTx = true;
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

async function oldArtifact() {
  const essential = [
    'tests/dbos-prune/worker.ts',
    'src/server/durable/prune-worker.ts',
    'src/server/durable/prune-family.ts',
    'package.json',
    'pnpm-lock.yaml',
    'tsconfig.json',
  ];
  if (process.env.TLP_REVIEW_OLD_PRUNE_ARTIFACT) {
    const manifest = z
      .object({
        base: z.literal(OLD_BASE),
        files: z.record(z.string(), z.string()),
        artifact: z.object({ path: z.string(), sha256: z.string(), buildExit: z.literal(0) }),
      })
      .passthrough()
      .parse(
        JSON.parse(
          await readFile(
            z.string().min(1).parse(process.env.TLP_REVIEW_OLD_PRUNE_MANIFEST),
            'utf8',
          ),
        ),
      );
    const artifact = resolve(process.env.TLP_REVIEW_OLD_PRUNE_ARTIFACT);
    const expected = z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .parse(process.env.TLP_REVIEW_OLD_PRUNE_SHA256);
    expect(manifest.artifact.sha256).toBe(expected);
    expect(sha(await readFile(artifact))).toBe(manifest.artifact.sha256);
    for (const file of essential) {
      const source = await exec('git', ['show', `${OLD_BASE}:${file}`], {
        maxBuffer: 20 * 1024 * 1024,
      });
      expect(sha(source.stdout)).toBe(manifest.files[file]);
    }
    expect(sha(await readFile('pnpm-lock.yaml'))).toBe(manifest.files['pnpm-lock.yaml']);
    evidence.push({
      oldBase: OLD_BASE,
      oldArtifact: artifact,
      oldSha256: manifest.artifact.sha256,
      manifest,
    });
    return artifact;
  }
  const directory = resolve(`.cache/yuk1393-old-prune-${process.pid}`);
  await mkdir(directory, { recursive: true });
  const archive = await exec(
    'git',
    [
      'archive',
      '--format=tar',
      OLD_BASE,
      'src',
      'tests/dbos-prune/worker.ts',
      'tsconfig.json',
      'package.json',
      'pnpm-lock.yaml',
    ],
    { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 },
  );
  await writeFile(`${directory}/source.tar`, archive.stdout);
  await exec('tar', ['-xf', `${directory}/source.tar`, '-C', directory]);
  await symlink(resolve('node_modules'), `${directory}/node_modules`, 'dir');
  expect(sha(await readFile(`${directory}/pnpm-lock.yaml`))).toBe(
    sha(await readFile('pnpm-lock.yaml')),
  );
  const path = `${directory}/worker.cjs`;
  const built = await exec(
    resolve('node_modules/.bin/esbuild'),
    ['tests/dbos-prune/worker.ts', ...buildArgs, `--outfile=${path}`],
    { cwd: directory },
  );
  evidence.push({
    oldBase: OLD_BASE,
    archiveSha256: sha(archive.stdout),
    oldArtifact: path,
    oldSha256: sha(await readFile(path)),
    build: built,
  });
  return path;
}
beforeAll(async () => {
  // CI must provide full checkout history or the separately verified old artifact.
  // Fail before opening any pool/worker when the required immutable source is absent.
  await exec('git', ['cat-file', '-e', `${OLD_BASE}^{commit}`]);
  db = postgres(safeUrl().toString(), { max: 3 });
  await exec(resolve('node_modules/.bin/esbuild'), [
    'tests/dbos-review-orphan/worker.ts',
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
  if (process.env.TLP_REVIEW_EVIDENCE_PATH)
    await writeFile(
      process.env.TLP_REVIEW_EVIDENCE_PATH,
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
    await db`update review_orphan_control set phase = 'pg-boss', legacy_not_before = null`;
    await db.end();
  }
});

describe('actual review orphan crash and recovery', () => {
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
      const id = `review-crash-${randomUUID()}`;
      const first = worker({ id, pauseAt });
      await first.wait('ready');
      await first.wait('boundary');
      await first.kill();
      const before = await snapshots(id);
      if (pauseAt === 'row-committed' || pauseAt === 'checkpoint-saved') {
        await db`update learning_session set status = 'started', started_at = '2026-10-09T01:00:00Z', version = version + 1, ended_at = null where id = 'crash-a'`;
        // The user's existing writer is exercised separately by the SQL/domain suite.
      }
      if (pauseAt !== 'admission-uncommitted')
        await db`insert into learning_session (id,type,status,started_at,version) values ('later-d','review','started','2026-10-08T10:00:00Z',0)`;
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
          status: 'started',
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
      const id = `review-fault-${randomUUID()}`;
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
    const id = `review-unknown-${randomUUID()}`;
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
      const client = await DBOSClient.create({
        systemDatabaseUrl: safeUrl().toString(),
        systemDatabaseSchemaName: 'tlp_dbos',
        systemDatabasePoolSize: 1,
        applicationName: 'tlp-housekeeping',
      });
      try {
        const resumed = await client.resumeWorkflow(id);
        expect((await resumed.getStatus())?.status).toBe('ERROR');
      } finally {
        await client.destroy();
      }

      const retry = worker({ id, recover: true });
      await retry.wait('ready');
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
      evidence.push({ unknownId: id, before, after, terminalErrorWasNotRetried: true });
      if (retry.child.exitCode === null && retry.child.signalCode === null) await retry.kill();
    } finally {
      if (first.child.exitCode === null && first.child.signalCode === null) await first.kill();
      await proxy.stop();
    }
  }, 120000);
  it('demonstrates why a selected-row pre-migration consumer must be quiesced before cutover', async () => {
    const seed = worker();
    await seed.wait('ready');
    await seed.stop();
    await reset();
    await db`update review_orphan_control set phase = 'pg-boss'`;
    const id = `old-consumer-${randomUUID()}`;
    await db`insert into learning_session (id,type,status,started_at) values (${id},'review','started',clock_timestamp() - interval '7 hours')`;
    const directory = resolve(`.cache/yuk1393-old-consumer-${process.pid}`);
    await mkdir(directory, { recursive: true });
    const archive = await exec(
      'git',
      [
        'archive',
        '--format=tar',
        OLD_BASE,
        'src',
        'tsconfig.json',
        'package.json',
        'pnpm-lock.yaml',
      ],
      { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 },
    );
    await writeFile(`${directory}/source.tar`, archive.stdout);
    await exec('tar', ['-xf', `${directory}/source.tar`, '-C', directory]);
    await symlink(resolve('node_modules'), `${directory}/node_modules`, 'dir');
    // This temporary actor imports the exact archived old handler; only its selection
    // promise is observed/held. It has no new family fence or alternate state writer.
    const actorSource = `
      const url = new URL(process.env.DATABASE_URL);
      if (process.env.TLP_REVIEW_TEST_PROCESS !== '1' || !/^\\/test_fork_\\d+$/.test(url.pathname) || !['localhost','127.0.0.1'].includes(url.hostname)) throw new Error('Disposable DB required');
      const postgres = (await import('postgres')).default;
      const { drizzle } = await import('drizzle-orm/postgres-js');
      const schema = await import('@/db/schema');
      const db = drizzle(postgres(url.toString(), {max:2,ssl:false}), {schema});
      const { runPruneOrphanReviewSessions } = await import('@/server/boss/handlers/prune_orphan_review_sessions');
      let release; const held = new Promise(resolve => release = resolve);
      process.on('message', message => { if (message.kind === 'release') release(); });
      const select = db.select.bind(db);
      db.select = (...args) => {
        const builder = select(...args); const from = builder.from.bind(builder);
        builder.from = (...tables) => {
          const selection = from(...tables); const where = selection.where.bind(selection);
          selection.where = (...conditions) => {
          const query = where(...conditions); const then = query.then.bind(query);
          query.then = (fulfilled, rejected) => then(async rows => {
            process.send({kind:'old-selected', ids:rows.map(row => row.id)}); await held;
            return fulfilled(rows);
          }, rejected);
            return query;
          };
          return selection;
        };
        return builder;
      };
      const result = await runPruneOrphanReviewSessions(db);
      await new Promise(resolve => process.send({kind:'old-done', result}, resolve)); await db.$client.end(); process.disconnect();
    `;
    await writeFile(
      `${directory}/actor.mjs`,
      `(async () => {${actorSource}})().catch(error => { process.send({kind:'failure',error:String(error)});process.exit(1); });`,
    );
    const actor = `${directory}/actor.cjs`;
    await exec(
      resolve('node_modules/.bin/esbuild'),
      ['actor.mjs', ...buildArgs, `--outfile=${actor}`],
      { cwd: directory },
    );
    const old = worker({ oldBundle: actor });
    const selected = await old.wait('old-selected');
    const current = worker();
    await current.wait('ready');
    current.child.send({ kind: 'transition', phase: 'draining-pg-boss' });
    await current.wait('ack');
    current.child.send({ kind: 'transition', phase: 'dbos' });
    expect((await current.wait('rejected')).error).toContain('quiescence');
    old.child.send({ kind: 'release' });
    await old.wait('old-done');
    await expect
      .poll(async () => (await db`select status from learning_session where id = ${id}`)[0].status)
      .toBe('abandoned');
    expect(await db`select * from review_orphan_receipt where session_id = ${id}`).toHaveLength(0);
    expect(
      await db`select * from job_events where business_id = ${id} and event_type = 'review.abandoned'`,
    ).toHaveLength(1);
    await expect.poll(() => old.child.exitCode).toBe(0);
    current.child.send({
      kind: 'quiesce',
      reason: 'Observed the selected old process exit; no old consumer remains',
    });
    await current.wait('ack');
    current.child.send({ kind: 'transition', phase: 'dbos' });
    await current.wait('ack');
    evidence.push({
      oldBase: OLD_BASE,
      selected,
      oldActorSha256: sha(await readFile(actor)),
      archivedHandlerSha256: sha(
        await readFile(`${directory}/src/server/boss/handlers/prune_orphan_review_sessions.ts`),
      ),
      oldEffectAcrossDrain: true,
    });
    await current.stop();
  }, 120000);
  it('recovers the genuine old prune-v1 bundle both before and after review admission', async () => {
    const seed = worker();
    await seed.wait('ready');
    await seed.stop();
    const artifact = await oldArtifact();
    for (const admitted of [false, true]) {
      await reset();
      await db`update prune_job_events_control set phase = 'dbos'`;
      const id = `old-prune-${randomUUID()}`;
      await db`insert into job_events (business_table,business_id,event_type,payload,occurred_at) values ('echo_jobs','old','echo.queued','{}','2026-01-01T00:00:00Z')`;
      const old = worker({ oldBundle: artifact, pruneId: id });
      await old.wait('ready');
      await old.wait('boundary');
      await old.kill();
      const before = await db`select * from prune_job_events_receipt where workflow_id = ${id}`;
      const current = worker({ id: admitted ? `review-admit-${randomUUID()}` : undefined });
      await current.wait('ready');
      if (admitted) await current.wait('done');
      await expect
        .poll(
          async () =>
            (await db`select status from tlp_dbos.workflow_status where workflow_uuid = ${id}`)[0]
              ?.status,
          { timeout: 30000 },
        )
        .toBe('SUCCESS');
      expect(await db`select * from prune_job_events_receipt where workflow_id = ${id}`).toEqual(
        before,
      );
      expect(before).toHaveLength(1);
      expect(before[0].deleted).toBeGreaterThanOrEqual(1);
      const steps =
        await db`select function_name from tlp_dbos.operation_outputs where workflow_uuid = ${id}`;
      expect(steps.filter((s) => s.function_name === 'prune-business-commit')).toHaveLength(1);
      evidence.push({ oldPruneId: id, admitted, receipt: before, steps });
      await current.stop();
    }
  }, 180000);
});
