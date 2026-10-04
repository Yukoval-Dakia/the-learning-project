import { describe, expect, it } from 'vitest';
import {
  budgetChanges,
  configSection,
  initialBudget,
  modelChanges,
  providerStatus,
  providerUnavailable,
  resetTaskChanges,
  taskEditable,
} from './config-model';
import { configFixture } from './config-test-fixture';

describe('configuration projections', () => {
  it('uses only declared sections and distinguishes typed tasks and missing credentials', () => {
    const data = configFixture();
    expect(configSection('ai-models')).toBe('ai-models');
    expect(configSection('garbage')).toBe('overview');
    expect(taskEditable(data.tasks[1])).toBe(false);
    expect(providerUnavailable(data.providers[2])).toContain('凭据');
  });
  it('reports typed-only wiring independently from native chat selection', () => {
    const provider = configFixture().providers[3];
    expect(providerStatus(provider)).toBe('typed 已接线 · 凭据已配置');
    expect(providerUnavailable(provider)).toBe('未开放原生 chat 通道');
    expect(providerStatus({ ...provider, key_present: false })).toContain('尚未配置凭据');
    expect(providerStatus({ ...provider, implemented_for: { chat: false, typed: false } })).toBe(
      '未开放原生 chat 通道',
    );
  });
  it('saves and clears the complete provider/model pair', () => {
    const task = configFixture().tasks[0];
    expect(modelChanges(task, 'opencode-go', 'glm-5.3-flash')).toEqual([
      { action: 'set', key: 'task.QuizGenTask.provider', value: 'opencode-go' },
      { action: 'set', key: 'task.QuizGenTask.model', value: 'glm-5.3-flash' },
    ]);
    expect(resetTaskChanges(task, 'model')).toEqual([
      { action: 'clear', key: 'task.QuizGenTask.provider' },
      { action: 'clear', key: 'task.QuizGenTask.model' },
    ]);
  });
  it('converts seconds to milliseconds and preserves existing unwired budget values', () => {
    const task = configFixture().tasks[0];
    task.override = { budget: { maxCost: 0.75 } };
    const draft = initialBudget(task);
    expect(draft.timeout).toBe('60');
    expect(budgetChanges(task, { ...draft, timeout: '90.5', maxCost: '999' })).toEqual([
      {
        action: 'set',
        key: 'task.QuizGenTask.budget',
        value: { timeout: 90500, maxIterations: 6, transientRetries: 0, maxCost: 0.75 },
      },
    ]);
    expect(() => budgetChanges(task, { ...draft, timeout: '3600' })).toThrow();
    expect(() => budgetChanges(task, { ...draft, transientRetries: '' })).toThrow();
  });
});
