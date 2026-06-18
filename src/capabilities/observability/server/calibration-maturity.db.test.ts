import { item_calibration, knowledge, mastery_state, question } from '@/db/schema';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import {
  COLD_START_EVIDENCE_FLOOR,
  COLD_START_PRECISION_CEILING,
  loadCalibrationMaturity,
} from './calibration-maturity';

const db = testDb();
const NOW = new Date('2026-06-18T08:00:00Z');

async function seedKc(id: string, name: string, opts: { archived?: boolean } = {}) {
  await db.insert(knowledge).values({
    id,
    name,
    domain: 'wenyan',
    parent_id: null,
    merged_from: [],
    archived_at: opts.archived ? NOW : null,
    proposed_by_ai: false,
    approval_status: 'approved',
    created_at: NOW,
    updated_at: NOW,
    version: 0,
  });
}

async function seedMastery(
  subjectId: string,
  opts: { evidence_count: number; theta_precision: number; theta_hat?: number },
) {
  await db.insert(mastery_state).values({
    id: `ms_${subjectId}`,
    subject_kind: 'knowledge',
    subject_id: subjectId,
    theta_hat: opts.theta_hat ?? 0,
    evidence_count: opts.evidence_count,
    success_count: 0,
    fail_count: 0,
    last_outcome_at: NOW,
    theta_precision: opts.theta_precision,
    updated_at: NOW,
  });
}

async function seedQuestion(id: string, knowledgeIds: string[]) {
  await db.insert(question).values({
    id,
    kind: 'short_answer',
    prompt_md: `prompt ${id}`,
    knowledge_ids: knowledgeIds,
    difficulty: 3,
    source: 'test',
    draft_status: null,
    created_at: NOW,
    updated_at: NOW,
    version: 0,
  });
}

async function seedCalibration(
  questionId: string,
  opts: { confidence: number | null; track?: string; source?: string },
) {
  await db.insert(item_calibration).values({
    id: `ic_${questionId}`,
    question_id: questionId,
    b: 0.5,
    confidence: opts.confidence,
    track: opts.track ?? 'hard',
    source: opts.source ?? 'llm_prior',
    created_at: NOW,
    updated_at: NOW,
  });
}

describe('calibration-maturity read model', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('classifies cold_start vs firm by the documented evidence + precision thresholds', async () => {
    // firm: evidence >= floor AND precision > ceiling
    await seedKc('k_firm', '已收紧');
    await seedMastery('k_firm', {
      evidence_count: COLD_START_EVIDENCE_FLOOR + 2,
      theta_precision: 4,
    });

    // cold by low evidence (precision is high, but evidence below floor)
    await seedKc('k_low_evidence', '作答太少');
    await seedMastery('k_low_evidence', {
      evidence_count: COLD_START_EVIDENCE_FLOOR - 1,
      theta_precision: 5,
    });

    // cold by precision still at the weak-prior default (evidence high, precision not firmed)
    await seedKc('k_low_precision', '不确定度未收紧');
    await seedMastery('k_low_precision', {
      evidence_count: COLD_START_EVIDENCE_FLOOR + 10,
      theta_precision: COLD_START_PRECISION_CEILING,
    });

    // cold: never attempted (no mastery_state row at all — LEFT JOIN)
    await seedKc('k_never', '从未作答');

    const { rows } = await loadCalibrationMaturity(db);
    const byId = new Map(rows.map((r) => [r.knowledge_id, r]));

    expect(byId.get('k_firm')?.cold_start).toBe(false);
    expect(byId.get('k_low_evidence')?.cold_start).toBe(true);
    expect(byId.get('k_low_precision')?.cold_start).toBe(true);
    expect(byId.get('k_never')?.cold_start).toBe(true);
  });

  it('reports theta_se from precision and null for never-attempted KCs', async () => {
    await seedKc('k_state', '有状态');
    await seedMastery('k_state', { evidence_count: 6, theta_precision: 4 });
    await seedKc('k_nostate', '无状态');

    const { rows } = await loadCalibrationMaturity(db);
    const byId = new Map(rows.map((r) => [r.knowledge_id, r]));

    // thetaSe(4) = 1/sqrt(4) = 0.5
    expect(byId.get('k_state')?.theta_se).toBeCloseTo(0.5, 9);
    expect(byId.get('k_state')?.evidence_count).toBe(6);

    // never attempted → theta_se null, evidence_count 0
    expect(byId.get('k_nostate')?.theta_se).toBeNull();
    expect(byId.get('k_nostate')?.evidence_count).toBe(0);
  });

  it('aggregates item_calibration confidence + dominant track per KC through question.knowledge_ids', async () => {
    await seedKc('k_cal', '标定题');
    await seedMastery('k_cal', { evidence_count: 6, theta_precision: 3 });

    // two calibrated questions both tagged k_cal: confidences 0.4 and 0.6 → avg 0.5
    await seedQuestion('q1', ['k_cal']);
    await seedQuestion('q2', ['k_cal', 'k_other']);
    await seedCalibration('q1', { confidence: 0.4, track: 'hard' });
    await seedCalibration('q2', { confidence: 0.6, track: 'hard' });

    await seedKc('k_other', '另一KC');
    await seedMastery('k_other', { evidence_count: 6, theta_precision: 3 });

    // KC with mastery state but no calibrated question → confidence/track null
    await seedKc('k_uncal', '无标定题');
    await seedMastery('k_uncal', { evidence_count: 6, theta_precision: 3 });

    const { rows } = await loadCalibrationMaturity(db);
    const byId = new Map(rows.map((r) => [r.knowledge_id, r]));

    // confidence is a `real` (float4) column → single-precision rounding, so
    // 0.4/0.6 averaged lands ~0.50000001. Assert at 6 dp (real's precision).
    expect(byId.get('k_cal')?.confidence).toBeCloseTo(0.5, 6);
    expect(byId.get('k_cal')?.track).toBe('hard');
    // k_other only on q2 (confidence 0.6)
    expect(byId.get('k_other')?.confidence).toBeCloseTo(0.6, 6);
    expect(byId.get('k_other')?.track).toBe('hard');
    // no calibrated question for this KC
    expect(byId.get('k_uncal')?.confidence).toBeNull();
    expect(byId.get('k_uncal')?.track).toBeNull();
  });

  it('computes the whole-map aggregate counts, pct_firm, and median_theta_se', async () => {
    // 2 firm, 3 cold → total 5, pct_firm 0.4
    await seedKc('k_firm_1', 'firm1');
    await seedMastery('k_firm_1', { evidence_count: 8, theta_precision: 4 }); // se 0.5
    await seedKc('k_firm_2', 'firm2');
    await seedMastery('k_firm_2', { evidence_count: 8, theta_precision: 16 }); // se 0.25

    await seedKc('k_cold_1', 'cold1');
    await seedMastery('k_cold_1', { evidence_count: 1, theta_precision: 1 }); // se 1.0
    await seedKc('k_cold_2', 'cold2');
    await seedMastery('k_cold_2', { evidence_count: 8, theta_precision: 1 }); // se 1.0
    await seedKc('k_cold_never', 'coldNever'); // no state → se null, excluded from median

    const { aggregate } = await loadCalibrationMaturity(db);

    expect(aggregate.total_kcs).toBe(5);
    expect(aggregate.firm_count).toBe(2);
    expect(aggregate.cold_start_count).toBe(3);
    expect(aggregate.pct_firm).toBeCloseTo(0.4, 9);
    // se values present (excluding null): [0.25, 0.5, 1.0, 1.0] → median = (0.5 + 1.0)/2 = 0.75
    expect(aggregate.median_theta_se).toBeCloseTo(0.75, 9);
  });

  it('excludes archived KCs and returns a zeroed aggregate when the map is empty', async () => {
    await seedKc('k_archived', '已归档', { archived: true });
    await seedMastery('k_archived', { evidence_count: 8, theta_precision: 4 });

    const { rows, aggregate } = await loadCalibrationMaturity(db);

    expect(rows.find((r) => r.knowledge_id === 'k_archived')).toBeUndefined();
    expect(aggregate.total_kcs).toBe(0);
    expect(aggregate.firm_count).toBe(0);
    expect(aggregate.cold_start_count).toBe(0);
    expect(aggregate.pct_firm).toBe(0);
    expect(aggregate.median_theta_se).toBeNull();
  });
});
