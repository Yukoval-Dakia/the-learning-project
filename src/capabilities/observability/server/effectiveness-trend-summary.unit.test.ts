// YUK-519 (A7) — 纯趋势数学 unit 测试（no-DB 车道，约定 glob src/capabilities/**/*.unit.test.ts）。
//
// 重点覆盖**置信阶梯**（low/medium/high）——它是 ⑥硬约束「别把噪声画成确定上升」的执行机制，
// 是契约里安全关键的一半。direction 已被 db.test 的集成测覆盖；这里专测 confidence 的每一档
// + 边界分支（n=MIN 边界、奇数 n 跳中点）+ subject-rollup 置信。
import { describe, expect, it } from 'vitest';
import {
  type EffectivenessTrendPoint,
  type EffectivenessTrendSummary,
  FIRM_TREND_EVIDENCE,
  MIN_EVENTS_FOR_TREND,
  rollupSubjectDirection,
  summarizeTrend,
} from './effectiveness-trend-summary';

// 只 theta_hat 影响趋势（at/p_learned/theta_delta 对 summarizeTrend 无关）。
function pts(thetas: Array<number | null>): EffectivenessTrendPoint[] {
  return thetas.map((th, i) => ({
    at: new Date(2026, 5, 28, 8, 0, i).toISOString(),
    p_learned: null,
    theta_hat: th,
    theta_delta: null,
  }));
}

function summary(
  direction: EffectivenessTrendSummary['direction'],
  hasSignal = true,
): EffectivenessTrendSummary {
  return { direction, confidence: 'medium', span_evidence: 8, has_mastery_signal: hasSignal };
}

describe('summarizeTrend — direction', () => {
  it('insufficient below MIN_EVENTS_FOR_TREND usable points', () => {
    const t = summarizeTrend(pts([0.0, 0.2, 0.4])); // n=3 < 4
    expect(t.direction).toBe('insufficient');
    expect(t.confidence).toBe('low');
    expect(t.has_mastery_signal).toBe(false);
    expect(t.span_evidence).toBe(3);
  });

  it('null theta_hat points are excluded from span (degenerate KC → insufficient)', () => {
    const t = summarizeTrend(pts([null, null, null, null, null, null]));
    expect(t.direction).toBe('insufficient');
    expect(t.span_evidence).toBe(0);
    expect(t.has_mastery_signal).toBe(false);
  });

  it('n == MIN_EVENTS_FOR_TREND is the inclusive boundary (asserts a real direction, not insufficient)', () => {
    expect(MIN_EVENTS_FOR_TREND).toBe(4);
    const t = summarizeTrend(pts([0.0, 0.2, 0.6, 0.8])); // n=4, clear rise
    expect(t.direction).toBe('rising');
    expect(t.span_evidence).toBe(4);
  });

  it('odd n skips the midpoint from both early/near windows', () => {
    // ends rise (0,0 → 1,1) but the skipped midpoint is a huge negative outlier; if it
    // leaked into the near window the verdict would flip to falling. Asserting rising
    // proves the midpoint is excluded from the window means (it still counts in span).
    const t = summarizeTrend(pts([0.0, 0.0, -10.0, 1.0, 1.0]));
    expect(t.direction).toBe('rising');
    expect(t.span_evidence).toBe(5);
  });
});

describe('summarizeTrend — confidence ladder (⑥硬约束 safety-critical)', () => {
  it('LOW: weak rising signal — drift just over the band but ratio < EFFECT_RATIO_MEDIUM', () => {
    // big ±1 oscillation (sd≈1) with a tiny net early→near rise (~0.15) → ratio ≈ 0.15 < 0.5.
    const t = summarizeTrend(pts([-1, 1, -1, 1, -1, 1, -1, 1.6]));
    expect(t.direction).toBe('rising');
    expect(t.confidence).toBe('low');
  });

  it('LOW: weak falling signal mirrors rising (falling also runs the ladder)', () => {
    const t = summarizeTrend(pts([1, -1, 1, -1, 1, -1, 1, -1.6]));
    expect(t.direction).toBe('falling');
    expect(t.confidence).toBe('low');
  });

  it('MEDIUM: clear rise but sample below FIRM_TREND_EVIDENCE caps confidence at medium', () => {
    expect(FIRM_TREND_EVIDENCE).toBe(8);
    // n=4 (< firm), strong monotone rise → ratio high, but cannot be `high` (needs n≥8).
    const t = summarizeTrend(pts([0.0, 0.2, 0.6, 0.8]));
    expect(t.direction).toBe('rising');
    expect(t.confidence).toBe('medium');
    expect(t.span_evidence).toBe(4);
  });

  it('MEDIUM: enough samples but only a moderate signal-to-noise ratio', () => {
    // n=8 rising, ratio in [0.5, 1.0): net rise ~0.475 against sd ~0.65 → ratio ~0.73.
    const t = summarizeTrend(pts([-0.2, 0.6, -0.1, 0.5, 0.2, 0.8, 0.1, 0.7]));
    expect(t.direction).toBe('rising');
    expect(t.confidence).toBe('medium');
  });

  it('HIGH: strong monotone rise with n ≥ FIRM_TREND_EVIDENCE and ratio ≥ EFFECT_RATIO_HIGH', () => {
    const t = summarizeTrend(pts([-0.4, -0.2, 0.0, 0.3, 0.6, 0.9, 1.2, 1.5]));
    expect(t.direction).toBe('rising');
    expect(t.confidence).toBe('high');
    expect(t.span_evidence).toBe(8);
  });

  it('holding confidence is sample-driven: medium below firm, high at/above firm', () => {
    // flat within the holding band; not enough evidence → medium, enough → high.
    const flatShort = summarizeTrend(pts(Array(MIN_EVENTS_FOR_TREND).fill(0.42)));
    expect(flatShort.direction).toBe('holding');
    expect(flatShort.confidence).toBe('medium');

    const flatFirm = summarizeTrend(pts(Array(FIRM_TREND_EVIDENCE).fill(0.42)));
    expect(flatFirm.direction).toBe('holding');
    expect(flatFirm.confidence).toBe('high');
  });
});

describe('rollupSubjectDirection — dominant direction + agreement-driven confidence', () => {
  it('insufficient/low when no KC carries a credible mastery signal', () => {
    const r = rollupSubjectDirection([
      summary('insufficient', false),
      summary('insufficient', false),
    ]);
    expect(r.direction).toBe('insufficient');
    expect(r.confidence).toBe('low');
  });

  it('non-credible (has_mastery_signal=false) KCs are excluded from the rollup', () => {
    // 3 credible rising + 2 degenerate → dominant rising, agreement computed over credible only.
    const r = rollupSubjectDirection([
      summary('rising'),
      summary('rising'),
      summary('rising'),
      summary('falling', false),
      summary('holding', false),
    ]);
    expect(r.direction).toBe('rising');
  });

  it('HIGH: ≥ MIN_EVENTS_FOR_TREND credible KCs all agreeing on direction', () => {
    const r = rollupSubjectDirection([
      summary('rising'),
      summary('rising'),
      summary('rising'),
      summary('rising'),
    ]);
    expect(r.direction).toBe('rising');
    expect(r.confidence).toBe('high');
  });

  it('MEDIUM: unanimous direction but fewer than MIN_EVENTS_FOR_TREND credible KCs', () => {
    // 3 credible all rising → agree 1.0 but credible (3) < floor (4) → capped at medium.
    const r = rollupSubjectDirection([summary('rising'), summary('rising'), summary('rising')]);
    expect(r.direction).toBe('rising');
    expect(r.confidence).toBe('medium');
  });

  it('MEDIUM: dominant direction at exactly half agreement', () => {
    // 4 credible: 2 rising, 1 holding, 1 falling → dominant rising, agree 0.5 → medium.
    const r = rollupSubjectDirection([
      summary('rising'),
      summary('rising'),
      summary('holding'),
      summary('falling'),
    ]);
    expect(r.direction).toBe('rising');
    expect(r.confidence).toBe('medium');
  });

  it('LOW: dominant direction holds less than half the credible KCs', () => {
    // 3 credible, one each rising/holding/falling → dominant share 1/3 < 0.5 → low.
    const r = rollupSubjectDirection([summary('rising'), summary('holding'), summary('falling')]);
    expect(r.confidence).toBe('low');
  });

  it('deterministic tiebreak prefers rising > holding > falling on equal counts', () => {
    const r = rollupSubjectDirection([summary('falling'), summary('rising')]);
    expect(r.direction).toBe('rising');
  });
});
