import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tasks } from '@/ai/registry';
import { capabilities } from '@/capabilities';
import { getConfig, replaceConfigSnapshot } from '@/core/config/store';
import { system_config, system_config_epoch, system_config_journal } from '@/db/schema';
import { resolveTaskProvider } from '@/server/ai/providers';
import { createAdminConfigWriter } from '@/server/config/admin-config-write';
import { __hydratePublishGate, hydrateConfigFromDb } from '@/server/config/hydrate';
import { buildHonoApp } from '../../../../server/app';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import {
  __resetAdminConfigWriterForTests,
  setAdminConfigWriter,
} from '../server/admin-config-writer';
import { AdminConfigResponseSchema } from './admin-config-contracts';
import { AdminConfigWriteResponseSchema } from './admin-config-write-contracts';

const TOKEN = 'config-write-local-token';
const app = buildHonoApp(capabilities);
const pair = [
  { action: 'set', key: 'task.QuizGenTask.provider', value: 'opencode-go' },
  { action: 'set', key: 'task.QuizGenTask.model', value: 'glm-5.3-flash' },
];

function request(body: unknown, reset = false, token: string | null = TOKEN) {
  return app.request(reset ? '/api/admin/config/reset' : '/api/admin/config', {
    method: reset ? 'POST' : 'PATCH',
    headers: {
      'content-type': 'application/json',
      ...(token ? { 'x-internal-token': token } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function expectNoWrites() {
  expect(await testDb().select().from(system_config)).toEqual([]);
  expect(await testDb().select().from(system_config_journal)).toEqual([]);
  expect(await testDb().select().from(system_config_epoch)).toEqual([]);
}

beforeEach(async () => {
  await resetDb();
  vi.stubEnv('INTERNAL_TOKEN', TOKEN);
  vi.stubEnv('AI_PROVIDER_OVERRIDE', '');
  vi.stubEnv('AI_PROVIDER_MODEL', '');
  vi.stubEnv('OPENCODE_API_KEY', 'local-go-credential-canary');
  vi.stubEnv('XIAOMI_API_KEY', 'local-xiaomi-credential-canary');
  setAdminConfigWriter(createAdminConfigWriter(testDb()));
});
afterEach(() => {
  __hydratePublishGate.hook = undefined;
  __resetAdminConfigWriterForTests();
  replaceConfigSnapshot({ epoch: 0, entries: new Map(), hydratedAt: '' });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('admin configuration writes over real Hono + Postgres', () => {
  it.each([false, true])('authenticates before writes (reset=%s)', async (reset) => {
    const writer = vi.fn(createAdminConfigWriter(testDb()));
    setAdminConfigWriter(writer);
    const response = await request(
      reset ? { keys: pair.map((p) => p.key) } : { changes: pair },
      reset,
      null,
    );
    expect(response.status).toBe(401);
    expect(writer).not.toHaveBeenCalled();
    await expectNoWrites();
  });

  it.each([false, true])(
    'returns 503 if the composition root has no writer (reset=%s)',
    async (reset) => {
      __resetAdminConfigWriterForTests();
      const response = await request(
        reset ? { keys: pair.map((p) => p.key) } : { changes: pair },
        reset,
      );
      expect(response.status).toBe(503);
      await expectNoWrites();
    },
  );

  it('rejects malformed JSON, empty batches, caller actors and invalid mutation shapes', async () => {
    expect(
      (
        await app.request('/api/admin/config', {
          method: 'PATCH',
          headers: { 'x-internal-token': TOKEN },
          body: '{',
        })
      ).status,
    ).toBe(400);
    for (const body of [
      { changes: [] },
      { changes: pair, actor: 'owner' },
      { changes: [{ action: 'set', key: 'AI_RATE_LIMIT_MAX' }] },
      { changes: [{ action: 'clear', key: 'AI_RATE_LIMIT_MAX', value: 40 }] },
    ]) {
      expect((await request(body)).status).toBe(400);
    }
    expect((await request({ keys: [] }, true)).status).toBe(400);
    await expectNoWrites();
  });

  it.each([
    ['task.Unknown.model', 'gpt-6-astra', 400],
    ['lane.global.budget', { timeout: 1000 }, 400],
    ['constructor', 'x', 400],
    ['PLACEMENT_PROBE_ENABLED', false, 409],
    ['task.QuizGenTask.budget', { timeout: 3_600_000 }, 422],
    ['task.QuizGenTask.provider', 'zhipu', 422],
    ['task.QuizGenTask.model', 'mimo-does-not-exist', 422],
    ['task.MultimodalDirectJudgeTask.model', 'mimo-v2.5-pro', 422],
  ])('rejects %s and rolls back the whole batch', async (key, value, status) => {
    const response = await request({
      changes: [
        { action: 'set', key: 'AI_RATE_LIMIT_MAX', value: 41 },
        { action: 'set', key, value },
      ],
    });
    expect(response.status).toBe(status);
    await expectNoWrites();
  });

  it('rejects a text-only native pair for the vision override lane', async () => {
    const response = await request({
      changes: [
        { action: 'set', key: 'lane.vision_judge.provider', value: 'xiaomi' },
        { action: 'set', key: 'lane.vision_judge.model', value: 'mimo-v2.5-pro' },
      ],
    });
    expect(response.status).toBe(422);
    await expectNoWrites();
  });

  it('rejects duplicate mixed mutations and duplicate resets', async () => {
    expect(
      (await request({ changes: [pair[0], { action: 'clear', key: pair[0].key }] })).status,
    ).toBe(400);
    expect((await request({ keys: [pair[0].key, pair[0].key] }, true)).status).toBe(400);
    expect((await request({ keys: ['constructor'] }, true)).status).toBe(400);
    expect((await request({ keys: ['PLACEMENT_PROBE_ENABLED'] }, true)).status).toBe(409);
    await expectNoWrites();
  });

  it('switches a real native pair, resets it atomically and keeps journal revisions monotonic', async () => {
    const response = await request({ changes: pair, note: 'Use the native Go preset' });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain('credential-canary');
    expect(text).not.toContain(TOKEN);
    const result = AdminConfigWriteResponseSchema.parse(JSON.parse(text));
    expect(result.snapshot_current).toBe(true);
    expect(new Set(result.changes.map((c) => c.epoch))).toEqual(new Set([result.committed_epoch]));
    expect(resolveTaskProvider('QuizGenTask')).toMatchObject({
      provider: 'opencode-go',
      model: 'glm-5.3-flash',
    });
    expect(await testDb().select().from(system_config_journal)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actor: 'panel:admin',
          revision: 1,
          action: 'set',
          payload: expect.objectContaining({ note: 'Use the native Go preset' }),
        }),
      ]),
    );

    // Either single reset would create an invalid intermediate pair; the group is valid.
    const reset = await request({ keys: pair.map((p) => p.key) }, true);
    expect(reset.status).toBe(200);
    const resetResult = AdminConfigWriteResponseSchema.parse(await reset.json());
    expect(resetResult.changes).toHaveLength(2);
    for (const change of resetResult.changes)
      expect(change).toMatchObject({ revision: 2, action: 'clear', cleared: true });
    expect(resolveTaskProvider('QuizGenTask')).toMatchObject({
      provider: tasks.QuizGenTask.defaultProvider,
      model: tasks.QuizGenTask.defaultModel,
    });
    expect((await request({ changes: pair })).status).toBe(200);
    const journal = await testDb().select().from(system_config_journal);
    expect(journal).toHaveLength(6);
    expect(
      journal
        .filter((j) => j.key === pair[0].key)
        .map((j) => j.revision)
        .sort(),
    ).toEqual([1, 2, 3]);
  });

  it('can atomically reset a global pin and the incompatible model it was hiding', async () => {
    expect(
      (
        await request({
          changes: [
            { action: 'set', key: 'lane.global.provider', value: 'openai' },
            { action: 'set', key: 'lane.global.model', value: 'gpt-6-astra' },
            { action: 'set', key: 'task.QuizGenTask.model', value: 'gpt-6-astra' },
          ],
        })
      ).status,
    ).toBe(200);
    const before = await testDb().select().from(system_config_journal);
    expect(
      (await request({ keys: ['lane.global.provider', 'lane.global.model'] }, true)).status,
    ).toBe(422);
    expect(await testDb().select().from(system_config_journal)).toEqual(before);
    expect(
      (
        await request({
          changes: [
            { action: 'clear', key: 'lane.global.provider' },
            { action: 'clear', key: 'lane.global.model' },
            { action: 'set', key: 'task.QuizGenTask.model', value: 'mimo-v2.5-pro' },
          ],
        })
      ).status,
    ).toBe(200);
    expect(resolveTaskProvider('QuizGenTask')).toMatchObject({
      provider: 'xiaomi',
      model: 'mimo-v2.5-pro',
    });
  });

  it('retains the operator env pin above saved and reset task configuration', async () => {
    vi.stubEnv('AI_PROVIDER_OVERRIDE', 'anthropic-sub');
    vi.stubEnv('AI_PROVIDER_MODEL', 'claude-opus-4-8');
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'local-oauth-canary');
    expect((await request({ changes: pair })).status).toBe(200);
    expect(resolveTaskProvider('QuizGenTask')).toMatchObject({
      provider: 'anthropic-sub',
      model: 'claude-opus-4-8',
    });
    expect((await request({ keys: pair.map((p) => p.key) }, true)).status).toBe(200);
    const response = await app.request('/api/admin/config', {
      headers: { 'x-internal-token': TOKEN },
    });
    const body = AdminConfigResponseSchema.parse(await response.json());
    expect(body.tasks.find((task) => task.kind === 'QuizGenTask')?.global_pin).toEqual({
      provider: 'anthropic-sub',
      model: 'claude-opus-4-8',
    });
  });

  it('reports a committed write honestly when local hydration fails, then catches up without another write', async () => {
    __hydratePublishGate.hook = async () => {
      throw new Error('local snapshot publication unavailable');
    };
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const response = await request({
      changes: [{ action: 'set', key: 'AI_RATE_LIMIT_MAX', value: 41 }],
    });
    expect(response.status).toBe(200);
    const result = AdminConfigWriteResponseSchema.parse(await response.json());
    expect(result.snapshot_current).toBe(false);
    expect(result.snapshot_epoch).toBe(0);
    expect(result.committed_epoch).toBeGreaterThan(0);
    expect(getConfig('AI_RATE_LIMIT_MAX', {})).toBe(30);
    expect(await testDb().select().from(system_config_journal)).toHaveLength(1);
    __hydratePublishGate.hook = undefined;
    await hydrateConfigFromDb(testDb());
    expect(getConfig('AI_RATE_LIMIT_MAX', {})).toBe(41);
    expect(await testDb().select().from(system_config_journal)).toHaveLength(1);
  });
});
