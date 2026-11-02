// Long-term brief freshness: pure decay arithmetic, no IO. The timestamp resolver
// lives in brief.ts, which owns the event table and Db type.

import type { LongTermFreshnessBudget } from '@/kernel/tools/budgets';

const MS_PER_DAY = 86_400_000;
const LN2 = Math.log(2);

/**
 * Mean exponential decay over evidence with a known created_at. Unknown timestamps
 * are excluded from both numerator and count; no judgeable evidence scores null,
 * distinct from a real 0. Consumers render staleness; this is not a mutation gate.
 */
export function scoreLongTermFreshness(
  evidenceTimestamps: { id: string; created_at: Date | null }[],
  now: Date,
  budget: LongTermFreshnessBudget,
): { score: number | null; knownCount: number; unknownCount: number } {
  // Reject a bad half-life here: it is a compile-time const today, but a config
  // error would otherwise persist NaN/Infinity/>1 scores. `!(x > 0)` also rejects NaN.
  if (!(budget.halfLifeDays > 0)) {
    throw new Error(`scoreLongTermFreshness: halfLifeDays must be > 0, got ${budget.halfLifeDays}`);
  }
  const nowMs = now.getTime();
  let sum = 0;
  let knownCount = 0;
  let unknownCount = 0;

  for (const { created_at } of evidenceTimestamps) {
    if (created_at == null) {
      // Unknown timestamp: excluded from both numerator and knownCount.
      unknownCount += 1;
      continue;
    }
    const ageDays = Math.max(0, (nowMs - created_at.getTime()) / MS_PER_DAY);
    sum += Math.exp((-LN2 * ageDays) / budget.halfLifeDays);
    knownCount += 1;
  }

  // null removes any divide-by-zero and is the "unjudgeable" state, distinct from 0.
  const score = knownCount === 0 ? null : sum / knownCount;
  return { score, knownCount, unknownCount };
}
