import type { Job } from 'pg-boss';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const facade = vi.hoisted(() => ({ proposeVariant: vi.fn() }));

vi.mock('@/capabilities/practice/server/failure-learning', () => ({
  createFailureLearning: () => ({ proposeVariant: facade.proposeVariant }),
}));

// The durable adapter resolves the effective verdict (YUK-1054) before calling the
// facade — unit boundary, so mock the resolver to a non-overturned verdict.
const verdicts = vi.hoisted(() => ({ resolve: vi.fn() }));

vi.mock('@/kernel/read-models/assessment-verdict', () => ({
  resolveVerdictForAttempt: verdicts.resolve,
}));

import { type VariantGenJobData, buildVariantGenHandler } from './variant_gen';

const effectiveVerdict = {
  attempt_event_id: '',
  embedded: null,
  original: null,
  effective: null,
  newest_raw: null,
} as const;

beforeEach(() => {
  verdicts.resolve.mockResolvedValue(effectiveVerdict);
});

describe('variant_gen durable adapter', () => {
  it('ACKs a malformed truthy attempt id without calling the owner facade', async () => {
    facade.proposeVariant.mockClear();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const handler = buildVariantGenHandler({} as never, { runTaskFn: vi.fn() });
    const jobs = [
      { id: 'variant-malformed', data: { attempt_event_id: 42 } },
    ] as unknown as Job<VariantGenJobData>[];

    await expect(handler(jobs)).resolves.toBeUndefined();
    expect(facade.proposeVariant).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('ACKs a permanent invalid-output result returned by the owner facade', async () => {
    facade.proposeVariant.mockResolvedValueOnce({
      status: 'failed:invalid_model_output',
      reason: 'invalid VariantGen output',
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
