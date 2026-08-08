import type { Job } from 'pg-boss';
import { describe, expect, it, vi } from 'vitest';

const facade = vi.hoisted(() => ({ proposeVariant: vi.fn() }));

vi.mock('@/capabilities/practice/server/failure-learning', () => ({
  createFailureLearning: () => ({ proposeVariant: facade.proposeVariant }),
}));

import { type VariantGenJobData, buildVariantGenHandler } from './variant_gen';

describe('variant_gen durable adapter', () => {
  it('ACKs a permanent invalid-output result returned by the owner facade', async () => {
    facade.proposeVariant.mockResolvedValueOnce({
      status: 'failed_permanent',
      error: new Error('invalid VariantGen output'),
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const handler = buildVariantGenHandler({} as never, {
      runTaskFn: vi.fn(),
    });
    const jobs = [
      { id: 'variant-job', data: { attempt_event_id: 'attempt-invalid-output' } },
    ] as Job<VariantGenJobData>[];

    await expect(handler(jobs)).resolves.toBeUndefined();
    expect(facade.proposeVariant).toHaveBeenCalledWith({
      attemptEventId: 'attempt-invalid-output',
    });
    log.mockRestore();
  });
});
