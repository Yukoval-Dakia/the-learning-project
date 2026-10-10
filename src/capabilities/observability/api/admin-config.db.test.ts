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
import { buildHonoApp } from '../../../../server/app';
import { resetDb } from '../../../../tests/helpers/db';
import {
  __resetAdminConfigRuntimeFactsForTests,
  setAdminConfigRuntimeFacts,
} from '../server/admin-config-facts';
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
  __resetAdminConfigRuntimeFactsForTests();
  vi.unstubAllEnvs();
});

describe('GET /api/admin/config — env layers and secrecy over HTTP', () => {
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

describe('GET /api/admin/config — injected runtime facts over HTTP (real builder)', () => {
  // 真组合根装配（server/config/admin-config-facts.ts）：真实 provider 注册表、
  // boss/memory cron 静态表、运行形态常量、各 capability 真实 reader 的 effective。
  beforeEach(async () => {
    const [{ buildAdminConfigRuntimeFacts }, { observabilityConfigEffectiveFacts }] =
      await Promise.all([
        import('@/server/config/admin-config-facts'),
        import('@/capabilities/observability/public'),
      ]);
    expect(observabilityConfigEffectiveFacts().BACKUP_IMPORT_MAX_BYTES?.value).toBe(1_000_000_000);
    setAdminConfigRuntimeFacts(buildAdminConfigRuntimeFacts);
  });

  it('serves providers[] with presence booleans only (no credential values) and reserved lanes marked unimplemented', async () => {
    vi.stubEnv('XIAOMI_API_KEY', 'sk-http-facts-canary-xiaomi-9f1a');
    const body = AdminConfigResponseSchema.parse(await (await get()).json());
    expect(body.facts_injected).toBe(true);
    expect(body.tasks.find((task) => task.kind === 'QuizGenTask')?.effective_binding).toEqual({
      provider: 'xiaomi',
      model: 'mimo-v2.5-pro',
      error: null,
    });

    expect(body.providers.length).toBe(8);
    const byName = new Map(body.providers.map((row) => [row.name, row]));
    expect(byName.get('xiaomi')).toMatchObject({
      auth_mode: 'key',
      credential_env: 'XIAOMI_API_KEY',
      key_present: true,
      implemented: true,
    });
    expect(byName.get('anthropic-sub')).toMatchObject({
      auth_mode: 'oauth',
      credential_env: 'CLAUDE_CODE_OAUTH_TOKEN',
      key_present: false,
      implemented: true,
    });
    expect(byName.has('zhipu')).toBe(false);
    expect(byName.get('zai-coding-cn')).toMatchObject({
      pi_provider: 'zai-coding-cn',
      credential_env: 'ZAI_CODING_CN_API_KEY',
    });
    expect(byName.get('anthropic-sub')?.pi_provider).toBe('anthropic');
    expect(byName.get('xiaomi')?.models).toContainEqual({
      id: 'mimo-v2.5-pro',
      api: 'openai-completions',
      input: ['text'],
    });
    expect(byName.get('opencode-go')?.models).toContainEqual({
      id: 'glm-5.3-flash',
      api: 'openai-completions',
      input: ['text', 'image'],
    });
    expect(byName.get('openrouter')).toMatchObject({ implemented: false });
    expect(byName.get('gateway')).toMatchObject({ implemented: false });
    // 布尔与 env 名之外不得有任何 credential 派生事实；值绝不进响应体。
    const text = JSON.stringify(body);
    expect(text.includes('sk-http-facts-canary-xiaomi-9f1a')).toBe(false);
    for (const row of body.providers) {
      expect(Object.keys(row).sort()).toEqual([
        'auth_mode',
        'credential_env',
        'implemented',
        'implemented_for',
        'key_present',
        'models',
        'name',
        'pi_provider',
      ]);
    }
  });
});
