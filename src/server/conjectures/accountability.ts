// YUK-795 — deterministic n=1 prediction accountability.
//
// This is deliberately a small ordinal policy, not a fitted calibration model:
// every score is one within-owner observation, duplicates collapse by the backing
// probe_result id, and only a repeated same-direction streak changes ranking.
// Population parameters, posterior odds, and cross-learner estimates do not belong
// here.

import { misconceptionHardConfirmEnabled } from '@/capabilities/agency/public';
import type { Db } from '@/db/client';
import {
  type DissociationVerdict,
  decideDissociation,
  gatherDissociationRecordsByIdentity,
  summarizeDissociation,
} from '@/server/conjectures/hard-confirm';
import { scorePrediction } from '@/server/conjectures/scoring';

export const ACCOUNTABILITY_STREAK_FLOOR = 2;
export const ACCOUNTABILITY_DOWNWEIGHT_MULTIPLIER = 0.25;
export const ACCOUNTABILITY_SUPPORTED_MULTIPLIER = 1.15;
export const ACCOUNTABILITY_EMERGING_MULTIPLIER = 1.25;
const ACCOUNTABILITY_RANK_TIE_EPSILON = 1e-9;

export interface PredictionAccountabilityRecord {
  score_event_id: string;
  probe_result_event_id: string;
  conjecture_event_id: string;
  skill_score_point: number;
  scored_at: Date;
}

export type PredictionAccountabilityState = 'watch' | 'downweighted' | 'supported';
export type PredictionAccountabilityDirection = 'hit' | 'miss' | 'neutral';

export interface PredictionAccountability {
  state: PredictionAccountabilityState;
  latest_direction: PredictionAccountabilityDirection;
  consecutive_count: number;
  rank_multiplier: number;
  hard_confirm_verdict: DissociationVerdict;
  hard_confirm_enabled: boolean;
  score_event_ids: string[];
}

export interface AccountabilityCandidate {
  key: string;
  cause_category: string;
  knowledge_id: string;
  recurrence_count: number;
  probe_here: boolean;
}

function directionForScore(skillScorePoint: number): PredictionAccountabilityDirection {
  if (skillScorePoint > 0) return 'hit';
  if (skillScorePoint < 0) return 'miss';
  return 'neutral';
}

/**
 * Fold valid prediction scores for one `(cause_category × knowledge_id)` identity.
 *
 * The latest consecutive direction wins. One miss is intentionally inert; two
 * misses downweight. Two hits boost; only when the hard-confirm track is explicitly
 * enabled does an independently established Tier-1 `EMERGING` verdict permit the
 * slightly stronger boost. A neutral score resets the streak. A later opposite
 * streak reverses the prior state.
 */
export function derivePredictionAccountability(
  records: readonly PredictionAccountabilityRecord[],
  hardConfirmVerdict: DissociationVerdict,
  options: { hardConfirmEnabled?: boolean } = {},
): PredictionAccountability {
  const sorted = [...records].sort(
    (a, b) =>
      a.scored_at.getTime() - b.scored_at.getTime() ||
      a.score_event_id.localeCompare(b.score_event_id),
  );
  const seenProbeResults = new Set<string>();
  const effective: PredictionAccountabilityRecord[] = [];
  for (const record of sorted) {
    if (seenProbeResults.has(record.probe_result_event_id)) continue;
    seenProbeResults.add(record.probe_result_event_id);
    effective.push(record);
  }

  let latestDirection: PredictionAccountabilityDirection = 'neutral';
  let consecutiveCount = 0;
  for (const record of effective) {
    const direction = directionForScore(record.skill_score_point);
    if (direction === 'neutral') {
      latestDirection = 'neutral';
      consecutiveCount = 0;
      continue;
    }
    if (direction === latestDirection) {
      consecutiveCount += 1;
    } else {
      latestDirection = direction;
      consecutiveCount = 1;
    }
  }

  let state: PredictionAccountabilityState = 'watch';
  let rankMultiplier = 1;
  if (consecutiveCount >= ACCOUNTABILITY_STREAK_FLOOR && latestDirection === 'miss') {
    state = 'downweighted';
    rankMultiplier = ACCOUNTABILITY_DOWNWEIGHT_MULTIPLIER;
  } else if (consecutiveCount >= ACCOUNTABILITY_STREAK_FLOOR && latestDirection === 'hit') {
    state = 'supported';
    rankMultiplier =
      hardConfirmVerdict === 'EMERGING' && options.hardConfirmEnabled === true
        ? ACCOUNTABILITY_EMERGING_MULTIPLIER
        : ACCOUNTABILITY_SUPPORTED_MULTIPLIER;
  }

  return {
    state,
    latest_direction: latestDirection,
    consecutive_count: consecutiveCount,
    rank_multiplier: rankMultiplier,
    hard_confirm_verdict: hardConfirmVerdict,
    hard_confirm_enabled: options.hardConfirmEnabled === true,
    score_event_ids: effective.map((record) => record.score_event_id),
  };
}

/**
 * Re-rank nightly evidence cells before the top-K cut. With no matched profile or
 * a rule-miss (`rank_multiplier=1`) this reproduces the existing recurrence /
 * probe_here / key order exactly.
 */
export function rankEvidenceCellsByAccountability<T extends AccountabilityCandidate>(
  cells: readonly T[],
  accountabilityByKey: ReadonlyMap<string, PredictionAccountability>,
): T[] {
  return [...cells].sort((a, b) => {
    const aMultiplier = accountabilityByKey.get(a.key)?.rank_multiplier ?? 1;
    const bMultiplier = accountabilityByKey.get(b.key)?.rank_multiplier ?? 1;
    const adjusted = b.recurrence_count * bMultiplier - a.recurrence_count * aMultiplier;
    const adjustedWithStableTie =
      Math.abs(adjusted) < ACCOUNTABILITY_RANK_TIE_EPSILON ? 0 : adjusted;
    return (
      adjustedWithStableTie ||
      b.recurrence_count - a.recurrence_count ||
      Number(b.probe_here) - Number(a.probe_here) ||
      a.key.localeCompare(b.key)
    );
  });
}

/**
 * Correction-aware live DB reader used by the nightly research meeting. The
 * hard-confirm decision is evaluated in the same pass and consumed by the rank
 * policy, but ownerFreshlyConfirmed is deliberately false: a background job may
 * observe `EMERGING`; it can never mint a hard misconception.
 */
export async function loadPredictionAccountabilityByKey(
  db: Db,
  cells: readonly AccountabilityCandidate[],
): Promise<Map<string, PredictionAccountability>> {
  const targets = cells.map((cell) => ({
    key: cell.key,
    causeCategory: cell.cause_category,
    knowledgeId: cell.knowledge_id,
  }));
  const recordsByKey = await gatherDissociationRecordsByIdentity(db, targets);
  const hardConfirmEnabled = misconceptionHardConfirmEnabled();
  const out = new Map<string, PredictionAccountability>();
  for (const cell of cells) {
    const records = recordsByKey.get(cell.key) ?? [];
    const evidence = summarizeDissociation(records);
    const hardConfirmVerdict = decideDissociation(evidence, {
      hardConfirmEnabled,
      hasRivalProbe: records.some((record) => record.discriminating),
      // Protected red line: only a dedicated owner command may ever pass true.
      ownerFreshlyConfirmed: false,
    });
    out.set(
      cell.key,
      derivePredictionAccountability(
        records.flatMap((record) =>
          record.baselineP === null
            ? []
            : [
                {
                  score_event_id: record.scoreEventId,
                  probe_result_event_id: record.probeResultEventId,
                  conjecture_event_id: record.conjectureEventId,
                  skill_score_point: scorePrediction(
                    record.predictedP,
                    record.baselineP,
                    record.outcome,
                  ).skillScorePoint,
                  scored_at: record.scoredAt,
                },
              ],
        ),
        hardConfirmVerdict,
        { hardConfirmEnabled },
      ),
    );
  }
  return out;
}
