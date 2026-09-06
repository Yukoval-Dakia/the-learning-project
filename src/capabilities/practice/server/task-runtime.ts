import type { Db } from '@/db/client';
import {
  type BoundRunTaskTextFn,
  type RunTaskCallCtx,
  makeRunTaskFn,
  makeRunTaskTextFn,
} from '@/server/ai/runner-fn';

export { type BoundRunTaskFn, type RunTaskCallCtx, makeRunTaskFn } from '@/server/ai/runner-fn';

/** Capability-local AI runtime port. Product code does not depend on runner internals. */
export type PracticeTaskRunFn = BoundRunTaskTextFn;
export type PracticeTaskCallCtx = RunTaskCallCtx;

export function makePracticeTaskRunFn(
  db: Db,
  baseCtx: PracticeTaskCallCtx = {},
): PracticeTaskRunFn {
  return makeRunTaskFn(db, baseCtx);
}

export function makePracticeTaskTextRunFn(
  db: Db,
  baseCtx: PracticeTaskCallCtx = {},
): PracticeTaskRunFn {
  return makeRunTaskTextFn(db, baseCtx);
}

export function practiceCostUsdToMicroUsd(costUsd: number | undefined): number | null {
  return costUsd === undefined ? null : Math.round(costUsd * 1_000_000);
}
