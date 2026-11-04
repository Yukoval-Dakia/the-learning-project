// YUK-1770 — kernel port for the steering reaction's practice recomposition.
//
// Agency's steering subscription must not import practice (cross-capability
// value edges are decrease-only, same rule that keeps Coach on the kernel
// daily-review-plan reader). Practice installs the real recompose at
// composition time; until then this is a silent no-op, mirroring the
// installed-reader pattern in kernel/read-models/daily-review-plan.ts.

import type { Db } from '@/db/client';

export type RecomposeTodayPracticeFn = (db: Db) => Promise<unknown>;

let recomposeTodayPracticeFn: RecomposeTodayPracticeFn | undefined;

export function installTodayPracticeRecompose(fn: RecomposeTodayPracticeFn): void {
  recomposeTodayPracticeFn = fn;
}

/**
 * Recompose today's practice stream; false when no implementation is installed
 * (e.g. a unit-context host that never composed practice).
 */
export async function recomposeTodayPractice(db: Db): Promise<boolean> {
  if (!recomposeTodayPracticeFn) return false;
  await recomposeTodayPracticeFn(db);
  return true;
}
