import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { z } from 'zod';
import { evaluateSubmission } from '@/capabilities/practice/server/judge/evaluate-submission';
import { disposeJudgeRun } from '@/capabilities/practice/server/judge-operational';
import { readJudgeRunPermanent } from '@/capabilities/practice/server/judge-run-observation';
import { canonicalHash } from '@/core/migration/canonical';
import { ModelUnitOutcome } from '@/core/schema/assessment';
import type { JudgeWorkflowInputT } from '@/core/schema/event/judge-operational-events';
import {
  ai_task_runs,
  evaluation,
  evaluation_effective_head,
  event,
  job_events,
  material_fsrs_state,
} from '@/db/schema';
import { sanitizeDiagnostic } from '../dbos-review-orphan/fixture-process';
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
const wire: { unit: string; bodyDigest: string; at: string; body: unknown }[] = [];
const transport: {
  route: 'chat-completions' | 'responses' | 'other';
  method: string;
  at: string;
  bodyDigest?: string;
  error?: string;
}[] = [];
let holdUnit: string | undefined;
const releases = new Set<() => void>();
type ResponseMode = 'valid' | 'partial-break' | 'malformed-assessment';
let failureMode: Exclude<ResponseMode, 'valid'> | undefined;
const failureModes: Exclude<ResponseMode, 'valid'>[] = ['partial-break', 'malformed-assessment'];
const transportBreaks = new Set<() => void>();
function controlledCompletion(unit: string, slot: string, mode: ResponseMode) {
  const answer = {
    kind: 'rule',
    rule_id: unit,
    points_awarded:
      mode === 'malformed-assessment'
        ? 'two'
        : ['equations', 'elimination', 'units'].indexOf(unit) + 1,
    confidence: 0.98,
    feedback_md: '真实原始证据包含方程、消元与单位。',
    evidence_citations: [{ slot_id: slot, quote: '2v=30' }],
  };
  const content =
    mode === 'partial-break' ? JSON.stringify(answer).slice(0, 60) : JSON.stringify(answer);
  const frame = (choices: unknown[], usage?: unknown) =>
    `data: ${JSON.stringify({ id: 'controlled-wire', object: 'chat.completion.chunk', created: 1, model: 'gpt-4.1-mini', choices, ...(usage ? { usage } : {}) })}\n\n`;
  const frames = [
    frame([{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }]),
  ];
  if (mode !== 'partial-break')
    frames.push(
      frame([{ index: 0, delta: {}, finish_reason: 'stop' }], {
        prompt_tokens: 10,
        completion_tokens: 10,
        total_tokens: 20,
      }),
      'data: [DONE]\n\n',
    );
  return { content, frames };
}
const server = createServer(async (req, res) => {
  const request: (typeof transport)[number] = {
    route:
      req.url === '/v1/chat/completions'
        ? 'chat-completions'
        : req.url === '/v1/responses'
          ? 'responses'
          : 'other',
    method: req.method ?? 'unknown',
    at: new Date().toISOString(),
  };
  transport.push(request);
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString('utf8');
    request.bodyDigest = canonicalHash(JSON.parse(body));
    const parsed = z
      .object({ messages: z.array(z.object({ content: z.unknown() }).passthrough()) })
      .parse(JSON.parse(body));
    const text = parsed.messages
      .flatMap((message) => {
        if (typeof message.content === 'string') return [message.content];
        const blocks = z
          .array(z.object({ type: z.string(), text: z.string().optional() }).passthrough())
          .parse(message.content);
        return blocks.flatMap((block) =>
          block.type === 'text' && block.text !== undefined ? [block.text] : [],
        );
      })
      .join('\n');
    const names = [...text.matchAll(/"rule_id"\s*:\s*"(equations|elimination|units)"/g)].map(
      (m) => m[1],
    );
    const unit = names.at(-1);
    if (!unit) throw new Error('Controlled wire cannot locate frozen rule');
    const slot = [...text.matchAll(/"slot_id"\s*:\s*"([^"]+)"/g)].map((m) => m[1]).at(-1);
    if (!slot) throw new Error('Controlled wire cannot locate original response slot');
    wire.push({
      unit,
      bodyDigest: canonicalHash(JSON.parse(body)),
      body: JSON.parse(body),
      at: new Date().toISOString(),
    });
    if (holdUnit === unit) await new Promise<void>((resolve) => releases.add(resolve));
    const mode = unit === 'elimination' ? (failureMode ?? 'valid') : 'valid';
    const completion = controlledCompletion(unit, slot, mode);
    res.writeHead(200, { 'content-type': 'text/event-stream', 'x-controlled-mode': mode });
    if (mode === 'partial-break') {
      // The test waits for the child to read this frame before breaking this owned socket.
      const breakTransport = () => res.destroy();
      transportBreaks.add(breakTransport);
      res.once('close', () => transportBreaks.delete(breakTransport));
      res.write(completion.frames[0]);
    } else res.end(completion.frames.join(''));
  } catch (error) {
    request.error = sanitizeDiagnostic(String(error), ['controlled-local-fixture']).slice(0, 2048);
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: String(error) } }));
  }
});
function worker(
  input: JudgeWorkflowInputT,
  options: {
    pause?: string;
    unit?: string;
    recover?: boolean;
    observeTransport?: boolean;
    reconcile?: { scheduledAt: Date; authorizationAt: Date };
  } = {},
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
      TLP_JUDGE_OBSERVE_TRANSPORT: options.observeTransport ? '1' : '0',
      TLP_JUDGE_RECONCILE: options.reconcile ? JSON.stringify(options.reconcile) : undefined,
      AI_PROVIDER_OVERRIDE: 'openai',
      AI_PROVIDER_MODEL: 'gpt-4.1-mini',
      OPENAI_API_KEY: 'controlled-local-fixture',
      CLAUDE_CODE_MAX_RETRIES: '2',
    },
  });
  children.add(child);
  const exited = once(child, 'close'),
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
  });
  child.on('close', () => {
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
    closed: () => exited,
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
  const receipts = await judgeEvidence(testDb(), runId);
  const taskRunIds = receipts.flatMap((receipt) => {
    const claim = z.object({ planned_task_run_id: z.string() }).safeParse(receipt.payload);
    return claim.success ? [claim.data.planned_task_run_id] : [];
  });
  const taskRuns = taskRunIds.length
    ? await testDb()
        .select({
          id: ai_task_runs.id,
          task_kind: ai_task_runs.task_kind,
          provider: ai_task_runs.provider,
          model: ai_task_runs.model,
          status: ai_task_runs.status,
          finish_reason: ai_task_runs.finish_reason,
          usage_json: ai_task_runs.usage_json,
          cost_usd: ai_task_runs.cost_usd,
          cost_basis: ai_task_runs.cost_basis,
          error_message: ai_task_runs.error_message,
          started_at: ai_task_runs.started_at,
          finished_at: ai_task_runs.finished_at,
        })
        .from(ai_task_runs)
        .where(inArray(ai_task_runs.id, taskRunIds))
    : [];
  evidence.push({
    label,
    runId,
    wire: [...wire],
    transport: [...transport],
    receipts,
    taskRuns: taskRuns.map((run) => ({
      ...run,
      error_message:
        run.error_message === null
          ? null
          : sanitizeDiagnostic(run.error_message, ['controlled-local-fixture']).slice(0, 4096),
    })),
    candidates: await testDb().select().from(evaluation),
    heads: await testDb().select().from(evaluation_effective_head),
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
  transport.length = 0;
  holdUnit = undefined;
  failureMode = undefined;
});
afterAll(async () => {
  for (const child of children) {
    const closed = once(child, 'close');
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
  }
  for (const release of releases) release();
  for (const breakTransport of transportBreaks) breakTransport();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const paths = [
    'tests/dbos-judge/worker.ts',
    'tests/dbos-judge/process.db.test.ts',
    'tests/dbos-judge/transport-fixture.unit.test.ts',
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
        logs: logs.map((log) => ({
          ...log,
          stdout: sanitizeDiagnostic(log.stdout, ['controlled-local-fixture']),
          stderr: sanitizeDiagnostic(log.stderr, ['controlled-local-fixture']),
        })),
        wire,
        transport,
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
  const savedBeforeKill = (await judgeEvidence(testDb(), f.runId)).filter(
    (r) => r.action === 'experimental:assessment_model_result',
  );
  expect(savedBeforeKill).toHaveLength(1);
  expect(savedBeforeKill[0]?.payload.outcome).toMatchObject({ kind: 'scored' });
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
  const savedAfterReopen = (await judgeEvidence(testDb(), f.runId)).filter(
    (r) => r.action === 'experimental:assessment_model_result',
  );
  expect(savedAfterReopen).toEqual(expect.arrayContaining(savedBeforeKill));
}, 90000);
it.each(failureModes)(
  'controlled transport failure %s preserves first score and held second across SIGKILL/reopen without retry',
  async (mode) => {
    const f = await accepted();
    failureMode = mode;
    const first = worker(f.input, {
      pause: 'result-committed',
      unit: 'elimination',
      observeTransport: true,
    });
    let second: ReturnType<typeof worker> | undefined;
    try {
      await first.wait('ready');
      const slot = f.request.response_set.entries[0]?.slot_id;
      if (!slot) throw new Error('Controlled original slot missing');
      const completion = controlledCompletion('elimination', slot, mode);
      const response = await first.wait(
        mode === 'partial-break' ? 'transport-partial' : 'transport-complete',
      );
      expect(response).toMatchObject({ mode, status: 200, body: completion.frames.join('') });
      if (mode === 'partial-break') {
        expect(transportBreaks.size).toBe(1);
        for (const breakTransport of transportBreaks) breakTransport();
        expect(await first.wait('transport-error')).toMatchObject({
          mode,
          body: completion.frames[0],
          error: expect.stringContaining('terminated'),
        });
      }
      await first.wait('boundary');
      await capture(f.runId, `${mode}:held-result-before-kill`);
      const before = await judgeEvidence(testDb(), f.runId);
      const claims = before.filter((r) => r.action === 'experimental:assessment_model_claim');
      const results = before.filter((r) => r.action === 'experimental:assessment_model_result');
      expect(claims).toHaveLength(2);
      expect(results).toHaveLength(2);
      expect(wire.map((w) => w.unit)).toEqual(['equations', 'elimination']);
      expect(transport).toHaveLength(2);
      expect(transport.map((t) => [t.method, t.route, t.error])).toEqual([
        ['POST', 'chat-completions', undefined],
        ['POST', 'chat-completions', undefined],
      ]);
      const taskIds: string[] = [];
      expect(f.contract.structure.materials).toMatchObject([
        {
          kind: 'plaintext',
          visibility: 'private',
          caption: 'reference solution',
          content_md: 'v=15 km/h; c=3 km/h',
        },
      ]);
      for (const [index, unit] of ['equations', 'elimination'].entries()) {
        const scoringUnit = f.contract.scoring_basis.units[index];
        const claim = claims.find(
          (r) => r.payload.scoring_unit_id === scoringUnit?.scoring_unit_id,
        );
        if (!claim || !scoringUnit) throw new Error(`Missing permanent claim for ${unit}`);
        const payload = z
          .object({ planned_task_run_id: z.string(), submission_id: z.string() })
          .parse(claim.payload);
        taskIds.push(payload.planned_task_run_id);
        expect(payload.planned_task_run_id).toBe(
          claim.id.replace('evt_model_claim_', 'assessment_'),
        );
        expect(claim.payload.reserved_cost_usd_micros).toBe(1000);
        const result = results.find((r) => r.caused_by_event_id === claim.id);
        expect(result?.id).toBe(claim.id.replace('evt_model_claim_', 'evt_model_result_'));
        expect(result?.payload.input_digest).toBe(claim.payload.input_digest);
        const outcome = ModelUnitOutcome.parse(result?.payload.outcome);
        expect(outcome.run_refs).toEqual([payload.planned_task_run_id]);
        expect(outcome).toMatchObject(
          index === 0
            ? { kind: 'scored', points_awarded: 1, matched: { rule_id: unit } }
            : {
                kind: 'pending',
                pending: {
                  reason: 'infra_failure',
                  retryable: false,
                  detail: 'native model asset, execution or output validation failed',
                },
              },
        );
        const request = z
          .object({
            model: z.literal('gpt-4.1-mini'),
            stream: z.literal(true),
            messages: z.array(
              z.object({
                role: z.string(),
                content: z.union([
                  z.string(),
                  z.array(z.object({ type: z.literal('text'), text: z.string() })),
                ]),
              }),
            ),
          })
          .parse(wire[index]?.body);
        const user = request.messages.findLast((m) => m.role === 'user');
        if (!user) throw new Error('Actual endpoint request has no user message');
        const text =
          typeof user.content === 'string'
            ? user.content
            : user.content.map((b) => b.text).join('\n');
        expect(JSON.parse(text)).toMatchObject({
          submission_id: payload.submission_id,
          evaluation_group_id: f.request.evaluation_group_id,
          scoring_unit: scoringUnit,
          question_parts: f.contract.structure.parts,
          response_slots: f.contract.response_spec.slots,
          slot_responses: f.request.response_set.entries,
          group_evidence: [],
          materials: f.contract.structure.materials,
        });
        expect(wire[index]?.bodyDigest).toBe(canonicalHash(wire[index]?.body));
        expect(transport[index]?.bodyDigest).toBe(wire[index]?.bodyDigest);
      }
      const tasksBefore = await testDb()
        .select()
        .from(ai_task_runs)
        .where(inArray(ai_task_runs.id, taskIds))
        .orderBy(ai_task_runs.id);
      expect(tasksBefore).toHaveLength(2);
      expect(await testDb().select({ id: ai_task_runs.id }).from(ai_task_runs)).toHaveLength(2);
      expect(tasksBefore.find((r) => r.id === taskIds[0])).toMatchObject({
        status: 'success',
        finish_reason: 'end_turn',
        error_message: null,
      });
      expect(tasksBefore.find((r) => r.id === taskIds[1])).toMatchObject(
        mode === 'partial-break'
          ? {
              status: 'failure',
              finish_reason: 'error',
              error_message: expect.stringMatching(/subtype=error_during_execution.*terminated/),
            }
          : { status: 'success', finish_reason: 'end_turn', error_message: null },
      );
      expect(await testDb().select().from(evaluation)).toHaveLength(0);
      const headsBefore = await testDb().select().from(evaluation_effective_head);
      expect(headsBefore).toMatchObject([
        {
          evaluation_group_id: f.request.evaluation_group_id,
          effective_evaluation_id: null,
          generation: 0,
        },
      ]);
      expect((await readJudgeRunPermanent(testDb(), f.runId)).kind).toBe('pending');
      await first.kill();
      second = worker(f.input, { recover: true });
      await second.wait('ready');
      expect((await second.wait('done')).status).toMatchObject({ status: 'SUCCESS' });
      await second.stop();
      await capture(f.runId, `${mode}:after-reopen`);
      const after = await judgeEvidence(testDb(), f.runId);
      expect(after.filter((r) => r.action === 'experimental:assessment_model_claim')).toEqual(
        claims,
      );
      expect(after.filter((r) => r.action === 'experimental:assessment_model_result')).toEqual(
        results,
      );
      expect(
        await testDb()
          .select()
          .from(ai_task_runs)
          .where(inArray(ai_task_runs.id, taskIds))
          .orderBy(ai_task_runs.id),
      ).toEqual(tasksBefore);
      expect(wire.map((w) => w.unit)).toEqual(['equations', 'elimination']);
      expect(transport).toHaveLength(2);
      expect(await testDb().select({ id: ai_task_runs.id }).from(ai_task_runs)).toHaveLength(2);
      const candidates = await testDb().select().from(evaluation);
      expect(candidates).toHaveLength(1);
      expect(candidates[0]?.unit_results.map((r) => r.scoring_unit_id)).toEqual(
        f.contract.scoring_basis.units.map((u) => u.scoring_unit_id),
      );
      expect(candidates[0]?.unit_results).toMatchObject([
        { status: 'scored', points_awarded: 1 },
        {
          status: 'pending',
          pending: { reason: 'infra_failure', retryable: false },
        },
        {
          status: 'pending',
          pending: {
            reason: 'infra_failure',
            retryable: false,
            detail:
              'a prior unit has an unknown or held result; further fresh claims are forbidden',
          },
        },
      ]);
      expect(await testDb().select().from(evaluation_effective_head)).toEqual(headsBefore);
      expect(await testDb().select().from(material_fsrs_state)).toHaveLength(0);
      expect(await readJudgeRunPermanent(testDb(), f.runId)).toMatchObject({
        kind: 'resolved',
        result: {
          status: 'review_required',
          assessment: { candidate_id: candidates[0]?.evaluation_id },
        },
      });
    } finally {
      for (const breakTransport of transportBreaks) breakTransport();
      for (const running of [first, second]) {
        if (!running) continue;
        if (running.child.exitCode === null && running.child.signalCode === null)
          await running.kill();
        else await running.closed();
      }
      const state = await readJudgeRunPermanent(testDb(), f.runId);
      if (state.kind === 'pending' || (state.kind === 'unmapped' && state.pending)) {
        await capture(f.runId, `${mode}:failure-before-disposal`);
        await disposeJudgeRun(testDb(), f.runId, {
          reason: 'explicit_disposal',
          actorRef: 'test:controlled-transport-cleanup',
          evidenceRefs: [f.input.pending_id],
          evidenceDigest: canonicalHash({ mode, cleanup: true }),
        });
      }
    }
  },
  90000,
);
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
  expect(
    (await judgeEvidence(testDb(), f.runId)).filter(
      (r) => r.action === 'experimental:assessment_model_result',
    ),
  ).toHaveLength(3);
}, 90000);

it.each([false, true])(
  'registered old reconcile tick forbids >=7d authorization on delayed first run or uncheckpointed SIGKILL/reopen (reopen=%s)',
  async (reopen) => {
    const submittedAt = new Date(Date.now() - 7 * 86400_000),
      scheduledAt = new Date(submittedAt.getTime() + 7 * 86400_000 - 3600_000),
      authorizationAt = new Date(submittedAt.getTime() + 7 * 86400_000 + 1);
    const f = await dispatchFrozenJudge(
      testDb(),
      {
        checkRateLimit: () => 19,
        enqueueDbos: async () => {
          throw new Error('controlled unsent original');
        },
      },
      submittedAt,
    );
    const sendsBefore = await testDb()
        .select()
        .from(event)
        .where(eq(event.action, 'experimental:judge_delivery_send')),
      reservationsBefore = await testDb()
        .select()
        .from(event)
        .where(eq(event.action, 'experimental:judge_delivery_reserved'));
    const options = { reconcile: { scheduledAt, authorizationAt } };
    if (reopen) {
      const first = worker(f.input, { ...options, pause: 'authorization-clock' });
      await first.wait('ready');
      await first.wait('boundary');
      const [selection] = await testDb()
        .select()
        .from(event)
        .where(
          sql`${event.action}='experimental:judge_reconcile_observation' and ${event.payload}->>'tick_id'=${`sched-judge_pending_reconcile-${scheduledAt.toISOString()}`}`,
        );
      expect(selection?.payload.pending_ids).toEqual([f.input.pending_id]);
      await capture(f.runId, 'old-tick-uncheckpointed');
      await first.kill();
    }
    const last = worker(f.input, { ...options, recover: reopen });
    await last.wait('ready');
    const done = await last.wait('done');
    expect(done.status).toMatchObject({ status: 'SUCCESS' });
    await last.stop();
    const state = await readJudgeRunPermanent(testDb(), f.runId);
    expect(state.kind).toBe('manual');
    if (state.kind === 'manual') expect(state.disposition.reason).toBe('recovery_exhausted');
    expect(
      await testDb()
        .select()
        .from(event)
        .where(eq(event.action, 'experimental:judge_delivery_send')),
    ).toEqual(sendsBefore);
    expect(
      await testDb()
        .select()
        .from(event)
        .where(eq(event.action, 'experimental:judge_delivery_reserved')),
    ).toEqual(reservationsBefore);
    expect(
      await testDb()
        .select()
        .from(event)
        .where(eq(event.action, 'experimental:assessment_model_claim')),
    ).toHaveLength(0);
    expect(wire).toHaveLength(0);
    await capture(f.runId, reopen ? 'old-tick-reopened' : 'old-tick-first-delayed');
  },
  90000,
);
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
