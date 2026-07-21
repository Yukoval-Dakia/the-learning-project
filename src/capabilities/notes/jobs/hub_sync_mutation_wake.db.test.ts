// YUK-384 P2-b — the FULL immediate wake producer must deliver even at APP-process cold
// start. wakeHubSyncAfterCommit uses getStartedBoss() (the app enqueue path that starts/
// reuses a send-capable boss), NOT a getRunningBoss() peek (null until some getStartedBoss
// path has run → silent no-op → wake never delivered, degrading FULL mode to minute
// recovery). `@/server/boss/client` is mocked so no real pg-boss/DB is touched; the module
// under test still imports db-tainted reconciliation, so this lives in the db partition.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const send = vi.fn(async (_queue: string, _data: unknown, _options?: unknown) => 'job-id');
const fakeBoss = { send } as unknown as import('pg-boss').PgBoss;
const getStartedBoss = vi.fn(async () => fakeBoss);
const getRunningBoss = vi.fn<() => import('pg-boss').PgBoss | null>(() => null);

vi.mock('@/server/boss/client', () => ({
  getStartedBoss: () => getStartedBoss(),
  getRunningBoss: () => getRunningBoss(),
}));

import { wakeHubSyncAfterCommit } from './hub_auto_sync_nightly';

describe('wakeHubSyncAfterCommit (YUK-384 FULL wake — app-process enqueue path)', () => {
  beforeEach(() => {
    send.mockClear();
    getStartedBoss.mockClear();
    getRunningBoss.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('delivers the wake via getStartedBoss (app enqueue path), not a getRunningBoss peek that no-ops at cold start', async () => {
    await wakeHubSyncAfterCommit();

    // Post-fix: routes through getStartedBoss (starts/reuses a send-capable boss) and sends.
    // Pre-fix (getRunningBoss peek, null at cold start): would never call send.
    expect(getStartedBoss).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    // Coalesced single wake to the mutation-wake queue with a singleton key.
    const [queue, , options] = send.mock.calls[0];
    expect(String(queue)).toContain('hub_sync');
    expect(options).toMatchObject({ singletonKey: expect.any(String) });
  });
});
