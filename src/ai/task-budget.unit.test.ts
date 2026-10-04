import { afterEach, describe, expect, it } from 'vitest';
import { STUCK_RUN_THRESHOLD_MS } from '@/core/ai-run-limits';
import { resetTestConfig, setTestConfig } from '@/core/config/store';
import { type TaskKind, tasks } from './registry';
import { resolveTaskBudget } from './task-budget';

afterEach(resetTestConfig);

describe('attempt lifetime invariant', () => {
  it('every registered default finishes before stuck-run reconciliation', () => {
    for (const kind of Object.keys(tasks) as TaskKind[]) {
      const timeout = resolveTaskBudget(kind).timeout;
      expect(timeout, kind).toBeGreaterThan(0);
      expect(timeout, kind).toBeLessThan(STUCK_RUN_THRESHOLD_MS);
    }
  });
  it.each([0, -1, Number.POSITIVE_INFINITY, Number.NaN, STUCK_RUN_THRESHOLD_MS, 7_200_000])(
    'caller timeout %s cannot bypass the same lifetime boundary',
    (timeoutMs) => {
      expect(() => resolveTaskBudget('CopilotTask', { timeoutMs })).toThrow(RangeError);
    },
  );
  it('honors a safe caller timeout above configuration and preserves the frozen snapshot', () => {
    setTestConfig({ 'task.CopilotTask.budget': { timeout: 2000, maxIterations: 7 } });
    const budget = resolveTaskBudget('CopilotTask', { timeoutMs: 720_000 });
    setTestConfig({ 'task.CopilotTask.budget': { timeout: 3000, maxIterations: 9 } });
    expect(budget).toMatchObject({ timeout: 720_000, maxIterations: 7 });
    expect(Object.isFrozen(budget)).toBe(true);
    expect(resolveTaskBudget('CopilotTask').timeout).toBe(3000);
  });
});
