import { STUCK_RUN_THRESHOLD_MS } from '@/core/ai-run-limits';
import { getTaskOverride } from '@/core/config/store';
import { type TaskKind, tasks } from './registry';
import type { TaskBudget, TaskDefinition } from './task-spec';

/** Caller-owned durable limits take precedence over the hot task configuration. */
export interface TaskBudgetOverride {
  readonly maxIterations?: number;
  readonly timeoutMs?: number;
}

/** Read once before asynchronous work; never retain the mutable store value. */
export function resolveTaskBudget(kind: TaskKind, explicit?: TaskBudgetOverride): TaskBudget {
  const defaults = tasks[kind].budget;
  const configured = getTaskOverride(kind)?.budget;
  const timeout = explicit?.timeoutMs ?? configured?.timeout ?? defaults.timeout;
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout >= STUCK_RUN_THRESHOLD_MS) {
    throw new RangeError(`Task timeout must be positive and below ${STUCK_RUN_THRESHOLD_MS}ms`);
  }
  return Object.freeze({
    maxIterations: explicit?.maxIterations ?? configured?.maxIterations ?? defaults.maxIterations,
    maxCost: configured?.maxCost ?? defaults.maxCost,
    transientRetries: configured?.transientRetries ?? defaults.transientRetries,
    timeout,
  });
}

/** Supported consumers, not a claim that every invocation opts into retries. */
export function taskBudgetWiring(kind: TaskKind): Record<keyof TaskBudget, boolean> {
  const def: TaskDefinition = tasks[kind];
  const typed = def.execution === 'typed';
  return {
    maxIterations: !typed,
    maxCost: typed,
    transientRetries: true,
    timeout: true,
  };
}

/** Baseline for the next invocation, before caller overrides/retry policy gates. */
export function taskBudgetFacts(kind: TaskKind) {
  const budget = resolveTaskBudget(kind);
  const wired = taskBudgetWiring(kind);
  return {
    wired,
    effective: {
      maxIterations: wired.maxIterations ? budget.maxIterations : null,
      maxCost: wired.maxCost ? budget.maxCost : null,
      transientRetries: budget.transientRetries,
      timeout: budget.timeout,
    },
  };
}
