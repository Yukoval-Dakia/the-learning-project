import { describe, expect, it, vi } from 'vitest';

import type { CapabilityManifest } from '@/kernel/manifest';

// Cut the DB-tainted chain (queue-config → boss/client → pg-boss) so this stays a no-DB unit: the
// mount only needs createOrUpdateQueue to be called, not to run.
vi.mock('@/server/boss/queue-config', () => ({
  createOrUpdateQueue: vi.fn(async () => undefined),
  FAST_QUEUE_OPTS: {},
  // dispatch-mount.ts builds DISPATCH_QUEUE_OPTS from these at module load (H2), so the mock must
  // export them or vitest throws "No <name> export is defined on the mock".
  JOB_RETRY_LIMIT: 2,
  JOB_RETRY_DELAY_SECONDS: 30,
}));

import { createOrUpdateQueue } from '@/server/boss/queue-config';
import { EVENT_SUBSCRIPTION_DISPATCH_QUEUE, mountSubscriptionDispatch } from './dispatch-mount';

function mockBoss() {
  return {
    work: vi.fn((..._args: unknown[]): Promise<undefined> => Promise.resolve(undefined)),
    schedule: vi.fn((..._args: unknown[]): Promise<undefined> => Promise.resolve(undefined)),
  };
}

const withSubscriber: CapabilityManifest[] = [
  { name: 'events', description: 'event owner', events: { actions: ['test:mounted'] } },
  {
    name: 'subscribers',
    description: 'subscriber owner',
    subscriptions: {
      handlers: [
        {
          id: 'test.subscriber',
          version: 1,
          actions: ['test:mounted'],
          load: async () => () => async () => ({ status: 'succeeded' as const }),
        },
      ],
    },
  },
];

describe('mountSubscriptionDispatch', () => {
  it('creates the dispatch queue, registers the worker, and schedules it when a subscription is declared', async () => {
    const boss = mockBoss();
    // biome-ignore lint/suspicious/noExplicitAny: mock PgBoss surface for the two methods the mount calls
    const mounted = await mountSubscriptionDispatch(boss as any, {} as never, withSubscriber);

    expect(mounted).toBe(true);
    expect(createOrUpdateQueue).toHaveBeenCalledWith(
      boss,
      EVENT_SUBSCRIPTION_DISPATCH_QUEUE,
      expect.anything(),
    );
    expect(boss.work).toHaveBeenCalledTimes(1);
    expect(boss.work.mock.calls[0][0]).toBe(EVENT_SUBSCRIPTION_DISPATCH_QUEUE);
    expect(boss.schedule).toHaveBeenCalledTimes(1);
    expect(boss.schedule.mock.calls[0][0]).toBe(EVENT_SUBSCRIPTION_DISPATCH_QUEUE);
  });

  it('mounts nothing (returns false) when no capability declares a subscription', async () => {
    const boss = mockBoss();
    // biome-ignore lint/suspicious/noExplicitAny: mock PgBoss surface
    const mounted = await mountSubscriptionDispatch(boss as any, {} as never, []);

    expect(mounted).toBe(false);
    expect(boss.work).not.toHaveBeenCalled();
    expect(boss.schedule).not.toHaveBeenCalled();
  });
});
