import type { Db } from '@/db/client';
import type { PgBoss } from 'pg-boss';
import { describe, expect, it, vi } from 'vitest';
import { registerHandlers } from './handlers';

describe('registerHandlers', () => {
  it('registers and schedules knowledge_maintenance_nightly', async () => {
    const boss = {
      createQueue: vi.fn(async () => undefined),
      work: vi.fn(async () => undefined),
      schedule: vi.fn(async () => undefined),
    } as unknown as PgBoss;

    await registerHandlers(boss, {} as Db);

    expect(boss.createQueue).toHaveBeenCalledWith('knowledge_maintenance_nightly');
    expect(boss.work).toHaveBeenCalledWith(
      'knowledge_maintenance_nightly',
      { pollingIntervalSeconds: 2, batchSize: 1 },
      expect.any(Function),
    );
    expect(boss.schedule).toHaveBeenCalledWith(
      'knowledge_maintenance_nightly',
      '0 3 * * *',
      {},
      { tz: 'Asia/Shanghai' },
    );
  });
});
