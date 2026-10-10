import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { capabilities } from '@/capabilities';
import { tasks } from '@/capabilities/task-registry';
import { replaceConfigSnapshot } from '@/core/config/store';
import { system_config_journal } from '@/db/schema';
import { resolveTaskProvider } from '@/server/ai/providers';
import { createAdminConfigWriter } from '@/server/config/admin-config-write';
import { __hydratePublishGate } from '@/server/config/hydrate';
import { buildHonoApp } from '../../../../server/app';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import {
  __resetAdminConfigWriterForTests,
  setAdminConfigWriter,
} from '../server/admin-config-writer';
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
});
