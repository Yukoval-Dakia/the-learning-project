// YUK-575 (N6/MF-C) — durable pickup-stall predicate unit test (no DB).

import { describe, expect, it } from 'vitest';

import {
  PICKUP_TIMEOUT_MS,
  getDurablePickupDeadlineMs,
  hasDurableWorkerTouch,
  isDurablePickupStalled,
} from './durable-pickup';
import { COPILOT_RUN_EVENTS } from './server/copilot-run-status';

const DEADLINE = 1_000_000;
const queued = { event_type: COPILOT_RUN_EVENTS.QUEUED, payload: { pickup_deadline_ms: DEADLINE } };

describe('isDurablePickupStalled', () => {
  it('QUEUED past deadline + worker never touched → stalled', () => {
    expect(getDurablePickupDeadlineMs([queued])).toBe(DEADLINE);
    expect(isDurablePickupStalled([queued], DEADLINE + 1)).toBe(true);
  });

  it('QUEUED but still before deadline → not stalled', () => {
    expect(isDurablePickupStalled([queued], DEADLINE)).toBe(false);
    expect(isDurablePickupStalled([queued], DEADLINE - 1)).toBe(false);
  });

  it('worker touched the run (STARTED) → never stalled, even past deadline', () => {
    expect(
      isDurablePickupStalled(
        [queued, { event_type: COPILOT_RUN_EVENTS.STARTED }],
        DEADLINE + 100_000,
      ),
    ).toBe(false);
  });

  it('a terminal FAILED counts as touched (the run ran, not a pickup stall)', () => {
    expect(
      isDurablePickupStalled(
        [queued, { event_type: COPILOT_RUN_EVENTS.FAILED, payload: { reason: 'exhausted' } }],
        DEADLINE + 100_000,
      ),
    ).toBe(false);
  });

  it('legacy FAILED(reason=error) is worker-touch evidence even though it remains retryable', () => {
    const legacyRetry = {
      event_type: COPILOT_RUN_EVENTS.FAILED,
      payload: {
        reason: 'error',
        error: 'provider reset after validating 31 of 48 answers and four of six probes',
      },
    };
    expect(hasDurableWorkerTouch([queued, legacyRetry])).toBe(true);
    expect(isDurablePickupStalled([queued, legacyRetry], DEADLINE + 100_000)).toBe(false);
  });

  it('no QUEUED event → not judged (false)', () => {
    expect(isDurablePickupStalled([{ event_type: COPILOT_RUN_EVENTS.STARTED }], DEADLINE + 1)).toBe(
      false,
    );
  });

  it('QUEUED without a numeric deadline → not judged (false)', () => {
    expect(
      isDurablePickupStalled(
        [{ event_type: COPILOT_RUN_EVENTS.QUEUED, payload: { session_id: 's' } }],
        DEADLINE + 1,
      ),
    ).toBe(false);
    expect(
      getDurablePickupDeadlineMs([
        { event_type: COPILOT_RUN_EVENTS.QUEUED, payload: { pickup_deadline_ms: Number.NaN } },
      ]),
    ).toBeUndefined();
  });

  it('PICKUP_TIMEOUT_MS is a positive constant', () => {
    expect(PICKUP_TIMEOUT_MS).toBeGreaterThan(0);
  });
});
