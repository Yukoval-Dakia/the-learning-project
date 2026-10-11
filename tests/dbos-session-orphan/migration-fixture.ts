import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { type Socket, createConnection, createServer } from 'node:net';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { type TestContext, expect } from 'vitest';
import { z } from 'zod';
import type { Db } from '@/db/client';
import * as schema from '@/db/schema';
import {
  type ChildExit,
  assertFixtureCanReset,
  cleanupOwnedChildren,
  errorDiagnostic,
  fixtureErrorMessage,
  fixtureMessageSchema,
  metafileExternals,
  nonterminalDurableWork,
  oldArtifactDependencyDrift,
  requireSpecifiers,
  sanitizeDiagnostic,
  waitForFixtureMessage,
} from '../dbos-review-orphan/fixture-process';

export function createMigrationFixture(label: 'conversation' | 'placement' | 'legacy') {
  const OLD_BASE = '6aaf8ca89eaf5feb5af5c00b7c5b3bd90cd953ea';
  const REVIEW_BASE = '3be966000e53842dc9592df60c367b5af14660fb';
  const families = [
    'prune_orphan_conversation_sessions',
    'prune_orphan_placement_sessions',
  ] as const;
  let selectedFamily: (typeof families)[number] = families[0];
  const scheduledAt = '2026-10-09T00:00:00.000Z';
  const nextId = () =>
    `sched-${selectedFamily}-${new Date(Date.parse(scheduledAt) + ++serial).toISOString()}`;
  let serial = 0;
  const exec = promisify(execFile);
  const identity = `${label}-${process.pid}-${randomUUID()}`;
  const bundle = resolve(`.cache/yuk1394-session-${identity}.cjs`);
  const children = new Map<ChildProcess, Promise<ChildExit>>();
  const logs: unknown[] = [];
  const evidence: unknown[] = [];
  let caseLogStart = 0;
  let suiteBlocked: string | undefined = 'Session fixture setup has not completed';
  let hadCaseFailure = false;
  let db: ReturnType<typeof postgres>;
  let appDb: Db;
  let fixtureUrl: string | undefined;
  const messageSchema = fixtureMessageSchema;
  const diagnosticSecrets: string[] = [];
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
    const url = new URL(z.url().parse(fixtureUrl ?? process.env.TEST_DATABASE_URL));
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
    assertFixtureCanReset([], suiteBlocked);
    const url = safeUrl();
    const requestId = options.id ?? options.reviewId ?? options.pruneId ?? randomUUID();
    const secrets = [
      url.toString(),
      url.password,
      decodeURIComponent(url.password),
      options.appUrl ?? '',
    ];
    diagnosticSecrets.push(...secrets);
    const child = spawn(process.execPath, [options.oldBundle ?? bundle], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: {
        PATH: process.env.PATH,
        NODE_PATH: resolve('node_modules'),
        NODE_ENV: 'test',
        DATABASE_URL: url.toString(),
        TLP_SESSION_REQUEST_ID: requestId,
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
    const exited = new Promise<ChildExit>((resolveExit) => {
      child.once('exit', (code, signal) => resolveExit([code, signal]));
    });
    children.set(child, exited);
    const messages: z.infer<typeof messageSchema>[] = [];
    const record: {
      pid: number | undefined;
      database: string;
      family: (typeof families)[number];
      requestId: string;
      bundle: string;
      pauseAt: string | undefined;
      recover: boolean;
      stdout: string;
      stderr: string;
      messages: unknown[];
      exit: { code: ChildExit[0]; signal: ChildExit[1] } | null;
    } = {
      pid: child.pid,
      database: url.pathname.slice(1),
      family: selectedFamily,
      requestId,
      bundle: options.oldBundle ?? bundle,
      pauseAt: options.pauseAt,
      recover: options.recover ?? false,
      stdout: '',
      stderr: '',
      messages: [],
      exit: null,
    };
    logs.push(record);
    child.stdout?.on('data', (c) => {
      record.stdout += String(c);
    });
    child.stderr?.on('data', (c) => {
      record.stderr += String(c);
    });
    child.on('message', (m) => {
      record.messages.push(m);
      const parsed = messageSchema.safeParse(m);
      messages.push(
        parsed.success
          ? parsed.data
          : fixtureErrorMessage({
              kind: 'failure',
              error: parsed.error,
              pid: child.pid ?? process.pid,
              database: record.database,
              stage: 'invalid-worker-ipc',
              requestId,
              secrets,
            }),
      );
    });
    child.on('error', (error) => {
      const failure = fixtureErrorMessage({
        kind: 'failure',
        error,
        pid: child.pid ?? process.pid,
        database: record.database,
        stage: 'child-process-error',
        requestId,
        secrets,
      });
      record.messages.push(failure);
      messages.push(failure);
    });
    child.on('exit', (code, signal) => {
      children.delete(child);
      record.exit = { code, signal };
    });
    async function wait(kind: string) {
      return waitForFixtureMessage({
        messages,
        expected: kind,
        exited: () => record.exit !== null,
        evidence: () => record,
        timeoutMs: 30000,
        accept: (message) =>
          kind !== 'boundary' ||
          !options.id ||
          message.workflowId === options.id ||
          (!message.workflowId && message.requestId === options.id),
      });
    }
    async function kill() {
      child.kill('SIGKILL');
      expect(await exited).toEqual([null, 'SIGKILL']);
    }
    async function stop() {
      child.send({ kind: 'stop' });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        expect(
          await Promise.race([
            exited,
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () =>
                  reject(new Error(`Owned worker shutdown timed out: ${JSON.stringify(record)}`)),
                30000,
              );
            }),
          ]),
        ).toEqual([0, null]);
      } finally {
        clearTimeout(timer);
      }
    }
    return { child, exited, wait, kill, stop };
  }
  async function reset() {
    assertFixtureCanReset(children.keys(), suiteBlocked);
    assertSettledCaseState(await observeCaseState(false));
    // Retain admissions, receipts and dispositions, including explicitly retired ERRORs.
    await db`truncate learning_session, job_events cascade`;
    await db`update session_orphan_control set phase = 'dbos', legacy_not_before = null, phase_changed_at = clock_timestamp()`;
    await db`update prune_job_events_control set phase = 'pg-boss'`;
    await db`update review_orphan_control set phase = 'pg-boss'`;
  }
  async function observeCaseState(includeApp: boolean) {
    const [{ sessionOrphanObligations }, { reviewOrphanObligations }, { pruneObligations }] =
      await Promise.all([
        import('@/server/durable/session-orphan-backend'),
        import('@/server/durable/review-orphan-family'),
        import('@/server/durable/prune-family'),
      ]);
    return drizzle(db).transaction(
      async (tx) => {
        await tx.execute(sql`set local statement_timeout = '3s'`);
        await tx.execute(sql`set local lock_timeout = '1s'`);
        const [relations] =
          await tx.execute(sql`select to_regclass('tlp_dbos.workflow_status') as workflows,
      to_regclass('pgboss.job') as jobs`);
        const workflows = z
          .array(z.object({ workflow_uuid: z.string(), status: z.string() }).passthrough())
          .parse(
            relations.workflows
              ? await tx.execute(
                  sql`select workflow_uuid,name,status,recovery_attempts from tlp_dbos.workflow_status order by workflow_uuid`,
                )
              : [],
          );
        const obligations: unknown[] = [];
        for (const backend of ['dbos', 'pg-boss'] as const) {
          if (!(backend === 'dbos' ? relations.workflows : relations.jobs)) continue;
          for (const family of families)
            obligations.push(...(await sessionOrphanObligations(tx, { family, backend })));
          obligations.push(
            ...(await reviewOrphanObligations(tx, backend)).map((row) => ({
              family: 'prune_orphan_review_sessions',
              backend,
              ...row,
            })),
            ...(await pruneObligations(tx, backend)).map((row) => ({
              family: 'prune_job_events',
              backend,
              ...row,
            })),
          );
        }
        return {
          workflows,
          obligations,
          ...(includeApp
            ? {
                ticks: await tx.execute(
                  sql`select * from session_orphan_tick order by family,tick_id`,
                ),
                receipts: await tx.execute(
                  sql`select * from session_orphan_receipt order by family,tick_id,session_id`,
                ),
                dispositions: await tx.execute(sql`select * from session_orphan_disposition`),
                reviewTicks: await tx.execute(
                  sql`select * from review_orphan_tick order by tick_id`,
                ),
                reviewReceipts: await tx.execute(
                  sql`select * from review_orphan_receipt order by tick_id,session_id`,
                ),
                reviewDispositions: await tx.execute(sql`select * from review_orphan_disposition`),
                pruneReceipts: await tx.execute(
                  sql`select * from prune_job_events_receipt order by workflow_id`,
                ),
                pruneDispositions: await tx.execute(
                  sql`select * from prune_job_events_disposition`,
                ),
                sessions: await tx.execute(
                  sql`select id,type,status,version,started_at::text from learning_session order by id`,
                ),
                events: await tx.execute(
                  sql`select business_id,event_type from job_events order by business_id,event_type`,
                ),
                control: await tx.execute(
                  sql`select * from session_orphan_control order by family`,
                ),
                legacyJobs: relations.jobs
                  ? await tx.execute(
                      sql`select id::text,name,state::text from pgboss.job where name in (${families[0]},${families[1]},'prune_orphan_review_sessions','prune_job_events','__pgboss__send-it') order by id`,
                    )
                  : [],
              }
            : {}),
        };
      },
      { accessMode: 'read only' },
    );
  }
  function assertSettledCaseState(state: Awaited<ReturnType<typeof observeCaseState>>) {
    const nonterminal = nonterminalDurableWork(state.workflows);
    if (nonterminal.length || state.obligations.length)
      throw new Error(
        `Unsettled fixture state; evidence preserved: ${JSON.stringify({ nonterminal, obligations: state.obligations })}`,
      );
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
      sessions:
        await db`select id,status,version,started_at::text from learning_session order by id`,
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
      downstream.setNoDelay(true);
      if (fired && mode === 'after-server-commit-and-unavailable') {
        downstream.destroy();
        return;
      }
      const upstream = createConnection({
        host: target.hostname,
        port: Number(target.port || 5432),
      });
      upstream.setNoDelay(true);
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
            if (mode === 'after-server-commit-and-unavailable') {
              // Existing pool connections must become unavailable too. Refusing only
              // new connections lets the authoritative reread use a healthy sibling.
              evidence.push({ unavailableSocketCount: sockets.size });
              for (const socket of sockets) socket.destroy();
              sockets.clear();
            } else close();
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

  async function setup() {
    // CI must provide full checkout history or the separately verified old artifact.
    // Fail before opening any pool/worker when the required immutable source is absent.
    await exec('git', ['cat-file', '-e', `${OLD_BASE}^{commit}`]);
    await exec('git', ['cat-file', '-e', `${REVIEW_BASE}^{commit}`]);
    const target = safeUrl();
    const adminTarget = new URL(target);
    adminTarget.pathname = '/postgres';
    const admin = postgres(adminTarget.toString(), { max: 1 });
    const databaseName = `test_fork_${BigInt(`0x${randomUUID().replaceAll('-', '')}`).toString()}`;
    try {
      // Share the clone lock with the other migration fixture on this disposable
      // container's maintenance DB. No template connection or application lock.
      await admin`select pg_advisory_lock(1107, 1394)`;
      try {
        await admin.unsafe(`CREATE DATABASE "${databaseName}" TEMPLATE "test"`);
      } finally {
        await admin`select pg_advisory_unlock(1107, 1394)`;
      }
    } finally {
      await admin.end();
    }
    target.pathname = `/${databaseName}`;
    fixtureUrl = target.toString();
    db = postgres(fixtureUrl, { max: 3, connect_timeout: 2 });
    appDb = drizzle(db, { schema });
    await exec(resolve('node_modules/.bin/esbuild'), [
      'tests/dbos-session-orphan/worker.ts',
      ...buildArgs,
      `--outfile=${bundle}`,
    ]);
    await db`delete from contract_epoch`;
    suiteBlocked = undefined;
    try {
      const seed = worker();
      await seed.wait('ready');
      await seed.stop();
    } catch (error) {
      suiteBlocked = 'Initial durable host setup failed; evidence retained';
      throw error;
    }
  }
  function beforeCase() {
    caseLogStart = logs.length;
    assertFixtureCanReset(children.keys(), suiteBlocked);
  }
  async function afterCase(context: TestContext) {
    if (suiteBlocked && logs.length === caseLogStart) return;
    const failed = context.task.result?.state === 'fail';
    hadCaseFailure ||= failed;
    if (failed) {
      suiteBlocked = `Failed case ${context.task.name}; durable evidence is retained`;
      evidence.push({
        case: context.task.name,
        preCleanupLogs: structuredClone(logs.slice(caseLogStart)),
      });
      try {
        evidence.push({ case: context.task.name, preCleanupState: await observeCaseState(true) });
      } catch (error) {
        evidence.push({ case: context.task.name, observationFailure: errorDiagnostic(error) });
      }
    }
    try {
      await cleanupOwnedChildren(children);
      assertFixtureCanReset(children.keys());
    } catch (error) {
      suiteBlocked = 'Owned child cleanup did not establish process exit';
      evidence.push({ case: context.task.name, cleanupFailure: errorDiagnostic(error) });
      throw error;
    }
    try {
      const afterCleanup = await observeCaseState(false);
      evidence.push({ case: context.task.name, afterCleanup });
      assertSettledCaseState(afterCleanup);
    } catch (error) {
      suiteBlocked ??= `Unresolved post-cleanup state after ${context.task.name}`;
      evidence.push({
        case: context.task.name,
        observationOrSettlementFailure: errorDiagnostic(error),
      });
    }
    assertFixtureCanReset(children.keys(), suiteBlocked);
  }
  async function teardown() {
    let cleanupError: unknown;
    try {
      await cleanupOwnedChildren(children);
    } catch (error) {
      cleanupError = error;
      suiteBlocked = 'Final owned child cleanup did not establish process exit';
      evidence.push({ finalCleanupFailure: errorDiagnostic(error) });
    }
    try {
      if (process.env.TLP_SESSION_EVIDENCE_PATH)
        await writeFile(
          `${process.env.TLP_SESSION_EVIDENCE_PATH}.${identity}.json`,
          sanitizeDiagnostic(
            JSON.stringify(
              {
                capturedAt: new Date().toISOString(),
                node: process.version,
                execPath: process.execPath,
                bundle,
                bundleSha256: await readFile(bundle)
                  .then(sha)
                  .catch(() => null),
                logs,
                evidence,
                suiteBlocked,
                hadCaseFailure,
              },
              null,
              2,
            ),
            diagnosticSecrets,
          ),
        );
    } finally {
      if (db) {
        try {
          if (!hadCaseFailure && !suiteBlocked)
            await db`update session_orphan_control set phase = 'pg-boss', legacy_not_before = null`;
        } finally {
          await db.end({ timeout: 2 });
        }
      }
    }
    if (cleanupError) throw cleanupError;
  }
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
      // The artifact digest pins everything bundled; only its runtime requires reach node_modules.
      const { drift, runtimePackages } = oldArtifactDependencyDrift({
        baseLock: (
          await exec('git', ['show', `${base}:pnpm-lock.yaml`], { maxBuffer: 24 * 1024 * 1024 })
        ).stdout,
        currentLock: await readFile('pnpm-lock.yaml', 'utf8'),
        runtimeSpecifiers: requireSpecifiers(await readFile(artifact, 'utf8')),
      });
      expect(drift).toEqual([]);
      evidence.push({ kind, base, artifact, expected, manifest, runtimePackages });
      return artifact;
    }
    // CI with full history can compile the genuine predecessor, never reconstructed domain code.
    const archived = resolve(`.cache/yuk1394-${kind}-${identity}`);
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
    const path = `${archived}/${name}`;
    await exec(
      resolve('node_modules/.bin/esbuild'),
      [entry, ...buildArgs, `--outfile=${path}`, `--metafile=${archived}/metafile.json`],
      { cwd: archived },
    );
    const inputs = z
      .object({
        inputs: z.record(
          z.string(),
          z
            .object({
              imports: z.array(
                z.object({ path: z.string(), external: z.boolean().optional() }).passthrough(),
              ),
            })
            .passthrough(),
        ),
      })
      .passthrough()
      .parse(JSON.parse(await readFile(`${archived}/metafile.json`, 'utf8')));
    const { drift, bundledPackages, runtimePackages } = oldArtifactDependencyDrift({
      baseLock: await readFile(`${archived}/pnpm-lock.yaml`, 'utf8'),
      currentLock: await readFile('pnpm-lock.yaml', 'utf8'),
      bundledFiles: Object.keys(inputs.inputs),
      runtimeSpecifiers: metafileExternals(inputs.inputs),
    });
    expect(drift).toEqual([]);
    const sources: Record<string, string> = {};
    for (const file of Object.keys(inputs.inputs).filter((p) => !p.includes('node_modules'))) {
      sources[file] = sha(await readFile(`${archived}/${file}`));
      expect(sources[file]).toBe(
        sha(
          (await exec('git', ['show', `${base}:${file}`], { maxBuffer: 24 * 1024 * 1024 })).stdout,
        ),
      );
    }
    evidence.push({
      kind,
      base,
      artifact: path,
      artifactSha256: sha(await readFile(path)),
      archiveSha256: sha(archive.stdout),
      bundledPackages,
      runtimePackages,
      sources,
    });
    return path;
  }
  return {
    families,
    identity,
    setup,
    beforeCase,
    afterCase,
    teardown,
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
    get db() {
      return db;
    },
    get appDb() {
      return appDb;
    },
    get selectedFamily() {
      return selectedFamily;
    },
    set selectedFamily(family: (typeof families)[number]) {
      selectedFamily = family;
    },
  };
}
