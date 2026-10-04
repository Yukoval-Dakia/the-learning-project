import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tasks } from '@/ai/registry';
import { resolveTaskBudget } from '@/ai/task-budget';
import { getConfig, replaceConfigSnapshot } from '@/core/config/store';
import { system_config, system_config_epoch, system_config_journal } from '@/db/schema';
import { STUCK_RUN_THRESHOLD_MS } from '@/server/boss/handlers/ai_task_run_reconcile';
import { hydrateConfigFromDb } from '@/server/config/hydrate';
import { clearConfig, setConfig, setConfigs } from '@/server/config/write';
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
  it.each([STUCK_RUN_THRESHOLD_MS, STUCK_RUN_THRESHOLD_MS * 2])(
    'rejects timeout %s before it can outlive stuck-run reconciliation',
    async (timeout) => {
      await expect(
        setConfig('task.QuizGenTask.budget', { timeout }, { actor: 'cli' }, testDb()),
      ).rejects.toMatchObject({ status: 422 });
      await expectNoWrites();
    },
  );

  it('skips persisted oversized budgets while hydrating other valid configuration', async () => {
    await testDb()
      .insert(system_config)
      .values([
        {
          key: 'task.QuizGenTask.budget',
          value: { timeout: 7_200_000 },
          updated_by: 'cli',
          created_at: new Date(),
          updated_at: new Date(),
        },
        {
          key: 'AI_RATE_LIMIT_MAX',
          value: 41,
          updated_by: 'cli',
          created_at: new Date(),
          updated_at: new Date(),
        },
      ]);
    const report = await hydrateConfigFromDb(testDb());
    expect(report.skipped).toContainEqual({
      key: 'task.QuizGenTask.budget',
      reason: 'schema parse failed',
    });
    expect(resolveTaskBudget('QuizGenTask').timeout).toBe(tasks.QuizGenTask.budget.timeout);
    expect(getConfig('AI_RATE_LIMIT_MAX', {})).toBe(41);
  });

  it.each([
    'task.MissingTask.budget',
    'task.constructor.model',
    'lane.missing.provider',
    'lane.global.budget',
    'constructor',
    'toString',
  ])('rejects unknown or unwired key %s on both set and reset', async (key) => {
    const value = key.endsWith('.budget') ? { timeout: 1000 } : 'xiaomi';
    await expect(setConfig(key, value, { actor: 'cli' }, testDb())).rejects.toMatchObject({
      status: 400,
    });
    await expect(clearConfig(key, { actor: 'cli' }, testDb())).rejects.toMatchObject({
      status: 400,
    });
    await expectNoWrites();
  });

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

  it('rejects global reset that exposes an incompatible task model', async () => {
    await setConfigs(
      [
        { key: 'lane.global.provider', value: 'openai' },
        { key: 'lane.global.model', value: 'gpt-6-astra' },
        { key: 'task.QuizGenTask.model', value: 'gpt-6-astra' },
      ],
      { actor: 'cli' },
      testDb(),
    );
    const before = await testDb().select().from(system_config_journal);
    await expect(
      clearConfig('lane.global.provider', { actor: 'cli' }, testDb()),
    ).rejects.toMatchObject({ status: 422 });
    expect(await testDb().select().from(system_config_journal)).toEqual(before);
  });
});
