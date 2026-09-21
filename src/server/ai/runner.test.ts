// Runner tests — pi adapter path (post YUK-1025 P4: the Claude Agent SDK
// subprocess is retired; PiAgentAdapter is the only execution engine). The
// consume loop still reads SDKMessage-shaped frames, so the fake adapter feeds
// the same scripted frames the old module mock produced — coverage of the
// durable lifecycle (task_runs / cost_ledger / terminal evidence) is unchanged.

import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ai_task_runs, cost_ledger } from '@/db/schema';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { memR2 } from '../../../tests/helpers/r2';

const mockPi = vi.hoisted(() => ({
  messages: [] as unknown[],
  capturedArgs: undefined as unknown,
  capturedPrompt: undefined as unknown,
}));

import { resolveSubjectProfile } from '@/subjects/profile';
import {
  type ExecutionAdapterStartupArgs,
  type PreparedExecutionQuery,
  type RunnerMessage,
  __setPiAdapterForTests,
} from './execution-adapter';
import { ATTEMPT_PRICEBOOK_VERSION } from './pricing';
import { runAgentTask, runTask, streamTask } from './runner';

function fakePiAdapter() {
  return {
    id: 'pi' as const,
    startup: vi.fn(async (args: ExecutionAdapterStartupArgs) => {
      mockPi.capturedArgs = args;
      const prepared: PreparedExecutionQuery = {
        query: (prompt) => {
          mockPi.capturedPrompt = prompt;
          return (async function* () {
            for (const m of mockPi.messages) yield m as RunnerMessage;
          })();
        },
        close: async () => {},
      };
      return prepared;
    }),
  };
}

function capturedOptions() {
  return (mockPi.capturedArgs as ExecutionAdapterStartupArgs).options;
}

function successResult(text: string, cost_usd = 0.001) {
  return {
    type: 'result',
    subtype: 'success',
    result: text,
    stop_reason: 'end_turn',
    total_cost_usd: cost_usd,
    usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0 },
  };
}

afterEach(() => {
  __setPiAdapterForTests(undefined);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('runTask (Claude Agent SDK adapter)', () => {
  beforeEach(async () => {
    await resetDb();
    mockPi.messages = [];
    mockPi.capturedArgs = undefined;
    __setPiAdapterForTests(fakePiAdapter());
    mockPi.capturedPrompt = undefined;
    process.env.XIAOMI_API_KEY = 'sk-test-key';
  });

  it('returns final text and the same MiMo estimate in result, run and ledger despite positive SDK USD', async () => {
    mockPi.messages = [successResult('归因结果：concept', 0.001)];

    const result = await runTask(
      'AttributionTask',
      { question: '...', wrong_answer: '...' },
      { db: testDb(), r2: memR2() },
    );

    expect(result.text).toBe('归因结果：concept');
    expect(result.finishReason).toBe('end_turn');
    expect(result.usage.inputTokens).toBe(100);
    expect(result.usage.outputTokens).toBe(50);
    expect(result.cost_usd).toBeCloseTo(0.000087, 12);
    expect(result).toMatchObject({
      cost_basis: 'estimated',
      cost_ref: `pricebook:${ATTEMPT_PRICEBOOK_VERSION}/xiaomi/mimo-v2.5-pro`,
    });

    const { ai_task_runs, cost_ledger } = await import('@/db/schema');
    const { eq } = await import('drizzle-orm');
    const rows = await testDb()
      .select()
      .from(cost_ledger)
      .where(eq(cost_ledger.task_kind, 'AttributionTask'));
    expect(rows).toHaveLength(1);
    // codex P1 fix: cost_ledger.cost is USD float, NOT micro-USD ints.
    expect(rows[0].cost ?? Number.NaN).toBeCloseTo(0.000087, 12);
    expect(rows[0].task_run_id).toBe(result.task_run_id);
    expect(rows[0]).toMatchObject({
      entry_kind: 'attempt',
      cost_basis: 'estimated',
      cost_ref: `pricebook:${ATTEMPT_PRICEBOOK_VERSION}/xiaomi/mimo-v2.5-pro`,
    });

    const runRows = await testDb()
      .select()
      .from(ai_task_runs)
      .where(eq(ai_task_runs.id, result.task_run_id));
    expect(runRows).toHaveLength(1);
    expect(runRows[0]).toMatchObject({
      task_kind: 'AttributionTask',
      provider: 'xiaomi',
      model: 'mimo-v2.5-pro',
      status: 'success',
      finish_reason: 'end_turn',
      cost_basis: 'estimated',
      cost_ref: `pricebook:${ATTEMPT_PRICEBOOK_VERSION}/xiaomi/mimo-v2.5-pro`,
    });
    expect(runRows[0].input_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(runRows[0].usage_json).toEqual({ inputTokens: 100, outputTokens: 50 });
    expect(runRows[0].cost_usd).toBeCloseTo(0.000087, 12);
    expect(runRows[0].finished_at).toBeTruthy();
  });

  it('projects Xiaomi zero as the same estimate in result, run, and ledger', async () => {
    mockPi.messages = [successResult('estimated', 0)];

    const result = await runTask('AttributionTask', {}, { db: testDb(), r2: memR2() });
    const [run] = await testDb()
      .select()
      .from(ai_task_runs)
      .where(eq(ai_task_runs.id, result.task_run_id));
    const [ledger] = await testDb()
      .select()
      .from(cost_ledger)
      .where(eq(cost_ledger.task_run_id, result.task_run_id));

    expect(result.cost_basis).toBe('estimated');
    expect(result.cost_usd).toBeGreaterThan(0);
    expect(result.cost_ref).toContain('pricebook:');
    expect(run).toMatchObject({
      cost_usd: result.cost_usd,
      cost_basis: result.cost_basis,
      cost_ref: result.cost_ref,
    });
    expect(ledger).toMatchObject({
      entry_kind: 'attempt',
      cost: result.cost_usd,
      cost_basis: result.cost_basis,
      cost_ref: result.cost_ref,
    });
  });

  it('keeps an unpriced Xiaomi model unknown instead of projecting zero', async () => {
    mockPi.messages = [successResult('unknown', 0)];

    const result = await runTask(
      'AttributionTask',
      {},
      {
        db: testDb(),
        r2: memR2(),
        override: { provider: 'xiaomi', model: 'mimo-future' },
      },
    );
    const [run] = await testDb()
      .select()
      .from(ai_task_runs)
      .where(eq(ai_task_runs.id, result.task_run_id));
    const [ledger] = await testDb()
      .select()
      .from(cost_ledger)
      .where(eq(cost_ledger.task_run_id, result.task_run_id));

    expect(result).toMatchObject({
      cost_basis: 'unknown',
      cost_ref: 'unpriced:xiaomi/mimo-future',
    });
    expect(result.cost_usd).toBeUndefined();
    expect(run).toMatchObject({ cost_usd: null, cost_basis: 'unknown' });
    expect(ledger).toMatchObject({ cost: null, cost_basis: 'unknown' });
  });

  it('preserves Anthropic direct reported zero as real evidence', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-anthropic-test');
    mockPi.messages = [successResult('free-tier', 0)];

    const result = await runTask(
      'AttributionTask',
      {},
      {
        db: testDb(),
        r2: memR2(),
        override: { provider: 'anthropic', model: 'claude-sonnet-test' },
      },
    );

    expect(result).toMatchObject({
      cost_usd: 0,
      cost_basis: 'reported',
      cost_ref: 'sdk:total_cost_usd',
    });
  });

  it('passes systemPrompt + model + resolved credential via options + tools from registry', async () => {
    mockPi.messages = [successResult('ok')];

    await runTask('AttributionTask', { test: 'payload' }, { db: testDb(), r2: memR2() });

    const args = mockPi.capturedArgs as ExecutionAdapterStartupArgs;
    const opts = args.options;
    expect(opts.model).toBe('mimo-v2.5-pro');
    expect(typeof opts.systemPrompt).toBe('string');
    // The credential/provider binding rides on `resolved` (per-request apiKey
    // into streamSimple), not a subprocess env block.
    expect(args.resolved.provider).toBe('xiaomi');
    expect(args.resolved.apiKey).toBe('sk-test-key');
    // Registry's allowedTools picks up automatically when ctx doesn't override.
    expect(opts.tools).toEqual([]);
    expect(mockPi.capturedPrompt).toBe('{"test":"payload"}');
  });

  it('uses ctx.subjectProfile to build the runtime system prompt', async () => {
    mockPi.messages = [successResult('ok')];

    await runTask(
      'NoteGenerateTask',
      { test: 'payload' },
      { db: testDb(), r2: memR2(), subjectProfile: resolveSubjectProfile('math') },
    );

    const opts = capturedOptions();
    expect(opts.systemPrompt).toContain('你是数学学习笔记作者');
    expect(opts.systemPrompt).toContain('每一步变形依据');
    expect(opts.systemPrompt).not.toContain('古文');
  });

  it('honours registry-declared allowedTools (KnowledgeReviewTask → mcp__loom__write_proposal)', async () => {
    mockPi.messages = [successResult('ok')];

    await runTask('KnowledgeReviewTask', { test: 'payload' }, { db: testDb(), r2: memR2() });

    const opts = capturedOptions();
    expect(opts.tools).toEqual(['mcp__loom__write_proposal']);
  });

  it('warns once when an agentic task has no piToolMounts', async () => {
    mockPi.messages = [successResult('ok')];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await runTask(
      'KnowledgeReviewTask',
      { test: 'payload' },
      { db: testDb(), r2: memR2() },
    );

    expect(warn).toHaveBeenCalledWith('[runTask] missing_tool_mounts', {
      event: 'missing_tool_mounts',
      task_run_id: result.task_run_id,
      kind: 'KnowledgeReviewTask',
    });
    expect(warn).toHaveBeenCalledOnce();
  });

  it('does not warn when a non-agentic task has no piToolMounts', async () => {
    mockPi.messages = [successResult('ok')];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await runTask('AttributionTask', { test: 'payload' }, { db: testDb(), r2: memR2() });

    expect(warn).not.toHaveBeenCalled();
  });

  it('does not warn when an agentic task receives a piToolMounts entry', async () => {
    mockPi.messages = [successResult('ok')];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await runTask(
      'KnowledgeReviewTask',
      { test: 'payload' },
      { db: testDb(), r2: memR2(), piToolMounts: [{ type: 'custom', tools: [] }] },
    );

    expect(warn).not.toHaveBeenCalled();
  });

  it('ctx.allowedTools overrides registry default', async () => {
    mockPi.messages = [successResult('ok')];

    await runTask(
      'AttributionTask',
      {},
      { db: testDb(), r2: memR2(), allowedTools: ['mcp__custom__foo'] },
    );

    const opts = capturedOptions();
    expect(opts.tools).toEqual(['mcp__custom__foo']);
  });

  it('honours middleware.beforeRun + afterRun', async () => {
    mockPi.messages = [successResult('echoed')];
    const beforeRun = vi.fn(async (_kind: string, input: unknown) => ({
      ...(input as Record<string, unknown>),
      injected: 'memory-context',
    }));
    const afterRun = vi.fn(async () => {});

    await runTask(
      'AttributionTask',
      { original: 'data' },
      { db: testDb(), r2: memR2(), middleware: { beforeRun, afterRun } },
    );

    expect(beforeRun).toHaveBeenCalledOnce();
    expect(afterRun).toHaveBeenCalledOnce();
    expect(JSON.stringify(mockPi.capturedPrompt)).toContain('memory-context');
  });

  it('captures SDK error terminal usage/cost and writes a failure attempt ledger', async () => {
    mockPi.messages = [
      {
        type: 'result',
        subtype: 'error_max_budget_usd',
        stop_reason: null,
        total_cost_usd: 0,
        usage: { input_tokens: 80, output_tokens: 20, cache_read_input_tokens: 5 },
        errors: ['budget reached'],
      },
    ];

    await expect(runTask('AttributionTask', {}, { db: testDb(), r2: memR2() })).rejects.toThrow(
      /error_max_budget_usd/,
    );

    const runRows = await testDb()
      .select()
      .from(ai_task_runs)
      .where(eq(ai_task_runs.task_kind, 'AttributionTask'));
    expect(runRows).toHaveLength(1);
    expect(runRows[0].status).toBe('failure');
    expect(runRows[0].usage_json).toEqual({ inputTokens: 85, outputTokens: 20 });
    expect(runRows[0].cost_basis).toBe('estimated');
    expect(runRows[0].error_message).toContain('error_max_budget_usd');
    expect(runRows[0].finished_at).toBeTruthy();
    const ledger = await testDb()
      .select()
      .from(cost_ledger)
      .where(eq(cost_ledger.task_run_id, runRows[0].id));
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      entry_kind: 'attempt',
      cost_basis: 'estimated',
      tokens_in: 85,
      tokens_out: 20,
      outcome: 'failed_permanent',
    });
  });

  it('writes an unknown retryable attempt ledger when the SDK has no terminal message', async () => {
    mockPi.messages = [];

    await expect(runTask('AttributionTask', {}, { db: testDb(), r2: memR2() })).rejects.toThrow(
      /stream_no_terminal/,
    );

    const [run] = await testDb()
      .select()
      .from(ai_task_runs)
      .where(eq(ai_task_runs.task_kind, 'AttributionTask'));
    const [ledger] = await testDb()
      .select()
      .from(cost_ledger)
      .where(eq(cost_ledger.task_run_id, run.id));
    expect(run).toMatchObject({ status: 'failure', cost_usd: null, cost_basis: 'unknown' });
    expect(ledger).toMatchObject({
      entry_kind: 'attempt',
      cost: null,
      cost_basis: 'unknown',
      outcome: 'failed_retryable',
    });
  });

  it('runAgentTask is an alias of runTask', async () => {
    mockPi.messages = [successResult('agent-text', 0.002)];

    const result = await runAgentTask(
      'AttributionTask',
      { test: 'x' },
      { db: testDb(), r2: memR2() },
    );

    expect(result.text).toBe('agent-text');
    expect(result.cost_usd).toBeCloseTo(0.000087, 12);
  });
});

// YUK-225 (S2 slice 4) — spike-invariant regression guards, rewritten for the
// pi-only surface (YUK-1025): the SDK's filesystem skill mirror (CLAUDE_CONFIG_DIR
// + Options.skills + settingSources) is gone. Pi receives resolved skill bodies
// via `ctx.piSkillDocs` and the adapter folds them into the system prompt — so
// the surviving invariants are (a) caller-provided docs forward verbatim and
// (b) no ctx.piSkillDocs means nothing is attached (pi never reads repo files,
// which is the structural form of the old 'no leak' invariant).
describe('runTask — skill docs forwarding (piSkillDocs)', () => {
  beforeEach(async () => {
    await resetDb();
    mockPi.messages = [];
    mockPi.capturedArgs = undefined;
    mockPi.capturedPrompt = undefined;
    __setPiAdapterForTests(fakePiAdapter());
    process.env.XIAOMI_API_KEY = 'sk-test-key';
  });

  it('forwards ctx.piSkillDocs verbatim to the adapter startup args', async () => {
    mockPi.messages = [successResult('ok')];
    const docs = [{ name: 'yuwen--quiz-gen-translation', body: '# 翻译出题\nbody' }];

    await runTask(
      'NoteGenerateTask',
      { test: 'payload' },
      { db: testDb(), r2: memR2(), piSkillDocs: docs },
    );

    const args = mockPi.capturedArgs as ExecutionAdapterStartupArgs;
    expect(args.piSkillDocs).toEqual(docs);
    // The call spec itself carries no skill knob — injection happens adapter-side.
    expect('skills' in args.options).toBe(false);
  });

  it('attaches no skill docs when ctx.piSkillDocs is absent (no implicit discovery)', async () => {
    mockPi.messages = [successResult('ok')];

    await runTask('AttributionTask', { test: 'payload' }, { db: testDb(), r2: memR2() });

    const args = mockPi.capturedArgs as ExecutionAdapterStartupArgs;
    expect(args.piSkillDocs).toBeUndefined();
  });

  it('forwards an explicitly empty piSkillDocs array (caller means zero skills)', async () => {
    mockPi.messages = [successResult('ok')];

    await runTask(
      'AttributionTask',
      { test: 'payload' },
      { db: testDb(), r2: memR2(), piSkillDocs: [] },
    );

    const args = mockPi.capturedArgs as ExecutionAdapterStartupArgs;
    expect(args.piSkillDocs).toEqual([]);
  });
});

describe('streamTask middleware + cost', () => {
  beforeEach(async () => {
    await resetDb();
    mockPi.messages = [];
    mockPi.capturedArgs = undefined;
    __setPiAdapterForTests(fakePiAdapter());
    mockPi.capturedPrompt = undefined;
    process.env.XIAOMI_API_KEY = 'sk-test-key';
  });

  it('runs beforeRun before issuing the query', async () => {
    mockPi.messages = [successResult('streamed', 0.003)];

    const beforeRun = vi.fn(async (_kind: string, input: unknown) => ({
      ...(input as Record<string, unknown>),
      injected: 'pre-stream-memory',
    }));

    const response = streamTask(
      'AttributionTask',
      { hello: 'world' },
      { db: testDb(), r2: memR2(), middleware: { beforeRun } },
    );
    // Drain so the start() callback runs to completion.
    const reader = response.body?.getReader();
    if (reader) {
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    }

    expect(beforeRun).toHaveBeenCalledOnce();
    expect(JSON.stringify(mockPi.capturedPrompt)).toContain('pre-stream-memory');
  });

  it('uses a caller-owned task run id and can suppress the input-only tool log', async () => {
    mockPi.messages = [
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tool_use_maintenance',
              name: 'mcp__loom__write_proposal',
              input: { payload: { mutation: 'propose_knowledge_edge' } },
            },
          ],
        },
      },
      successResult('done'),
    ];

    const response = streamTask(
      'KnowledgeReviewTask',
      { input: 'x' },
      {
        db: testDb(),
        r2: memR2(),
        taskRunId: 'tr_caller_owned',
        autoLogToolCalls: false,
      },
    );
    await response.text();

    const { ai_task_runs, tool_call_log } = await import('@/db/schema');
    const { eq } = await import('drizzle-orm');
    const runs = await testDb()
      .select()
      .from(ai_task_runs)
      .where(eq(ai_task_runs.id, 'tr_caller_owned'));
    expect(runs).toHaveLength(1);
    const logs = await testDb()
      .select()
      .from(tool_call_log)
      .where(eq(tool_call_log.task_run_id, 'tr_caller_owned'));
    expect(logs).toHaveLength(0);
  });

  it('writes USD cost via cost_ledger (not micro-USD)', async () => {
    mockPi.messages = [successResult('hello', 0.005)];

    const response = streamTask('AttributionTask', { input: 'x' }, { db: testDb(), r2: memR2() });
    const reader = response.body?.getReader();
    if (reader) {
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    }

    const { ai_task_runs, cost_ledger } = await import('@/db/schema');
    const { eq } = await import('drizzle-orm');
    const rows = await testDb()
      .select()
      .from(cost_ledger)
      .where(eq(cost_ledger.task_kind, 'AttributionTask'));
    expect(rows).toHaveLength(1);
    expect(rows[0].cost ?? Number.NaN).toBeCloseTo(0.000087, 12);
    expect(rows[0]).toMatchObject({
      cost_basis: 'estimated',
      cost_ref: `pricebook:${ATTEMPT_PRICEBOOK_VERSION}/xiaomi/mimo-v2.5-pro`,
    });
    const taskRunId = rows[0].task_run_id;
    expect(taskRunId).toBeTruthy();
    if (!taskRunId) throw new Error('expected cost_ledger.task_run_id');

    const runRows = await testDb()
      .select()
      .from(ai_task_runs)
      .where(eq(ai_task_runs.id, taskRunId));
    expect(runRows).toHaveLength(1);
    expect(runRows[0]).toMatchObject({
      task_kind: 'AttributionTask',
      status: 'success',
      finish_reason: 'end_turn',
    });
  });
});
