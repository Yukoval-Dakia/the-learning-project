import { describe, expect, it } from 'vitest';
import {
  PEDAGOGY_METHOD_LIBRARY,
  type PedagogyStateT,
  PrecisionBand,
  ThetaBand,
} from './method-library';
import { matchesStateGuard, selectPedagogyCandidates } from './policy';

const ALL_PEDAGOGY_STATES: PedagogyStateT[] = ThetaBand.options.flatMap((theta_band) =>
  PrecisionBand.options.flatMap((precision_band) =>
    [false, true].flatMap((misconception_present) =>
      [false, true].map((kc_is_rule_based) => ({
        theta_band,
        precision_band,
        misconception_present,
        kc_is_rule_based,
      })),
    ),
  ),
);

describe('selectPedagogyCandidates', () => {
  it('keeps low-precision states inside the scaffolded candidate set', () => {
    const result = selectPedagogyCandidates({
      theta_band: 'novice',
      precision_band: 'low',
      misconception_present: false,
      kc_is_rule_based: true,
    });

    expect(result.candidate_ids).toContain('worked_example');
    expect(result.candidate_ids).toContain('completion_problem');
    expect(result.candidate_ids).not.toContain('open_problem');
    expect(result.candidate_ids).not.toContain('interleaving');
    expect(result.candidate_ids).not.toContain('reconstruction');
    expect(result.candidate_ids).not.toContain('socratic');
  });

  it('routes an evidenced misconception toward contrast/refutation, not more open practice', () => {
    const result = selectPedagogyCandidates({
      theta_band: 'developing',
      precision_band: 'medium',
      misconception_present: true,
      kc_is_rule_based: false,
    });

    expect(result.candidate_ids).toContain('contrasting_cases');
    expect(result.candidate_ids).toContain('refutation');
    expect(result.candidate_ids).not.toContain('open_problem');
    expect(result.candidate_ids).not.toContain('interleaving');
  });

  it('allows independent methods only for a precise, secure rule-based state', () => {
    const result = selectPedagogyCandidates({
      theta_band: 'secure',
      precision_band: 'high',
      misconception_present: false,
      kc_is_rule_based: true,
    });

    expect(result.candidate_ids).toEqual([
      'open_problem',
      'interleaving',
      'reconstruction',
      'socratic',
    ]);
  });

  it('does not restore worked examples for a secure but low-precision state', () => {
    const result = selectPedagogyCandidates({
      theta_band: 'secure',
      precision_band: 'low',
      misconception_present: false,
      kc_is_rule_based: true,
    });

    expect(result.candidate_ids).toContain('completion_problem');
    expect(result.candidate_ids).not.toContain('worked_example');
    expect(result.excluded).toContainEqual({
      method_id: 'worked_example',
      reason: 'contraindicated',
    });
  });

  it('is deterministic and rejects state keys outside the four allowed signals', () => {
    const state = {
      theta_band: 'developing' as const,
      precision_band: 'medium' as const,
      misconception_present: false,
      kc_is_rule_based: false,
    };

    expect(selectPedagogyCandidates(state)).toEqual(selectPedagogyCandidates(state));
    expect(() =>
      selectPedagogyCandidates({ ...state, learning_style: 'visual' } as never),
    ).toThrow();
  });

  it('keeps every contraindication reachable from an indicated state', () => {
    for (const method of PEDAGOGY_METHOD_LIBRARY) {
      for (const contraindication of method.contraindicated_when) {
        const isOperational = ALL_PEDAGOGY_STATES.some(
          (state) =>
            method.indicated_when.some((indication) => matchesStateGuard(state, indication)) &&
            matchesStateGuard(state, contraindication),
        );

        expect(isOperational, `${method.id}: ${JSON.stringify(contraindication)}`).toBe(true);
      }
    }
  });
});
