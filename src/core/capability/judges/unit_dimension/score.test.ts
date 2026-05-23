import { describe, expect, it } from 'vitest';

import { composeScore } from './score';

const ref = { value: 30, unit: 'm/s', tolerance: 0.05 };

describe('unit_dimension score composition', () => {
  it('correct: dim_match + unit_exact + value_match -> 1.0', () => {
    const r = composeScore({
      accelerator: {
        value_si: 30,
        unit_si: 'm/s',
        parsed: true,
        dimension_match: true,
        unit_exact_match: true,
        value_match: true,
        value_close: false,
        signal: null,
      },
      reference: ref,
      evidence: {},
    });
    expect(r.score).toBe(1.0);
    expect(r.coarse_outcome).toBe('correct');
  });

  it('numeric_close: dim_match + unit_exact + value_close -> 0.7 partial', () => {
    const r = composeScore({
      accelerator: {
        value_si: 25,
        unit_si: 'm/s',
        parsed: true,
        dimension_match: true,
        unit_exact_match: true,
        value_match: false,
        value_close: true,
        signal: 'numeric_close',
      },
      reference: ref,
      evidence: {},
    });
    expect(r.score).toBe(0.7);
    expect(r.coarse_outcome).toBe('partial');
    expect((r.evidence_json as { signal?: string }).signal).toBe('numeric_close');
  });

  it('numeric_off: dim_match + unit_exact + neither match nor close -> 0.3 partial', () => {
    const r = composeScore({
      accelerator: {
        value_si: 50,
        unit_si: 'm/s',
        parsed: true,
        dimension_match: true,
        unit_exact_match: true,
        value_match: false,
        value_close: false,
        signal: 'numeric_off',
      },
      reference: ref,
      evidence: {},
    });
    expect(r.score).toBe(0.3);
    expect(r.coarse_outcome).toBe('partial');
    expect((r.evidence_json as { signal?: string }).signal).toBe('numeric_off');
  });

  it('unit_mismatch_same_dimension: dim_match=true + unit_exact=false -> 0.4 partial', () => {
    const r = composeScore({
      accelerator: {
        value_si: 30,
        unit_si: 'm/s',
        parsed: true,
        dimension_match: true,
        unit_exact_match: false,
        value_match: true,
        value_close: false,
        signal: 'unit_mismatch_same_dimension',
      },
      reference: ref,
      evidence: {},
    });
    expect(r.score).toBe(0.4);
    expect(r.coarse_outcome).toBe('partial');
    expect((r.evidence_json as { signal?: string }).signal).toBe('unit_mismatch_same_dimension');
  });

  it('dimension_mismatch: dim_match=false -> score literal 0, incorrect', () => {
    const r = composeScore({
      accelerator: {
        value_si: 30,
        unit_si: 'm',
        parsed: true,
        dimension_match: false,
        unit_exact_match: false,
        value_match: false,
        value_close: false,
        signal: 'dimension_mismatch',
      },
      reference: ref,
      evidence: {},
    });
    expect(r.score).toBe(0);
    expect(r.coarse_outcome).toBe('incorrect');
    expect((r.evidence_json as { signal?: string }).signal).toBe('dimension_mismatch');
  });

  it('missing_unit: parsed=false, signal=missing_unit -> score literal 0, incorrect', () => {
    const r = composeScore({
      accelerator: {
        value_si: 30,
        unit_si: null,
        parsed: false,
        dimension_match: false,
        unit_exact_match: false,
        value_match: false,
        value_close: false,
        signal: 'missing_unit',
      },
      reference: ref,
      evidence: {},
    });
    expect(r.score).toBe(0);
    expect(r.coarse_outcome).toBe('incorrect');
    expect((r.evidence_json as { signal?: string }).signal).toBe('missing_unit');
  });

  it('unparseable + fallback equivalent -> 1.0 correct', () => {
    const r = composeScore({
      accelerator: {
        value_si: null,
        unit_si: null,
        parsed: false,
        dimension_match: false,
        unit_exact_match: false,
        value_match: false,
        value_close: false,
        signal: 'unparseable',
      },
      fallback: {
        student_value_si: 30,
        student_unit_si: 'm/s',
        equivalent_to_reference: true,
        parser_confidence: 0.92,
      },
      reference: ref,
      evidence: {},
    });
    expect(r.score).toBe(1.0);
    expect(r.coarse_outcome).toBe('correct');
  });

  it('fallback non-equiv + dim_mismatch_reason -> dimension_mismatch, score literal 0', () => {
    const r = composeScore({
      accelerator: {
        value_si: null,
        unit_si: null,
        parsed: false,
        dimension_match: false,
        unit_exact_match: false,
        value_match: false,
        value_close: false,
        signal: 'unparseable',
      },
      fallback: {
        student_value_si: 30,
        student_unit_si: 'm',
        equivalent_to_reference: false,
        dimension_mismatch_reason: 'length (m) vs velocity (m/s)',
        parser_confidence: 0.88,
      },
      reference: ref,
      evidence: {},
    });
    expect(r.score).toBe(0);
    expect(r.coarse_outcome).toBe('incorrect');
    expect((r.evidence_json as { signal?: string }).signal).toBe('dimension_mismatch');
  });

  it('fallback unit-matches + value within tolerance -> 1.0 correct', () => {
    const r = composeScore({
      accelerator: {
        value_si: null,
        unit_si: null,
        parsed: false,
        dimension_match: false,
        unit_exact_match: false,
        value_match: false,
        value_close: false,
        signal: 'unparseable',
      },
      fallback: {
        student_value_si: 29.5,
        student_unit_si: 'm/s',
        equivalent_to_reference: false,
        parser_confidence: 0.9,
      },
      reference: ref,
      evidence: {},
    });
    expect(r.coarse_outcome).toBe('correct');
    expect(r.score).toBeGreaterThanOrEqual(0.85);
  });

  it('fallback with reference.value === 0 uses absolute residual', () => {
    const refZero = { value: 0, unit: 'K', tolerance: 0.05 };
    const r = composeScore({
      accelerator: {
        value_si: null,
        unit_si: null,
        parsed: false,
        dimension_match: false,
        unit_exact_match: false,
        value_match: false,
        value_close: false,
        signal: 'unparseable',
      },
      fallback: {
        student_value_si: 0.01,
        student_unit_si: 'K',
        equivalent_to_reference: false,
        parser_confidence: 0.9,
      },
      reference: refZero,
      evidence: {},
    });
    expect(r.coarse_outcome).toBe('correct');
    expect(r.score).toBeGreaterThanOrEqual(0.85);
  });

  it('fallback non-equiv + no dim_reason + unit differs -> unit_mismatch 0.4', () => {
    const r = composeScore({
      accelerator: {
        value_si: null,
        unit_si: null,
        parsed: false,
        dimension_match: false,
        unit_exact_match: false,
        value_match: false,
        value_close: false,
        signal: 'unparseable',
      },
      fallback: {
        student_value_si: 50,
        student_unit_si: 'km/h',
        equivalent_to_reference: false,
        parser_confidence: 0.85,
      },
      reference: ref,
      evidence: {},
    });
    expect(r.score).toBe(0.4);
    expect((r.evidence_json as { signal?: string }).signal).toBe('unit_mismatch_same_dimension');
  });

  it('fallback non-equiv + unit matches + value 16% off -> numeric_close 0.7', () => {
    const r = composeScore({
      accelerator: {
        value_si: null,
        unit_si: null,
        parsed: false,
        dimension_match: false,
        unit_exact_match: false,
        value_match: false,
        value_close: false,
        signal: 'unparseable',
      },
      fallback: {
        student_value_si: 25,
        student_unit_si: 'm/s',
        equivalent_to_reference: false,
        parser_confidence: 0.85,
      },
      reference: ref,
      evidence: {},
    });
    expect(r.score).toBe(0.7);
    expect((r.evidence_json as { signal?: string }).signal).toBe('numeric_close');
  });

  it('fallback non-equiv + unit matches + value 67% off -> numeric_off 0.3 partial', () => {
    const r = composeScore({
      accelerator: {
        value_si: null,
        unit_si: null,
        parsed: false,
        dimension_match: false,
        unit_exact_match: false,
        value_match: false,
        value_close: false,
        signal: 'unparseable',
      },
      fallback: {
        student_value_si: 50,
        student_unit_si: 'm/s',
        equivalent_to_reference: false,
        parser_confidence: 0.82,
      },
      reference: ref,
      evidence: {},
    });
    expect(r.score).toBe(0.3);
    expect(r.coarse_outcome).toBe('partial');
    expect((r.evidence_json as { signal?: string }).signal).toBe('numeric_off');
  });

  it('unparseable + fallback also fails -> unsupported with confidence literal 0', () => {
    const r = composeScore({
      accelerator: {
        value_si: null,
        unit_si: null,
        parsed: false,
        dimension_match: false,
        unit_exact_match: false,
        value_match: false,
        value_close: false,
        signal: 'unparseable',
      },
      fallback: {
        student_value_si: null,
        student_unit_si: null,
        equivalent_to_reference: false,
        parser_confidence: 0,
      },
      reference: ref,
      evidence: {},
    });
    expect(r.coarse_outcome).toBe('unsupported');
    expect(r.score).toBeNull();
    expect(r.confidence).toBe(0);
  });

  it('unparseable + no fallback called -> unsupported with confidence literal 0', () => {
    const r = composeScore({
      accelerator: {
        value_si: null,
        unit_si: null,
        parsed: false,
        dimension_match: false,
        unit_exact_match: false,
        value_match: false,
        value_close: false,
        signal: 'unparseable',
      },
      reference: ref,
      evidence: {},
    });
    expect(r.coarse_outcome).toBe('unsupported');
    expect(r.confidence).toBe(0);
  });
});
