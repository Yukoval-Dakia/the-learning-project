import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb } from '../../../../tests/helpers/db';
import { GET as getCalibrationMaturity } from './calibration-maturity';
import { GET as getConjectureScores } from './conjecture-scores';
import { GET as getCoverageLattice } from './coverage-lattice';
import {
  CalibrationMaturityResponseSchema,
  ConjectureScoresResponseSchema,
  CoverageLatticeResponseSchema,
  EffectivenessTrendResponseSchema,
  JudgeCalibrationResponseSchema,
} from './diagnostic-contracts';
import { GET as getEffectivenessTrend } from './effectiveness-trend';
import { GET as getJudgeCalibration } from './judge-calibration';

describe('diagnostic observation route contracts', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('matches every declared response schema on an empty database', async () => {
    const responses = await Promise.all([
      getConjectureScores(),
      getJudgeCalibration(),
      getCoverageLattice(),
      getCalibrationMaturity(),
      getEffectivenessTrend(),
    ]);
    for (const response of responses) expect(response.status).toBe(200);

    expect(ConjectureScoresResponseSchema.parse(await responses[0].json())).toMatchObject({
      score_basis: 'single_point',
      prediction_scores: [],
      typed_states: [],
    });
    expect(JudgeCalibrationResponseSchema.parse(await responses[1].json()).headline).toEqual({
      status: 'insufficient_data',
      n: 0,
    });
    expect(CoverageLatticeResponseSchema.parse(await responses[2].json()).totals).toMatchObject({
      activeKcs: 0,
      totalGaps: 0,
    });
    expect(CalibrationMaturityResponseSchema.parse(await responses[3].json()).aggregate).toEqual({
      total_kcs: 0,
      cold_start_count: 0,
      firm_count: 0,
      pct_firm: 0,
      median_theta_se: null,
    });
    const effectiveness = EffectivenessTrendResponseSchema.parse(await responses[4].json());
    expect(effectiveness.aggregate).toEqual({
      total_kcs_with_activity: 0,
      total_events: 0,
      by_subject: [],
    });
    expect(effectiveness).toMatchObject({
      series: [],
      subject_roots: [],
      metadata: { notable_limit: 6, eligible: 0, returned: 0, truncated: false },
    });
  });
});
