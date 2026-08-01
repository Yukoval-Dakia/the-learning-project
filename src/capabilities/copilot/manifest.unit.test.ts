import { describe, expect, it } from 'vitest';

import { copilotCapability } from './manifest';

describe('copilot durable job declarations (YUK-596)', () => {
  it('gives paid execution a heartbeat and mounts a singleton fast reconciliation floor', () => {
    const handlers = copilotCapability.jobs?.handlers ?? [];
    expect(handlers.find((handler) => handler.name === 'copilot_run')).toMatchObject({
      queue: 'agent',
      heartbeatSeconds: 30,
    });
    expect(handlers.find((handler) => handler.name === 'copilot_run_reconcile')).toMatchObject({
      queue: 'fast',
      schedule: {
        cron: '0-58/2 * * * *',
        tz: 'Asia/Shanghai',
        singletonKey: 'copilot_run_reconcile-sweep',
        singletonSeconds: 120,
      },
    });
  });
});
