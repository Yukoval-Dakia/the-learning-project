import type { Job } from 'pg-boss';
import { describe, expect, it, vi } from 'vitest';

const facade = vi.hoisted(() => ({ followUp: vi.fn() }));

vi.mock('@/capabilities/practice/server/failure-learning', () => ({
  createFailureLearning: () => ({ followUp: facade.followUp }),
}));

import {
  type AttributionFollowupJobData,
  buildAttributionFollowupHandler,
} from './attribution_followup';

describe('attribution_followup durable adapter', () => {
  it('ACKs a malformed truthy attempt id without calling the owner facade', async () => {
    facade.followUp.mockClear();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const handler = buildAttributionFollowupHandler({} as never, {
      runTaskFn: vi.fn(),
      enqueueVariantGen: vi.fn(),
    });
    const jobs = [
      { id: 'attribution-malformed', data: { attempt_event_id: {} } },
    ] as unknown as Job<AttributionFollowupJobData>[];

    await expect(handler(jobs)).resolves.toBeUndefined();
    expect(facade.followUp).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
