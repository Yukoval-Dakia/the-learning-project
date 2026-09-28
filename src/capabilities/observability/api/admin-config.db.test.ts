// YUK-1007 — GET /api/admin/config 路由 DB 测试（真实 Hono 挂载 + 真实 store 写路径）。
//
// 覆盖面（lane 验收矩阵的 DB/HTTP 侧）：
//   - 组合根真实挂载：manifest 声明 → buildHonoApp 循环挂载 → /api/* token
//     中间件先于 route（无 token 401 / 合法 token 200）。
//   - 真实写路径 round-trip：setConfig（行 + journal + epoch + 即时 hydrate）
//     → GET 读到 source='db' + revision/updated_at；clearConfig → 回落
//     code-default。
//   - per-task override 经真实写路径落 DB → tasks[] 行如实浮现，静态默认不动。
//   - env pin / compose-forced 层在 HTTP 响应里的表现。
//   - secret marker 不出现在 HTTP 响应体。
//
// 隔离：beforeEach resetDb（三表在 wipe list）；afterEach resetTestConfig +
// 快照复位，防止读面测试间泄漏。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { capabilities } from '@/capabilities';
import { replaceConfigSnapshot, resetTestConfig } from '@/core/config/store';
import { clearConfig, setConfig, setConfigs } from '@/server/config/write';
import { buildHonoApp } from '../../../../server/app';
import { resetDb, testDb } from '../../../../tests/helpers/db';

import { AdminConfigResponseSchema } from './admin-config-contracts';

const INTERNAL_TOKEN = 'admin-config-test-token';
const EMPTY_SNAPSHOT = { epoch: 0, entries: new Map(), hydratedAt: '' };

const app = buildHonoApp(capabilities);

async function get(
  path = '/api/admin/config',
  token: string | null = INTERNAL_TOKEN,
): Promise<Response> {
  return app.request(path, {
    headers: token === null ? {} : { 'x-internal-token': token },
  });
}

beforeEach(async () => {
  await resetDb();
  vi.stubEnv('INTERNAL_TOKEN', INTERNAL_TOKEN);
});

afterEach(() => {
  resetTestConfig();
  replaceConfigSnapshot(EMPTY_SNAPSHOT);
  vi.unstubAllEnvs();
});

describe('GET /api/admin/config — auth + mounting', () => {
  it('rejects requests without the internal token (401) before the route runs', async () => {
    const res = await get('/api/admin/config', null);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
  });

  it('serves the route for a valid token and the payload satisfies the manifest contract', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    const parsed = AdminConfigResponseSchema.safeParse(body);
    if (!parsed.success) throw new Error(JSON.stringify(parsed.error.issues, null, 2));
    expect(parsed.data.snapshot.epoch).toBeGreaterThanOrEqual(0);
    expect(parsed.data.keys.length).toBeGreaterThan(50);
    expect(parsed.data.tasks.length).toBeGreaterThan(50);
  });
});

describe('GET /api/admin/config — DB-layer resolution over real write path', () => {
  it('reflects a real setConfig write (row + journal + epoch + immediate hydrate)', async () => {
    await setConfig('JUDGE_DURABLE_ENABLED', true, { actor: 'cli' }, testDb());

    const res = await get();
    expect(res.status).toBe(200);
    const body = AdminConfigResponseSchema.parse(await res.json());
    const row = body.keys.find((candidate) => candidate.key === 'JUDGE_DURABLE_ENABLED');
    if (!row) throw new Error('missing JUDGE_DURABLE_ENABLED row');
    expect(row).toMatchObject({
      value: true,
      source: 'db',
      revision: 1,
      default: false,
      wired: true,
    });
    expect(row.updated_at).toBeTruthy();
    expect(body.snapshot.epoch).toBeGreaterThan(0);
  });

  it('falls back to code-default after clearConfig removes the row', async () => {
    await setConfig('AI_RATE_LIMIT_MAX', 123, { actor: 'cli' }, testDb());
    await clearConfig('AI_RATE_LIMIT_MAX', { actor: 'cli' }, testDb());

    const body = AdminConfigResponseSchema.parse(await (await get()).json());
    const row = body.keys.find((candidate) => candidate.key === 'AI_RATE_LIMIT_MAX');
    if (!row) throw new Error('missing AI_RATE_LIMIT_MAX row');
    expect(row).toMatchObject({ value: 30, source: 'code-default', revision: null });
  });

  it('surfaces a real per-task override write on the task row, defaults untouched', async () => {
    // pair 守卫：openai 需显式 model，provider+model 必须同写（写端 422 语义的对面）。
    await setConfigs(
      [
        { key: 'task.AttributionTask.provider', value: 'openai' },
        { key: 'task.AttributionTask.model', value: 'gpt-6-astra' },
      ],
      { actor: 'cli' },
      testDb(),
    );

    const body = AdminConfigResponseSchema.parse(await (await get()).json());
    const task = body.tasks.find((candidate) => candidate.kind === 'AttributionTask');
    if (!task) throw new Error('missing AttributionTask row');
    expect(task.override).toEqual({ provider: 'openai', model: 'gpt-6-astra' });
    // 静态 catalog 默认不受 DB 覆盖影响；budget 未接线如实标注。
    expect(task.override_wired).toEqual({ provider: true, model: true, budget: false });
  });
});

describe('GET /api/admin/config — env layers and secrecy over HTTP', () => {
  it('reports the operator env pin above a DB row (priority semantics) over HTTP', async () => {
    await setConfigs(
      [
        { key: 'lane.global.provider', value: 'openai' },
        { key: 'lane.global.model', value: 'gpt-6-astra' },
      ],
      { actor: 'cli' },
      testDb(),
    );
    vi.stubEnv('AI_PROVIDER_OVERRIDE', 'anthropic-sub');

    const body = AdminConfigResponseSchema.parse(await (await get()).json());
    const row = body.keys.find((candidate) => candidate.key === 'lane.global.provider');
    if (!row) throw new Error('missing lane.global.provider row');
    expect(row).toMatchObject({
      value: 'anthropic-sub',
      source: 'env',
      env_mode: 'priority',
    });
    for (const task of body.tasks) {
      // caller 语义：env pin all-or-nothing——DB model 行（gpt-6-astra）不进 pin。
      expect(task.global_pin).toEqual({ provider: 'anthropic-sub' });
    }
  });

  it('reports compose-forced source for pinned keys even when a DB row exists', async () => {
    // 写端对 pinned 键 409，直接注行模拟手工/历史漂移——读面必须仍报 env 层。
    const { system_config } = await import('@/db/schema');
    await testDb().insert(system_config).values({
      key: 'PLACEMENT_PROBE_ENABLED',
      value: false,
      revision: 5,
      updated_by: 'cli',
      created_at: new Date(),
      updated_at: new Date(),
    });
    const { hydrateConfigFromDb } = await import('@/server/config/hydrate');
    await hydrateConfigFromDb(testDb());
    vi.stubEnv('PLACEMENT_PROBE_ENABLED', 'true');

    const body = AdminConfigResponseSchema.parse(await (await get()).json());
    const row = body.keys.find((candidate) => candidate.key === 'PLACEMENT_PROBE_ENABLED');
    if (!row) throw new Error('missing PLACEMENT_PROBE_ENABLED row');
    expect(row).toMatchObject({
      value: true,
      source: 'compose-forced',
      read_only: true,
      revision: null,
    });
  });

  it('never echoes secret env material in the HTTP response body', async () => {
    vi.stubEnv('XIAOMI_API_KEY', 'sk-db-test-secret-xiaomi-3341');
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-db-test-secret-3341');
    const res = await get();
    const text = await res.text();
    expect(text.includes('sk-db-test-secret-xiaomi-3341')).toBe(false);
    expect(text.includes('sk-ant-db-test-secret-3341')).toBe(false);
    expect(text.includes(INTERNAL_TOKEN)).toBe(false);
  });
});
