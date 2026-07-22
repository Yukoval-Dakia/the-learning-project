import type { Db } from '@/db/client';
import type { RunTaskCtx, RunTaskResult } from '@/server/ai/runner';

export type BoundRunTaskCtx = Omit<RunTaskCtx, 'db' | 'enableTransientRetry'>;

export type BoundRunTaskFn = {
  bivarianceHack(kind: string, input: unknown, ctx?: BoundRunTaskCtx): Promise<RunTaskResult>;
}['bivarianceHack'];

export type BoundRunTaskTextFn = {
  bivarianceHack(kind: string, input: unknown, ctx?: BoundRunTaskCtx): Promise<{ text: string }>;
}['bivarianceHack'];

export function makeRunTaskFn(db: Db, baseCtx: BoundRunTaskCtx = {}): BoundRunTaskFn {
  return async (kind, input, callCtx = {}) => {
    const { runTask } = await import('@/server/ai/runner');
    const { db: _baseDb, enableTransientRetry: _baseRetry, ...safeBaseCtx } = baseCtx as RunTaskCtx;
    const { db: _callDb, enableTransientRetry: _callRetry, ...safeCallCtx } = callCtx as RunTaskCtx;
    return runTask(kind, input, { ...safeBaseCtx, ...safeCallCtx, db });
  };
}

export function makeRunTaskTextFn(db: Db, baseCtx: BoundRunTaskCtx = {}): BoundRunTaskTextFn {
  const runTask = makeRunTaskFn(db, baseCtx);
  return async (kind, input, callCtx) => {
    const result = await runTask(kind, input, callCtx);
    return { text: result.text };
  };
}
