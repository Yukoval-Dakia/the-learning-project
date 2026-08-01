import { describe, expect, it } from 'vitest';

import { physicsProfile } from '@/subjects/physics/profile';
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
      runTaskCtx: { subjectProfile: physicsProfile },
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

  it('parses a fenced JSON object from the fallback model', async () => {
    const mockTask = async () => ({
      text: `Here is the result:
\`\`\`json
{
  "student_value_si": 30,
  "student_unit_si": "m/s",
  "equivalent_to_reference": true,
  "parser_confidence": 0.95
}
\`\`\``,
    });
    const r = await runLlmFallback({
      student_answer: '三十米每秒',
      reference: { value: 30, unit: 'm/s' },
      runTaskFn: mockTask,
    });
    expect(r.equivalent_to_reference).toBe(true);
    expect(r.student_value_si).toBe(30);
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

  it('prefers structured output for a compound SI-unit answer and ignores conflicting text', async () => {
    const structured = {
      student_value_si: 2500,
      student_unit_si: 'kg*m^2/s^3',
      equivalent_to_reference: true,
      parser_confidence: 0.97,
    };
    const r = await runLlmFallback({
      student_answer: '2.50 千瓦（即 2.50×10³ kg·m²·s⁻³）',
      reference: { value: 2500, unit: 'W' },
      question_context_md:
        '一台提升机在 20.0 s 内把重物做功 5.00×10⁴ J，求平均功率并写成 SI 基本单位。',
      runTaskFn: async () => ({
        text: JSON.stringify({
          student_value_si: null,
          student_unit_si: null,
          equivalent_to_reference: false,
          dimension_mismatch_reason: 'conflicting text must not win',
          parser_confidence: 0.1,
        }),
        structured_output: structured,
      }),
      runTaskCtx: { subjectProfile: physicsProfile },
    });

    expect(r).toEqual(structured);
  });

  it('rejects a present schema-invalid structured value instead of hiding it with valid text', async () => {
    const validText = {
      student_value_si: 2500,
      student_unit_si: 'W',
      equivalent_to_reference: true,
      parser_confidence: 0.95,
    };

    await expect(
      runLlmFallback({
        student_answer: '2.50 千瓦',
        reference: { value: 2500, unit: 'W' },
        runTaskFn: async () => ({
          text: JSON.stringify(validText),
          structured_output: {
            ...validText,
            student_value_si: '2500',
            equivalent_to_reference: 'yes',
            parser_confidence: 3,
          },
        }),
      }),
    ).rejects.toThrow();
  });

  it('keeps null/absent endpoint fallback byte-equivalent to structured dispatch', async () => {
    const parsed = {
      student_value_si: 0.03,
      student_unit_si: 'm/s',
      equivalent_to_reference: true,
      parser_confidence: 0.89,
    };
    const base = {
      student_answer: '每小时一百零八米',
      reference: { value: 0.03, unit: 'm/s' },
      question_context_md: '滴定泵匀速输送液体，要求把中文速度换算成 SI 单位。',
    };
    const structured = await runLlmFallback({
      ...base,
      runTaskFn: async () => ({ text: 'ignored', structured_output: parsed }),
    });
    const nullFallback = await runLlmFallback({
      ...base,
      runTaskFn: async () => ({
        text: `模型说明：\n\`\`\`json\n${JSON.stringify(parsed)}\n\`\`\``,
        structured_output: null,
      }),
    });
    const undefinedFallback = await runLlmFallback({
      ...base,
      runTaskFn: async () => ({ text: JSON.stringify(parsed), structured_output: undefined }),
    });

    expect(nullFallback).toEqual(structured);
    expect(undefinedFallback).toEqual(structured);
  });
});
