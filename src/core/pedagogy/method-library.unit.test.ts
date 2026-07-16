import { describe, expect, it } from 'vitest';
import { PEDAGOGY_METHOD_LIBRARY, PedagogyMethodId, StateGuard } from './method-library';

describe('pedagogy method library', () => {
  it('contains the closed eight-method palette exactly once', () => {
    const ids = PEDAGOGY_METHOD_LIBRARY.map((method) => method.id);

    expect(ids).toEqual(PedagogyMethodId.options);
    expect(new Set(ids).size).toBe(8);
  });

  it('gives every method evidence and state-only indication guards', () => {
    for (const method of PEDAGOGY_METHOD_LIBRARY) {
      expect(method.evidence_refs.length).toBeGreaterThan(0);
      expect(method.indicated_when.length).toBeGreaterThan(0);
      for (const guard of [...method.indicated_when, ...method.contraindicated_when]) {
        expect(StateGuard.parse(guard)).toEqual(guard);
      }
    }
  });

  it('rejects learner-style labels at the runtime guard boundary', () => {
    expect(
      StateGuard.safeParse({
        theta_band: ['novice'],
        learning_style: ['visual'],
      }).success,
    ).toBe(false);
  });
});
