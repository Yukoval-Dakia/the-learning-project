// YUK-266 (C1) — streamTaskCollecting: a collecting variant of streamTask that
// streams text deltas to an onDelta callback then resolves the full RunTaskResult.
// Pure no-DB unit (post YUK-1025 P4): a fake ExecutionAdapter injected via
// __setPiAdapterForTests replays scripted frames and @/server/ai/log is vi.mock'd,
// so no live Postgres is needed — mirrors the sibling stream-cancel.test.ts
// (both live in fastTestInclude).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Captures the startup args the runner hands the adapter (chiefly the
// AbortController inside options) and lets a test feed an arbitrary frame
// sequence + optionally throw mid-stream.
const mockPi = vi.hoisted(() => ({
  capturedArgs: undefined as unknown,
  messages: [] as unknown[],
  throwAfter: -1 as number, // when >= 0, throw after yielding this many messages
  waitForAbortAfter: -1 as number,
  waitForAbortBeforeMessages: false,
}));

function fakePiAdapter() {
  return {
    id: 'pi' as const,
    startup: vi.fn(async (args: ExecutionAdapterStartupArgs) => {
      mockPi.capturedArgs = args;
      const signal = args.options.abortController?.signal;
      const waitAbort = () =>
        new Promise<void>((resolve) => {
          if (!signal || signal.aborted) resolve();
          else signal.addEventListener('abort', () => resolve(), { once: true });
        });
      const prepared: PreparedExecutionQuery = {
        query: () =>
          (async function* () {
            if (mockPi.waitForAbortBeforeMessages) {
              await waitAbort();
              throw new Error('pi stream aborted before first message');
            }
            let i = 0;
            for (const msg of mockPi.messages) {
              if (mockPi.throwAfter >= 0 && i >= mockPi.throwAfter) {
                throw new Error('pi blew up mid-stream');
              }
              yield msg as RunnerMessage;
              i += 1;
              if (mockPi.waitForAbortAfter === i) {
                await waitAbort();
                throw new Error('pi stream aborted after owner Stop');
              }
            }
          })(),
        close: async () => {},
      };
      return prepared;
    }),
  };
}

const logMocks = vi.hoisted(() => ({
  finishedShouldThrow: false,
  finishedFailuresRemaining: 0,
  terminalStatuses: [] as string[],
  started: vi.fn(async (_db: unknown, _row: unknown) => {}),
  finished: vi.fn(async (_db: unknown, _row: unknown) => {}),
  cost: vi.fn(async (_db: unknown, _row: unknown) => {}),
}));

vi.mock('@/server/ai/log', () => ({
  logMissingToolMountsWarning: vi.fn(),
  writeAiTaskRunStarted: logMocks.started,
  writeAiTaskRunFinished: logMocks.finished,
  writeAiTaskRunRetried: vi.fn(async () => true),
  writeCostLedger: logMocks.cost,
  writeAiTaskAttemptFinished: vi.fn(
    async (
      db: unknown,
      row: {
        id: string;
        status: string;
        finish_reason: string;
        usage: unknown;
        cost_truth: { amountUsd: number | null; basis: string; ref: string };
        error_message?: string;
        outcome: string;
      },
    ) => {
      logMocks.terminalStatuses.push(row.status);
      if (logMocks.finishedFailuresRemaining > 0) {
        logMocks.finishedFailuresRemaining -= 1;
        throw new Error('db down once');
      }
      if (logMocks.finishedShouldThrow) throw new Error('db down');
      await logMocks.finished(db, {
        id: row.id,
        status: row.status,
        finish_reason: row.finish_reason,
        usage: row.usage,
        cost_usd: row.cost_truth.amountUsd ?? undefined,
        cost_basis: row.cost_truth.basis,
        cost_ref: row.cost_truth.ref,
        error_message: row.error_message,
      });
      const usage = row.usage as { inputTokens?: number; outputTokens?: number } | undefined;
      await logMocks.cost(db, {
        task_run_id: row.id,
        cost: row.cost_truth.amountUsd,
        cost_basis: row.cost_truth.basis,
        cost_ref: row.cost_truth.ref,
        tokens_in: usage?.inputTokens ?? 0,
        tokens_out: usage?.outputTokens ?? 0,
        outcome: row.outcome,
      });
      return true;
    },
  ),
  writeToolCallLog: vi.fn(async () => 'tool-log-id'),
}));

import {
  type ExecutionAdapterStartupArgs,
  type PreparedExecutionQuery,
  type RunnerMessage,
  __setPiAdapterForTests,
} from './execution-adapter';
import { __setTraceExporterForTests } from './laminar-tracing';
import { memoryTraceExporter, traceField } from './laminar-tracing.test-support';
import { type TaskEventMessage, runTask, streamTaskCollecting } from './runner';
import { SPAWN_TOOL_ALIASES, SPAWN_TOOL_NAME } from './spawn-contract';
import { createPiSpawnContract } from './tools/pi-subagent';

const fakeDb = {} as never;

function assistant(text: string) {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  };
}

function assistantThinking(thinking: string) {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'thinking', thinking, signature: '' }] },
  };
}

function assistantThinkingWithTask(
  thinking: string,
  toolUseId: string,
  domainTool?: { id: string; name: string; input: Record<string, unknown> },
) {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking, signature: 'redacted-signature' },
        {
          type: 'tool_use',
          id: toolUseId,
          name: 'Agent',
          input: {
            subagent_type: 'diagnostic-scout',
            description: '核对近七日必要条件/充分条件错题、探针与复习轨迹，只回证据结论',
          },
        },
        ...(domainTool
          ? [
              {
                type: 'tool_use',
                id: domainTool.id,
                name: domainTool.name,
                input: domainTool.input,
              },
            ]
          : []),
      ],
    },
  };
}

function taskStarted(taskId: string, toolUseId: string, description: string) {
  return {
    type: 'system',
    subtype: 'task_started',
    task_id: taskId,
    tool_use_id: toolUseId,
    description,
    subagent_type: 'diagnostic-scout',
    uuid: `uuid-start-${taskId}`,
    session_id: 'copilot-session-structured-task-events',
  };
}

function taskProgress(taskId: string, toolUseId: string, description: string) {
  return {
    type: 'system',
    subtype: 'task_progress',
    task_id: taskId,
    tool_use_id: toolUseId,
    description,
    subagent_type: 'diagnostic-scout',
    usage: { total_tokens: 1_842, tool_uses: 4, duration_ms: 12_400 },
    last_tool_name: 'mcp__copilot__get_probe_history',
    summary: '已对齐两次失败作答与一次未教学探针，正在核对反例。',
    uuid: `uuid-progress-${taskId}`,
    session_id: 'copilot-session-structured-task-events',
  };
}

function taskUpdated(
  taskId: string,
  patch: { status: 'running' | 'completed' | 'failed'; description?: string; error?: string },
) {
  return {
    type: 'system',
    subtype: 'task_updated',
    task_id: taskId,
    patch,
    uuid: `uuid-update-${taskId}-${patch.status}`,
    session_id: 'copilot-session-structured-task-events',
  };
}

function taskNotification(
  taskId: string,
  toolUseId: string,
  status: 'completed' | 'failed' | 'stopped',
  summary: string,
) {
  return {
    type: 'system',
    subtype: 'task_notification',
    task_id: taskId,
    tool_use_id: toolUseId,
    status,
    output_file: `/tmp/${taskId}.result.md`,
    summary,
    usage: { total_tokens: 2_711, tool_uses: 6, duration_ms: 18_900 },
    uuid: `uuid-notify-${taskId}-${status}`,
    session_id: 'copilot-session-structured-task-events',
  };
}

const resultMsg = {
  type: 'result',
  subtype: 'success',
  result: 'ignored',
  stop_reason: 'end_turn',
  total_cost_usd: 0,
  usage: { input_tokens: 5, output_tokens: 7, cache_read_input_tokens: 2 },
};

describe('streamTaskCollecting — YUK-266 collecting stream', () => {
  beforeEach(() => {
    mockPi.capturedArgs = undefined;
    __setPiAdapterForTests(fakePiAdapter());
    mockPi.messages = [];
    mockPi.throwAfter = -1;
    mockPi.waitForAbortAfter = -1;
    mockPi.waitForAbortBeforeMessages = false;
    logMocks.finishedShouldThrow = false;
    logMocks.finishedFailuresRemaining = 0;
    logMocks.terminalStatuses = [];
    process.env.XIAOMI_API_KEY = 'sk-test-key';
  });

  afterEach(() => {
    __setTraceExporterForTests();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it('captures per-run sanitized business text and ends after middleware, without accepting provider execution as business success', async () => {
    const { records, exporter } = memoryTraceExporter();
    __setTraceExporterForTests(exporter);
    mockPi.messages = [assistant('synthetic final'), resultMsg];
    const afterRun = vi.fn(() => {
      expect(records.every((record) => record.ends === 0)).toBe(true);
    });
    const result = await streamTaskCollecting(
      'AttributionTask',
      { private: 'SECRET_INPUT' },
      {
        db: fakeDb,
        middleware: { afterRun },
        laminarContent: {
          input: { summary: 'synthetic business input' },
          output: (value) => ({ summary: value.text }),
        },
      },
      () => {},
    );
    expect(result.text).toBe('synthetic final');
    expect(afterRun).toHaveBeenCalledOnce();
    expect(records.every((record) => record.ends === 1)).toBe(true);
    expect(
      records.find((record) => record.name === 'task.run')?.attributes['lmnr.span.output'],
    ).toBe('{"summary":"synthetic final"}');
    const attempt = records.find((record) => record.name === 'task.attempt');
    expect(attempt?.attributes[traceField('business_outcome')]).toBe('unassessed');
    expect(attempt?.attributes[traceField('durable_settled')]).toBe(true);
    expect(attempt?.attributes[traceField('task_run_id')]).toBe(result.task_run_id);
    expect(attempt?.attributes['gen_ai.usage.cost']).toBeUndefined();
    expect(JSON.stringify(records)).not.toContain('SECRET_INPUT');
  });

  it('carries thinking-block metadata without streaming or logging raw reasoning', async () => {
    mockPi.messages = [assistantThinking('hidden reasoning'), assistant('answer'), resultMsg];
    const deltas: string[] = [];

    const result = await streamTaskCollecting(
      'AttributionTask',
      { q: 'x' },
      { db: fakeDb },
      (delta) => deltas.push(delta),
    );

    expect(result.usage).toEqual({
      inputTokens: 7,
      outputTokens: 7,
      thinkingBlocks: 1,
      thinkingCharacters: 16,
    });
    expect(deltas).toEqual(['answer']);
    const { writeAiTaskRunFinished } = await import('@/server/ai/log');
    const finished = (writeAiTaskRunFinished as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1];
    expect(JSON.stringify(finished)).not.toContain('hidden reasoning');
  });

  it('runTask exposes only typed task events and records the SDK-emitted Agent tool_use without raw reasoning', async () => {
    // Agent-enabled product roots override inherited CLI feature flags so an
    // operator or parent shell cannot re-enable SDK background execution.
    vi.stubEnv('CLAUDE_CODE_DISABLE_BACKGROUND_TASKS', '0');
    const hiddenReasoning =
      '先推测学习者可能被“只有才”措辞诱导，但这个内部推理绝不能进入 task observer 或 tool log。';
    const foregroundText = '我会在前台只用 Copilot 一个声音汇总后台调查。';
    mockPi.messages = [
      taskStarted('task-logic-evidence', 'tool-spawn-logic-01', '核对逻辑关系失败证据'),
      assistantThinkingWithTask(hiddenReasoning, 'tool-spawn-logic-01', {
        id: 'tool-domain-attempts-02',
        name: 'mcp__copilot__get_attempt_details',
        input: {
          question_ids: [
            'q_logic_necessary_sufficient_17',
            'q_logic_gate_access_09',
            'q_logic_counterexample_22',
          ],
          include_submission_snapshots: true,
          include_judge_evidence: true,
        },
      }),
      taskProgress('task-logic-evidence', 'tool-spawn-logic-01', '比对作答、探针与复习记录'),
      assistant(foregroundText),
      taskUpdated('task-logic-evidence', {
        status: 'completed',
        description: '证据核对完成，等待 Copilot 汇总',
      }),
      taskNotification(
        'task-logic-evidence',
        'tool-spawn-logic-01',
        'completed',
        '两次错误均把必要条件当充分条件；独立探针复现同一错误。',
      ),
      resultMsg,
    ];
    const observed: TaskEventMessage[] = [];
    const contract = createPiSpawnContract({
      enabled: true,
      agents: {
        'diagnostic-scout': {
          description: '只读证据核对',
          prompt: '核对 attempt/review/probe，一律只回结论与引用。',
          tools: ['mcp__copilot__get_attempt_details', SPAWN_TOOL_NAME],
        },
      },
    });

    const result = await runTask(
      'AttributionTask',
      { question_id: 'q_logic_necessary_sufficient_17' },
      {
        db: fakeDb,
        allowedTools: [SPAWN_TOOL_NAME, 'mcp__copilot__get_attempt_details'],
        piAgents: contract.piAgents,
        piHooks: { beforeToolCall: [contract.gate], afterToolCall: [] },
        onTaskEvent: async (event) => {
          await Promise.resolve();
          observed.push(event);
        },
      },
    );

    expect(result.text).toBe('ignored');
    expect(observed.map((event) => event.subtype)).toEqual([
      'task_started',
      'task_progress',
      'task_updated',
      'task_notification',
    ]);
    const serializedObserved = JSON.stringify(observed);
    expect(serializedObserved).not.toContain(hiddenReasoning);
    expect(serializedObserved).not.toContain(foregroundText);

    const capturedArgs = mockPi.capturedArgs as ExecutionAdapterStartupArgs;
    const spec = capturedArgs.piAgents?.['diagnostic-scout'];
    expect(spec?.tools).toEqual(['mcp__copilot__get_attempt_details']);
    expect(spec?.disallowedTools).toContain(SPAWN_TOOL_NAME);
    expect(spec?.disallowedTools).toEqual(expect.arrayContaining([...SPAWN_TOOL_ALIASES]));
    // The spawn gate rides piHooks.beforeToolCall; no SDK hooks/canUseTool twin.
    expect(capturedArgs.piHooks?.beforeToolCall).toContain(contract.gate);
    expect('forwardSubagentText' in capturedArgs.options).toBe(false);
    expect('env' in capturedArgs.options).toBe(false);

    const { writeToolCallLog } = await import('@/server/ai/log');
    expect(writeToolCallLog).toHaveBeenCalledTimes(1);
    expect(writeToolCallLog).toHaveBeenCalledWith(
      fakeDb,
      expect.objectContaining({
        task_kind: 'AttributionTask',
        tool_name: 'Agent',
        input_json: {
          subagent_type: 'diagnostic-scout',
          description: '核对近七日必要条件/充分条件错题、探针与复习轨迹，只回证据结论',
        },
        iteration: 1,
      }),
    );
    expect(JSON.stringify((writeToolCallLog as ReturnType<typeof vi.fn>).mock.calls)).not.toContain(
      hiddenReasoning,
    );
  });
});
