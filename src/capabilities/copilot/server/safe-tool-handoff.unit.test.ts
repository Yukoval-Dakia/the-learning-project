import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, vi } from 'vitest';
import type { ToolOperationRecord, ToolOperations } from '@/kernel/tools/tool-operations';
import {
  controlOwnedToolOperation,
  createToolUseCorrelation,
  executeSafeToolOperation,
} from '@/server/ai/tools/safe-tool-handoff';

function record(overrides: Partial<ToolOperationRecord> = {}): ToolOperationRecord {
  const now = new Date('2026-08-27T12:00:00.000Z');
  return {
    id: 'toolop_safe_1',
    sessionId: 'session_owner',
    taskRunId: 'task_owner',
    toolName: 'remote_reader',
    effect: 'read',
    status: 'running',
    processId: 'process_test',
    inputHash: 'a'.repeat(64),
    input: { query: 'complex nested query', filters: { subject: 'physics' } },
    result: null,
    error: null,
    sideEffectRisk: null,
    cancelledBy: null,
    terminalToolCallLogId: null,
    hardDeadlineAt: new Date('2026-08-27T12:05:00.000Z'),
    startedAt: now,
    ownerHeartbeatAt: now,
    leaseExpiresAt: new Date('2026-08-27T12:00:30.000Z'),
    settledAt: null,
    updatedAt: now,
    ...overrides,
  };
}

function operations(waited: ToolOperationRecord): ToolOperations {
  return {
    start: vi.fn(async (_input, execute) => {
      void execute({ operationId: waited.id, signal: new AbortController().signal });
      return {
        id: waited.id,
        wait: vi.fn(async () => waited),
        cancel: vi.fn(async () => waited),
      };
    }),
    get: vi.fn(async () => waited),
    wait: vi.fn(async () => waited),
    cancel: vi.fn(async () => waited),
    recoverLost: vi.fn(async () => []),
    linkTerminalToolCallLog: vi.fn(async (_id, terminalToolCallLogId) =>
      record({
        ...waited,
        terminalToolCallLogId,
      }),
    ),
  };
}

describe('safe ToolOperations handoff', () => {
  it('does not yield before the exact 45 second boundary', async () => {
    vi.useFakeTimers();
    try {
      const running = record();
      const toolOperations = operations(running);
      toolOperations.start = vi.fn(async () => ({
        id: running.id,
        wait: vi.fn(async () => running),
        cancel: vi.fn(async () => running),
      }));
      toolOperations.wait = vi.fn(
        async (_id, options) =>
          new Promise<ToolOperationRecord>((resolve) => {
            setTimeout(() => resolve(running), options.timeoutMs);
          }),
      );
      let settled = false;
      const result = executeSafeToolOperation({
        toolOperations,
        sessionId: 'session_owner',
        taskRunId: 'task_owner',
        toolName: 'remote_reader',
        input: { query: 'slow safe lookup' },
        execute: vi.fn(async () => ({ facts: [], count: 0 })),
      }).then((value) => {
        settled = true;
        return value;
      });

      await vi.advanceTimersByTimeAsync(44_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(result).resolves.toMatchObject({ kind: 'yielded' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns one persisted handle after the safe remote read remains running for 45 seconds', async () => {
    const toolOperations = operations(record());

    const result = await executeSafeToolOperation({
      toolOperations,
      sessionId: 'session_owner',
      taskRunId: 'task_owner',
      toolName: 'remote_reader',
      toolUseId: 'toolu_remote_42',
      input: { query: 'complex nested query', filters: { subject: 'physics' } },
      hardDeadlineAt: new Date('2026-08-27T12:05:00.000Z'),
      yieldAfterMs: 45_000,
      execute: vi.fn(async () => ({ facts: [{ id: 'fact_1', score: 0.82 }] })),
    });

    expect(result).toEqual({
      kind: 'yielded',
      operation: {
        id: 'toolop_safe_1',
        status: 'running',
        tool_use_id: 'toolu_remote_42',
      },
    });
    expect(toolOperations.start).toHaveBeenCalledTimes(1);
    expect(toolOperations.wait).toHaveBeenCalledWith('toolop_safe_1', { timeoutMs: 45_000 });
  });

  it('returns the observed terminal result instead of yielding a second identity', async () => {
    const settled = record({
      status: 'succeeded',
      result: { facts: [{ id: 'fact_2', memory: 'uses worked examples' }], count: 1 },
      settledAt: new Date('2026-08-27T12:00:12.000Z'),
    });
    const toolOperations = operations(settled);

    const result = await executeSafeToolOperation({
      toolOperations,
      sessionId: 'session_owner',
      taskRunId: 'task_owner',
      toolName: 'remote_reader',
      input: { query: 'worked examples' },
      yieldAfterMs: 45_000,
      execute: vi.fn(async () => ({ facts: [], count: 0 })),
    });

    expect(result).toEqual({ kind: 'settled', record: settled });
    expect(toolOperations.start).toHaveBeenCalledTimes(1);
  });

  it('preserves possible side-effect uncertainty returned by ToolOperations', async () => {
    const lost = record({
      effect: 'write',
      status: 'lost',
      sideEffectRisk: 'possible',
      error: { code: 'execution_ambiguous', message: 'remote outcome unknown' },
      settledAt: new Date('2026-08-27T12:00:30.000Z'),
    });

    await expect(
      executeSafeToolOperation({
        toolOperations: operations(lost),
        sessionId: 'session_owner',
        taskRunId: 'task_owner',
        toolName: 'remote_writer',
        input: { target: 'external' },
        yieldAfterMs: 45_000,
        execute: vi.fn(async () => ({ ok: true })),
      }),
    ).resolves.toEqual({ kind: 'settled', record: lost });
  });

  it.each(['system', 'user'] as const)(
    'routes parent %s cancellation through the owned cancel seam',
    async (requestedBy) => {
      const controller = new AbortController();
      const toolOperations = operations(record());
      const result = await executeSafeToolOperation({
        toolOperations,
        sessionId: 'session_owner',
        taskRunId: 'task_owner',
        toolName: 'remote_reader',
        input: { query: 'cancel this lookup' },
        cancellationSignals: [{ signal: controller.signal, requestedBy }],
        execute: vi.fn(async () => ({ facts: [], count: 0 })),
      });
      expect(result.kind).toBe('yielded');

      controller.abort();
      await vi.waitFor(() => {
        expect(toolOperations.cancel).toHaveBeenCalledWith('toolop_safe_1', { requestedBy });
      });
    },
  );

  it('attributes a user-triggered parent abort to user when its lifecycle signal also aborts', async () => {
    const systemController = new AbortController();
    const userController = new AbortController();
    userController.signal.addEventListener('abort', () => systemController.abort(), { once: true });
    const toolOperations = operations(record());
    await executeSafeToolOperation({
      toolOperations,
      sessionId: 'session_owner',
      taskRunId: 'task_owner',
      toolName: 'remote_reader',
      input: { query: 'cancel from user' },
      cancellationSignals: [
        { signal: systemController.signal, requestedBy: 'system' },
        { signal: userController.signal, requestedBy: 'user' },
      ],
      execute: vi.fn(async () => ({ facts: [], count: 0 })),
    });

    userController.abort();
    await vi.waitFor(() => {
      expect(toolOperations.cancel).toHaveBeenCalledTimes(1);
      expect(toolOperations.cancel).toHaveBeenCalledWith('toolop_safe_1', {
        requestedBy: 'user',
      });
    });
  });
});

describe('owned ToolOperations controls', () => {
  it('lets model, system, and user use one ownership-enforcing get/wait/cancel seam', async () => {
    const toolOperations = operations(record());

    await controlOwnedToolOperation(toolOperations, {
      action: 'get',
      operationId: 'toolop_safe_1',
      sessionId: 'session_owner',
      taskRunId: 'task_owner',
      requestedBy: 'model',
    });
    await controlOwnedToolOperation(toolOperations, {
      action: 'wait',
      operationId: 'toolop_safe_1',
      sessionId: 'session_owner',
      taskRunId: 'task_owner',
      requestedBy: 'system',
      timeoutMs: 5_000,
    });
    await controlOwnedToolOperation(toolOperations, {
      action: 'cancel',
      operationId: 'toolop_safe_1',
      sessionId: 'session_owner',
      taskRunId: 'task_owner',
      requestedBy: 'user',
    });

    expect(toolOperations.get).toHaveBeenCalledTimes(3);
    expect(toolOperations.wait).toHaveBeenCalledWith('toolop_safe_1', { timeoutMs: 5_000 });
    expect(toolOperations.cancel).toHaveBeenCalledWith('toolop_safe_1', {
      requestedBy: 'user',
    });
  });

  it('does not disclose or control another session or task owner', async () => {
    const toolOperations = operations(record());

    await expect(
      controlOwnedToolOperation(toolOperations, {
        action: 'cancel',
        operationId: 'toolop_safe_1',
        sessionId: 'session_other',
        taskRunId: 'task_other',
        requestedBy: 'model',
      }),
    ).rejects.toThrow('tool operation not found');
    expect(toolOperations.cancel).not.toHaveBeenCalled();
  });
});

describe('toolUseId correlation', () => {
  it('reuses the SDK PreToolUse identity exactly once for the matching bridge call', async () => {
    const correlation = createToolUseCorrelation('loom');
    const hook = correlation.hooks.PreToolUse?.[0]?.hooks[0] as HookCallback;
    await hook(
      {
        hook_event_name: 'PreToolUse',
        session_id: 'sdk_session',
        transcript_path: '/tmp/transcript',
        cwd: '/tmp',
        permission_mode: 'default',
        tool_name: 'mcp__loom__remote_reader',
        tool_input: { query: 'same call', nested: { page: 2 } },
        tool_use_id: 'toolu_correlated_7',
      },
      'toolu_correlated_7',
      { signal: new AbortController().signal },
    );

    expect(correlation.claim('remote_reader', { nested: { page: 2 }, query: 'same call' })).toBe(
      'toolu_correlated_7',
    );
    expect(
      correlation.claim('remote_reader', { nested: { page: 2 }, query: 'same call' }),
    ).toBeUndefined();
  });

  it('does not correlate run_task into safe ToolOperations handoff', async () => {
    const correlation = createToolUseCorrelation('loom');
    const hook = correlation.hooks.PreToolUse?.[0]?.hooks[0] as HookCallback;
    await hook(
      {
        hook_event_name: 'PreToolUse',
        session_id: 'sdk_session',
        transcript_path: '/tmp/transcript',
        cwd: '/tmp',
        permission_mode: 'default',
        tool_name: 'mcp__loom__run_task',
        tool_input: { task_kind: 'QuizGenTask', intent: { subject_id: 'math' } },
        tool_use_id: 'toolu_run_task_excluded',
      },
      'toolu_run_task_excluded',
      { signal: new AbortController().signal },
    );

    expect(correlation.claim('run_task', { task_kind: 'QuizGenTask' })).toBeUndefined();
  });
});
