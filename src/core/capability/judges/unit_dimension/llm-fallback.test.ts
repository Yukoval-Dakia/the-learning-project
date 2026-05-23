import { describe, expect, it } from 'vitest';

import { runLlmFallback } from './llm-fallback';

describe('unit_dimension LLM fallback', () => {
  it('parses Chinese unit "三十米每秒" -> 30 m/s', async () => {
    const captured: { kind: string; input: unknown; ctx: unknown }[] = [];
    const mockTask = async (kind: string, input: unknown, ctx: unknown) => {
      captured.push({ kind, input, ctx });
      return {
        text: JSON.stringify({
          student_value_si: 30,
          student_unit_si: 'm/s',
          equivalent_to_reference: true,
          parser_confidence: 0.95,
        }),
      };
    };
    const r = await runLlmFallback({
      student_answer: '三十米每秒',
      reference: { value: 30, unit: 'm/s' },
      runTaskFn: mockTask,
      runTaskCtx: { subjectProfile: { id: 'physics' } },
    });
    expect(captured).toHaveLength(1);
    expect(captured[0].kind).toBe('UnitDimensionFallback');
    expect(captured[0].input).toMatchObject({
      text: expect.stringContaining('三十米每秒'),
    });
    expect(captured[0].ctx).toMatchObject({ subjectProfile: { id: 'physics' } });
    expect(r.equivalent_to_reference).toBe(true);
    expect(r.student_value_si).toBe(30);
  });

  it('flags dimension mismatch', async () => {
    const mockTask = async () => ({
      text: JSON.stringify({
        student_value_si: 30,
        student_unit_si: 'm',
        equivalent_to_reference: false,
        dimension_mismatch_reason: 'length (m) vs velocity (m/s)',
        parser_confidence: 0.92,
      }),
    });
    const r = await runLlmFallback({
      student_answer: '30 米',
      reference: { value: 30, unit: 'm/s' },
      runTaskFn: mockTask,
    });
    expect(r.equivalent_to_reference).toBe(false);
    expect(r.dimension_mismatch_reason).toContain('length');
  });

  it('returns null fields when LLM cannot parse', async () => {
    const mockTask = async () => ({
      text: JSON.stringify({
        student_value_si: null,
        student_unit_si: null,
        equivalent_to_reference: false,
        parser_confidence: 0.0,
      }),
    });
    const r = await runLlmFallback({
      student_answer: '不知道',
      reference: { value: 30, unit: 'm/s' },
      runTaskFn: mockTask,
    });
    expect(r.student_value_si).toBeNull();
    expect(r.parser_confidence).toBe(0);
  });
});
