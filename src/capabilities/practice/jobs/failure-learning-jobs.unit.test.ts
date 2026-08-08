import { describe, expect, it, vi } from 'vitest';
import {
  ATTRIBUTION_FOLLOWUP_QUEUE,
  VARIANT_GEN_QUEUE,
  enqueueAttributionFollowup,
  enqueueVariantGen,
  failureLearningJobId,
} from './failure-learning-jobs';

describe('Failure Learning durable job identity', () => {
  it('derives stable, stage-specific pg-boss UUIDs from the attempt id', () => {
    const attemptId = 'attempt_cuid_that_is_not_a_uuid';
    const attribution = failureLearningJobId(ATTRIBUTION_FOLLOWUP_QUEUE, attemptId);
    const variant = failureLearningJobId(VARIANT_GEN_QUEUE, attemptId);

    expect(attribution).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(failureLearningJobId(ATTRIBUTION_FOLLOWUP_QUEUE, attemptId)).toBe(attribution);
    expect(variant).not.toBe(attribution);
    expect(failureLearningJobId(ATTRIBUTION_FOLLOWUP_QUEUE, 'attempt_other')).not.toBe(attribution);
  });

  it('keeps the legacy payload while pinning variant_gen to its stable id', async () => {
    const attemptId = 'attempt_variant_handoff';
    const expectedId = failureLearningJobId(VARIANT_GEN_QUEUE, attemptId);
    const send = vi.fn(async () => null);

    await expect(enqueueVariantGen(send, attemptId)).resolves.toBe(expectedId);
    expect(send).toHaveBeenCalledWith(
      VARIANT_GEN_QUEUE,
      { attempt_event_id: attemptId },
      { id: expectedId },
    );
  });

  it('supports a stable non-transactional attribution enqueue for backfill callers', async () => {
    const attemptId = 'attempt_backfill';
    const expectedId = failureLearningJobId(ATTRIBUTION_FOLLOWUP_QUEUE, attemptId);
    const send = vi.fn(async () => expectedId);

    await expect(enqueueAttributionFollowup(send, attemptId)).resolves.toBe(expectedId);
    expect(send).toHaveBeenCalledWith(
      ATTRIBUTION_FOLLOWUP_QUEUE,
      { attempt_event_id: attemptId },
      { id: expectedId },
    );
  });
});
