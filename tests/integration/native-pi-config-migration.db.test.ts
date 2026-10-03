import { readFileSync } from 'node:fs';
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { replaceConfigSnapshot } from '@/core/config/store';
import { system_config, system_config_epoch, system_config_journal } from '@/db/schema';
import { resolveTaskProvider } from '@/server/ai/providers';
import { clearConfig, setConfigs } from '@/server/config/write';
import { resetDb, testDb } from '../helpers/db';

const migration = readFileSync(
  new URL('../../drizzle/0113_yuk1007_native_pi_providers.sql', import.meta.url),
  'utf8',
);
const runMigration = () => testDb().execute(sql.raw(migration));
async function seed(entries: Record<string, unknown>) {
  await testDb()
    .insert(system_config)
    .values(
      Object.entries(entries).map(([key, value]) => ({
        key,
        value,
        revision: 2,
        updated_by: 'owner',
        created_at: new Date(),
        updated_at: new Date(),
      })),
    );
}

beforeEach(resetDb);
afterEach(() => {
  replaceConfigSnapshot({ epoch: 0, entries: new Map(), hydratedAt: '' });
  vi.unstubAllEnvs();
});

describe('native pi routing config migration', () => {
  it('migrates active pairs and policies, appends history, advances stale epoch, and is idempotent', async () => {
    await seed({
      'lane.global.provider': 'zhipu',
      'lane.global.model': 'glm-5.2',
      'task.QuizGenTask.model': 'glm-5.2',
      'lane.verify_solve.provider': 'zhipu',
      'lane.verify_solve.model': 'glm-5.3-flash',
      AI_PROVIDER_SESSION_ADMISSION_POLICIES_JSON: { zhipu: { maxConcurrentSessions: 2 } },
      JYEOO_DAILY_FETCH_BUDGET: 27,
    });
    await testDb()
      .insert(system_config_journal)
      .values({
        key: 'lane.global.provider',
        revision: 8,
        payload: { prev: null, next: 'zhipu' },
        action: 'set',
        actor: 'owner',
        created_at: new Date(),
      });
    await testDb()
      .insert(system_config_epoch)
      .values({ id: 'global', epoch: 1000, updated_at: new Date() });
    const [oldJournal] = await testDb().select().from(system_config_journal);
    await runMigration();
    const rows = await testDb().select().from(system_config);
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
    expect(byKey['lane.global.provider']).toMatchObject({
      value: 'zai-coding-cn',
      revision: 9,
      updated_by: 'migrate',
    });
    expect(byKey['lane.global.model'].value).toBe('glm-5.3');
    expect(byKey['task.QuizGenTask.model'].value).toBe('glm-5.3');
    expect(byKey['lane.verify_solve.model']).toMatchObject({ value: 'glm-5.3-flash', revision: 2 });
    expect(byKey.AI_PROVIDER_SESSION_ADMISSION_POLICIES_JSON.value).toEqual({
      'zai-coding-cn': { maxConcurrentSessions: 2 },
    });
    expect(byKey.JYEOO_DAILY_FETCH_BUDGET.revision).toBe(2);
    const journals = await testDb().select().from(system_config_journal);
    expect(journals).toContainEqual(oldJournal);
    expect(journals).toHaveLength(6);
    const [epoch] = await testDb().select().from(system_config_epoch);
    expect(epoch.epoch).toBeGreaterThan(1000);
    await runMigration();
    expect(await testDb().select().from(system_config_journal)).toEqual(journals);
    expect(await testDb().select().from(system_config_epoch)).toEqual([epoch]);
    const written = await setConfigs(
      [{ key: 'JYEOO_DAILY_FETCH_BUDGET', value: 35 }],
      { actor: 'owner' },
      testDb(),
    );
    expect(written[0].epoch).toBeGreaterThan(epoch.epoch);
  });

  it.each(['glm-5v-turbo', 'glm-5.1', 'glm-5.2-highspeed', 'glm-5-turbo', 'glm-4.7'])(
    'rejects retired active model %s before changing any config',
    async (model) => {
      await seed({ 'task.QuizGenTask.provider': 'zhipu', 'task.QuizGenTask.model': model });
      await expect(runMigration()).rejects.toThrow(
        /retired Zhipu models require an explicit native replacement/,
      );
      const [provider] = await testDb()
        .select()
        .from(system_config)
        .where(eq(system_config.key, 'task.QuizGenTask.provider'));
      expect(provider.value).toBe('zhipu');
      expect(await testDb().select().from(system_config_journal)).toHaveLength(0);
    },
  );

  it('conflicting old/new admission policies abort the whole migration', async () => {
    await seed({
      'lane.global.provider': 'zhipu',
      AI_PROVIDER_SESSION_ADMISSION_POLICIES_JSON: {
        zhipu: { maxConcurrentSessions: 2 },
        'zai-coding-cn': { maxConcurrentSessions: 3 },
      },
    });
    await expect(runMigration()).rejects.toThrow(/conflicting zhipu/);
    const [row] = await testDb()
      .select()
      .from(system_config)
      .where(eq(system_config.key, 'lane.global.provider'));
    expect(row.value).toBe('zhipu');
    expect(await testDb().select().from(system_config_journal)).toHaveLength(0);
  });

  it('model-only writes validate against the higher-priority global provider', async () => {
    vi.stubEnv('AI_PROVIDER_OVERRIDE', 'zai-coding-cn');
    vi.stubEnv('AI_PROVIDER_MODEL', '');
    await expect(
      setConfigs(
        [{ key: 'task.QuizGenTask.model', value: 'glm-5.3' }],
        { actor: 'owner' },
        testDb(),
      ),
    ).resolves.toHaveLength(1);
  });

  it('an env provider excludes the entire DB global pair during both validation and execution', async () => {
    await seed({ 'lane.global.provider': 'xiaomi', 'lane.global.model': 'mimo-v2.5' });
    vi.stubEnv('AI_PROVIDER_OVERRIDE', 'zai-coding-cn');
    vi.stubEnv('AI_PROVIDER_MODEL', '');
    vi.stubEnv('ZAI_CODING_CN_API_KEY', 'native-test-key');
    await setConfigs(
      [{ key: 'task.QuizGenTask.model', value: 'glm-5.3' }],
      { actor: 'owner' },
      testDb(),
    );
    expect(resolveTaskProvider('QuizGenTask')).toMatchObject({
      provider: 'zai-coding-cn',
      model: 'glm-5.3',
    });
  });

  it('global writes reject a text-only pin before breaking image tasks and preserve the previous pair', async () => {
    await setConfigs(
      [
        { key: 'lane.global.provider', value: 'xiaomi' },
        { key: 'lane.global.model', value: 'mimo-v2.5' },
      ],
      { actor: 'owner' },
      testDb(),
    );
    const before = await testDb().select().from(system_config_journal);
    await expect(
      setConfigs(
        [{ key: 'lane.global.model', value: 'mimo-v2.5-pro' }],
        { actor: 'owner' },
        testDb(),
      ),
    ).rejects.toMatchObject({ status: 422 });
    const [row] = await testDb()
      .select()
      .from(system_config)
      .where(eq(system_config.key, 'lane.global.model'));
    expect(row.value).toBe('mimo-v2.5');
    expect(await testDb().select().from(system_config_journal)).toEqual(before);
  });

  it('provider-only global pin validates per-task models, including image tasks', async () => {
    await seed({ 'task.StepsJudgeTask.model': 'mimo-v2.5-pro' });
    await expect(
      setConfigs([{ key: 'lane.global.provider', value: 'xiaomi' }], { actor: 'owner' }, testDb()),
    ).rejects.toMatchObject({ status: 422 });
    expect(
      await testDb()
        .select()
        .from(system_config)
        .where(eq(system_config.key, 'lane.global.provider')),
    ).toHaveLength(0);
  });

  it('accepts native OpenCode Go globally without redirecting the typed task', async () => {
    await setConfigs(
      [
        { key: 'lane.global.provider', value: 'opencode-go' },
        { key: 'lane.global.model', value: 'glm-5.3-flash' },
      ],
      { actor: 'owner' },
      testDb(),
    );
    await expect(
      clearConfig('task.JevScoringDecisionTask.model', { actor: 'owner' }, testDb()),
    ).resolves.toMatchObject({ cleared: false });
  });

  it('a global legacy provider takes precedence over a task provider during model migration', async () => {
    await seed({
      'lane.global.provider': 'zhipu',
      'task.QuizGenTask.provider': 'xiaomi',
      'task.QuizGenTask.model': 'glm-5.2',
    });
    await runMigration();
    const [model] = await testDb()
      .select()
      .from(system_config)
      .where(eq(system_config.key, 'task.QuizGenTask.model'));
    expect(model.value).toBe('glm-5.3');
  });

  it('clearing an absent typed task model preserves the valid typed registry default', async () => {
    await expect(
      clearConfig('task.JevScoringDecisionTask.model', { actor: 'owner' }, testDb()),
    ).resolves.toMatchObject({ cleared: false });
  });

  it('rejects deleted aliases, nonexistent pairs and text-only vision configurations atomically', async () => {
    for (const [kind, provider, model] of [
      ['QuizGenTask', 'zhipu', 'glm-5.2'],
      ['QuizGenTask', 'zai-coding-cn', 'glm-5.2'],
      ['QuizGenTask', 'openai', 'mimo-v2.5-pro'],
      ['MultimodalDirectJudgeTask', 'xiaomi', 'mimo-v2.5-pro'],
    ]) {
      await expect(
        setConfigs(
          [
            { key: `task.${kind}.provider`, value: provider },
            { key: `task.${kind}.model`, value: model },
          ],
          { actor: 'owner' },
          testDb(),
        ),
      ).rejects.toMatchObject({ status: 422 });
      expect(await testDb().select().from(system_config)).toHaveLength(0);
      expect(await testDb().select().from(system_config_journal)).toHaveLength(0);
    }
  });
});
