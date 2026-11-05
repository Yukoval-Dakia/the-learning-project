import { AsyncLocalStorage } from 'node:async_hooks';

/** One admitted allowance shared by a task and all its paid descendants. */
export interface TaskSpendScope {
  remainingUsd(): number;
  charge(amountUsd: number | null): void;
  beforeQuery(taskRunId: string): Promise<void>;
}
const scopes = new AsyncLocalStorage<TaskSpendScope>();
export const currentTaskSpendScope = () => scopes.getStore();
export function withTaskSpendScope<T>(
  allowanceUsd: number,
  register: (taskRunId: string) => Promise<void>,
  execute: () => Promise<T>,
): Promise<T> {
  let spent = 0;
  let unknown = false;
  const scope: TaskSpendScope = {
    remainingUsd: () => (unknown ? 0 : Math.max(0, allowanceUsd - spent)),
    charge(amount) {
      if (amount === null) unknown = true;
      else spent += amount;
    },
    async beforeQuery(id) {
      if (scope.remainingUsd() <= 0) throw new Error('shared task allowance exhausted or unpriced');
      // Persist even failed descendants before the first paid request.
      await register(id);
    },
  };
  return scopes.run(scope, execute);
}

const taskFrames = new AsyncLocalStorage<{ children: Promise<void> }>();

/** Siblings share one allowance; serialize them so each sees the previous child's settled spend.
 * Descendants get their own frame, allowing a waiting parent to call a child without deadlock. */
export async function withinTaskSpendFrame<T>(execute: () => Promise<T>): Promise<T> {
  if (!currentTaskSpendScope()) return execute();
  const parent = taskFrames.getStore();
  if (!parent) return taskFrames.run({ children: Promise.resolve() }, execute);
  const previous = parent.children;
  let release: () => void = () => {};
  parent.children = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await taskFrames.run({ children: Promise.resolve() }, execute);
  } finally {
    release();
  }
}
