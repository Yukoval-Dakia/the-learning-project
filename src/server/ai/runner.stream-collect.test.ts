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

function capturedOptions() {
  const args = mockPi.capturedArgs as ExecutionAdapterStartupArgs | undefined;
  return args?.options;
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

function assistantWithUsage(
  text: string,
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  },
) {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }], usage },
  };
}

function assistantThinkingWithUsage(
  thinking: string,
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  },
) {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'thinking', thinking, signature: '' }],
      usage,
    },
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
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it('fires onDelta once per assistant-message chunk and resolves the concatenated text', async () => {
    mockPi.messages = [assistant('Hello, '), assistant('world!'), resultMsg];
    const deltas: string[] = [];

    const result = await streamTaskCollecting('AttributionTask', { q: 'x' }, { db: fakeDb }, (t) =>
      deltas.push(t),
    );

    expect(deltas).toEqual(['Hello, ', 'world!']);
    expect(result.text).toBe('Hello, world!');
    expect(result.terminalText).toBe('ignored');
    expect(result.finishReason).toBe('end_turn');
    // usage aggregates input + cache_read.
    expect(result.usage).toEqual({ inputTokens: 7, outputTokens: 7 });
    expect(result.task_run_id).toBeTruthy();
    expect(result.partial).toBeUndefined();
    expect('forwardSubagentText' in (capturedOptions() as Record<string, unknown>)).toBe(false);
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

  it("forwards caller-declared piAgents verbatim (depth-one reduction is the contract's job)", async () => {
    mockPi.messages = [resultMsg];

    const piAgents = {
      'background-observer': {
        description: 'generic compatibility fixture',
        prompt: 'observe without blocking',
      },
    };
    await runTask(
      'AttributionTask',
      { question_id: 'q_async_compatibility' },
      { db: fakeDb, piAgents },
    );

    const args = mockPi.capturedArgs as ExecutionAdapterStartupArgs;
    expect(args.piAgents).toEqual(piAgents);
    expect('env' in args.options).toBe(false);
  });

  it('streamTaskCollecting preserves interleaved task-event order while thinking/text stay on their own channels', async () => {
    const hiddenReasoning = '内部比较两条知识轨迹的置信度，不向 UI 或 event sink 暴露。';
    const foregroundText = '两个后台核对任务正在推进，我会统一汇总。';
    mockPi.messages = [
      taskStarted('task-symbolic', 'spawn-symbolic-01', '核对符号题证据链'),
      taskStarted('task-applied', 'spawn-applied-02', '核对门禁情境迁移'),
      assistantThinking(hiddenReasoning),
      taskProgress('task-applied', 'spawn-applied-02', '检查门禁题的充分性迁移'),
      assistant(foregroundText),
      taskUpdated('task-symbolic', { status: 'running', description: '等待 probe 对照' }),
      taskNotification(
        'task-applied',
        'spawn-applied-02',
        'failed',
        '题目快照缺少 parent，保守停止，不形成学习结论。',
      ),
      taskNotification(
        'task-symbolic',
        'spawn-symbolic-01',
        'completed',
        '符号题与独立 probe 均复现逆命题错误。',
      ),
      resultMsg,
    ];
    const observed: TaskEventMessage[] = [];
    const deltas: string[] = [];

    const result = await streamTaskCollecting(
      'AttributionTask',
      { learner_window_days: 7, target_knowledge_id: 'kn_logic_implication' },
      {
        db: fakeDb,
        onTaskEvent: (event) => {
          observed.push(event);
        },
      },
      (delta) => deltas.push(delta),
    );

    expect(result.text).toBe(foregroundText);
    expect(deltas).toEqual([foregroundText]);
    expect(observed.map((event) => `${event.subtype}:${event.task_id}`)).toEqual([
      'task_started:task-symbolic',
      'task_started:task-applied',
      'task_progress:task-applied',
      'task_updated:task-symbolic',
      'task_notification:task-applied',
      'task_notification:task-symbolic',
    ]);
    const serializedObserved = JSON.stringify(observed);
    expect(serializedObserved).not.toContain(hiddenReasoning);
    expect(serializedObserved).not.toContain(foregroundText);
  });

  it('runTask respects autoLogToolCalls=false for an owner-written authoritative trace', async () => {
    mockPi.messages = [
      assistantThinkingWithTask('不应落到 input-only tool log 的内部推理。', 'tool-owned-trace-01'),
      resultMsg,
    ];

    await runTask(
      'AttributionTask',
      { q: '由 MCP owner 同时记录输入与输出的调用' },
      { db: fakeDb, autoLogToolCalls: false },
    );

    const { writeToolCallLog } = await import('@/server/ai/log');
    expect(writeToolCallLog).not.toHaveBeenCalled();
  });

  it('streamTaskCollecting respects autoLogToolCalls=false for an owner-written trace', async () => {
    mockPi.messages = [
      assistantThinkingWithTask('流式路径也不应重复记录 owner trace。', 'tool-stream-owned-01', {
        id: 'tool-stream-domain-02',
        name: 'mcp__copilot__get_attempt_details',
        input: {
          question_ids: ['q_fraction_domain_01', 'q_fraction_parameter_08'],
          include_submission_snapshots: true,
        },
      }),
      resultMsg,
    ];

    await streamTaskCollecting(
      'AttributionTask',
      { learner_window_days: 14, target_knowledge_id: 'kn_fractional_equations' },
      { db: fakeDb, autoLogToolCalls: false },
      () => {},
    );

    const { writeToolCallLog } = await import('@/server/ai/log');
    expect(writeToolCallLog).not.toHaveBeenCalled();
  });

  it('rejects an already-aborted collecting request before adapter startup', async () => {
    mockPi.messages = [assistant('hi'), resultMsg];
    const ac = new AbortController();
    ac.abort();

    await expect(
      streamTaskCollecting(
        'AttributionTask',
        { q: 'x' },
        { db: fakeDb, signal: ac.signal },
        () => {},
      ),
    ).rejects.toThrow('provider attempt aborted before adapter startup');

    expect(capturedOptions()).toBeUndefined();
    expect(logMocks.started).not.toHaveBeenCalled();
    expect(logMocks.terminalStatuses).toEqual([]);
    expect(logMocks.cost).not.toHaveBeenCalled();
  });

  it('propagates a mid-flight owner Stop, preserves the collected delta, and records failure', async () => {
    const partial = '已核对 48 条历史回答、3 份讲义和 4/6 个薄弱点探针；9 个迁移变式尚未开始。';
    mockPi.messages = [assistant(partial), resultMsg];
    mockPi.waitForAbortAfter = 1;
    const owner = new AbortController();
    const deltas: string[] = [];

    const running = streamTaskCollecting(
      'AttributionTask',
      {
        answer_ids: Array.from({ length: 48 }, (_, index) => `answer_${index + 1}`),
        probe_count: 6,
        source_document_count: 3,
        transfer_variant_count: 9,
      },
      { db: fakeDb, signal: owner.signal },
      (delta) => deltas.push(delta),
    );
    await vi.waitFor(() => {
      expect(deltas).toEqual([partial]);
    });
    owner.abort();

    const result = await running;
    expect(result).toMatchObject({
      text: partial,
      partial: true,
      finishReason: 'error',
      error: 'pi stream aborted after owner Stop',
    });
    const captured = (capturedOptions() as { abortController: AbortController }).abortController;
    expect(captured.signal.aborted).toBe(true);
    const { writeAiTaskRunFinished } = await import('@/server/ai/log');
    expect(writeAiTaskRunFinished).toHaveBeenLastCalledWith(
      fakeDb,
      expect.objectContaining({ status: 'failure', finish_reason: 'error' }),
    );
  });

  it('rejects an already-aborted non-streaming request before adapter startup', async () => {
    mockPi.messages = [assistant('classifier result'), resultMsg];
    const owner = new AbortController();
    owner.abort();

    await expect(
      runTask(
        'AttributionTask',
        { q: 'bounded classifier input' },
        {
          db: fakeDb,
          signal: owner.signal,
        },
      ),
    ).rejects.toThrow('provider attempt aborted before adapter startup');

    expect(capturedOptions()).toBeUndefined();
    expect(logMocks.started).not.toHaveBeenCalled();
    expect(logMocks.terminalStatuses).toEqual([]);
    expect(logMocks.cost).not.toHaveBeenCalled();
  });

  it('records failure (not success) when the stream ends without a terminal result message', async () => {
    // Assistant deltas arrive but the SDK stream ends WITHOUT a result message and
    // WITHOUT throwing. The collecting variant must NOT record this as success
    // (which would corrupt the cost ledger + run audit); it falls into the
    // graceful-degrade path: status:'failure' / finishReason:'error' / partial:true.
    mockPi.messages = [assistant('orphan chunk')];
    const deltas: string[] = [];

    const result = await streamTaskCollecting('AttributionTask', { q: 'x' }, { db: fakeDb }, (t) =>
      deltas.push(t),
    );

    expect(deltas).toEqual(['orphan chunk']);
    expect(result.text).toBe('orphan chunk');
    expect(result.partial).toBe(true);
    expect(result.finishReason).toBe('error');
    expect(result.error).toContain('stream_no_terminal');

    // The finished row must be recorded as a failure — never success.
    const { writeAiTaskRunFinished, writeCostLedger } = await import('@/server/ai/log');
    expect(writeAiTaskRunFinished).toHaveBeenCalledTimes(1);
    expect((writeAiTaskRunFinished as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]).toMatchObject({
      status: 'failure',
      finish_reason: 'error',
    });
    expect(writeCostLedger).toHaveBeenCalledWith(
      fakeDb,
      expect.objectContaining({
        cost: null,
        cost_basis: 'unknown',
        outcome: 'failed_retryable',
      }),
    );
  });

  it('classifies an abort after durable start but before the first message as permanent', async () => {
    const owner = new AbortController();
    mockPi.messages = [];
    mockPi.waitForAbortBeforeMessages = true;

    const running = streamTaskCollecting(
      'AttributionTask',
      { q: 'x' },
      { db: fakeDb, signal: owner.signal },
      () => {},
    );
    await vi.waitFor(() => expect(logMocks.started).toHaveBeenCalledTimes(1));
    owner.abort();

    const result = await running;
    expect(result.partial).toBe(true);
    expect(result.error).toContain('aborted');
    expect(logMocks.cost).toHaveBeenCalledWith(
      fakeDb,
      expect.objectContaining({ cost_basis: 'unknown', outcome: 'failed_permanent' }),
    );
  });

  it('propagates a start-write failure without returning a phantom partial task run', async () => {
    logMocks.started.mockRejectedValueOnce(new Error('start row unavailable'));

    await expect(
      streamTaskCollecting('AttributionTask', { q: 'x' }, { db: fakeDb }, () => {}),
    ).rejects.toThrow('start row unavailable');

    expect(logMocks.finished).not.toHaveBeenCalled();
    expect(logMocks.cost).not.toHaveBeenCalled();
  });

  it('keeps a paid lower bound when a large multi-turn stream dies before its terminal result', async () => {
    const hiddenThinking =
      '逐项核对 21 条只读 observation、六个 request atoms 与十个 evidence points；这里只保留计数。';
    mockPi.messages = [
      assistantWithUsage('已整理第一批证据点。', {
        input_tokens: 40_000,
        output_tokens: 2_000,
        cache_read_input_tokens: 5_000,
        cache_creation_input_tokens: 1_000,
      }),
      assistantThinkingWithUsage(hiddenThinking, {
        input_tokens: 55_000,
        output_tokens: 3_000,
        cache_read_input_tokens: 7_000,
        cache_creation_input_tokens: 2_000,
      }),
      resultMsg,
    ];
    mockPi.throwAfter = 2;

    const result = await streamTaskCollecting(
      'AttributionTask',
      {
        request_unit_count: 6,
        successful_read_count: 21,
        evidence_leaf_count: 2_184,
      },
      { db: fakeDb },
      () => {},
    );

    expect(result).toMatchObject({
      partial: true,
      finishReason: 'error',
      usage: {
        inputTokens: 107_000,
        outputTokens: 5_000,
        thinkingBlocks: 1,
        thinkingCharacters: hiddenThinking.length,
      },
    });
    expect(result.cost_usd).toBeGreaterThan(0);

    const { writeAiTaskRunFinished, writeCostLedger } = await import('@/server/ai/log');
    expect(writeAiTaskRunFinished).toHaveBeenLastCalledWith(
      fakeDb,
      expect.objectContaining({
        status: 'failure',
        usage: expect.objectContaining({ inputTokens: 107_000, outputTokens: 5_000 }),
        cost_usd: expect.any(Number),
      }),
    );
    expect(writeCostLedger).toHaveBeenCalledTimes(1);
    expect(writeCostLedger).toHaveBeenCalledWith(
      fakeDb,
      expect.objectContaining({
        outcome: 'failed_permanent',
        tokens_in: 107_000,
        tokens_out: 5_000,
        cost: expect.any(Number),
      }),
    );
    expect(
      JSON.stringify((writeAiTaskRunFinished as ReturnType<typeof vi.fn>).mock.calls),
    ).not.toContain(hiddenThinking);
  });

  it('records success+is_error usage and cost as a graceful partial failure without success accounting', async () => {
    mockPi.messages = [
      assistant('partial chunk'),
      {
        type: 'result',
        subtype: 'success',
        is_error: true,
        api_error_status: 429,
        result: 'rate limited',
        stop_reason: 'end_turn',
        total_cost_usd: 0.25,
        usage: {
          input_tokens: 10,
          output_tokens: 3,
          cache_read_input_tokens: 4,
          cache_creation_input_tokens: 2,
        },
      },
    ];

    const result = await streamTaskCollecting(
      'AttributionTask',
      { q: 'x' },
      { db: fakeDb },
      () => {},
    );

    expect(result).toMatchObject({
      text: 'partial chunk',
      finishReason: 'error',
      partial: true,
      usage: { inputTokens: 14, outputTokens: 3 },
      cost_usd: 0.0000069744,
      cost_basis: 'estimated',
      error: expect.stringContaining('api_error_result http=429'),
    });

    const { writeAiTaskRunFinished, writeCostLedger } = await import('@/server/ai/log');
    expect(writeAiTaskRunFinished).toHaveBeenCalledTimes(1);
    expect(writeAiTaskRunFinished).toHaveBeenCalledWith(
      fakeDb,
      expect.objectContaining({
        status: 'failure',
        finish_reason: 'error',
        usage: { inputTokens: 14, outputTokens: 3 },
        cost_usd: 0.0000069744,
        cost_basis: 'estimated',
        error_message: expect.stringContaining('api_error_result http=429'),
      }),
    );
    expect(writeCostLedger).toHaveBeenCalledTimes(1);
    expect(writeCostLedger).toHaveBeenCalledWith(
      fakeDb,
      expect.objectContaining({
        outcome: 'failed_retryable',
        cost: 0.0000069744,
        tokens_in: 14,
        tokens_out: 3,
        cost_basis: 'estimated',
      }),
    );
  });

  it('does not add an empty error detail when success+is_error omits result', async () => {
    mockPi.messages = [
      assistantWithUsage('已完成部分核验。', {
        input_tokens: 12_000,
        output_tokens: 800,
        cache_read_input_tokens: 2_000,
      }),
      {
        type: 'result',
        subtype: 'success',
        is_error: true,
        api_error_status: 500,
        total_cost_usd: 0.1,
      },
    ];

    const result = await streamTaskCollecting(
      'AttributionTask',
      { q: 'x' },
      { db: fakeDb },
      () => {},
    );

    expect(result.error).toBe(
      '[AttributionTask] agent run errored: subtype=api_error_result http=500',
    );
    expect(result.usage).toEqual({ inputTokens: 14_000, outputTokens: 800 });
    const { writeCostLedger } = await import('@/server/ai/log');
    expect(writeCostLedger).toHaveBeenCalledWith(
      fakeDb,
      expect.objectContaining({
        outcome: 'failed_retryable',
        cost: 0.0059232,
        cost_basis: 'estimated',
        tokens_in: 14_000,
        tokens_out: 800,
      }),
    );
  });

  it('degrades gracefully: resolves partial text when the SDK throws mid-stream', async () => {
    // Yield one delta, then throw before the result message.
    mockPi.messages = [assistant('partial chunk'), resultMsg];
    mockPi.throwAfter = 1;
    const deltas: string[] = [];

    const result = await streamTaskCollecting('AttributionTask', { q: 'x' }, { db: fakeDb }, (t) =>
      deltas.push(t),
    );

    // The collected delta reached the caller, and the resolved result carries it
    // with the partial/error flags — the run did NOT throw.
    expect(deltas).toEqual(['partial chunk']);
    expect(result.text).toBe('partial chunk');
    expect(result.partial).toBe(true);
    expect(result.error).toContain('pi blew up');
    expect(result.finishReason).toBe('error');
  });

  it('rejects instead of returning partial when success settlement fails', async () => {
    mockPi.messages = [assistant('must not persist'), resultMsg];
    logMocks.finishedShouldThrow = true;

    await expect(
      streamTaskCollecting('AttributionTask', { q: 'x' }, { db: fakeDb }, () => {}),
    ).rejects.toThrow(/cannot report success before durable attempt settlement/);

    expect(logMocks.terminalStatuses).toEqual(['success', 'failure']);
    expect(logMocks.finished).not.toHaveBeenCalled();
    expect(logMocks.cost).not.toHaveBeenCalled();
  });

  it('still rejects provider-success text when the bounded failure fallback settles', async () => {
    mockPi.messages = [assistant('must not persist'), resultMsg];
    logMocks.finishedFailuresRemaining = 1;

    await expect(
      streamTaskCollecting('AttributionTask', { q: 'x' }, { db: fakeDb }, () => {}),
    ).rejects.toThrow(/cannot report success before durable attempt settlement/);

    expect(logMocks.terminalStatuses).toEqual(['success', 'failure']);
    expect(logMocks.finished).toHaveBeenCalledTimes(1);
    expect(logMocks.finished.mock.calls[0][1]).toMatchObject({ status: 'failure' });
    expect(logMocks.cost).toHaveBeenCalledTimes(1);
    expect(logMocks.cost.mock.calls[0][1]).toMatchObject({ outcome: 'failed_permanent' });
  });

  it('rejects instead of returning partial when failure settlement fails', async () => {
    mockPi.messages = [assistant('must not persist'), resultMsg];
    mockPi.throwAfter = 1;
    logMocks.finishedShouldThrow = true;

    await expect(
      streamTaskCollecting('AttributionTask', { q: 'x' }, { db: fakeDb }, () => {}),
    ).rejects.toThrow(/pi blew up mid-stream/);

    expect(logMocks.terminalStatuses).toEqual(['failure']);
    expect(logMocks.finished).not.toHaveBeenCalled();
    expect(logMocks.cost).not.toHaveBeenCalled();
  });
});
