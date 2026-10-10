import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { replaceConfigSnapshot } from '@/core/config/store';
import { system_config, system_config_epoch, system_config_journal } from '@/db/schema';
import { setConfigs } from '@/server/config/write';
import { resetDb, testDb } from '../helpers/db';

beforeEach(resetDb);
afterEach(() => {
  replaceConfigSnapshot({ epoch: 0, entries: new Map(), hydratedAt: '' });
  vi.unstubAllEnvs();
});

async function expectNoWrites() {
  expect(await testDb().select().from(system_config)).toEqual([]);
  expect(await testDb().select().from(system_config_journal)).toEqual([]);
  expect(await testDb().select().from(system_config_epoch)).toEqual([]);
}

describe('configuration write boundaries', () => {
  it('rejects duplicate keys without adding ambiguous journal revisions', async () => {
    await expect(
      setConfigs(
        [
          { key: 'AI_RATE_LIMIT_MAX', value: 35 },
          { key: 'AI_RATE_LIMIT_MAX', value: 41 },
        ],
        { actor: 'cli' },
        testDb(),
      ),
    ).rejects.toMatchObject({ status: 400 });
    await expectNoWrites();
  });
  it.each([
    ['lane.verify_solve.model', 'gpt-6-astra'],
    ['JUDGE_CALIBRATION_REJUDGE_MODEL', 'mimo-v2.5'],
  ])('rejects model-only %s against its actual default provider atomically', async (key, value) => {
    await expect(
      setConfigs(
        [
          { key: 'locale.learner', value: 'en' },
          { key, value },
        ],
        { actor: 'cli' },
        testDb(),
      ),
    ).rejects.toMatchObject({ status: 422 });
    await expectNoWrites();
  });
});
