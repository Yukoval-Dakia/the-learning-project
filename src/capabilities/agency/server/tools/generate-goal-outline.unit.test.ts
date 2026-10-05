import { describe, expect, it, vi } from 'vitest';

import { GoalScopeIntentSchema } from '@/kernel/task-intents';
import type { RunTaskCallCtx } from '@/server/ai/runner-fn';
import type { prepareGoalScopeTask } from '../goals/scope';
import {
  createGenerateGoalOutlineExecutor,
  generateGoalOutlineTool,
} from './generate-goal-outline';

const writes = {
  insert: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  transaction: vi.fn(),
};
const db = writes as never;
const abortController = new AbortController();
const ctx = {
  db,
  taskRunId: 'parent_goal_run',
  callerActor: { kind: 'agent' as const, ref: 'agent:copilot' },
  signal: abortController.signal,
  providerSessionDeadlineAt: 567_890,
};

describe('generate_goal_outline', () => {
  it('rejects invalid intent before owner preparation or any write', async () => {
    const prepare = vi.fn();
    const execute = createGenerateGoalOutlineExecutor({
      prepare: prepare as unknown as typeof prepareGoalScopeTask,
      bindRunner: vi.fn(),
    });

    await expect(execute(ctx, { goal_title: '', db: 'injected' })).rejects.toThrow('goal_title');
    expect(prepare).not.toHaveBeenCalled();
    expect(writes.insert).not.toHaveBeenCalled();
    expect(writes.update).not.toHaveBeenCalled();
    expect(writes.delete).not.toHaveBeenCalled();
    expect(writes.transaction).not.toHaveBeenCalled();
  });

  it('forwards cancellation, parent audit identity, deadline, and cost metadata without writing', async () => {
    const prepare = vi.fn(async () => ({
      input: { goal_title: 'Master vector calculus', grid: { nodes: [], edges: [] } },
      ctx: { subjectProfile: undefined },
    }));
    const run = vi.fn(async (_kind: string, _input: unknown, _ctx?: RunTaskCallCtx) => ({
      text: '{"scope_knowledge_ids":[],"sequence_hint":0,"reasoning":"No nodes"}',
      task_run_id: 'goal_generation_run',
      cost_usd: 0.12,
      cost_basis: 'reported' as const,
      cost_ref: 'sdk:total_cost_usd',
      finishReason: 'end_turn',
      usage: { inputTokens: 21, outputTokens: 13 },
    }));
    const bindRunner = vi.fn(() => run);
    const execute = createGenerateGoalOutlineExecutor({
      prepare: prepare as unknown as typeof prepareGoalScopeTask,
      bindRunner,
    });

    await expect(execute(ctx, { goal_title: 'Master vector calculus' })).resolves.toEqual({
      text: '{"scope_knowledge_ids":[],"sequence_hint":0,"reasoning":"No nodes"}',
      task_run_id: 'goal_generation_run',
      cost_usd: 0.12,
      cost_basis: 'reported',
      cost_ref: 'sdk:total_cost_usd',
      finish_reason: 'end_turn',
    });
    expect(prepare).toHaveBeenCalledWith(ctx, { goal_title: 'Master vector calculus' });
    expect(bindRunner).toHaveBeenCalledWith(
      {
        signal: abortController.signal,
        parentTaskRunId: 'parent_goal_run',
        providerSessionDeadlineAt: 567_890,
      },
      db,
    );
    expect(run).toHaveBeenCalledWith(
      'GoalScopeTask',
      { goal_title: 'Master vector calculus', grid: { nodes: [], edges: [] } },
      { subjectProfile: undefined },
    );
    expect(writes.insert).not.toHaveBeenCalled();
    expect(writes.update).not.toHaveBeenCalled();
    expect(writes.delete).not.toHaveBeenCalled();
    expect(writes.transaction).not.toHaveBeenCalled();
  });

  it('publishes only the goal intent schema and a read-only generation contract', () => {
    expect(generateGoalOutlineTool.effect).toBe('read');
    expect(
      generateGoalOutlineTool.inputSchema.parse({ goal_title: 'Learn proof writing' }),
    ).toEqual({
      goal_title: 'Learn proof writing',
    });
    expect(() =>
      generateGoalOutlineTool.inputSchema.parse({ task_kind: 'GoalScopeTask' }),
    ).toThrow();
    expect(GoalScopeIntentSchema.safeParse({ goal_title: 'x', write: true }).success).toBe(false);
  });
});
