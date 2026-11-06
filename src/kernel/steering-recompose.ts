// YUK-1770 — kernel ports for the steering reactions into practice.
//
// Agency's steering surfaces (subscription, record_steering tool) must not
// import practice (cross-capability value edges are decrease-only). Practice
// installs the real operations at composition time; until then these are
// inert (recompose: silent no-op; due count: null), mirroring the
// installed-reader pattern in kernel/read-models/daily-review-plan.ts.

import type { Db } from '@/db/client';
import { installHostOperation, installedHostOperation } from '@/kernel/host-operation';

export type RecomposeTodayPracticeFn = (db: Db) => Promise<unknown>;
export type SteeringDeferredDueCountFn = (db: Db, now: Date) => Promise<number>;

const RECOMPOSE_SLOT = 'kernel/steering-recompose:recomposeTodayPractice';
const DEFERRED_DUE_COUNT_SLOT = 'kernel/steering-recompose:steeringDeferredDueCount';

export function installTodayPracticeRecompose(fn: RecomposeTodayPracticeFn): void {
  installHostOperation(RECOMPOSE_SLOT, fn);
}

/** Installs practice's 「顺延 N 项」 counter (same due query, deferral suppressed). */
export function installSteeringDeferredDueCount(fn: SteeringDeferredDueCountFn): void {
  installHostOperation(DEFERRED_DUE_COUNT_SLOT, fn);
}

/**
 * Recompose today's practice stream; false when no implementation is installed
 * (e.g. a unit-context host that never composed practice).
 */
export async function recomposeTodayPractice(db: Db): Promise<boolean> {
  const fn = installedHostOperation<RecomposeTodayPracticeFn>(RECOMPOSE_SLOT);
  if (!fn) return false;
  await fn(db);
  return true;
}

/**
 * Net due items today's page loses to steering deferral; null when practice
 * never installed the counter (report unknown, never guess zero).
 */
export async function steeringDeferredDueCount(db: Db, now: Date): Promise<number | null> {
  const fn = installedHostOperation<SteeringDeferredDueCountFn>(DEFERRED_DUE_COUNT_SLOT);
  if (!fn) return null;
  return fn(db, now);
}
