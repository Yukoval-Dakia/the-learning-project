import { QuestionAuthorIntentSchema } from '@/ai/task-intents';
import { GoalScopeIntentSchema } from '@/kernel/task-intents';
import type { RunTaskCallCtx } from '@/server/ai/runner-fn';
import { createRunTaskExecutor, runTaskTool } from '@/server/ai/tools/run-task';
import { describe, expect, it, vi } from 'vitest';

const db = {} as never;
const ctx = {
  db,
  taskRunId: 'tool-run',
  callerActor: { kind: 'agent' as const, ref: 'agent:copilot' },
};

const executeRaw = (input: unknown) => runTaskTool.execute(ctx, input as never);

describe('run_task', () => {
  it('rejects malformed outer input', () => {
    expect(() => runTaskTool.inputSchema.parse({ task_kind: 'GoalScopeTask' })).toThrow();
  });

  it('rejects task/intent mismatches through the registry-selected strict schema', async () => {
    await expect(
      executeRaw({
        task_kind: 'GoalScopeTask',
        intent: { seed_mode: 'knowledge', knowledge_ids: ['k1'] },
      }),
    ).rejects.toThrow();
    await expect(
      executeRaw({ task_kind: 'QuestionAuthorTask', intent: { goal_title: 'Learn' } }),
    ).rejects.toThrow();
  });

  it('publishes exactly the two legal task names and their intent fields', () => {
    expect(
      runTaskTool.inputSchema.parse({
        task_kind: 'GoalScopeTask',
        intent: { goal_title: 'Learn', subject_id: 'math' },
      }),
    ).toEqual({
      task_kind: 'GoalScopeTask',
      intent: { goal_title: 'Learn', subject_id: 'math' },
    });
    expect(
      runTaskTool.inputSchema.parse({
        task_kind: 'QuestionAuthorTask',
        intent: { seed_mode: 'knowledge', knowledge_ids: ['k1'], difficulty: 3 },
      }),
    ).toEqual({
      task_kind: 'QuestionAuthorTask',
      intent: { seed_mode: 'knowledge', knowledge_ids: ['k1'], difficulty: 3 },
    });
    expect(() => runTaskTool.inputSchema.parse({ task_kind: 'CopilotTask', intent: {} })).toThrow();
  });

  it('rejects unknown and known non-invocable tasks', async () => {
    await expect(executeRaw({ task_kind: 'MissingTask', intent: {} })).rejects.toThrow(
      'unknown task kind',
    );
    await expect(executeRaw({ task_kind: 'CopilotTask', intent: {} })).rejects.toThrow(
      'not invocable',
    );
  });

  it('validates intent before loading prepare', async () => {
    await expect(
      executeRaw({
        task_kind: 'QuestionAuthorTask',
        intent: { seed_mode: 'knowledge', knowledge_ids: [], db: 'inject' },
      }),
    ).rejects.toThrow();
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
        executeRaw({
          task_kind: 'GoalScopeTask',
          intent: { goal_title: 'Learn', ...injected },
        }),
      ).rejects.toThrow();
    }
  });

  it('runs schema, prepare loader, prepare, and runner in order with forwarded context', async () => {
    const events: string[] = [];
    const prepare = vi.fn(async (toolContext, intent) => {
      events.push('prepare');
      expect(toolContext).toEqual({ ...ctx, providerSessionDeadlineAt: 567_890 });
      expect(intent).toEqual({ goal_title: 'Learn' });
      return { input: { prepared: intent }, ctx: { subjectProfile: undefined } };
    });
    const run = vi.fn(async (kind: string, input: unknown, callContext?: RunTaskCallCtx) => {
      events.push('runner');
      expect(kind).toBe('GoalScopeTask');
      expect(input).toEqual({ prepared: { goal_title: 'Learn' } });
      expect(callContext).toEqual({ subjectProfile: undefined });
      return {
        text: 'generated',
        task_run_id: 'run-1',
        cost_usd: 0.12,
        cost_basis: 'reported' as const,
        cost_ref: 'sdk:total_cost_usd',
        finishReason: 'end_turn',
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    });
    const execute = createRunTaskExecutor({
      declarations: {
        GoalScopeTask: {
          intentSchema: GoalScopeIntentSchema.transform((value) => {
            events.push('schema');
            return value;
          }),
          async loadPrepare() {
            events.push('loader');
            return prepare;
          },
        },
        QuestionAuthorTask: {
          intentSchema: QuestionAuthorIntentSchema,
          loadPrepare: async () => prepare,
        },
      },
      bindRunner(baseContext) {
        expect(baseContext).toEqual({
          signal: undefined,
          parentTaskRunId: 'tool-run',
          providerSessionDeadlineAt: 567_890,
        });
        return run;
      },
    });

    await expect(
      execute(
        { ...ctx, providerSessionDeadlineAt: 567_890 },
        { task_kind: 'GoalScopeTask', intent: { goal_title: 'Learn' } },
      ),
    ).resolves.toEqual({
      task_kind: 'GoalScopeTask',
      text: 'generated',
      task_run_id: 'run-1',
      cost_usd: 0.12,
      cost_basis: 'reported',
      cost_ref: 'sdk:total_cost_usd',
      finish_reason: 'end_turn',
    });
    expect(events).toEqual(['schema', 'loader', 'prepare', 'runner']);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid intent before loading prepare', async () => {
    const loadPrepare = vi.fn();
    const execute = createRunTaskExecutor({
      declarations: {
        GoalScopeTask: { intentSchema: GoalScopeIntentSchema, loadPrepare },
        QuestionAuthorTask: {
          intentSchema: QuestionAuthorIntentSchema,
          loadPrepare: vi.fn(),
        },
      },
      bindRunner: vi.fn(),
    });

    await expect(
      execute(ctx, { task_kind: 'GoalScopeTask', intent: { goal_title: '' } }),
    ).rejects.toThrow('goal_title');
    expect(loadPrepare).not.toHaveBeenCalled();
  });

  it('propagates prepare failure without running or retrying', async () => {
    const prepare = vi.fn(async () => {
      throw new Error('prepare failed');
    });
    const run = vi.fn();
    const execute = createRunTaskExecutor({
      declarations: {
        GoalScopeTask: { intentSchema: GoalScopeIntentSchema, loadPrepare: async () => prepare },
        QuestionAuthorTask: {
          intentSchema: QuestionAuthorIntentSchema,
          loadPrepare: async () => prepare,
        },
      },
      bindRunner: () => run,
    });

    await expect(
      execute(ctx, { task_kind: 'GoalScopeTask', intent: { goal_title: 'Learn' } }),
    ).rejects.toThrow('prepare failed');
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();
  });

  it('propagates runner failure without retrying', async () => {
    const prepare = vi.fn(async () => ({ input: { prepared: true } }));
    const run = vi.fn(async () => {
      throw new Error('runner failed');
    });
    const execute = createRunTaskExecutor({
      declarations: {
        GoalScopeTask: { intentSchema: GoalScopeIntentSchema, loadPrepare: async () => prepare },
        QuestionAuthorTask: {
          intentSchema: QuestionAuthorIntentSchema,
          loadPrepare: async () => prepare,
        },
      },
      bindRunner: () => run,
    });

    await expect(
      execute(ctx, { task_kind: 'GoalScopeTask', intent: { goal_title: 'Learn' } }),
    ).rejects.toThrow('runner failed');
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
