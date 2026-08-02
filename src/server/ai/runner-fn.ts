import type { Db } from '@/db/client';
import type { TaskTextResult } from '@/server/ai/provenance';
import type { RunTaskCtx, RunTaskResult } from '@/server/ai/runner';

export type RunTaskCallCtx = Omit<RunTaskCtx, 'db' | 'enableTransientRetry'>;

export type BoundRunTaskFn = {
  bivarianceHack(kind: string, input: unknown, ctx?: RunTaskCallCtx): Promise<RunTaskResult>;
}['bivarianceHack'];

export type BoundRunTaskTextFn = {
  bivarianceHack(kind: string, input: unknown, ctx?: RunTaskCallCtx): Promise<TaskTextResult>;
}['bivarianceHack'];

export function makeRunTaskFn(db: Db, baseCtx: RunTaskCallCtx = {}): BoundRunTaskFn {
  return async (kind, input, callCtx = {}) => {
    const { runTask } = await import('@/server/ai/runner');
    const { db: _baseDb, enableTransientRetry: _baseRetry, ...safeBaseCtx } = baseCtx as RunTaskCtx;
    const { db: _callDb, enableTransientRetry: _callRetry, ...safeCallCtx } = callCtx as RunTaskCtx;
    const providerSessionDeadlineAt =
      safeBaseCtx.providerSessionDeadlineAt === undefined
        ? safeCallCtx.providerSessionDeadlineAt
        : safeCallCtx.providerSessionDeadlineAt === undefined
          ? safeBaseCtx.providerSessionDeadlineAt
          : Math.min(safeBaseCtx.providerSessionDeadlineAt, safeCallCtx.providerSessionDeadlineAt);
    return runTask(kind, input, {
      ...safeBaseCtx,
      ...safeCallCtx,
      ...(providerSessionDeadlineAt !== undefined ? { providerSessionDeadlineAt } : {}),
      db,
    });
  };
}

export function makeRunTaskTextFn(db: Db, baseCtx: RunTaskCallCtx = {}): BoundRunTaskTextFn {
  const runTask = makeRunTaskFn(db, baseCtx);
  return async (kind, input, callCtx) => {
    const result = await runTask(kind, input, callCtx);
    return {
      text: result.text,
      task_run_id: result.task_run_id,
      cost_usd: result.cost_usd,
      cost_basis: result.cost_basis,
      cost_ref: result.cost_ref,
      structured_output: result.structured_output,
    };
  };
}
