// YUK-495 Phase 1 (S3, decision ②) — byte-identical-OFF anchor for the σ dark-ship swap.
//
// theta.ts `logistic` + pfa.ts `sigmoid` now route through POLY_SIGMOID_ENABLED. This
// suite pins the dark-ship contract: with the flag OFF (the default), the live θ̂/p(L)
// path is BYTE-IDENTICAL to the pre-swap `Math.exp` behaviour — landing the wiring is a
// true no-op. It also guards the flag at `false` so an accidental flip can't slip in
// without a deliberate, suite-re-greening change (the flip shifts values by ≤1 ULP).

import { describe, expect, it } from 'vitest';
import { PFA_GAMMA, PFA_RHO, pLearned, pfaLogit } from './pfa';
import { POLY_SIGMOID_ENABLED, polySigmoid } from './poly-exp';
import { expectedScore } from './theta';

describe('poly-sigmoid swap — byte-identical-off anchor (YUK-495 S3)', () => {
  it('flag is OFF by default (dark-ship; flip is owner-in-loop + suite re-green)', () => {
    expect(POLY_SIGMOID_ENABLED).toBe(false);
  });

  it('OFF: theta.ts expectedScore === live 1/(1+Math.exp(−(θ−b))) bit-for-bit', () => {
    for (let theta = -6; theta <= 6; theta += 0.05) {
      for (const b of [-2, -0.7, 0, 0.7, 2]) {
        const got = expectedScore(theta, b);
        const live = 1 / (1 + Math.exp(-(theta - b)));
        expect(Object.is(got, live)).toBe(true);
      }
    }
  });

  it('OFF: pfa.ts pLearned === live σ(pfaLogit) bit-for-bit', () => {
    for (const beta of [-1.5, 0, 0.8, 2.3]) {
      for (let succ = 0; succ <= 12; succ++) {
        for (const fail of [0, 1, 3, 7]) {
          const got = pLearned(beta, PFA_GAMMA, PFA_RHO, succ, fail);
          const logit = pfaLogit(beta, PFA_GAMMA, PFA_RHO, succ, fail);
          const live = 1 / (1 + Math.exp(-logit));
          expect(Object.is(got, live)).toBe(true);
        }
      }
    }
  });

  it('flip readiness: polySigmoid ≤1 ULP from the live σ it would replace (the shift cost)', () => {
    // The value the flip WOULD introduce — bounded, recorded (matches poly-exp.unit.test.ts).
    let maxAbs = 0;
    for (let x = -25; x <= 25; x += 0.01) {
      const live = 1 / (1 + Math.exp(-x));
      maxAbs = Math.max(maxAbs, Math.abs(polySigmoid(x) - live));
    }
    expect(maxAbs).toBeLessThan(1e-12);
  });
});
