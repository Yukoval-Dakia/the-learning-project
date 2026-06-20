import { describe, expect, it } from 'vitest';
import { evaluatePlacementTermination } from './placement-termination';

// thetaSe(precision) = 1/√precision. So SE <= 0.5 ⟺ precision >= 4; SE <= 0.4 ⟺ precision >= 6.25.

describe('evaluatePlacementTermination — cap ceiling', () => {
  it('stops with reason=cap when answeredCount >= cap', () => {
    expect(evaluatePlacementTermination({ answeredCount: 8, cap: 8 })).toEqual({
      shouldStop: true,
      reason: 'cap',
    });
    expect(evaluatePlacementTermination({ answeredCount: 9, cap: 8 })).toEqual({
      shouldStop: true,
      reason: 'cap',
    });
  });

  it('continues below cap when no SE threshold is set', () => {
    expect(evaluatePlacementTermination({ answeredCount: 3, cap: 8 })).toEqual({
      shouldStop: false,
      reason: null,
    });
  });

  it('cap is the ceiling even when SE would also have converged (cap reported)', () => {
    // answeredCount === cap → cap wins regardless of convergence.
    expect(
      evaluatePlacementTermination({
        answeredCount: 8,
        cap: 8,
        perKcPrecision: [100, 100], // SE = 0.1 each, well converged
        seThreshold: 0.5,
      }),
    ).toEqual({ shouldStop: true, reason: 'cap' });
  });
});

describe('evaluatePlacementTermination — SE convergence early stop', () => {
  it('stops early with reason=se_converged when every KC SE <= threshold (below cap)', () => {
    // precision 4 → SE 0.5 (== threshold, inclusive); precision 9 → SE 0.333.
    expect(
      evaluatePlacementTermination({
        answeredCount: 3,
        cap: 8,
        perKcPrecision: [4, 9],
        seThreshold: 0.5,
      }),
    ).toEqual({ shouldStop: true, reason: 'se_converged' });
  });

  it('continues when ANY KC has not converged', () => {
    // precision 3 → SE ≈ 0.577 > 0.5 → not converged.
    expect(
      evaluatePlacementTermination({
        answeredCount: 3,
        cap: 8,
        perKcPrecision: [9, 3],
        seThreshold: 0.5,
      }),
    ).toEqual({ shouldStop: false, reason: null });
  });

  it('does NOT evaluate SE when perKcPrecision is empty (cap-only)', () => {
    expect(
      evaluatePlacementTermination({
        answeredCount: 3,
        cap: 8,
        perKcPrecision: [],
        seThreshold: 0.5,
      }),
    ).toEqual({ shouldStop: false, reason: null });
  });

  it('does NOT evaluate SE when seThreshold is null/undefined/non-positive', () => {
    const base = { answeredCount: 3, cap: 8, perKcPrecision: [100, 100] };
    expect(evaluatePlacementTermination({ ...base, seThreshold: null })).toEqual({
      shouldStop: false,
      reason: null,
    });
    expect(evaluatePlacementTermination(base)).toEqual({ shouldStop: false, reason: null });
    expect(evaluatePlacementTermination({ ...base, seThreshold: 0 })).toEqual({
      shouldStop: false,
      reason: null,
    });
  });
});

describe('evaluatePlacementTermination — input guards (fail loud)', () => {
  it('throws on cap < 1', () => {
    expect(() => evaluatePlacementTermination({ answeredCount: 0, cap: 0 })).toThrow(/cap/);
  });

  it('throws on non-integer cap', () => {
    expect(() => evaluatePlacementTermination({ answeredCount: 0, cap: 8.5 })).toThrow(/cap/);
  });

  it('throws on negative answeredCount', () => {
    expect(() => evaluatePlacementTermination({ answeredCount: -1, cap: 8 })).toThrow(
      /answeredCount/,
    );
  });

  it('throws on a negative precision entry (only when SE is evaluated)', () => {
    expect(() =>
      evaluatePlacementTermination({
        answeredCount: 2,
        cap: 8,
        perKcPrecision: [4, -1],
        seThreshold: 0.5,
      }),
    ).toThrow(/perKcPrecision/);
  });

  it('throws on an invalid entry positioned AFTER a non-converged one (no .every short-circuit bypass)', () => {
    // OCR major regression: precision 9 → SE 0.333 (converged), precision 3 → SE ≈ 0.577
    // (NOT converged → .every() would stop here), then an invalid -5. The pre-pass must
    // still visit -5 and throw rather than silently returning {shouldStop:false}.
    expect(() =>
      evaluatePlacementTermination({
        answeredCount: 2,
        cap: 8,
        perKcPrecision: [9, 3, -5],
        seThreshold: 0.5,
      }),
    ).toThrow(/perKcPrecision/);
  });
});
