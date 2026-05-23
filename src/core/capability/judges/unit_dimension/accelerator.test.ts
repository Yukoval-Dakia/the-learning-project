import { describe, expect, it } from 'vitest';

import { runAccelerator } from './accelerator';

describe('unit_dimension accelerator', () => {
  const reference = { value: 30, unit: 'm/s', tolerance: 0.05 };

  it('exact match', () => {
    const r = runAccelerator({ student_answer: '30 m/s', reference });
    expect(r.parsed).toBe(true);
    expect(r.value_match).toBe(true);
    expect(r.dimension_match).toBe(true);
    expect(r.unit_exact_match).toBe(true);
    expect(r.signal).toBe(null);
  });

  it('exact match remains correct with zero tolerance', () => {
    const r = runAccelerator({
      student_answer: '30 m/s',
      reference: { value: 30, unit: 'm/s', tolerance: 0 },
    });
    expect(r.value_match).toBe(true);
    expect(r.value_close).toBe(false);
    expect(r.signal).toBe(null);
  });

  it('value_match within tolerance (3% off -> correct)', () => {
    const r = runAccelerator({ student_answer: '29.1 m/s', reference });
    expect(r.value_match).toBe(true);
    expect(r.signal).toBe(null);
  });

  it('numeric_close (16.7% off in [5%, 50%) band)', () => {
    const r = runAccelerator({ student_answer: '25 m/s', reference });
    expect(r.value_match).toBe(false);
    expect(r.value_close).toBe(true);
    expect(r.signal).toBe('numeric_close');
  });

  it('numeric_off (>50% off)', () => {
    const r = runAccelerator({ student_answer: '50 m/s', reference });
    expect(r.value_match).toBe(false);
    expect(r.value_close).toBe(false);
    expect(r.signal).toBe('numeric_off');
  });

  it('unit_mismatch_same_dimension (km/h vs m/s; signal outranks value match)', () => {
    const r = runAccelerator({ student_answer: '108 km/h', reference });
    expect(r.parsed).toBe(true);
    expect(r.dimension_match).toBe(true);
    expect(r.unit_exact_match).toBe(false);
    expect(r.signal).toBe('unit_mismatch_same_dimension');
  });

  it('dimension_mismatch (m vs m/s; different dimension family)', () => {
    const r = runAccelerator({ student_answer: '30 m', reference });
    expect(r.parsed).toBe(true);
    expect(r.dimension_match).toBe(false);
    expect(r.signal).toBe('dimension_mismatch');
  });

  it('missing_unit (numeric only, no unit text)', () => {
    const r = runAccelerator({ student_answer: '30', reference });
    expect(r.parsed).toBe(false);
    expect(r.signal).toBe('missing_unit');
  });

  it('unparseable (Chinese / non-numeric -> LLM fallback)', () => {
    const r = runAccelerator({ student_answer: '忘了', reference });
    expect(r.parsed).toBe(false);
    expect(r.signal).toBe('unparseable');
  });
});
