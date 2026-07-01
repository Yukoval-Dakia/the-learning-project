// YUK-531 (A5 S4 / RT1) — Tier-1 misconception HARD-confirm decision layer (pure).
// Covers the DISCRIMINATION gate (held-M vs 缺-skill), the isCrucial admissibility gate
// (single-point skillScorePoint reuse), the dedup/contextSpread/asymmetry counting, and the
// dark decideDissociation verdict (flag OFF ⇒ never HARD, rival missing ⇒ cap EMERGING,
// asymmetry, gate failure ⇒ INSUFFICIENT). No DB — everything here is counts / reads / enums.
import { describe, expect, it } from 'vitest';

import {
  CONTEXT_SPREAD_FLOOR,
  DELTA_SEP,
  type DissociationRecord,
  N_DEDUP_FLOOR,
  RECENCY_ACTIVE_WINDOW_MS,
  decideDissociation,
  isCrucial,
  isDiscriminatingContext,
  recencyBand,
  resolutionClass,
  summarizeDissociation,
} from '@/server/conjectures/hard-confirm';

function rec(over: Partial<DissociationRecord> = {}): DissociationRecord {
  return {
    questionId: 'q1',
    sessionWindow: '2026-07-01',
    judgeRunId: 'run1',
    contextKey: 'symbolic',
    baselineP: 0.8,
    predictedP: 0.3,
    outcome: 0,
    discriminating: true,
    mDiagnostic: true,
    resolution: 'confirmed',
    judgedAt: new Date('2026-07-01T00:00:00Z'),
    ...over,
  };
}

describe('isDiscriminatingContext — held-M vs 缺-skill', () => {
  it('is TRUE only when p(L) is high AND the response is M-diagnostic (mastery + distractor tag)', () => {
    expect(isDiscriminatingContext({ baselineP: 0.8, mDiagnostic: true })).toBe(true);
  });

  it('is FALSE for a high-mastery SLIP (p(L) high but NOT M-diagnostic — the C1-O3 trap)', () => {
    expect(isDiscriminatingContext({ baselineP: 0.9, mDiagnostic: false })).toBe(false);
  });

  it('is FALSE at low mastery (an error with no mastery in place is 缺-skill, not held-M)', () => {
    expect(isDiscriminatingContext({ baselineP: 0.2, mDiagnostic: true })).toBe(false);
  });

  it('is FALSE on a null baseline (cold start cannot confirm a HELD misconception)', () => {
    expect(isDiscriminatingContext({ baselineP: null, mDiagnostic: true })).toBe(false);
  });
});

describe('isCrucial — admissibility via single-point skillScorePoint', () => {
  it('is TRUE when discriminating, separated ≥ δ_sep, and the model beat baseline at the point', () => {
    // predicted 0.2, baseline 0.7, outcome 0 (wrong): |0.2-0.7|=0.5 ≥ δ_sep; model closer to 0.
    expect(isCrucial({ discriminating: true, predictedP: 0.2, baselineP: 0.7, outcome: 0 })).toBe(
      true,
    );
  });

  it('is FALSE when not discriminating', () => {
    expect(isCrucial({ discriminating: false, predictedP: 0.2, baselineP: 0.7, outcome: 0 })).toBe(
      false,
    );
  });

  it('is FALSE when separation < δ_sep (no proper-distractor divergence from baseline)', () => {
    const tiny = DELTA_SEP / 2;
    expect(
      isCrucial({ discriminating: true, predictedP: 0.5, baselineP: 0.5 + tiny, outcome: 0 }),
    ).toBe(false);
  });

  it('is FALSE on a null baseline (no separation to measure)', () => {
    expect(isCrucial({ discriminating: true, predictedP: 0.2, baselineP: null, outcome: 0 })).toBe(
      false,
    );
  });

  it('is FALSE when the model did NOT beat baseline at the point (skillScorePoint ≤ 0)', () => {
    // outcome 1 (correct) but predicted LOW (0.1) vs baseline HIGH (0.9): baseline was closer.
    expect(isCrucial({ discriminating: true, predictedP: 0.1, baselineP: 0.9, outcome: 1 })).toBe(
      false,
    );
  });
});

describe('summarizeDissociation — dedup / contextSpread / asymmetry', () => {
  it('collapses a self-consistency triple (same question,session,judge-run) to n_dedup=1', () => {
    const triple = [rec(), rec(), rec()]; // identical dedup tuple
    expect(summarizeDissociation(triple).nDedup).toBe(1);
  });

  it('counts distinct (question, session, judge-run) tuples independently', () => {
    const ev = summarizeDissociation([
      rec({ questionId: 'q1', judgeRunId: 'r1' }),
      rec({ questionId: 'q2', judgeRunId: 'r1' }),
      rec({ questionId: 'q2', judgeRunId: 'r1', sessionWindow: '2026-07-02' }),
    ]);
    expect(ev.nDedup).toBe(3);
  });

  it('counts contextSpread over DISCRIMINATING contexts only (bug-migration guard)', () => {
    const ev = summarizeDissociation([
      rec({ contextKey: 'symbolic' }),
      rec({ contextKey: 'real_world', questionId: 'q2' }),
      // a high-mastery slip in a THIRD context is NOT discriminating → not counted.
      rec({ contextKey: 'timed', questionId: 'q3', mDiagnostic: false }),
    ]);
    expect(ev.contextSpread).toBe(2);
    expect(ev.hasDiscriminatingContext).toBe(true);
  });

  it('resets retiredSinceLastCrucial on a fresh crucial-confirmed, then counts retired AFTER it', () => {
    const ev = summarizeDissociation([
      rec({
        questionId: 'q1',
        resolution: 'confirmed',
        judgedAt: new Date('2026-07-01T00:00:00Z'),
      }),
      rec({
        questionId: 'q2',
        resolution: 'retired',
        discriminating: false,
        judgedAt: new Date('2026-07-02T00:00:00Z'),
      }),
    ]);
    expect(ev.crucialConfirmedCount).toBe(1);
    expect(ev.retiredSinceLastCrucial).toBe(1);
  });
});

describe('decideDissociation — dark verdict', () => {
  const fullEvidence = () =>
    summarizeDissociation([
      rec({ questionId: 'q1', contextKey: 'symbolic', judgeRunId: 'r1' }),
      rec({ questionId: 'q2', contextKey: 'real_world', judgeRunId: 'r2' }),
    ]);

  it('returns HARD_CONFIRM ONLY with flag ON + rival probe + fresh owner confirm', () => {
    expect(
      decideDissociation(fullEvidence(), {
        hardConfirmEnabled: true,
        hasRivalProbe: true,
        ownerFreshlyConfirmed: true,
      }),
    ).toBe('HARD_CONFIRM');
  });

  it('flag OFF ⇒ can NEVER return HARD_CONFIRM (structural), caps at EMERGING', () => {
    expect(
      decideDissociation(fullEvidence(), {
        hardConfirmEnabled: false,
        hasRivalProbe: true,
        ownerFreshlyConfirmed: true,
      }),
    ).toBe('EMERGING');
  });

  it('no rival-separating probe ⇒ capped at EMERGING (M vs baseline, not M vs M′)', () => {
    expect(
      decideDissociation(fullEvidence(), {
        hardConfirmEnabled: true,
        hasRivalProbe: false,
        ownerFreshlyConfirmed: true,
      }),
    ).toBe('EMERGING');
  });

  it('no fresh owner confirmation ⇒ capped at EMERGING (never automatic)', () => {
    expect(
      decideDissociation(fullEvidence(), {
        hardConfirmEnabled: true,
        hasRivalProbe: true,
        ownerFreshlyConfirmed: false,
      }),
    ).toBe('EMERGING');
  });

  it('a single context (contextSpread < floor) ⇒ INSUFFICIENT (flicker, not identity)', () => {
    const oneContext = summarizeDissociation([
      rec({ questionId: 'q1', contextKey: 'symbolic', judgeRunId: 'r1' }),
      rec({ questionId: 'q2', contextKey: 'symbolic', judgeRunId: 'r2' }),
    ]);
    expect(oneContext.contextSpread).toBeLessThan(CONTEXT_SPREAD_FLOOR);
    expect(
      decideDissociation(oneContext, {
        hardConfirmEnabled: true,
        hasRivalProbe: true,
        ownerFreshlyConfirmed: true,
      }),
    ).toBe('INSUFFICIENT');
  });

  it('n_dedup below floor (noisy judge triple) ⇒ INSUFFICIENT — a single unit cannot railroad a mint', () => {
    const triple = summarizeDissociation([rec(), rec(), rec()]); // n_dedup=1
    expect(triple.nDedup).toBeLessThan(N_DEDUP_FLOOR);
    expect(
      decideDissociation(triple, {
        hardConfirmEnabled: true,
        hasRivalProbe: true,
        ownerFreshlyConfirmed: true,
      }),
    ).toBe('INSUFFICIENT');
  });

  it('a retired probe AFTER the last crucial-confirmed (asymmetry) ⇒ INSUFFICIENT', () => {
    const ev = summarizeDissociation([
      rec({
        questionId: 'q1',
        contextKey: 'symbolic',
        judgeRunId: 'r1',
        judgedAt: new Date('2026-07-01T00:00:00Z'),
      }),
      rec({
        questionId: 'q2',
        contextKey: 'real_world',
        judgeRunId: 'r2',
        judgedAt: new Date('2026-07-02T00:00:00Z'),
      }),
      rec({
        questionId: 'q3',
        contextKey: 'timed',
        judgeRunId: 'r3',
        resolution: 'retired',
        discriminating: false,
        judgedAt: new Date('2026-07-03T00:00:00Z'),
      }),
    ]);
    expect(ev.retiredSinceLastCrucial).toBeGreaterThan(0);
    expect(
      decideDissociation(ev, {
        hardConfirmEnabled: true,
        hasRivalProbe: true,
        ownerFreshlyConfirmed: true,
      }),
    ).toBe('INSUFFICIENT');
  });

  it('a pure high-mastery SLIP (never M-diagnostic) mints nothing ⇒ INSUFFICIENT', () => {
    const slips = summarizeDissociation([
      rec({ questionId: 'q1', contextKey: 'symbolic', judgeRunId: 'r1', mDiagnostic: false }),
      rec({ questionId: 'q2', contextKey: 'real_world', judgeRunId: 'r2', mDiagnostic: false }),
    ]);
    expect(slips.hasDiscriminatingContext).toBe(false);
    expect(
      decideDissociation(slips, {
        hardConfirmEnabled: true,
        hasRivalProbe: true,
        ownerFreshlyConfirmed: true,
      }),
    ).toBe('INSUFFICIENT');
  });
});

describe('recencyBand — post-promotion display projection', () => {
  const now = new Date('2026-07-22T00:00:00Z');

  it('is quiet when there is no discriminating activation', () => {
    expect(recencyBand(null, now)).toBe('quiet');
  });

  it('is active within the recency window', () => {
    const within = new Date(now.getTime() - (RECENCY_ACTIVE_WINDOW_MS - 1000));
    expect(recencyBand(within, now)).toBe('active');
  });

  it('is quiet just past the recency window', () => {
    const past = new Date(now.getTime() - (RECENCY_ACTIVE_WINDOW_MS + 1000));
    expect(recencyBand(past, now)).toBe('quiet');
  });
});

describe('resolutionClass — archive honesty (read-time, 0 columns)', () => {
  it('maps the intuitive/ontological cause `concept` to dormant (suppressed-not-deleted)', () => {
    expect(resolutionClass('concept')).toBe('dormant');
  });

  it('maps procedural causes to resolved (conservative default across all profiles)', () => {
    for (const c of [
      'knowledge_gap',
      'reading',
      'memory',
      'method',
      'calculation',
      'computation',
      'expression',
      'unit_error',
      'dimension',
      'formula',
      'grammar',
      'word_meaning',
      'carelessness',
      'time_pressure',
      'other',
    ]) {
      expect(resolutionClass(c)).toBe('resolved');
    }
  });

  it('defaults an unknown cause to the conservative resolved', () => {
    expect(resolutionClass('some_new_cause')).toBe('resolved');
  });
});
