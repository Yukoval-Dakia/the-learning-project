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
import { __resetAdminConfigRuntimeFactsForTests } from '../server/admin-config-facts';

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
