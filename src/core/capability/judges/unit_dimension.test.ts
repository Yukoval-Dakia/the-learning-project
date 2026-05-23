import { JudgeResultV2 } from '@/core/schema/capability';
import { describe, expect, it } from 'vitest';
import { unitDimensionV1Capability } from './unit_dimension';

describe('unitDimensionV1Capability', () => {
  it('has the P1 skeleton manifest', () => {
    expect(unitDimensionV1Capability.manifest).toMatchObject({
      id: 'unit_dimension',
      version: '1.0.0',
      kind: 'judge',
      cost_class: 'local',
      latency_class: 'sync',
      stability: 'experimental',
    });
  });

  it('returns a valid unsupported JudgeResultV2 skeleton response', () => {
    const result = unitDimensionV1Capability.run({
      question: {
        prompt_md: '将 30 km/h 换算为 m/s',
        reference_md: '8.33 m/s',
      },
      answer: { content: '30 km/h' },
    });

    expect(result.coarse_outcome).toBe('unsupported');
    expect(result.score).toBeNull();
    expect(result.score_meaning).toBe('unit_dimension_v1');
    expect(result.capability_ref).toEqual({ id: 'unit_dimension', version: '1.0.0' });
    expect(result.feedback_md).toContain('unit_dimension@1');
    expect(JudgeResultV2.safeParse(result).success).toBe(true);
  });
});
