// YUK-573 — admin read model for judge-calibration observations (db tests).
// READ-ONLY: aggregates `experimental:judge_calibration_sample` +
// `experimental:judge_calibration_run_summary` events. Pins: MIN_N
// insufficient_data gating (S4), same_lane_suspected exclusion from the
// headline (MF5), run-summary health surface (复核吸收 3), zero-sample safety,
// and the two honesty notes.
import { event } from '@/db/schema';
import { createId } from '@paralleldrive/cuid2';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { JudgeCalibrationResponseSchema } from '../api/diagnostic-contracts';
import { JUDGE_CALIBRATION_MIN_N, loadJudgeCalibrationStats } from './judge-calibration';

interface SampleSeed {
  agreed?: boolean;
  bitAgreed?: boolean;
  route?: string;
  originalOutcome?: 'correct' | 'partial' | 'incorrect';
  sameLane?: boolean;
  at?: Date;
  /** null → structurally-unexpected row (dedup fallback coverage). */
  causedBy?: string | null;
}

async function seedSample(s: SampleSeed = {}): Promise<void> {
  const judgeId = createId();
  const agreed = s.agreed ?? true;
  const now = s.at ?? new Date();
  await testDb()
    .insert(event)
    .values({
      id: createId(),
      session_id: null,
      actor_kind: 'system',
      actor_ref: 'judge_calibration',
      action: 'experimental:judge_calibration_sample',
      subject_kind: 'event',
      subject_id: judgeId,
      outcome: null,
      payload: {
        original_outcome: s.originalOutcome ?? 'correct',
        rejudge_outcome: agreed ? (s.originalOutcome ?? 'correct') : 'incorrect',
        agreed,
        bit_agreed: s.bitAgreed ?? agreed,
        original_judge_event_id: judgeId,
        question_id: createId(),
        answer_event_id: createId(),
        rejudge_route: s.route ?? 'semantic',
        rejudge_confidence: 0.8,
        rejudge_provider: 'anthropic-sub',
        rejudge_model: 'claude-opus-4-8',
        rejudge_task_run_id: null,
        rejudge_raw_output: null,
        original_provider: 'unknown',
        vision_judge_provider_at_sample: null,
        ai_provider_override_at_sample: s.sameLane ? 'anthropic-sub' : null,
        same_lane_suspected: s.sameLane ?? false,
        sampled_at: now.toISOString(),
      },
      caused_by_event_id: s.causedBy === undefined ? judgeId : s.causedBy,
      task_run_id: null,
      cost_micro_usd: null,
      ingest_at: now,
      created_at: now,
    });
}

async function seedRunSummary(counts: {
  sampled: number;
  skipped?: number;
  runKey?: string;
}): Promise<void> {
  const now = new Date();
  await testDb()
    .insert(event)
    .values({
      id: createId(),
      session_id: null,
      actor_kind: 'system',
      actor_ref: 'judge_calibration',
      action: 'experimental:judge_calibration_run_summary',
      subject_kind: 'query',
      subject_id: counts.runKey ?? `judge_calibration_run:${createId()}`,
      outcome: null,
      payload: {
        sampled: counts.sampled,
        agreed: counts.sampled,
        disagreed: 0,
        skipped: counts.skipped ?? 0,
        skipped_unsupported: 0,
        errors: 0,
        batch_max: 20,
        window_days: 7,
        rejudge_provider: 'anthropic-sub',
        rejudge_model: 'claude-opus-4-8',
        vision_judge_provider_at_sample: null,
        ai_provider_override_at_sample: null,
      },
      caused_by_event_id: null,
      task_run_id: null,
      cost_micro_usd: null,
      ingest_at: now,
      created_at: now,
    });
}

describe('loadJudgeCalibrationStats', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('zero samples → insufficient_data headline, no crash (除零)', async () => {
    const stats = await loadJudgeCalibrationStats(testDb());
    expect(stats.total_samples).toBe(0);
    expect(stats.headline).toEqual({ status: 'insufficient_data', n: 0 });
    expect(stats.recent_runs).toEqual([]);
  });

  it('below MIN_N → insufficient_data (never a bare ratio on tiny n — S4)', async () => {
    for (let i = 0; i < JUDGE_CALIBRATION_MIN_N - 1; i++) {
      await seedSample({ agreed: true });
    }
    const stats = await loadJudgeCalibrationStats(testDb());
    expect(stats.headline.status).toBe('insufficient_data');
    expect(stats.by_route.semantic?.status).toBe('insufficient_data');
  });

  it('at/above MIN_N → ok stratum with both agreement rates', async () => {
    for (let i = 0; i < 4; i++) await seedSample({ agreed: true });
    await seedSample({ agreed: false, bitAgreed: true });
    await seedSample({ agreed: false, bitAgreed: false });
    const stats = await loadJudgeCalibrationStats(testDb());
    JudgeCalibrationResponseSchema.parse(JSON.parse(JSON.stringify(stats)));
    expect(stats.headline).toEqual({
      status: 'ok',
      n: 6,
      agreed: 4,
      bit_agreed: 5,
      agreement_rate: 4 / 6,
      bit_agreement_rate: 5 / 6,
    });
    expect(stats.by_route.semantic?.status).toBe('ok');
    expect(stats.by_original_outcome.correct?.status).toBe('ok');
  });

  it('same_lane_suspected samples are EXCLUDED from the headline and counted separately (MF5)', async () => {
    for (let i = 0; i < 5; i++) await seedSample({ agreed: false });
    // Same-lane agreements would flatter the rate — they must not enter it.
    for (let i = 0; i < 3; i++) await seedSample({ agreed: true, sameLane: true });
    const stats = await loadJudgeCalibrationStats(testDb());
    expect(stats.total_samples).toBe(8);
    expect(stats.same_lane_suspected_count).toBe(3);
    expect(stats.headline).toMatchObject({ status: 'ok', n: 5, agreed: 0 });
  });

  it('strata split by route and by original outcome', async () => {
    for (let i = 0; i < 5; i++) await seedSample({ route: 'semantic', agreed: true });
    for (let i = 0; i < 5; i++)
      await seedSample({ route: 'steps', originalOutcome: 'incorrect', agreed: false });
    const stats = await loadJudgeCalibrationStats(testDb());
    expect(stats.by_route.semantic).toMatchObject({ status: 'ok', n: 5, agreed: 5 });
    expect(stats.by_route.steps).toMatchObject({ status: 'ok', n: 5, agreed: 0 });
    expect(stats.by_original_outcome.incorrect).toMatchObject({ status: 'ok', n: 5 });
  });

  it('recent runs expose the mass-skip vs cold-start discriminator (复核吸收 3)', async () => {
    await seedRunSummary({ sampled: 0, skipped: 20 }); // systematically skipping
    await seedRunSummary({ sampled: 2 }); // healthy but sparse
    const stats = await loadJudgeCalibrationStats(testDb());
    expect(stats.recent_runs).toHaveLength(2);
    expect(stats.recent_runs.map((r) => r.sampled).sort()).toEqual([0, 2]);
    expect(stats.recent_runs.find((r) => r.sampled === 0)?.skipped).toBe(20);
  });

  it('duplicate run summaries (at-least-once redeliver) are deduped by run key (review finding 2)', async () => {
    await seedRunSummary({ sampled: 3, runKey: 'judge_calibration_run:2026-07-07T00:00:00Z' });
    await seedRunSummary({ sampled: 3, runKey: 'judge_calibration_run:2026-07-07T00:00:00Z' });
    await seedRunSummary({ sampled: 1 });
    const stats = await loadJudgeCalibrationStats(testDb());
    expect(stats.recent_runs).toHaveLength(2);
  });

  it('recent samples are surfaced (rejudge run id joinable for lane audits — S1)', async () => {
    await seedSample({ agreed: false });
    const stats = await loadJudgeCalibrationStats(testDb());
    expect(stats.recent_samples).toHaveLength(1);
    expect(stats.recent_samples[0]).toMatchObject({
      original_outcome: 'correct',
      rejudge_outcome: 'incorrect',
      agreed: false,
      rejudge_route: 'semantic',
      same_lane_suspected: false,
    });
  });

  it('samples older than the 90d window are excluded from the scan (OCR review)', async () => {
    for (let i = 0; i < 5; i++) await seedSample({ agreed: true });
    await seedSample({ agreed: false, at: new Date(Date.now() - 91 * 24 * 3600 * 1000) });
    const stats = await loadJudgeCalibrationStats(testDb());
    expect(stats.total_samples).toBe(5);
    expect(stats.headline).toMatchObject({ status: 'ok', n: 5, agreed: 5 });
  });

  it('null caused_by rows never collapse into one bucket (dedup key falls back to row id — OCR review)', async () => {
    // Structurally unexpected (the writer always anchors the judge id), and the
    // partial unique index does not constrain NULLs — the read side must not
    // let them swallow each other via a shared '' key.
    for (let i = 0; i < 5; i++) await seedSample({ agreed: true, causedBy: null });
    const stats = await loadJudgeCalibrationStats(testDb());
    expect(stats.total_samples).toBe(5);
  });

  it('carries the two honesty notes (agreement≠accuracy + same_lane 时效)', async () => {
    const stats = await loadJudgeCalibrationStats(testDb());
    const joined = stats.notes.join(' ');
    expect(joined).toContain('accuracy');
    expect(joined).toContain('采样时点');
  });
});
