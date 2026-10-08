import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { z } from 'zod';
import { evaluateSubmission } from '@/capabilities/practice/server/judge/evaluate-submission';
import { disposeJudgeRun } from '@/capabilities/practice/server/judge-operational';
import { readJudgeRunPermanent } from '@/capabilities/practice/server/judge-run-observation';
import { canonicalHash } from '@/core/migration/canonical';
import type { JudgeWorkflowInputT } from '@/core/schema/event/judge-operational-events';
import { evaluation, event, job_events, material_fsrs_state } from '@/db/schema';
import { resetDb, testDb } from '../helpers/db';
import { dispatchFrozenJudge, judgeEvidence, resetJudgeControl } from './support';

const execFileAsync = promisify(execFile),
  children = new Set<ChildProcess>();
const ipc = z
  .object({ kind: z.string(), boundary: z.string().optional(), error: z.string().optional() })
  .passthrough();
const logs: {
  pid?: number;
  stdout: string;
  stderr: string;
  messages: unknown[];
  exit?: unknown;
}[] = [];
const evidence: unknown[] = [];
let wireUrl: string;
const wire: { unit: string; bodyDigest: string; at: string }[] = [];
let holdUnit: string | undefined;
const releases = new Set<() => void>();
const server = createServer(async (req, res) => {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString('utf8'),
      parsed = z
        .object({ messages: z.array(z.object({ content: z.unknown() }).passthrough()) })
        .parse(JSON.parse(body));
    const text = parsed.messages
      .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
      .join('\n');
    const names = [...text.matchAll(/"rule_id"\s*:\s*"(equations|elimination|units)"/g)].map(
      (m) => m[1],
    );
    const unit = names.at(-1);
    if (!unit) throw new Error('Controlled wire cannot locate frozen rule');
    const slot = [...text.matchAll(/"slot_id"\s*:\s*"([^"]+)"/g)].map((m) => m[1]).at(-1);
    if (!slot) throw new Error('Controlled wire cannot locate original response slot');
    wire.push({ unit, bodyDigest: canonicalHash(JSON.parse(body)), at: new Date().toISOString() });
    if (holdUnit === unit) await new Promise<void>((resolve) => releases.add(resolve));
    const answer = {
      kind: 'rule',
      rule_id: unit,
      points_awarded: ['equations', 'elimination', 'units'].indexOf(unit) + 1,
      confidence: 0.98,
      feedback_md: '真实原始证据包含方程、消元与单位。',
      evidence_citations: [{ slot_id: slot, quote: '2v=30' }],
    };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(
      `data: ${JSON.stringify({ id: 'controlled-wire', object: 'chat.completion.chunk', created: 1, model: 'gpt-4.1-mini', choices: [{ index: 0, delta: { role: 'assistant', content: JSON.stringify(answer) }, finish_reason: null }] })}\n\n`,
    );
    res.write(
      `data: ${JSON.stringify({ id: 'controlled-wire', object: 'chat.completion.chunk', created: 1, model: 'gpt-4.1-mini', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } })}\n\n`,
    );
    res.end('data: [DONE]\n\n');
  } catch (error) {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: String(error) } }));
  }
});
function worker(
  input: JudgeWorkflowInputT,
  options: { pause?: string; unit?: string; recover?: boolean } = {},
) {
  const child = spawn(process.execPath, [resolve('.cache/yuk1356-judge-worker.cjs')], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: {
      PATH: process.env.PATH,
      NODE_ENV: 'test',
      DATABASE_URL: process.env.TEST_DATABASE_URL,
      TLP_JUDGE_TEST_PROCESS: '1',
      TLP_JUDGE_INPUT: JSON.stringify(input),
      TLP_JUDGE_WIRE_URL: wireUrl,
      TLP_JUDGE_PAUSE_AT: options.pause,
      TLP_JUDGE_PAUSE_UNIT: options.unit,
      TLP_JUDGE_RECOVER: options.recover ? '1' : '0',
      AI_PROVIDER_OVERRIDE: 'openai',
      AI_PROVIDER_MODEL: 'gpt-4.1-mini',
      OPENAI_API_KEY: 'controlled-local-fixture',
      CLAUDE_CODE_MAX_RETRIES: '2',
    },
  });
  children.add(child);
  const exited = once(child, 'exit'),
    messages: z.infer<typeof ipc>[] = [];
  const log: (typeof logs)[number] = { pid: child.pid, stdout: '', stderr: '', messages: [] };
  logs.push(log);
  child.stdout?.on('data', (chunk) => (log.stdout += String(chunk)));
  child.stderr?.on('data', (chunk) => (log.stderr += String(chunk)));
  child.on('message', (raw) => {
    messages.push(ipc.parse(raw));
    log.messages.push(raw);
  });
  child.on('exit', (code, signal) => {
    log.exit = { code, signal };
    children.delete(child);
  });
  const wait = async (kind: string) => {
    let found: z.infer<typeof ipc> | undefined;
    await expect
      .poll(
        () => {
          const failure = messages.find((m) => m.kind === 'failure');
          if (failure) throw new Error(`${failure.error}\n${log.stderr}`);
          const index = messages.findIndex((m) => m.kind === kind);
          if (index >= 0) found = messages.splice(index, 1)[0];
          if (!found && (child.exitCode !== null || child.signalCode !== null))
            throw new Error(`Worker exited before ${kind}: ${log.stderr}`);
          return Boolean(found);
        },
        { timeout: 30000, interval: 25 },
      )
      .toBe(true);
    return ipc.parse(found);
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
async function capture(runId: string, label: string) {
  evidence.push({
    label,
    runId,
    wire: [...wire],
    receipts: await judgeEvidence(testDb(), runId),
    candidates: await testDb().select().from(evaluation),
    settlements: await testDb().select().from(material_fsrs_state),
    permanent: await readJudgeRunPermanent(testDb(), runId),
  });
}
beforeAll(async () => {
  const url = new URL(z.url().parse(process.env.TEST_DATABASE_URL));
  if (
    !/^\/test_fork_\d+$/.test(url.pathname) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  )
    throw new Error('Disposable fixture DB required');
  await mkdir('.cache', { recursive: true });
  await execFileAsync(resolve('node_modules/.bin/esbuild'), [
    'tests/dbos-judge/worker.ts',
    '--bundle',
    '--platform=node',
    '--target=node24',
    '--format=cjs',
    '--outfile=.cache/yuk1356-judge-worker.cjs',
    '--external:pg-native',
    '--external:sharp',
    '--external:better-sqlite3',
    '--external:bufferutil',
    '--external:utf-8-validate',
    '--external:winston',
    '--external:winston-transport',
  ]);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Observer address');
  wireUrl = `http://127.0.0.1:${address.port}/v1`;
}, 60000);
beforeEach(async () => {
  await resetDb();
  await resetJudgeControl(testDb(), 'dbos');
  await testDb().execute(sql`delete from contract_epoch`);
  wire.length = 0;
  holdUnit = undefined;
});
afterAll(async () => {
  for (const child of children) {
    child.kill('SIGKILL');
    await once(child, 'exit');
  }
  for (const release of releases) release();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const paths = [
    'tests/dbos-judge/worker.ts',
    'tests/dbos-judge/process.db.test.ts',
    '.cache/yuk1356-judge-worker.cjs',
    'src/server/durable/judge-worker.ts',
    'src/capabilities/practice/server/judge/evaluate-submission.ts',
    'src/capabilities/practice/server/judge/recorded-model-executor.ts',
    'pnpm-lock.yaml',
    'node_modules/@dbos-inc/dbos-sdk/package.json',
    'node_modules/@earendil-works/pi-ai/package.json',
  ];
  await writeFile(
    '.cache/yuk1356-judge-process-evidence.json',
    JSON.stringify(
      {
        node: process.version,
        evidence,
        logs,
        wire,
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
const accepted = () =>
  dispatchFrozenJudge(testDb(), {
    checkRateLimit: () => 19,
    enqueueDbos: async () => {
      throw new Error('controlled pre-enqueue gap');
    },
  });
it.each(['native-load-committed', 'claim-committed', 'candidate-sealed', 'domain-committed'])(
  'SIGKILL/reopen through production worker at %s',
  async (boundary) => {
    const f = await accepted(),
      first = worker(f.input, { pause: boundary });
    await first.wait('ready');
    await first.wait('boundary');
    await capture(f.runId, `${boundary}:before-kill`);
    await first.kill();
    const calls = wire.length,
      second = worker(f.input, { recover: true });
    await second.wait('ready');
    await second.wait('done');
    await capture(f.runId, `${boundary}:after-reopen`);
    await second.stop();
    expect(wire.length).toBe(boundary === 'native-load-committed' ? 3 : calls);
    expect(await testDb().select().from(evaluation)).toHaveLength(1);
    const state = await readJudgeRunPermanent(testDb(), f.runId);
    expect(state.kind).toBe('resolved');
    if (boundary === 'claim-committed' && state.kind === 'resolved')
      expect(state.result.status).toBe('review_required');
  },
  90000,
);
it('saved first, second wire unknown, third unclaimed survives SIGKILL and actual DBOS recovery', async () => {
  const f = await accepted();
  holdUnit = 'elimination';
  const first = worker(f.input);
  await first.wait('ready');
  await expect.poll(() => wire.length, { timeout: 30000, interval: 25 }).toBe(2);
  await capture(f.runId, 'second-wire-held');
  await first.kill();
  holdUnit = undefined;
  for (const release of releases) release();
  releases.clear();
  const second = worker(f.input, { recover: true });
  await second.wait('ready');
  await second.wait('done');
  await second.stop();
  await capture(f.runId, 'multiunit-reopened');
  expect(wire.map((w) => w.unit)).toEqual(['equations', 'elimination']);
  expect(
    (await judgeEvidence(testDb(), f.runId)).filter(
      (r) => r.action === 'experimental:assessment_model_claim',
    ),
  ).toHaveLength(2);
}, 90000);
it('binding crash plus an intervening unactivated candidate never reallocates max+1 or repurchases', async () => {
  const f = await accepted(),
    first = worker(f.input, { pause: 'native-load-committed' });
  await first.wait('ready');
  await first.wait('boundary');
  await first.kill();
  const state = await readJudgeRunPermanent(testDb(), f.runId);
  if (state.kind !== 'pending' || state.pending.payload.caller !== 'native_assessment')
    throw new Error('Binding fixture pending');
  await evaluateSubmission(testDb(), {
    submission_id: state.pending.payload.submit.submission_id,
    evaluation_group_id: state.pending.payload.submit.evaluation_group_id,
    evaluation_key: 'intervening-native-candidate',
    model_executor: async () => ({
      kind: 'pending',
      pending: {
        reason: 'infra_failure',
        retryable: false,
        detail: 'alternate unactivated native candidate',
      },
      run_refs: [],
      cost_usd_micros: 0,
    }),
    provenance: { source: 'automatic', assisted: false },
  });
  const second = worker(f.input, { recover: true });
  await second.wait('ready');
  await second.wait('done');
  await second.stop();
  await capture(f.runId, 'binding-collision');
  expect(wire).toHaveLength(0);
  expect(await testDb().select().from(evaluation)).toHaveLength(1);
  expect((await readJudgeRunPermanent(testDb(), f.runId)).kind).toBe('manual');
}, 90000);
it('manual after saved final outcome defeats a late seal and held capture; result receipts remain', async () => {
  const f = await accepted(),
    first = worker(f.input, { pause: 'result-committed', unit: 'units' });
  await first.wait('ready');
  await first.wait('boundary');
  await disposeJudgeRun(testDb(), f.runId, {
    reason: 'explicit_disposal',
    actorRef: 'test:manual-before-seal',
    evidenceRefs: [f.input.pending_id],
    evidenceDigest: canonicalHash('manual-wins'),
  });
  first.child.send({ kind: 'release' });
  await first.wait('done');
  await first.stop();
  await testDb().delete(job_events);
  await capture(f.runId, 'manual-vs-seal');
  expect((await readJudgeRunPermanent(testDb(), f.runId)).kind).toBe('manual');
  expect(await testDb().select().from(evaluation)).toHaveLength(0);
  expect(wire).toHaveLength(3);
}, 90000);
it('SIGKILL before settlement COMMIT rolls back native activation and learning; reopen reuses candidate', async () => {
  const f = await accepted(),
    first = worker(f.input, { pause: 'settlement-uncommitted' });
  await first.wait('ready');
  await first.wait('boundary');
  expect(await testDb().select().from(event).where(eq(event.id, f.runId))).toHaveLength(0);
  await first.kill();
  await capture(f.runId, 'settlement-rollback');
  const second = worker(f.input, { recover: true });
  await second.wait('ready');
  await second.wait('done');
  await second.stop();
  await capture(f.runId, 'settlement-reopened');
  expect(wire).toHaveLength(3);
  expect((await readJudgeRunPermanent(testDb(), f.runId)).kind).toBe('resolved');
}, 90000);

it.each([false, true])(
  'manual after sealed candidate defeats activation/held capture (held=%s)',
  async (held) => {
    const f = await accepted();
    if (held) {
      const claimed = worker(f.input, { pause: 'claim-committed' });
      await claimed.wait('ready');
      await claimed.wait('boundary');
      await claimed.kill();
    }
    const first = worker(f.input, { pause: 'candidate-sealed', recover: held });
    await first.wait('ready');
    await first.wait('boundary');
    await disposeJudgeRun(testDb(), f.runId, {
      reason: 'explicit_disposal',
      actorRef: 'test:manual-after-seal',
      evidenceRefs: [f.input.pending_id],
      evidenceDigest: canonicalHash({ held }),
    });
    first.child.send({ kind: 'release' });
    await first.wait('done');
    await first.stop();
    await capture(f.runId, held ? 'manual-vs-held-capture' : 'manual-vs-activation');
    expect((await readJudgeRunPermanent(testDb(), f.runId)).kind).toBe('manual');
    expect(await testDb().select().from(evaluation)).toHaveLength(1);
    expect(await testDb().select().from(event).where(eq(event.id, f.runId))).toHaveLength(0);
    expect(await testDb().select().from(material_fsrs_state)).toHaveLength(0);
    expect(wire).toHaveLength(held ? 0 : 3);
  },
  90000,
);
