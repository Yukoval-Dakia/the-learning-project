import { describe, expect, it, vi } from 'vitest';
import type { BuildMcpServerOptions } from '@/server/ai/tools/mcp-bridge';
import {
  type CopilotExecutionAdapters,
  DURABLE_COPILOT_EXECUTION_BUDGET,
  createCopilotExecutionOwner,
} from './copilot-execution';
import type { CopilotRunCancellationControl } from './copilot-run-cancellation';
import type { CopilotRunInput } from './copilot-run-input';
import {
  clearCopilotSessionContextDelivery,
  copilotSessionContextDigest,
  markCopilotSessionContextDelivered,
} from './live-session-context';
import { buildCopilotToolResultSnapshot } from './tool-result-snapshot';

const input: CopilotRunInput = {
  surface: 'copilot',
  triggered_by: 'chat',
  user_message: '核对我的学习状态。',
  proposal_feedback: [],
  conversation_history: [],
  correction_contract: {
    available_prior_turn_ids: [],
    prior_turn_summaries: {},
    required_fields: ['prior_turn_id', 'changed', 'retained', 'uncertain'],
  },
};

function fakeCancellation(controller = new AbortController()): CopilotRunCancellationControl {
  return {
    signal: controller.signal,
    hasConfirmedCancellation: false,
    materializingToolStarted: false,
    startPolling: vi.fn(),
    dispose: vi.fn(),
    probe: vi.fn(async () => 'clear' as const),
    beforeTool: vi.fn(async () => undefined),
    piBeforeToolCall: vi.fn(async () => undefined),
    onToolExecutionStarted: vi.fn(),
    onToolExecutionSettled: vi.fn(),
    waitForInFlight: vi.fn(async () => true),
  };
}

function ownerWith(
  run: CopilotExecutionAdapters['runAgentTaskFn'],
  stream: CopilotExecutionAdapters['streamTaskCollectingFn'] | undefined,
  captureMcp: (options: BuildMcpServerOptions) => void = () => {},
) {
  const captureCtx = (ctx: { piToolMounts?: readonly { type: string; options?: unknown }[] }) => {
    const mount = ctx.piToolMounts?.[0];
    if (mount?.type === 'domain') captureMcp(mount.options as BuildMcpServerOptions);
  };
  return createCopilotExecutionOwner({
    runAgentTaskFn: async (kind, value, ctx) => {
      captureCtx(ctx);
      return run(kind, value, ctx);
    },
    streamTaskCollectingFn: stream
      ? async (kind, value, ctx, onDelta) => {
          captureCtx(ctx);
          return stream(kind, value, ctx, onDelta);
        }
      : async (kind, value, ctx) => {
          captureCtx(ctx);
          const result = await run(kind, value, ctx);
          return { ...result, terminalText: result.text, partial: false };
        },
    buildExaMcpServerFn: () => null,
    resolveCopilotSkillDocsFn: async () => undefined,
  });
}

async function piBefore(
  ctx: { piHooks?: { beforeToolCall?: readonly ((...args: never[]) => unknown)[] } },
  call: { id: string; name: string; agentType?: string },
  args: Record<string, unknown>,
): Promise<void> {
  for (const entry of ctx.piHooks?.beforeToolCall ?? []) {
    await (entry as (...a: unknown[]) => unknown)(call, args, new AbortController().signal);
  }
}

async function piAfter(
  ctx: { piHooks?: { afterToolCall?: readonly ((...args: never[]) => unknown)[] } },
  observation: {
    call: { id: string; name: string; agentType?: string };
    args: Record<string, unknown>;
    isError: boolean;
    output?: unknown;
    error?: unknown;
    interrupted?: boolean;
  },
): Promise<void> {
  for (const entry of ctx.piHooks?.afterToolCall ?? []) {
    await (entry as (...a: unknown[]) => unknown)(observation, new AbortController().signal);
  }
}

describe('Copilot execution owner', () => {
  it('preserves the paid reply but discards the SDK cursor when native projection persistence fails', async () => {
    const stream = vi.fn<CopilotExecutionAdapters['streamTaskCollectingFn']>(
      async (_kind, _input, ctx) => {
        await ctx.sdkSession?.onSessionId?.('sdk_projection_write_failed');
        await ctx.onTaskEvent?.({
          type: 'system',
          subtype: 'task_started',
          session_id: 'session_projection_failure',
          uuid: '00000000-0000-4000-8000-000000000980',
          task_id: 'native_projection_failure',
          subagent_type: 'copilot-researcher',
          description: '比较三份材料的来源、反例、时间范围与尚未覆盖的证据。',
        });
        return {
          task_run_id: 'root_projection_failure',
          text: '本轮已结束，缺失的材料仍待核对。',
          terminalText: '本轮已结束，缺失的材料仍待核对。',
          partial: false,
        };
      },
    );
    const db = {
      transaction: vi.fn().mockRejectedValue(new Error('isolated projection write unavailable')),
    };
    const run = vi.fn<CopilotExecutionAdapters['runAgentTaskFn']>();
    const owner = ownerWith(run, stream);
    const result = await owner(
      db as never,
      {
        input,
        sessionId: 'session_projection_failure',
        sourceEventId: 'ask_projection_failure',
        taskRunId: 'root_projection_failure',
      },
      { cancellation: fakeCancellation(), deadlineAt: Date.now() + 60_000, subagentsEnabled: true },
    );
    expect(result.finalization.accepted).toBe(true);
    expect(result.finalization.preparedReply.text).toBe('本轮已结束，缺失的材料仍待核对。');
    expect(result.sdkSessionId).toBeUndefined();
    expect(stream).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();
  });

  it('settles a partial stream through the finalizer without throwing', async () => {
    // streamTaskCollecting's graceful-partial return carries `text` but NO
    // `terminalText` — the seal marker is absent by definition. The owner must
    // NOT throw ('resumed agent session returned partial output' was removed):
    // the finalizer fails closed into the unsealed-draft fallback instead.
    const stream = vi.fn<CopilotExecutionAdapters['streamTaskCollectingFn']>(async () => ({
      task_run_id: 'root_partial_resume',
      text: '已检索到两段材料，但整理尚未完成。',
      partial: true,
      error: 'error_max_turns',
    }));
    const db = { transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(db)) };
    const run = vi.fn<CopilotExecutionAdapters['runAgentTaskFn']>();
    const owner = ownerWith(run, stream);
    const result = await owner(
      db as never,
      {
        input,
        sessionId: 'session_partial_resume',
        sourceEventId: 'ask_partial_resume',
        taskRunId: 'root_partial_resume',
      },
      {
        cancellation: fakeCancellation(),
        deadlineAt: Date.now() + 60_000,
        subagentsEnabled: false,
      },
    );
    expect(result.partial).toBe(true);
    expect(result.error).toBe('error_max_turns');
    expect(result.finalization.accepted).toBe(false);
    expect(result.finalization.preparedReply.text).not.toContain('已检索到两段材料');
    expect(result.sdkSessionId).toBeUndefined();
  });

  it('reinjects learner state on cached resumes and supplies complete current context for compact', async () => {
    const current = {
      ...input,
      learner_state_header: '当前目标：含参方程；边界仍待核对',
      proposal_feedback: [
        {
          kind: 'knowledge_edge',
          relation: 'prerequisite',
          acceptance_rate: 0.25,
          top_dismiss_reasons: ['范围过宽'],
          top_rubric_gates: ['先核对定义域'],
        },
      ],
      conversation_history: [{ role: 'ai' as const, text: '旧答案不得重发' }],
    };
    const run = vi.fn<CopilotExecutionAdapters['runAgentTaskFn']>(async () => ({
      task_run_id: 'resume_task',
      text: '已核对。',
      finishReason: 'end_turn',
    }));
    markCopilotSessionContextDelivered(
      'compact-resume-session',
      copilotSessionContextDigest(current),
    );
    try {
      const execute = ownerWith(run, undefined);
      await execute(
        {} as never,
        { input: current, sessionId: 'session_context', taskRunId: 'root_context' },
        {
          cancellation: fakeCancellation(),
          deadlineAt: 900_000,
          resumeSessionId: 'compact-resume-session',
        },
      );
      const ctx = run.mock.calls[0]?.[2];
      expect(ctx?.sdkSession?.resume).toBe('compact-resume-session');
      expect(ctx?.compiledModelPrompt?.text).toContain('当前目标：含参方程');
      expect(ctx?.compiledModelPrompt?.text).not.toContain('范围过宽');
      expect(ctx?.compiledModelPrompt?.text).not.toContain('旧答案');
      expect(ctx?.nativeCompaction?.sessionContext).toContain('当前目标：含参方程');
      expect(ctx?.nativeCompaction?.sessionContext).toContain('范围过宽');
      expect(ctx?.nativeCompaction?.sessionContext).not.toContain('旧答案');
      expect(ctx?.piHooks?.beforeToolCall?.length).toBeGreaterThanOrEqual(1);
      // YUK-1022 — resume on the pi lane replays the durable turns instead of
      // reattaching a session file: 'ai' rows land as assistant messages.
      expect(ctx?.piSessionReplay).toEqual([{ role: 'assistant', text: '旧答案不得重发' }]);
    } finally {
      clearCopilotSessionContextDelivery('compact-resume-session');
    }
  });
  it('owns worker runner/MCP assembly and preserves lifecycle signal identity', async () => {
    let mcp: BuildMcpServerOptions | undefined;
    const run = vi.fn<CopilotExecutionAdapters['runAgentTaskFn']>(async () => ({
      task_run_id: 'foreground_task',
      text: '已核对。',
      finishReason: 'end_turn',
    }));
    const execute = ownerWith(run, undefined, (options) => {
      mcp = options;
    });
    const requestController = new AbortController();

    const result = await execute(
      {} as never,
      { input, sessionId: 'session_1', taskRunId: 'root_1', sourceEventId: 'ask_1' },
      {
        cancellation: fakeCancellation(requestController),
        deadlineAt: 42_000,
        subagentsEnabled: true,
      },
    );

    expect(result.finalization).toMatchObject({ accepted: true, replyText: '已核对。' });
    const ctx = run.mock.calls[0]?.[2];
    expect(ctx).toMatchObject({
      taskRunId: 'root_1',
      signal: requestController.signal,
      sdkSession: { persist: true },
    });
    expect(ctx?.lifecycleAbortController).toBeInstanceOf(AbortController);
    expect(ctx?.allowedTools).toContain('Task');
    expect(ctx?.allowedTools).toContain('mcp__loom__present_primary_view');
    expect(ctx?.piAgents?.['copilot-researcher']).toBeDefined();
    expect(ctx?.onTaskEvent).toEqual(expect.any(Function));
    // YUK-1022 — pi dual descriptors ride the same runnerContext: the pi lane
    // mounts domain tools via piToolMounts, gates spawns through piHooks'
    // beforeToolCall chain, and hosts nested agents from piAgents specs.
    expect(ctx?.piAgents?.['copilot-researcher']).toMatchObject({
      description: expect.any(String),
      prompt: expect.any(String),
    });
    expect(ctx?.piAgents?.['copilot-researcher']?.disallowedTools).toEqual(
      expect.arrayContaining(['Agent', 'Task']),
    );
    expect(ctx?.piHooks?.beforeToolCall?.length).toBeGreaterThanOrEqual(2);
    expect(ctx?.piToolMounts?.map((mount) => mount.type)).toEqual(['domain']);
    const piSpawnGate = ctx?.piHooks?.beforeToolCall?.at(-1);
    expect(
      await piSpawnGate?.(
        { id: 'spawn-gate-check', name: 'Task' },
        { subagent_type: 'not-declared' },
        requestController.signal,
      ),
    ).toMatchObject({ block: true });
    expect(mcp?.ctx).toMatchObject({
      sessionId: 'session_1',
      taskRunId: 'root_1',
      causedByEventId: 'ask_1',
      providerAttemptCaller: 'worker',
      providerSessionDeadlineAt: 42_000,
    });
    expect(mcp?.ctx.signal).toBe(ctx?.lifecycleAbortController?.signal);
    expect(mcp?.cancellationSignals).toEqual([
      { signal: ctx?.lifecycleAbortController?.signal, requestedBy: 'system' },
      { signal: requestController.signal, requestedBy: 'user' },
    ]);
    const readTool = { name: 'query_knowledge', effect: 'read' as const };
    for (let index = 0; index < 10; index += 1) {
      await expect(mcp?.beforeExecute?.(readTool)).resolves.toBeUndefined();
    }
    const warning = mcp?.interceptInput?.(readTool, { limit: 10 });
    expect(warning?.truncationNote).toMatchObject({
      level: 'warning',
      // Uncapped surface: the hard limit is the JSON-safe inert sentinel, so
      // hard_remaining reports effectively-infinite headroom.
      dimensions: {
        toolCalls: { used: 10, hard_remaining: Number.MAX_SAFE_INTEGER - 10 },
      },
    });
  });

  it('keeps the persistent execution budget and cumulative read gates', async () => {
    let mcp: BuildMcpServerOptions | undefined;
    const stream = vi.fn<CopilotExecutionAdapters['streamTaskCollectingFn']>(async () => ({
      task_run_id: 'durable_task',
      text: '已核对。',
      terminalText: '已核对。',
      finishReason: 'end_turn',
    }));
    const execute = ownerWith(vi.fn(), stream, (options) => {
      mcp = options;
    });
    const cancellation = fakeCancellation();

    const result = await execute(
      {} as never,
      { input, sessionId: 'session_2', taskRunId: 'root_2', sourceEventId: 'ask_2' },
      {
        cancellation,
        deadlineAt: 900_000,
        subagentsEnabled: true,
      },
    );

    expect(result.finalization).toMatchObject({ accepted: true, replyText: '已核对。' });
    const ctx = stream.mock.calls[0]?.[2];
    expect(ctx).toMatchObject({
      taskRunId: 'root_2',
      signal: cancellation.signal,
      budgetOverride: {
        maxIterations: 'unbounded',
        timeoutMs: DURABLE_COPILOT_EXECUTION_BUDGET.timeoutMs,
      },
    });
    expect(ctx?.sdkSession).toMatchObject({ persist: true });
    expect(ctx?.nativeCompaction).toMatchObject({ sessionContext: expect.anything() });
    expect(ctx?.allowedTools).toContain('Task');
    // Root turns are uncapped, so the nested researcher carries no maxTurns.
    expect(ctx?.piAgents?.['copilot-researcher']).not.toHaveProperty('maxTurns');
    expect(ctx?.onTaskEvent).toEqual(expect.any(Function));
    expect(ctx?.providerSessionDeadlineAt).toBeUndefined();
    expect(mcp?.ctx.providerSessionDeadlineAt).toBe(900_000);
    expect(mcp?.ctx.signal).toBe(ctx?.lifecycleAbortController?.signal);
    expect(mcp?.cancellationSignals).toEqual([
      { signal: ctx?.lifecycleAbortController?.signal, requestedBy: 'system' },
      { signal: cancellation.signal, requestedBy: 'user' },
    ]);
    await expect(mcp?.beforeExecute?.({ name: 'query_knowledge', effect: 'read' })).resolves.toBe(
      undefined,
    );
    expect(cancellation.beforeTool).toHaveBeenCalledTimes(1);
    const durableTool = { name: 'query_knowledge', effect: 'read' as const };
    // Uncapped budget: 'unbounded' turns, finite recovery-bound timeout.
    expect(DURABLE_COPILOT_EXECUTION_BUDGET).toMatchObject({
      maxIterations: 'unbounded',
    });
    const graphTool = { name: 'expand_knowledge_subgraph', effect: 'read' as const };
    const graphArgs = {
      centerNodeId: 'kc_parameter_boundary',
      maxNodes: 60,
      depth: 3,
      include: ['ancestors', 'neighbors', 'recent_failures'],
      relationTypes: ['prerequisite', 'related'],
    };
    // Well past every historical hard ceiling: the tracker still counts and can
    // attach advisory warnings, but never truncates args and never soft-stops.
    for (let index = 1; index <= 60; index += 1) {
      await expect(mcp?.beforeExecute?.(graphTool)).resolves.toBeUndefined();
      const capped = mcp?.interceptInput?.(graphTool, graphArgs);
      expect(capped?.args).toEqual(graphArgs);
      expect(capped?.softStop).toBeNull();
    }
    expect(graphArgs.maxNodes).toBe(60);
    await expect(mcp?.beforeExecute?.(durableTool)).resolves.toBeUndefined();
  });

  it('owns optional web grounding and skill resolution', async () => {
    let runnerContext: Parameters<CopilotExecutionAdapters['runAgentTaskFn']>[2] | undefined;
    const execute = createCopilotExecutionOwner({
      streamTaskCollectingFn: async (_kind, _input, ctx) => {
        runnerContext = ctx;
        return {
          task_run_id: 'grounded_task',
          text: '已核对公开资料。',
          terminalText: '已核对公开资料。',
        };
      },
      buildExaMcpServerFn: () => ({
        type: 'http',
        url: 'https://mcp.exa.ai/mcp',
      }),
      resolveCopilotSkillDocsFn: async () => [{ name: '_shared--copilot', body: 'skill body' }],
    });

    await execute(
      {} as never,
      { input, sessionId: 'session_grounded', taskRunId: 'root_grounded' },
      { cancellation: fakeCancellation(), deadlineAt: 900_000, subagentsEnabled: false },
    );

    expect(runnerContext?.allowedTools).toEqual(
      expect.arrayContaining(['mcp__exa__web_search_exa', 'mcp__exa__web_fetch_exa']),
    );
    // YUK-1022 — pi twins: the domain mount + a remote-mcp mount for exa, and
    // the resolved SKILL.md bodies the adapter injects into the system prompt.
    expect(runnerContext?.piToolMounts?.map((mount) => mount.type)).toEqual([
      'domain',
      'remote-mcp',
    ]);
    expect(runnerContext?.piSkillDocs).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: '_shared--copilot' })]),
    );
  });

  it('emits tool_finished for settled remote-MCP calls and skips domain/native calls', async () => {
    let runnerContext: Parameters<CopilotExecutionAdapters['runAgentTaskFn']>[2] | undefined;
    const execute = createCopilotExecutionOwner({
      streamTaskCollectingFn: async (_kind, _input, ctx) => {
        runnerContext = ctx;
        return {
          task_run_id: 'remote_finished_task',
          text: '已核对公开资料。',
          terminalText: '已核对公开资料。',
        };
      },
      buildExaMcpServerFn: () => ({
        type: 'http',
        url: 'https://mcp.exa.ai/mcp',
      }),
      resolveCopilotSkillDocsFn: async () => undefined,
    });
    const observe = vi.fn();

    await execute(
      {} as never,
      { input, sessionId: 'session_remote', taskRunId: 'root_remote' },
      {
        cancellation: fakeCancellation(),
        deadlineAt: 900_000,
        subagentsEnabled: false,
        observe,
      },
    );

    const ctx = runnerContext as {
      piHooks?: { afterToolCall?: readonly ((...args: never[]) => unknown)[] };
    };
    // Remote exa call — the domain bridge never sees it, so the pi
    // afterToolCall observer is the only finish signal for its card.
    await piAfter(ctx, {
      call: { id: 'call_exa_1', name: 'mcp__exa__web_search_exa' },
      args: { query: 'IELTS reading' },
      isError: false,
      output: [{ text: 'result payload' }],
    });
    // Remote failure also emits (with errorReason) — the card must not spin.
    await piAfter(ctx, {
      call: { id: 'call_exa_2', name: 'mcp__exa__web_fetch_exa' },
      args: { url: 'https://example.com' },
      isError: true,
      error: new Error('fetch timeout'),
    });
    // Domain mount calls are finished by the bridge's onToolComplete — the
    // observer must not double-emit; native Task calls never match `mcp__`.
    await piAfter(ctx, {
      call: { id: 'call_loom', name: 'mcp__loom__query_knowledge' },
      args: { query: 'x' },
      isError: false,
      output: {},
    });
    await piAfter(ctx, {
      call: { id: 'call_task', name: 'Task' },
      args: {},
      isError: false,
      output: {},
    });
    await vi.waitFor(() => {
      expect(observe).toHaveBeenCalledTimes(2);
    });
    expect(observe).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'tool_finished',
        toolName: 'mcp__exa__web_search_exa',
        toolUseId: 'call_exa_1',
      }),
    );
    expect(observe).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'tool_finished',
        toolName: 'mcp__exa__web_fetch_exa',
        toolUseId: 'call_exa_2',
        errorReason: expect.stringContaining('fetch timeout'),
      }),
    );
  });

  it('streams generated learning prose before the unresolved terminal without review or marker JSON', async () => {
    const prose = '题目\n1. 求 17×19？\n解：17×20−17=323。';
    let finish!: () => void;
    let started!: () => void;
    const blocked = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const reviewer = vi.fn<CopilotExecutionAdapters['runAgentTaskFn']>();
    const events: unknown[] = [];
    const execute = ownerWith(reviewer, async (_kind, _input, _ctx, onDelta) => {
      onDelta('题目\n1. 求 ');
      onDelta('17×19？\n解：17×20−17=323。<!--copilot_');
      onDelta('learning_content:{"private":"hidden"}-->');
      started();
      await blocked;
      return { task_run_id: 'root_prose', text: prose, terminalText: prose };
    });
    const running = execute(
      {} as never,
      { input, sessionId: 'session_prose', taskRunId: 'root_prose' },
      {
        cancellation: fakeCancellation(),
        deadlineAt: Date.now() + 60_000,
        subagentsEnabled: false,
        observe: (activity) => {
          events.push(activity);
        },
      },
    );
    await ready;
    expect(events).toEqual([
      { kind: 'prose_delta', text: '题目\n1. 求 ' },
      { kind: 'prose_delta', text: '17×19？\n解：17×20−17=323。' },
    ]);
    expect(reviewer).not.toHaveBeenCalled();
    finish();
    expect((await running).finalization.preparedReply).toEqual({ text: prose });
    expect(reviewer).not.toHaveBeenCalled();
  });

  it('binds root and child tool trace while correlating the root MCP call id', async () => {
    let mcp: BuildMcpServerOptions | undefined;
    const toolInput = { subjectId: 'math', nodeId: 'k1' };
    const run = vi.fn(async (_kind, _input, ctx) => {
      const rootCall = { id: 'root_tool_1', name: 'mcp__loom__query_knowledge' };
      const childCall = {
        id: 'child_tool_1',
        name: 'mcp__loom__query_knowledge',
        agentType: 'researcher_1',
      };
      await piBefore(ctx, rootCall, toolInput);
      await piBefore(ctx, childCall, toolInput);
      // The pi bridge forwards the loop's native toolCall.id via
      // `correlatedToolUseId` — onResult's tool_use_id IS the call id.
      mcp?.onResult?.({
        tool_use_id: 'root_tool_1',
        name: 'query_knowledge',
        effect: 'read',
        input: toolInput,
        output: { nodes: [{ id: 'k1' }] },
        error_reason: null,
        executed: true,
      });
      await piAfter(ctx, {
        call: rootCall,
        args: toolInput,
        isError: false,
        output: { nodes: [{ id: 'k1' }] },
      });
      await piAfter(ctx, {
        call: childCall,
        args: toolInput,
        isError: false,
        output: { nodes: [{ id: 'k1' }] },
      });
      return { task_run_id: 'trace_task', text: '已根据知识节点核对。' };
    });
    const execute = ownerWith(run, undefined, (options) => {
      mcp = options;
    });

    const result = await execute(
      {} as never,
      { input, sessionId: 'session_5', taskRunId: 'root_5', sourceEventId: 'ask_5' },
      { cancellation: fakeCancellation(), deadlineAt: 900_000, subagentsEnabled: false },
    );

    expect(result.finalization.receipt).toMatchObject({
      trace_call_count: 2,
      observed_completed_tool_use_ids: ['root_tool_1'],
    });
  });

  it('captures the real MCP control output and retains its successful root tool result', async () => {
    let mcp: BuildMcpServerOptions | undefined;
    const readInput = { query: '函数' };
    const nomination = {
      source: 'tool_result' as const,
      ref: { kind: 'query_knowledge', id: 'root_read_1' },
    };
    const run = vi.fn<CopilotExecutionAdapters['runAgentTaskFn']>(async (_kind, _input, ctx) => {
      await piBefore(ctx, { id: 'root_read_1', name: 'mcp__loom__query_knowledge' }, readInput);
      mcp?.onResult?.({
        tool_use_id: 'root_read_1',
        name: 'query_knowledge',
        effect: 'read',
        input: readInput,
        output: { nodes: [{ id: 'kc_1' }] },
        error_reason: null,
        executed: true,
      });

      await piBefore(
        ctx,
        { id: 'root_present_1', name: 'mcp__loom__present_primary_view' },
        nomination,
      );
      mcp?.onResult?.({
        tool_use_id: 'root_present_1',
        name: 'present_primary_view',
        effect: 'control',
        input: nomination,
        output: nomination,
        error_reason: null,
        executed: true,
      });
      return { task_run_id: 'presentation_task', text: '已核对函数知识点。' };
    });
    const execute = ownerWith(run, undefined, (options) => {
      mcp = options;
    });

    const result = await execute(
      {} as never,
      { input, sessionId: 'session_present', taskRunId: 'root_present' },
      { cancellation: fakeCancellation(), deadlineAt: 900_000, subagentsEnabled: false },
    );

    expect(result.finalization.preparedReply).toEqual({
      text: '已核对函数知识点。',
      primaryView: {
        ...nomination,
        snapshot: buildCopilotToolResultSnapshot('query_knowledge', { nodes: [{ id: 'kc_1' }] }),
      },
    });
    expect(result.finalization.receipt.primary_view).toBe('retained');
  });
});
