import { describe, expect, it } from 'vitest';
import { JudgeResultV2 } from '@/core/schema/capability';

import { unitDimensionV1Capability } from './unit_dimension';

describe('unitDimensionV1Capability', () => {
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
});
