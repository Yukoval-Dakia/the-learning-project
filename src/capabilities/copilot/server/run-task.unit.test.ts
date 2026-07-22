import { beforeEach, describe, expect, it, vi } from 'vitest';

const runTask = vi.fn();
vi.mock('@/server/ai/runner', () => ({ runTask }));

import { tasks } from '@/ai/registry';
import { runTaskTool } from '@/server/ai/tools/run-task';

const db = {} as never;
const ctx = {
  db,
  taskRunId: 'tool-run',
  callerActor: { kind: 'agent' as const, ref: 'agent:copilot' },
};

describe('run_task', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects malformed outer input', () => {
    expect(() => runTaskTool.inputSchema.parse({ task_kind: 'GoalScopeTask' })).toThrow();
  });

  it('rejects unknown and known non-invocable tasks', async () => {
    await expect(
      runTaskTool.execute(ctx, { task_kind: 'MissingTask', intent: {} }),
    ).rejects.toThrow('unknown task kind');
    await expect(
      runTaskTool.execute(ctx, { task_kind: 'CopilotTask', intent: {} }),
    ).rejects.toThrow('not invocable');
    expect(runTask).not.toHaveBeenCalled();
  });

  it('validates intent before loading prepare', async () => {
    const load = vi.spyOn(tasks.QuestionAuthorTask.copilot, 'prepare');
    await expect(
      runTaskTool.execute(ctx, {
        task_kind: 'QuestionAuthorTask',
        intent: { seed_mode: 'knowledge', knowledge_ids: [], db: 'inject' },
      }),
    ).rejects.toThrow();
    expect(load).not.toHaveBeenCalled();
    expect(runTask).not.toHaveBeenCalled();
  });

  it('rejects model-controlled execution controls before prepare', async () => {
    for (const injected of [
      { db: {} },
      { enableTransientRetry: true },
      { provider: 'anthropic' },
      { tools: ['write_file'] },
      { task_run_id: 'injected' },
    ]) {
      await expect(
        runTaskTool.execute(ctx, {
          task_kind: 'GoalScopeTask',
          intent: { goal_title: 'Learn', ...injected },
        }),
      ).rejects.toThrow();
    }
    expect(runTask).not.toHaveBeenCalled();
  });

  it('runs schema, trusted prepare, and bound audited runner in order', async () => {
    const events: string[] = [];
    const original = tasks.GoalScopeTask.copilot;
    const originalIntentSchema = original.intentSchema;
    const originalPrepare = original.prepare;
    const intentSchema = originalIntentSchema.transform((value) => {
      events.push('schema');
      return value;
    });
    const prepare = vi.fn(async (_ctx, intent) => {
      events.push('prepare');
      expect(_ctx.db).toBe(db);
      return { input: { prepared: intent }, ctx: { subjectProfile: undefined } };
    });
    Object.assign(original, { intentSchema, prepare: async () => prepare });
    runTask.mockImplementation(async (kind, input, callCtx) => {
      events.push('runner');
      expect(kind).toBe('GoalScopeTask');
      expect(input).toEqual({ prepared: { goal_title: 'Learn' } });
      expect(callCtx).toEqual({ subjectProfile: undefined, db });
      return { text: 'generated', task_run_id: 'run-1', cost_usd: 0.12, finishReason: 'end_turn' };
    });

    try {
      await expect(
        runTaskTool.execute(ctx, { task_kind: 'GoalScopeTask', intent: { goal_title: 'Learn' } }),
      ).resolves.toEqual({
        task_kind: 'GoalScopeTask',
        text: 'generated',
        task_run_id: 'run-1',
        cost_usd: 0.12,
        finish_reason: 'end_turn',
      });
      expect(events).toEqual(['schema', 'prepare', 'runner']);
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(runTask).toHaveBeenCalledTimes(1);
    } finally {
      Object.assign(original, { intentSchema: originalIntentSchema, prepare: originalPrepare });
    }
  });

  it('propagates prepare and runner failures without retrying', async () => {
    const copilot = tasks.GoalScopeTask.copilot;
    const originalPrepare = copilot.prepare;
    copilot.prepare = async () => async () => {
      throw new Error('prepare failed');
    };
    await expect(
      runTaskTool.execute(ctx, { task_kind: 'GoalScopeTask', intent: { goal_title: 'Learn' } }),
    ).rejects.toThrow('prepare failed');
    expect(runTask).not.toHaveBeenCalled();

    copilot.prepare = async () => async () => ({ input: {} });
    runTask.mockRejectedValueOnce(new Error('runner failed'));
    await expect(
      runTaskTool.execute(ctx, { task_kind: 'GoalScopeTask', intent: { goal_title: 'Learn' } }),
    ).rejects.toThrow('runner failed');
    expect(runTask).toHaveBeenCalledTimes(1);
    copilot.prepare = originalPrepare;
  });
});
