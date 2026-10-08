import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { sql } from 'drizzle-orm';
import { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { z } from 'zod';
import { dispatchNativeAttempt } from '@/capabilities/practice/server/assessment/durable-attempt';
import { disposeJudgeRun } from '@/capabilities/practice/server/judge-operational';
import { readJudgeRunPermanent } from '@/capabilities/practice/server/judge-run-observation';
import { canonicalHash } from '@/core/migration/canonical';
import { JudgePendingAttemptPayload } from '@/core/schema/event/judge-pending-events';
import { event } from '@/db/schema';
import { inspectDbosJudgeInventory, sealJudgeEngineInventory } from '@/server/durable/judge-client';
import {
  inspectJudgePendingImport,
  inspectLegacyJudgeInventory,
  installJudgeProducerFence,
  mapJudgePendingOwnership,
  readJudgeFamilyControl,
  transitionJudgeFamily,
} from '@/server/durable/judge-family';
import { resetDb, testDb } from '../helpers/db';
import { frozenJudge, resetJudgeControl } from './support';

const oldRevision = '96077db1905ebab6a522b0ae36f9f22e26be5895';
const execFileAsync = promisify(execFile),
  children = new Set<ChildProcess>(),
  evidence: unknown[] = [];
let oldTree: string, boss: PgBoss;
const message = z
  .object({ kind: z.string(), runId: z.string().optional(), error: z.string().optional() })
  .passthrough();
const logs: { messages: unknown[]; stderr: string; exit?: unknown }[] = [];
function oldProducer(pauseBeforeSend = false) {
  const child = spawn(process.execPath, [resolve('.cache/yuk1356-old-judge-producer.cjs')], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: {
      PATH: process.env.PATH,
      NODE_ENV: 'test',
      DATABASE_URL: process.env.TEST_DATABASE_URL,
      TLP_JUDGE_OLD_PRODUCER: '1',
      TLP_JUDGE_OLD_REVISION: oldRevision,
      TLP_JUDGE_OLD_PAUSE_BEFORE_SEND: pauseBeforeSend ? '1' : '0',
    },
  });
  children.add(child);
  const exited = once(child, 'exit'),
    pending: z.infer<typeof message>[] = [];
  const log: (typeof logs)[number] = { messages: [], stderr: '' };
  logs.push(log);
  child.stderr?.on('data', (chunk) => (log.stderr += String(chunk)));
  child.on('message', (raw) => {
    pending.push(message.parse(raw));
    log.messages.push(raw);
  });
  child.on('exit', (code, signal) => {
    log.exit = { code, signal };
    children.delete(child);
  });
  const wait = async (kind: string) => {
    let value: z.infer<typeof message> | undefined;
    await expect
      .poll(
        () => {
          const failure = pending.find((m) => m.kind === 'failure');
          if (failure) throw new Error(`${failure.error}\n${log.stderr}`);
          const index = pending.findIndex((m) => m.kind === kind);
          if (index >= 0) value = pending.splice(index, 1)[0];
          return Boolean(value);
        },
        { timeout: 20000, interval: 25 },
      )
      .toBe(true);
    return message.parse(value);
  };
  return {
    child,
    wait,
    kill: async () => {
      child.kill('SIGKILL');
      expect(await exited).toEqual([null, 'SIGKILL']);
    },
    stop: async () => {
      child.send({ kind: 'stop' });
      expect(await exited).toEqual([0, null]);
    },
  };
}
beforeAll(async () => {
  const url = new URL(z.url().parse(process.env.TEST_DATABASE_URL));
  if (
    !/^\/test_fork_\d+$/.test(url.pathname) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  )
    throw new Error('Disposable old producer fixture required');
  oldTree = await mkdtemp(resolve(tmpdir(), 'yuk1356-old-judge-'));
  await mkdir('.cache', { recursive: true });
  const archive = resolve(oldTree, 'source.tar');
  await execFileAsync('git', ['archive', '--format=tar', oldRevision, '--output', archive]);
  await execFileAsync('tar', ['-xf', archive, '-C', oldTree]);
  await symlink(resolve('node_modules'), resolve(oldTree, 'node_modules'), 'dir');
  await mkdir(resolve(oldTree, 'tests/dbos-judge'), { recursive: true });
  await writeFile(
    resolve(oldTree, 'tests/dbos-judge/legacy-producer.ts'),
    await readFile('tests/dbos-judge/legacy-producer.ts'),
  );
  await execFileAsync(
    resolve('node_modules/.bin/esbuild'),
    [
      'tests/dbos-judge/legacy-producer.ts',
      '--bundle',
      '--platform=node',
      '--target=node24',
      '--format=cjs',
      `--outfile=${resolve('.cache/yuk1356-old-judge-producer.cjs')}`,
      '--external:pg-native',
      '--external:sharp',
      '--external:better-sqlite3',
      '--external:bufferutil',
      '--external:utf-8-validate',
      '--external:winston',
      '--external:winston-transport',
    ],
    { cwd: oldTree },
  );
  boss = new PgBoss({
    connectionString: url.toString(),
    max: 2,
    supervise: false,
    schedule: false,
  });
  boss.on('error', () => {});
  await boss.start();
  await boss.createQueue('judge_run');
  await boss.createQueue('judge_pending_reconcile');
  await installJudgeProducerFence(testDb());
}, 60000);
beforeEach(async () => {
  await resetDb();
  await resetJudgeControl(testDb());
  await boss.deleteAllJobs('judge_run');
  await boss.deleteAllJobs('judge_pending_reconcile');
  await boss.unschedule('judge_pending_reconcile');
});
afterAll(async () => {
  for (const child of children) {
    child.kill('SIGKILL');
    await once(child, 'exit');
  }
  await boss?.stop();
  const paths = [
    'tests/dbos-judge/legacy-producer.ts',
    '.cache/yuk1356-old-judge-producer.cjs',
    resolve(oldTree, 'source.tar'),
    resolve(oldTree, 'src/capabilities/practice/server/assessment/durable-attempt.ts'),
  ];
  await writeFile(
    '.cache/yuk1356-judge-cutover-evidence.json',
    JSON.stringify(
      {
        oldRevision,
        oldTree,
        node: process.version,
        evidence,
        logs,
        hashes: await Promise.all(
          paths.map(async (path) => ({
            path,
            sha256: createHash('sha256')
              .update(await readFile(path))
              .digest('hex'),
          })),
        ),
      },
      null,
      2,
    ),
  );
});
async function transition(
  nextPhase: 'draining-pg-boss' | 'dbos' | 'draining-dbos' | 'pg-boss',
  inventory = sealJudgeEngineInventory('pg-boss', []),
) {
  const control = await readJudgeFamilyControl(testDb());
  return transitionJudgeFamily(testDb(), {
    expectedEpoch: control.epoch,
    nextPhase,
    actorRef: 'test:cutover',
    evidenceRefs: ['sealed-old-process-exit', 'complete-engine-census'],
    evidenceDigest: inventory.digest,
    engineInventory: inventory,
  });
}
it('actual fixed old producer is fenced; its late original prevents exit until explicitly disposed; compatible rollback preserves slots', async () => {
  const beforeSend = oldProducer(true);
  await beforeSend.wait('ready');
  const original = await frozenJudge(testDb());
  beforeSend.child.send({
    kind: 'dispatch',
    questionId: original.id,
    request: original.request,
    capture: original.options.capture,
  });
  await beforeSend.wait('before-send');
  const [pending] = await testDb()
    .select()
    .from(event)
    .where(
      sql`${event.action}='experimental:judge_pending_attempt' and ${event.subject_id}=${original.id}`,
    );
  const runId = JudgePendingAttemptPayload.parse(pending?.payload).run_id;
  await beforeSend.kill();
  expect(
    (await inspectLegacyJudgeInventory(testDb())).items.filter((i) => i.run_id === runId),
  ).toHaveLength(0);
  await transition('draining-pg-boss');
  const producer = oldProducer();
  await producer.wait('ready');
  const late = await frozenJudge(testDb());
  producer.child.send({
    kind: 'dispatch',
    questionId: late.id,
    request: late.request,
    capture: late.options.capture,
  });
  const lateRun = z.string().parse((await producer.wait('dispatched')).runId);
  expect(
    (await inspectLegacyJudgeInventory(testDb())).items.some((i) => i.run_id === lateRun),
  ).toBe(false);
  await expect(
    dispatchNativeAttempt(
      testDb(),
      late.id,
      { ...late.request, idempotency_key: 'new-compatible-during-drain' },
      late.options,
    ),
  ).rejects.toMatchObject({ code: 'judge_draining' });
  const control = await readJudgeFamilyControl(testDb()),
    source = await inspectJudgePendingImport(testDb(), runId),
    sealed = await inspectLegacyJudgeInventory(testDb());
  await mapJudgePendingOwnership(testDb(), {
    runId,
    target: { incarnation: control.incarnation, epoch: control.epoch + 1, backend: 'dbos' },
    recoveryHistory: [],
    sourceDigest: source.digest,
    evidenceRefs: [oldRevision, 'fixed-old-source-killed-before-send'],
    engineInventory: sealed,
  });
  await expect(transition('dbos', await inspectLegacyJudgeInventory(testDb()))).rejects.toThrow(
    'Unmapped pending judge original',
  );
  await disposeJudgeRun(testDb(), lateRun, {
    reason: 'historical_unknown',
    actorRef: 'test:old-producer',
    evidenceRefs: [`evt_pending_${lateRun}`],
    evidenceDigest: canonicalHash(lateRun),
  });
  await producer.stop();
  const dbos = await transition('dbos', await inspectLegacyJudgeInventory(testDb()));
  const mapped = await readJudgeRunPermanent(testDb(), runId);
  expect(mapped.kind).toBe('pending');
  if (mapped.kind === 'pending')
    expect(mapped.delivery?.reservation.ownership.backend).toBe('dbos');
  await transition('draining-dbos');
  const rollbackControl = await readJudgeFamilyControl(testDb()),
    rollbackSource = await inspectJudgePendingImport(testDb(), runId),
    engine = await inspectDbosJudgeInventory();
  await mapJudgePendingOwnership(testDb(), {
    runId,
    target: {
      incarnation: rollbackControl.incarnation,
      epoch: rollbackControl.epoch + 1,
      backend: 'pg-boss',
    },
    recoveryHistory: [],
    sourceDigest: rollbackSource.digest,
    evidenceRefs: ['compatible-binary', 'verified-unsent-dbos-gap'],
    engineInventory: engine,
  });
  await transition('pg-boss', await inspectDbosJudgeInventory());
  const rolledBack = await readJudgeRunPermanent(testDb(), runId);
  expect(rolledBack.kind).toBe('pending');
  if (rolledBack.kind === 'pending') expect(rolledBack.delivery?.reservation.slot).toBe(1);
  expect((await readJudgeRunPermanent(testDb(), lateRun)).kind).toBe('manual');
  evidence.push({ runId, lateRun, dbos, mapped, rolledBack, oldRevision });
}, 90000);
it('unknown history and changed inventory seals cannot grant imported execution authority', async () => {
  const original = await frozenJudge(testDb());
  const runId = await dispatchNativeAttempt(
    testDb(),
    original.id,
    original.request,
    original.options,
    {
      checkRateLimit: () => 1,
      boss: {
        send: async () => {
          throw new Error('unknown legacy send');
        },
      },
    },
  );
  if (!runId) throw new Error('pending');
  await transition('draining-pg-boss');
  const control = await readJudgeFamilyControl(testDb()),
    source = await inspectJudgePendingImport(testDb(), runId),
    inventory = await inspectLegacyJudgeInventory(testDb());
  await expect(
    mapJudgePendingOwnership(testDb(), {
      runId,
      target: { incarnation: control.incarnation, epoch: control.epoch + 1, backend: 'dbos' },
      sourceDigest: source.digest,
      recoveryHistory: 'unknown',
      evidenceRefs: ['unknown-history'],
      engineInventory: inventory,
    }),
  ).rejects.toThrow('Unknown or exhausted');
  await expect(transition('dbos', { ...inventory, digest: '0'.repeat(64) })).rejects.toThrow(
    'seal conflict',
  );
});
