import { type ChildProcess, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { gateCapability } from '@/capabilities/practice/testing/pi-dbos-gate/manifest';
import {
  type GateSql,
  arrangeNext,
  createGateSchema,
  digest,
  readSnapshot,
  receiptSchema,
  recordAnswer,
} from '@/capabilities/practice/testing/pi-dbos-gate/operations';
import { buildHonoApp } from '../../server/app';
import { answerFixture, modelCommand } from './fixture';
import type { Boundary, GateJob } from './workflow';

const ipcSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('boundary'), boundary: z.string(), pid: z.number() }),
  z.object({
    kind: z.literal('done'),
    pid: z.number(),
    result: z.unknown(),
    steps: z.array(
      z.object({ functionID: z.number(), name: z.string(), output: z.unknown() }).passthrough(),
    ),
    status: z
      .object({ status: z.string(), recoveryAttempts: z.number(), applicationVersion: z.string() })
      .passthrough(),
  }),
  z.object({ kind: z.literal('failure'), error: z.string() }),
]);
type IpcMessage = z.infer<typeof ipcSchema>;

const codeFiles = [
  'src/capabilities/practice/testing/pi-dbos-gate/operations.ts',
  'src/capabilities/practice/testing/pi-dbos-gate/manifest.ts',
  'tests/pi-dbos-gate/fixture.ts',
  'tests/pi-dbos-gate/workflow.ts',
  'tests/pi-dbos-gate/worker.ts',
  'tests/pi-dbos-gate/recovery.db.test.ts',
  'tests/pi-dbos-gate/contract.unit.test.ts',
  'package.json',
  'pnpm-lock.yaml',
  'vitest.shared.ts',
];
let sql: GateSql;
let codeDigest: string;
let sourceHashes: { path: string; sha256: string }[];
const children = new Set<ChildProcess>();
const evidence: unknown[] = [];

function startWorker(job: GateJob, mode: 'start' | 'recover', pauseAt = '') {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', resolve('tests/pi-dbos-gate/worker.ts'), mode],
    {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: {
        PATH: process.env.PATH,
        NODE_ENV: 'test',
        TLP_GATE_DATABASE_URL: process.env.TEST_DATABASE_URL,
        TLP_GATE_TEST_PROCESS: '1',
        TLP_GATE_JOB: JSON.stringify(job),
        TLP_GATE_PAUSE_AT: pauseAt,
        TLP_GATE_CODE_DIGEST: codeDigest,
      },
    },
  );
  children.add(child);
  const exited = once(child, 'exit');
  const queue: IpcMessage[] = [];
  let logs = '';
  let terminal = false;
  let wake: (() => void) | undefined;
  child.stdout?.on('data', (chunk) => {
    logs = (logs + String(chunk)).slice(-4000);
  });
  child.stderr?.on('data', (chunk) => {
    logs = (logs + String(chunk)).slice(-4000);
  });
  child.on('message', (message) => {
    queue.push(ipcSchema.parse(message));
    wake?.();
  });
  child.on('exit', () => {
    terminal = true;
    children.delete(child);
    wake?.();
  });
  async function waitFor(kind: 'boundary' | 'done') {
    const deadline = Date.now() + 20000;
    while (true) {
      const message = queue.shift();
      if (message?.kind === 'failure')
        throw new Error(`Gate worker failed: ${message.error}\n${logs}`);
      if (message?.kind === kind) return message;
      if (terminal) throw new Error(`Gate worker exited before ${kind}: ${logs}`);
      if (Date.now() >= deadline) throw new Error(`Gate worker timed out before ${kind}: ${logs}`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 50);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
  }
  return { child, exited, waitFor };
}

function jobFor(learnerId: string, entry: GateJob['entry'] = 'pi'): GateJob {
  return {
    workflowId: randomUUID(),
    learnerId,
    entry,
    validUntil: new Date(Date.now() + 60000).toISOString(),
    timestamp: Date.now(),
  };
}

async function finish(worker: ReturnType<typeof startWorker>) {
  const message = await worker.waitFor('done');
  if (message.kind !== 'done') throw new Error('Expected workflow completion');
  const [code, signal] = await worker.exited;
  expect({ code, signal }).toEqual({ code: 0, signal: null });
  expect(message.status.status).toBe('SUCCESS');
  return message;
}

async function readOutcome(job: GateJob) {
  const snapshot = await readSnapshot(sql, job.learnerId);
  const effects = await sql`select * from yuk1338.effect where learner_id = ${job.learnerId}`;
  const [row] =
    await sql`select result from yuk1338.receipt where operation_id = ${`${job.workflowId}:arrange:0`}`;
  const attempts =
    await sql`select turn, input_digest, response from yuk1338.model_attempt where workflow_id = ${job.workflowId} order by created_at`;
  return { snapshot, effects, receipt: receiptSchema.parse(row?.result), attempts };
}

beforeAll(async () => {
  // setup.db-fork.ts supplies only the fresh Testcontainers database, never a .env database.
  const target = new URL(z.string().parse(process.env.TEST_DATABASE_URL));
  expect(target.pathname).toMatch(/^\/test_fork_\d+$/);
  sql = postgres(target.toString(), { max: 2 });
  await createGateSchema(sql);
  sourceHashes = await Promise.all(
    codeFiles.map(async (path) => ({
      path,
      sha256: createHash('sha256')
        .update(await readFile(path))
        .digest('hex'),
    })),
  );
  codeDigest = digest(sourceHashes);
});

afterAll(async () => {
  for (const child of children) {
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
  }
  await sql?.end();
  vi.unstubAllEnvs();
  if (process.env.TLP_GATE_EVIDENCE_PATH) {
    await writeFile(
      process.env.TLP_GATE_EVIDENCE_PATH,
      `${JSON.stringify(
        {
          capturedAt: new Date().toISOString(),
          codeDigest,
          codeFiles,
          sourceHashes,
          node: process.version,
          dbos: '5.2.11',
          pi: '1.0.2',
          provider: 'controlled replacement, no external calls',
          gatePassed: evidence.length === 10,
          evidence,
        },
        null,
        2,
      )}\n`,
    );
  }
});

describe('YUK-1338 real Pi + DBOS process recovery gate', () => {
  it('new independent answer changes the saved next activity and records effective version and latency', async () => {
    const learnerId = randomUUID();
    const assisted = await recordAnswer(sql, learnerId, answerFixture('assisted-before'));
    const assistedCommitAck = performance.now();
    const assistedJob = jobFor(learnerId);
    await finish(startWorker(assistedJob, 'start'));
    const first = await readOutcome(assistedJob);
    const assistedObservedLatencyMs = performance.now() - assistedCommitAck;
    expect(first.snapshot.nextActivity).toBe('ellipse-supported-review');
    expect(first.receipt.kind).toBe('accepted');
    const independent = await recordAnswer(
      sql,
      learnerId,
      answerFixture('independent-after', true),
    );
    const independentCommitAck = performance.now();
    expect(independent.version).toBe(3);
    expect(independent.nextActivity).toBeNull();
    const independentJob = jobFor(learnerId);
    await finish(startWorker(independentJob, 'start'));
    const second = await readOutcome(independentJob);
    const independentObservedLatencyMs = performance.now() - independentCommitAck;
    expect(second.snapshot.nextActivity).toBe('ellipse-transfer');
    expect(second.snapshot.version).toBe(4);
    expect(second.receipt.kind).toBe('accepted');
    if (first.receipt.kind === 'accepted' && second.receipt.kind === 'accepted') {
      expect(first.receipt.latencyMs).toBeGreaterThanOrEqual(0);
      expect(second.receipt.latencyMs).toBeGreaterThanOrEqual(0);
    }
    expect(second.effects).toHaveLength(2);
    evidence.push({
      scenario: 'evidence-changes-arrangement',
      assistedJob,
      independentJob,
      inputs: [assisted, independent],
      receipts: [first.receipt, second.receipt],
      commitAckToEffectObservedMs: [assistedObservedLatencyMs, independentObservedLatencyMs],
      finalVersion: second.snapshot.version,
      finalActivity: second.snapshot.nextActivity,
      effects: second.effects.length,
    });
  });
  it.each<Boundary>(['model-returned', 'model-saved', 'tool-committed', 'tool-receipt-saved'])(
    'SIGKILL at %s recovers with a single business effect',
    async (boundary) => {
      const learnerId = randomUUID();
      const first = await recordAnswer(sql, learnerId, answerFixture('assisted-a'));
      const snapshot = await recordAnswer(sql, learnerId, answerFixture('independent-b', true));
      expect(snapshot.version).toBe(first.version + 1);
      const job = jobFor(learnerId);
      const worker = startWorker(job, 'start', boundary);
      const paused = await worker.waitFor('boundary');
      expect(paused.kind).toBe('boundary');
      const [before] =
        await sql`select status from yuk1338_dbos.workflow_status where workflow_uuid = ${job.workflowId}`;
      expect(before?.status).toBe('PENDING');
      const effectsBefore = await sql`select * from yuk1338.effect where learner_id = ${learnerId}`;
      expect(effectsBefore.length).toBe(boundary.startsWith('tool-') ? 1 : 0);
      worker.child.kill('SIGKILL');
      const [exitCode, signal] = await worker.exited;
      expect({ exitCode, signal }).toEqual({ exitCode: null, signal: 'SIGKILL' });
      // This process never starts a workflow. DBOS.launch() alone recovers PENDING work.
      const done = await finish(startWorker(job, 'recover'));
      expect(done.pid).not.toBe(worker.child.pid);
      expect(done.status.recoveryAttempts).toBeGreaterThan(1);
      const outcome = await readOutcome(job);
      expect(outcome.effects).toHaveLength(1);
      expect(outcome.snapshot.version).toBe(3);
      expect(outcome.snapshot.nextActivity).toBe('ellipse-transfer');
      expect(outcome.receipt.kind).toBe('accepted');
      expect(outcome.attempts.filter((attempt) => attempt.turn === 0)).toHaveLength(
        boundary === 'model-returned' ? 2 : 1,
      );
      const savedModel = done.steps.find((step) => step.name === 'model-response-0');
      expect(savedModel?.output).toEqual(
        outcome.attempts.find((attempt) => attempt.turn === 0)?.response,
      );
      expect(done.steps.map((step) => step.name)).toEqual([
        'read-state',
        'model-response-0',
        'business-commit-arrange:0',
        'tool-receipt-arrange:0',
        'model-response-1',
      ]);
      // Attaching again to a completed workflow cannot create a second effect or model request.
      await finish(startWorker(job, 'start'));
      const repeated = await readOutcome(job);
      expect(repeated.effects).toHaveLength(1);
      expect(repeated.attempts).toHaveLength(outcome.attempts.length);
      evidence.push({
        scenario: boundary,
        job,
        evidenceDigest: digest(snapshot.evidence),
        input: snapshot,
        killedPid: worker.child.pid,
        restartPid: done.pid,
        signal,
        preCrashStatus: before?.status,
        recoveryAttempts: done.status.recoveryAttempts,
        applicationVersion: done.status.applicationVersion,
        steps: done.steps.map(({ name, output }) => ({ name, outputDigest: digest(output) })),
        receipt: outcome.receipt,
        finalVersion: outcome.snapshot.version,
        effects: outcome.effects.length,
        modelAttempts: outcome.attempts.map((attempt) => ({
          turn: attempt.turn,
          inputDigest: attempt.input_digest,
          outputDigest: digest(attempt.response),
          response: attempt.response,
        })),
        externalOutcome:
          boundary === 'model-returned'
            ? 'unknown before checkpoint; replacement called twice'
            : 'saved response reused',
      });
    },
    60000,
  );

  it('new evidence while reasoning rejects the late saved response after restart', async () => {
    const learnerId = randomUUID();
    await recordAnswer(sql, learnerId, answerFixture('assisted'));
    const job = jobFor(learnerId);
    const worker = startWorker(job, 'start', 'model-saved');
    await worker.waitFor('boundary');
    const newer = await recordAnswer(sql, learnerId, answerFixture('independent', true));
    worker.child.kill('SIGKILL');
    await worker.exited;
    await finish(startWorker(job, 'recover'));
    const old = await readOutcome(job);
    expect(old.receipt).toEqual({
      kind: 'rejected',
      reason: 'stale-version',
      version: newer.version,
    });
    expect(old.effects).toHaveLength(0);
    expect(old.snapshot).toEqual(newer);
    expect(old.attempts.filter((attempt) => attempt.turn === 0)).toHaveLength(1);
    const freshJob = jobFor(learnerId);
    await finish(startWorker(freshJob, 'start'));
    const fresh = await readOutcome(freshJob);
    expect(fresh.snapshot.nextActivity).toBe('ellipse-transfer');
    expect(fresh.effects).toHaveLength(1);
    evidence.push({
      scenario: 'stale-after-restart',
      staleJob: job,
      freshJob,
      receipt: old.receipt,
      freshReceipt: fresh.receipt,
      evidenceVersion: newer.version,
      staleEffects: 0,
      finalVersion: fresh.snapshot.version,
    });
  }, 60000);

  it('rejects expired results without changing learner state or effects', async () => {
    const learnerId = randomUUID();
    const snapshot = await recordAnswer(sql, learnerId, answerFixture('expiry'));
    const job = { ...jobFor(learnerId), validUntil: new Date(Date.now() + 6000).toISOString() };
    const worker = startWorker(job, 'start', 'model-saved');
    await worker.waitFor('boundary');
    const [clock] = await sql`select clock_timestamp() < ${job.validUntil}::timestamptz as valid`;
    expect(clock?.valid).toBe(true);
    await sql`select pg_sleep(greatest(0, extract(epoch from (${job.validUntil}::timestamptz - clock_timestamp()))) + 0.01)`;
    worker.child.kill('SIGKILL');
    await worker.exited;
    await finish(startWorker(job, 'recover'));
    const outcome = await readOutcome(job);
    expect(outcome.receipt).toEqual({
      kind: 'rejected',
      reason: 'expired',
      version: snapshot.version,
    });
    expect(outcome.snapshot).toEqual(snapshot);
    expect(outcome.effects).toHaveLength(0);
    evidence.push({ scenario: 'expired', job, receipt: outcome.receipt, effects: 0 });
  });

  it('page command, Pi tool and background workflow share the same idempotent operation', async () => {
    vi.stubEnv('INTERNAL_TOKEN', 'yuk1338-test-only-token');
    const receipts = [];
    for (const entry of ['page', 'pi', 'background']) {
      const learnerId = randomUUID();
      const snapshot = await recordAnswer(sql, learnerId, answerFixture(`entry-${entry}`, true));
      const job = jobFor(learnerId, entry === 'background' ? 'background' : 'pi');
      const command = modelCommand(snapshot, `${job.workflowId}:arrange:0`, job.validUntil);
      if (entry === 'page') {
        const app = buildHonoApp([gateCapability(sql)], {
          epochGate: async () => ({ runnable: true }),
        });
        for (const token of [undefined, 'wrong-token']) {
          const response = await app.request('/api/yuk1338-gate/arrange', {
            method: 'POST',
            headers: token ? { 'x-internal-token': token } : {},
            body: JSON.stringify(command),
          });
          expect(response.status).toBe(401);
        }
        const [before] =
          await sql`select count(*)::integer as count from yuk1338.effect where learner_id = ${learnerId}`;
        expect(before?.count).toBe(0);
        const response = await app.request('/api/yuk1338-gate/arrange', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-internal-token': 'yuk1338-test-only-token',
          },
          body: JSON.stringify(command),
        });
        expect(response.status).toBe(200);
        expect(receiptSchema.parse(await response.json()).kind).toBe('accepted');
      } else {
        await finish(startWorker(job, 'start'));
      }
      const outcome = await readOutcome(job);
      expect(outcome.receipt.kind).toBe('accepted');
      expect(outcome.effects).toHaveLength(1);
      expect(await arrangeNext(sql, command)).toEqual(outcome.receipt);
      await expect(
        arrangeNext(sql, { ...command, rationale: `${command.rationale} changed payload` }),
      ).rejects.toThrow('Operation identity conflict');
      expect(outcome.snapshot.nextActivity).toBe('ellipse-transfer');
      receipts.push({
        entry,
        receipt: outcome.receipt,
        effects: outcome.effects.length,
        operationId: command.operationId,
      });
    }
    evidence.push({ scenario: 'shared-operation', receipts, unauthorizedStatus: 401 });
  }, 60000);

  it('concurrent results for the same version accept one effect; evidence replay does not advance version', async () => {
    const learnerId = randomUUID();
    const answer = answerFixture('concurrent', true);
    const snapshot = await recordAnswer(sql, learnerId, answer);
    expect(await recordAnswer(sql, learnerId, answer)).toEqual(snapshot);
    await expect(recordAnswer(sql, learnerId, { ...answer, independent: false })).rejects.toThrow(
      'Evidence identity conflict',
    );
    const command = modelCommand(
      snapshot,
      randomUUID(),
      new Date(Date.now() + 60000).toISOString(),
    );
    const results = await Promise.all([
      arrangeNext(sql, command),
      arrangeNext(sql, { ...command, operationId: randomUUID() }),
    ]);
    expect(results.filter((receipt) => receipt.kind === 'accepted')).toHaveLength(1);
    expect(results.filter((receipt) => receipt.kind === 'rejected')).toEqual([
      { kind: 'rejected', reason: 'stale-version', version: 2 },
    ]);
    const effects = await sql`select * from yuk1338.effect where learner_id = ${learnerId}`;
    expect(effects).toHaveLength(1);
    evidence.push({
      scenario: 'concurrent-version-fence',
      inputVersion: snapshot.version,
      results,
      effects: 1,
    });
  });
  it('expiry is checked after a contended learner lock is acquired', async () => {
    const learnerId = randomUUID();
    const snapshot = await recordAnswer(sql, learnerId, answerFixture('lock-expiry', true));
    const command = modelCommand(snapshot, randomUUID(), new Date(Date.now() + 1500).toISOString());
    const locked = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const contender = postgres(z.string().parse(process.env.TEST_DATABASE_URL), {
      max: 1,
      connection: { application_name: 'yuk1338-expiry-contender' },
    });
    const blocker = sql.begin(async (tx) => {
      await tx`select id from yuk1338.learner where id = ${learnerId} for update`;
      locked.resolve();
      await release.promise;
    });
    await locked.promise;
    const pending = arrangeNext(contender, command);
    try {
      await vi.waitFor(
        async () => {
          const [row] = await sql`select count(*)::integer as count from pg_stat_activity
          where application_name = 'yuk1338-expiry-contender' and wait_event_type = 'Lock'`;
          expect(row?.count).toBe(1);
        },
        { timeout: 1000, interval: 20 },
      );
      await sql`select pg_sleep(greatest(0, extract(epoch from (${command.validUntil}::timestamptz - clock_timestamp()))) + 0.01)`;
      release.resolve();
      await blocker;
      const receipt = await pending;
      expect(receipt).toEqual({ kind: 'rejected', reason: 'expired', version: snapshot.version });
      expect(await readSnapshot(sql, learnerId)).toEqual(snapshot);
      evidence.push({
        scenario: 'expiry-after-lock-wait',
        command,
        receipt,
        observedLockWait: true,
        effects: 0,
      });
    } finally {
      release.resolve();
      await blocker;
      await pending;
      await contender.end();
    }
  });
});
