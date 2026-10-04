import { describe, expect, expectTypeOf, it } from 'vitest';
import { createTaskRegistry } from './registry';
import { createTaskBudgetReaders } from './task-budget';
import { createTaskPromptReaders } from './task-prompts';
import type { TaskDefinition } from './task-spec';

function catalog(text: string, timeout: number) {
  const definition = {
    kind: 'ProbeTask',
    description: 'Injected catalog contract probe',
    defaultProvider: 'xiaomi',
    defaultModel: 'fixture-model',
    budget: { maxIterations: 4, maxCost: 0.25, transientRetries: 1, timeout },
    needsToolCall: true,
    isMultimodal: false,
    allowedTools: ['fixture_read'],
    prompt: { kind: 'inline', text },
  } satisfies TaskDefinition;
  return Object.freeze({
    ProbeTask: definition,
    TypedProbe: {
      ...definition,
      kind: 'TypedProbe',
      execution: 'typed',
      prompt: { kind: 'none' },
    } satisfies TaskDefinition,
  });
}

describe('injected task registry', () => {
  it('preserves frozen identity and exact keys without installing a global catalog', () => {
    const input = catalog('First catalog', 1000);
    const first = createTaskRegistry(input);
    const second = createTaskRegistry(catalog('Second catalog', 2000));
    expectTypeOf<keyof typeof first>().toEqualTypeOf<'ProbeTask' | 'TypedProbe'>();
    expect(first).toBe(input);
    expect(Object.isFrozen(first)).toBe(true);
    expect(second).not.toBe(first);
    expect(() => Object.assign(first, { OtherTask: second.ProbeTask })).toThrow();
  });

  it('binds prompt, membership and budget readers independently for the same task kinds', () => {
    const first = createTaskRegistry(catalog('First catalog', 1000));
    const firstPrompts = createTaskPromptReaders(first);
    const firstBudgets = createTaskBudgetReaders(first);
    const second = createTaskRegistry(catalog('Second catalog', 2000));
    const secondPrompts = createTaskPromptReaders(second);
    const secondBudgets = createTaskBudgetReaders(second);

    expect(firstPrompts.getTaskSystemPrompt('ProbeTask')).toContain('First catalog');
    expect(secondPrompts.getTaskSystemPrompt('ProbeTask')).toContain('Second catalog');
    expect(firstBudgets.resolveTaskBudget('ProbeTask').timeout).toBe(1000);
    expect(secondBudgets.resolveTaskBudget('ProbeTask').timeout).toBe(2000);
    expect(firstPrompts.isAiTaskKind('ProbeTask')).toBe(true);
    for (const unknown of ['CopilotTask', 'toString', '__proto__', '']) {
      expect(firstPrompts.isAiTaskKind(unknown)).toBe(false);
    }
    expect(() => firstPrompts.getTaskSystemPrompt('TypedProbe')).toThrow(
      'typed task with no system prompt',
    );
    expect(firstBudgets.taskBudgetFacts('TypedProbe').effective).toEqual({
      maxIterations: null,
      maxCost: 0.25,
      transientRetries: 1,
      timeout: 1000,
    });
    expect(firstBudgets.taskBudgetWiring('ProbeTask')).toEqual({
      maxIterations: true,
      maxCost: false,
      transientRetries: true,
      timeout: true,
    });
  });
});
