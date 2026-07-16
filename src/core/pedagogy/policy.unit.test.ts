import { describe, expect, it } from 'vitest';
import { selectPedagogyCandidates } from './policy';

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
});
