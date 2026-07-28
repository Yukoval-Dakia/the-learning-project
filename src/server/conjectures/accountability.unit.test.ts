import { describe, expect, it } from 'vitest';

import {
  type AccountabilityCandidate,
  type PredictionAccountability,
  type PredictionAccountabilityRecord,
  derivePredictionAccountability,
  rankEvidenceCellsByAccountability,
} from '@/server/conjectures/accountability';

function score(
  id: string,
  point: number,
  minute: number,
  probeResultId = `result_${id}`,
): PredictionAccountabilityRecord {
  return {
    score_event_id: id,
    probe_result_event_id: probeResultId,
    conjecture_event_id: 'conjecture_a',
    skill_score_point: point,
    scored_at: new Date(`2026-07-28T10:${String(minute).padStart(2, '0')}:00.000Z`),
  };
}

function cell(key: string, recurrence: number, probeHere = true): AccountabilityCandidate {
  const [cause, knowledgeId] = key.split('::');
  return {
    key,
    cause_category: cause,
    knowledge_id: knowledgeId,
    recurrence_count: recurrence,
    probe_here: probeHere,
  };
}

describe('derivePredictionAccountability (YUK-795)', () => {
  it('keeps zero or one observation byte-for-byte rank neutral', () => {
    expect(derivePredictionAccountability([], 'INSUFFICIENT')).toMatchObject({
      state: 'watch',
      latest_direction: 'neutral',
      consecutive_count: 0,
      rank_multiplier: 1,
    });
    expect(
      derivePredictionAccountability([score('score_1', -0.4, 1)], 'INSUFFICIENT'),
    ).toMatchObject({
      state: 'watch',
      latest_direction: 'miss',
      consecutive_count: 1,
      rank_multiplier: 1,
    });
  });

  it('downweights only after two consecutive misses', () => {
    expect(
      derivePredictionAccountability(
        [score('score_1', -0.2, 1), score('score_2', -0.3, 2)],
        'INSUFFICIENT',
      ),
    ).toMatchObject({
      state: 'downweighted',
      latest_direction: 'miss',
      consecutive_count: 2,
      rank_multiplier: 0.25,
    });
  });

  it('boosts persistent hits and lets an EMERGING dissociation strengthen the boost', () => {
    const records = [score('score_1', 0.2, 1), score('score_2', 0.3, 2)];
    expect(derivePredictionAccountability(records, 'INSUFFICIENT').rank_multiplier).toBe(1.15);
    expect(derivePredictionAccountability(records, 'EMERGING').rank_multiplier).toBe(1.15);
    expect(
      derivePredictionAccountability(records, 'EMERGING', { hardConfirmEnabled: true }),
    ).toMatchObject({
      state: 'supported',
      latest_direction: 'hit',
      consecutive_count: 2,
      rank_multiplier: 1.25,
      hard_confirm_enabled: true,
    });
  });

  it('reverses a miss streak after later consecutive hits', () => {
    expect(
      derivePredictionAccountability(
        [
          score('score_1', -0.2, 1),
          score('score_2', -0.3, 2),
          score('score_3', 0.2, 3),
          score('score_4', 0.4, 4),
        ],
        'INSUFFICIENT',
      ),
    ).toMatchObject({
      state: 'supported',
      latest_direction: 'hit',
      consecutive_count: 2,
      rank_multiplier: 1.15,
    });
  });

  it('treats neutral and mixed evidence as watch, and duplicate delivery cannot inflate a streak', () => {
    const duplicate = score('score_duplicate', -0.8, 2, 'result_1');
    expect(
      derivePredictionAccountability(
        [score('score_1', -0.2, 1, 'result_1'), duplicate],
        'INSUFFICIENT',
      ),
    ).toMatchObject({ state: 'watch', consecutive_count: 1, rank_multiplier: 1 });
    expect(
      derivePredictionAccountability(
        [score('score_1', -0.2, 1), score('score_2', 0, 2)],
        'INSUFFICIENT',
      ),
    ).toMatchObject({
      state: 'watch',
      latest_direction: 'neutral',
      consecutive_count: 0,
      rank_multiplier: 1,
    });
  });
});

describe('rankEvidenceCellsByAccountability (YUK-795)', () => {
  it('preserves the prior order when no rule hits', () => {
    const cells = [cell('concept::kc_a', 3), cell('method::kc_b', 2)];
    expect(rankEvidenceCellsByAccountability(cells, new Map())).toEqual(cells);
  });

  it('moves repeated misses below a lower-recurrence neutral candidate', () => {
    const high = cell('concept::kc_a', 4);
    const neutral = cell('method::kc_b', 2);
    const downweighted = derivePredictionAccountability(
      [score('score_1', -0.2, 1), score('score_2', -0.3, 2)],
      'INSUFFICIENT',
    );
    expect(
      rankEvidenceCellsByAccountability([high, neutral], new Map([[high.key, downweighted]])).map(
        (candidate) => candidate.key,
      ),
    ).toEqual([neutral.key, high.key]);
  });

  it('uses deterministic tiebreakers for mathematically equal floating weighted scores', () => {
    const highRecurrence = cell('concept::kc_high', 3);
    const lowRecurrence = cell('method::kc_low', 1);
    const profile = (multiplier: number): PredictionAccountability => ({
      state: 'watch',
      latest_direction: 'neutral',
      consecutive_count: 0,
      rank_multiplier: multiplier,
      hard_confirm_verdict: 'INSUFFICIENT',
      hard_confirm_enabled: false,
      score_event_ids: [],
    });

    expect(
      rankEvidenceCellsByAccountability(
        [lowRecurrence, highRecurrence],
        new Map([
          [highRecurrence.key, profile(0.1)],
          [lowRecurrence.key, profile(0.3)],
        ]),
      ).map((candidate) => candidate.key),
    ).toEqual([highRecurrence.key, lowRecurrence.key]);
  });
});
