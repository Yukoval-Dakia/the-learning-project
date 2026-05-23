import { JudgeResultV2 } from '@/core/schema/capability';
import { describe, expect, it } from 'vitest';

import { runUnitDimensionJudge, unitDimensionV1Capability } from './unit_dimension';

describe('unitDimensionV1Capability', () => {
  it('has the P2 real-runner manifest', () => {
    expect(unitDimensionV1Capability.manifest).toMatchObject({
      id: 'unit_dimension',
      version: '1.0.0',
      kind: 'judge',
      cost_class: 'local',
      latency_class: 'async',
      stability: 'experimental',
    });
  });

  it('exact correct via accelerator', async () => {
    const result = await unitDimensionV1Capability.run({
      question: { metadata: { reference_value: 30, reference_unit: 'm/s' } },
      answer: { content: '30 m/s' },
    });

    expect(result.score).toBe(1.0);
    expect(result.coarse_outcome).toBe('correct');
    expect(result.score_meaning).toBe('unit_dimension_v1');
    expect(result.capability_ref).toEqual({ id: 'unit_dimension', version: '1.0.0' });
    expect(JudgeResultV2.safeParse(result).success).toBe(true);
  });

  it('returns unsupported when reference metadata is missing', async () => {
    const result = await unitDimensionV1Capability.run({
      question: {
        prompt_md: '将 30 km/h 换算为 m/s',
        reference_md: '8.33 m/s',
      },
      answer: { content: '30 km/h' },
    });

    expect(result.coarse_outcome).toBe('unsupported');
    expect(result.score).toBeNull();
    expect(result.confidence).toBe(0);
    expect(result.feedback_md).toContain('reference_value/reference_unit');
    expect(JudgeResultV2.safeParse(result).success).toBe(true);
  });

  it('LLM fallback is called when accelerator is unparseable', async () => {
    let llmCalled = false;
    const result = await runUnitDimensionJudge(
      {
        question: {
          prompt_md: '速度是多少？',
          metadata: { reference_value: 30, reference_unit: 'm/s' },
        },
        answer: { content: '三十米每秒' },
      },
      {
        runTaskFn: async () => {
          llmCalled = true;
          return {
            text: JSON.stringify({
              student_value_si: 30,
              student_unit_si: 'm/s',
              equivalent_to_reference: true,
              parser_confidence: 0.95,
            }),
          };
        },
      },
    );

    expect(llmCalled).toBe(true);
    expect(result.coarse_outcome).toBe('correct');
    expect(result.score).toBe(1.0);
    expect(JudgeResultV2.safeParse(result).success).toBe(true);
  });
});
