import { STUCK_RUN_THRESHOLD_MS } from '@/core/ai-run-limits';
import { getTaskOverride } from '@/core/config/store';
import type { TaskCatalog, TaskKindOf } from './registry';
import type { TaskBudget, TaskDefinition } from './task-spec';

/** Caller-owned durable limits take precedence over the hot task configuration. */
export interface TaskBudgetOverride {
  /**
   * `'unbounded'` (durable copilot only) removes the agentic-turn ceiling: the
   * pi lane then mounts no `shouldStopAfterTurn`, so only Stop/cancellation/
   * timeoutMs end the loop. Configured/default budgets stay finite numbers.
   */
  readonly maxIterations?: number | 'unbounded';
  readonly timeoutMs?: number;
}

/** Bind shared budget readers to an immutable, caller-owned catalog. */
export function createTaskBudgetReaders<const Catalog extends TaskCatalog>(tasks: Catalog) {
  /** Read once before asynchronous work; never retain the mutable store value. */
  function resolveTaskBudget(kind: TaskKindOf<Catalog>, explicit?: TaskBudgetOverride): TaskBudget {
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
  function taskBudgetWiring(kind: TaskKindOf<Catalog>): Record<keyof TaskBudget, boolean> {
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
  function taskBudgetFacts(kind: TaskKindOf<Catalog>) {
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

  return Object.freeze({ resolveTaskBudget, taskBudgetWiring, taskBudgetFacts });
}
