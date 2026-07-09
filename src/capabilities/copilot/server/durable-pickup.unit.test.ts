// YUK-575 (N6/MF-C) — durable pickup-stall predicate unit test (no DB).

import { describe, expect, it } from 'vitest';

import { COPILOT_RUN_EVENTS } from './copilot-run-status';
import { PICKUP_TIMEOUT_MS, isDurablePickupStalled } from './durable-pickup';

const DEADLINE = 1_000_000;
const queued = { event_type: COPILOT_RUN_EVENTS.QUEUED, payload: { pickup_deadline_ms: DEADLINE } };

describe('isDurablePickupStalled', () => {
  it('QUEUED past deadline + worker never touched → stalled', () => {
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
  });

  it('PICKUP_TIMEOUT_MS is a positive constant', () => {
    expect(PICKUP_TIMEOUT_MS).toBeGreaterThan(0);
  });
});
