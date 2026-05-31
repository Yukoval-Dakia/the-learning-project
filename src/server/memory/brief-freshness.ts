// P5.3 long-term brief freshness score — pure, IO-free decay arithmetic.
//
// Spec: docs/superpowers/specs/2026-05-31-p5.3-long-term-brief-stale-design.md §4.2.
// This module deliberately imports NO DB code so brief.test.ts can exercise it
// in the unit partition without spinning up Postgres. The lazy timestamp
// resolver (`resolveEvidenceTimestamps`) lives in brief.ts, which already owns
// the `event` table + `Db` type; this file is the model-free numerator math only.

import type { LongTermFreshnessBudget } from '@/server/ai/tools/budgets';

const MS_PER_DAY = 86_400_000;
const LN2 = Math.log(2);

/**
 * freshness = (1 / knownCount) * Σ exp(-ln(2) * ageDays_i / halfLifeDays)
 * over evidence rows whose created_at is known. ageDays = (now - created_at)/86_400_000, floored at 0.
 * score is NULL when knownCount === 0 (no judgeable evidence) — distinct from a scored 0.
 *
 * No `stale` boolean here — staleness is an advisory render-time judgement
 * (`score != null && score < budget.freshnessThreshold`) made by consumers,
 * NOT a mutation gate computed in the regen path.
 */
export function scoreLongTermFreshness(
  evidenceTimestamps: { id: string; created_at: Date | null }[],
  now: Date,
  budget: LongTermFreshnessBudget,
): { score: number | null; knownCount: number; unknownCount: number } {
  const nowMs = now.getTime();
  let sum = 0;
  let knownCount = 0;
  let unknownCount = 0;

  for (const { created_at } of evidenceTimestamps) {
    if (created_at == null) {
      // Unknown timestamp — excluded from BOTH the numerator and knownCount (§4.2).
      unknownCount += 1;
      continue;
    }
    const ageDays = Math.max(0, (nowMs - created_at.getTime()) / MS_PER_DAY);
    sum += Math.exp((-LN2 * ageDays) / budget.halfLifeDays);
    knownCount += 1;
  }

  // knownCount === 0 ⇒ null guard removes any divide-by-zero. null is the
  // "unjudgeable" state (empty ids OR all-unknown), distinct from a scored 0.
  const score = knownCount === 0 ? null : sum / knownCount;
  return { score, knownCount, unknownCount };
}
