// Shared per-KC numeric view over the learner profile. Agent startup, the
// Today/topics surface and the weekly report read the same row — same numbers,
// source tag, freshness provenance and named UNKNOWN reason — so they can
// never present three different "how is this KC" figures at once. Unknown is
// never zero; a missing row rebuilds the canonical projection in-snapshot.

import type { LearnerJudgment } from '@/core/schema/learner-judgment';
import type { Db, Tx } from '@/db/client';
import { retentionValue } from './build-judgment';
import { type ProfileFreshness, readLearnerProfiles } from './read';

type DbLike = Db | Tx;

export const PROFILE_NUMERIC_SOURCE = 'kernel/learner-profile:readLearnerProfiles' as const;

export interface ProfileNumericSource {
  mastery: number | null;
  /** The FSRS/retention point R(t) at this read's as_of; null when unknown. */
  retention: number | null;
  theta_hat: number | null;
  evidence_count: number | null;
  /** Named reason when a numeric field is unknown; never a fabricated zero. */
  masteryReason: string | null;
  retentionReason: string | null;
  freshness: ProfileFreshness;
  source: typeof PROFILE_NUMERIC_SOURCE;
}

function masteryNumber(judgment: LearnerJudgment): {
  value: number | null;
  reason: string | null;
} {
  if (judgment.ability.kind === 'available') {
    return { value: judgment.ability.reading.mastery, reason: null };
  }
  return { value: null, reason: judgment.ability.reason };
}

function thetaNumber(judgment: LearnerJudgment): number | null {
  return judgment.ability.kind === 'available' ? judgment.ability.reading.theta_hat : null;
}

function evidenceCount(judgment: LearnerJudgment): number | null {
  return judgment.ability.kind === 'available' ? judgment.ability.reading.evidence_count : null;
}

function retentionNumber(judgment: LearnerJudgment): {
  value: number | null;
  reason: string | null;
} {
  const r = retentionValue(judgment.retention);
  if (r !== null) return { value: r, reason: null };
  const reason =
    judgment.retention.kind === 'unknown'
      ? judgment.retention.reason
      : typeof judgment.retention.reading === 'object' &&
          judgment.retention.reading.kind === 'unknown'
        ? judgment.retention.reading.reason
        : 'missing_scheduling_state';
  return { value: null, reason };
}

export interface LearnerProfileNumbers {
  as_of: Date;
  items: Map<string, ProfileNumericSource>;
}

/**
 * Batch per-KC numeric read over the profile rows (with in-snapshot fallback
 * for stale/missing ones). The same read feeds every migrated consumer.
 */
export async function readLearnerProfileNumbers(
  db: DbLike,
  input: { knowledge_ids: string[]; as_of: Date },
): Promise<LearnerProfileNumbers> {
  const result = await readLearnerProfiles(db, input);
  const items = new Map<string, ProfileNumericSource>();
  for (const item of result.items) {
    const mastery = masteryNumber(item.judgment);
    const retention = retentionNumber(item.judgment);
    items.set(item.knowledge_id, {
      mastery: mastery.value,
      retention: retention.value,
      theta_hat: thetaNumber(item.judgment),
      evidence_count: evidenceCount(item.judgment),
      masteryReason: mastery.reason,
      retentionReason: retention.reason,
      freshness: item.freshness,
      source: PROFILE_NUMERIC_SOURCE,
    });
  }
  return { as_of: result.as_of, items };
}
