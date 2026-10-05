// YUK-1046 — 身份与 CAS 语义的 schema 契约测试（grounding §4.3/§11）。

import { describe, expect, it } from 'vitest';

import { ActivateEvaluationIntent, EvaluationEffectiveHead, resolveActivationCas } from './ids';

describe('EvaluationEffectiveHead', () => {
  it('initial head is null effective id + generation 0 (not omitted fields)', () => {
    const head = EvaluationEffectiveHead.parse({
      evaluation_group_id: 'eg_1',
      submission_id: 'sub_1',
      effective_evaluation_id: null,
      generation: 0,
    });
    expect(head.effective_evaluation_id).toBeNull();
    expect(head.generation).toBe(0);
  });

  it('rejects omission of effective_evaluation_id — absence is not "no effective yet"', () => {
    expect(() =>
      EvaluationEffectiveHead.parse({
        evaluation_group_id: 'eg_1',
        submission_id: 'sub_1',
        generation: 0,
      }),
    ).toThrow();
  });

  it('rejects empty-string ids (min(1) — opaque ids are never blank)', () => {
    expect(() =>
      EvaluationEffectiveHead.parse({
        evaluation_group_id: '',
        submission_id: 'sub_1',
        effective_evaluation_id: null,
        generation: 0,
      }),
    ).toThrow();
  });
});

describe('ActivateEvaluationIntent — REQUIRED null-or-id CAS precondition', () => {
  it('accepts null expected_effective_id for first activation', () => {
    const intent = ActivateEvaluationIntent.parse({
      evaluation_id: 'ev_9',
      expected_effective_id: null,
      expected_generation: 0,
    });
    expect(intent.expected_effective_id).toBeNull();
  });

  it('rejects omission — omitting must not mean "overwrite whatever is there"', () => {
    expect(() =>
      ActivateEvaluationIntent.parse({
        evaluation_id: 'ev_9',
        expected_generation: 0,
      }),
    ).toThrow(/expected_effective_id/i);
  });

  it('rejects omission of expected_generation (ABA guard is not optional)', () => {
    expect(() =>
      ActivateEvaluationIntent.parse({
        evaluation_id: 'ev_9',
        expected_effective_id: null,
      }),
    ).toThrow(/expected_generation/i);
  });
});

describe('resolveActivationCas', () => {
  const head = (effective: string | null, generation: number) => ({
    evaluation_group_id: 'eg_1',
    submission_id: 'sub_1',
    effective_evaluation_id: effective,
    generation,
  });
  const intent = (evaluationId: string, expected: string | null, generation: number) => ({
    evaluation_id: evaluationId,
    expected_effective_id: expected,
    expected_generation: generation,
  });

  it('first activation against null head passes', () => {
    expect(resolveActivationCas(head(null, 0), intent('ev_1', null, 0))).toEqual({ ok: true });
  });

  it('replacement against the exact prior effective id + generation passes', () => {
    expect(resolveActivationCas(head('ev_1', 3), intent('ev_2', 'ev_1', 3))).toEqual({ ok: true });
  });

  it('stale expectation (head moved past the expected old id) conflicts', () => {
    const outcome = resolveActivationCas(head('ev_2', 4), intent('ev_3', 'ev_1', 4));
    expect(outcome).toEqual({ ok: false, conflict: 'stale_head' });
  });

  it('null expectation against an already-effective head conflicts (not silent overwrite)', () => {
    const outcome = resolveActivationCas(head('ev_1', 2), intent('ev_2', null, 2));
    expect(outcome).toEqual({ ok: false, conflict: 'stale_head' });
  });

  it('generation mismatch conflicts even when the expected id matches (ABA)', () => {
    const outcome = resolveActivationCas(head('ev_1', 5), intent('ev_2', 'ev_1', 4));
    expect(outcome).toEqual({ ok: false, conflict: 'generation_mismatch' });
  });

  it('re-activating the already-effective evaluation is an explicit branch, not ok', () => {
    const outcome = resolveActivationCas(head('ev_1', 2), intent('ev_1', 'ev_1', 2));
    expect(outcome).toEqual({ ok: false, conflict: 'already_effective' });
  });
});
