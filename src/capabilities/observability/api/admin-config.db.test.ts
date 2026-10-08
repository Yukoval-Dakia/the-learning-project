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
import {
  LEARNER_LOCALE_PIN,
  getTaskSystemPrompt,
  resolveTaskBudget,
} from '@/capabilities/task-registry';
import { replaceConfigSnapshot, resetTestConfig } from '@/core/config/store';
import { VERIFY_DISPATCH_RECOVERY_QUEUE } from '@/server/boss/verify-dispatch-outbox';
import { clearConfig, setConfig, setConfigs } from '@/server/config/write';
import { buildHonoApp } from '../../../../server/app';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import {
  __resetAdminConfigRuntimeFactsForTests,
  setAdminConfigRuntimeFacts,
} from '../server/admin-config-facts';
import { AdminConfigResponseSchema, AdminConfigScheduleRowSchema } from './admin-config-contracts';

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
    // 静态 catalog 默认不变；预算并非所有字段均已接线。
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
      expect(task.global_pin).toEqual(
        task.kind === 'JevScoringDecisionTask' ? null : { provider: 'anthropic-sub' },
      );
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

  it.each([true, false])(
    'distinguishes typed OpenRouter wiring with credential presence=%s',
    async (present) => {
      vi.stubEnv('OPENROUTER_API_KEY', present ? 'typed-capability-canary' : '');
      const body = AdminConfigResponseSchema.parse(await (await get()).json());
      expect(body.providers.find((row) => row.name === 'openrouter')).toMatchObject({
        implemented: false,
        implemented_for: { chat: false, typed: true },
        pi_provider: null,
        key_present: present,
      });
      expect(body.providers.find((row) => row.name === 'xiaomi')).toMatchObject({
        implemented: true,
        implemented_for: { chat: true, typed: false },
      });
      expect(body.providers.find((row) => row.name === 'gateway')).toMatchObject({
        implemented_for: { chat: false, typed: false },
      });
      expect(JSON.stringify(body)).not.toContain('typed-capability-canary');
    },
  );

  it('serves schedules[] from the real declaration sources (manifest projection + boss/memory infra tables) with the read-only note', async () => {
    const body = AdminConfigResponseSchema.parse(await (await get()).json());
    expect(body.schedules.read_only_note).toContain('只读');

    const manifestRows = body.schedules.rows.filter((r) => r.source === 'capability-manifest');
    const expectedManifest = capabilities
      .flatMap((cap) => (cap.jobs?.handlers ?? []).filter((job) => job.schedule !== undefined))
      .map((job) => job.name)
      .sort();
    expect(manifestRows.map((r) => r.name)).toEqual(expectedManifest);
    expect(manifestRows.filter((r) => r.name === 'prune_job_events')).toHaveLength(1);
    expect(body.schedules.rows.filter((r) => r.name === 'prune_orphan_review_sessions')).toEqual([
      expect.objectContaining({
        source: 'capability-manifest',
        cron: '15 4 * * *',
        tz: 'Asia/Shanghai',
      }),
    ]);

    for (const [name, cron] of [
      ['prune_orphan_conversation_sessions', '25 4 * * *'],
      ['prune_orphan_placement_sessions', '35 4 * * *'],
    ])
      expect(body.schedules.rows.filter((r) => r.name === name)).toEqual([
        expect.objectContaining({ source: 'capability-manifest', cron, tz: 'Asia/Shanghai' }),
      ]);

    const bossRows = body.schedules.rows.filter((r) => r.source === 'server-boss-infra');
    // 队列名取真实常量（verify_dispatch_recover——verify-dispatch-outbox 导出）。
    expect(bossRows.map((r) => r.name).sort()).toEqual(
      ['promote_conversation_idle', VERIFY_DISPATCH_RECOVERY_QUEUE].sort(),
    );
    const memoryRows = body.schedules.rows.filter((r) => r.source === 'server-memory-infra');
    expect(memoryRows.map((r) => r.name).sort()).toEqual(
      ['memory_brief_sweep', 'memory_ingest_outbox_poll', 'memory_ingest_outbox_recover'].sort(),
    );
    // 声明源行全部过行契约（cron/tz/owner 真实值非空）。
    for (const row of body.schedules.rows) {
      expect(AdminConfigScheduleRowSchema.safeParse(row).success, row.name).toBe(true);
      expect(row.cron).not.toBe('');
      expect(row.tz).not.toBe('');
    }
  });

  it('serves the runtime partition from the real single-source constants', async () => {
    const body = AdminConfigResponseSchema.parse(await (await get()).json());
    expect(body.runtime).not.toBeNull();
    expect(body.runtime?.port).toBe(8787);
    expect(body.runtime?.db_pool_max).toBe(10);
    expect(body.runtime?.queue_tiers).toEqual({
      expire_seconds: { fast: 3600, llm: 3600, agent: 7200 },
      retention_seconds: 604_800,
    });
    expect(body.runtime?.orchestration).toMatchObject({
      anchor_cron: '30 2 * * *',
      tz: 'Asia/Shanghai',
      queue: 'nightly_orchestrator',
      catchup_window_seconds: 18_000,
      tick_interval_seconds: 60,
      node_timeout_seconds: 25_200,
      layer_stagger_seconds: 120,
    });
    // DAG 成员名单来自 kernel projectDagMembers 同源投影（非空 = 编排面在场）。
    expect(body.runtime?.orchestration.dag_members.length).toBeGreaterThan(0);
  });

  it('carries effective over the real DB write path: a valid 5MB row is honored verbatim by the real reader (configured = effective)', async () => {
    // 写端 schema（min 1MB）与 hydrate 校验保证 DB 层不可能携带低于地板的值——
    // DB 层分叉在构造上不可能；分叉只在 env 层（unit 测试钉住：envParse 垃圾直通
    // + reader 回退）。本测试钉 HTTP 面的 effective 列随真实写路径出现且如实。
    await setConfig('BACKUP_IMPORT_MAX_BYTES', 5_000_000, { actor: 'cli' }, testDb());

    const body = AdminConfigResponseSchema.parse(await (await get()).json());
    const row = body.keys.find((candidate) => candidate.key === 'BACKUP_IMPORT_MAX_BYTES');
    if (!row) throw new Error('missing BACKUP_IMPORT_MAX_BYTES row');
    expect(row.value).toBe(5_000_000);
    expect(row.source).toBe('db');
    expect(row.revision).toBe(1);
    // 真实 reader 直读该值（≥地板不回退）：effective = 5MB，两列一致且都在场。
    expect(row.effective).toBe(5_000_000);
    expect(row.effective_note).toBeTruthy();
  });
});

describe('GET /api/admin/config — P1 honest effective for degraded runtime overrides (real facts builder)', () => {
  // 验证审反例：VERIFY_SOLVE_PROVIDER_OVERRIDE=anthropic-sub + model=claude-opus-4-8
  // 且无 OAuth token 时，真实 reader（solve-lane.ts resolveSolveOverrideFromEnv）
  // 返回 {}（凭据缺失 fail-open 回默认 lane）；修复前 facts 未接该 reader ⇒
  // keys[].effective 缺席，而读面契约把缺席当「直通生效」= 虚报。同类：孤立
  // lane.global.model（runtime 不消费，readGlobalProviderSwitch 的 provider 门）。
  beforeEach(async () => {
    const [{ buildAdminConfigRuntimeFacts }] = await Promise.all([
      import('@/server/config/admin-config-facts'),
    ]);
    setAdminConfigRuntimeFacts(buildAdminConfigRuntimeFacts);
  });

  it('REGRESSION (RED pre-fix): solve-lane override pair without credentials reports effective=null with the reader degrade note, not pass-through', async () => {
    vi.stubEnv('VERIFY_SOLVE_PROVIDER_OVERRIDE', 'anthropic-sub');
    vi.stubEnv('VERIFY_SOLVE_MODEL_OVERRIDE', 'claude-opus-4-8');
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', '');

    const body = AdminConfigResponseSchema.parse(await (await get()).json());
    const providerRow = body.keys.find((k) => k.key === 'lane.verify_solve.provider');
    if (!providerRow) throw new Error('missing lane.verify_solve.provider row');
    // configured 如实报 env 值……
    expect(providerRow.value).toBe('anthropic-sub');
    expect(providerRow.source).toBe('env');
    // ……effective 必须来自真实 reader：凭据缺席 → 降级（null + reader 自己的降级说明）。
    expect(providerRow.effective).toBeNull();
    expect(providerRow.effective_note).toContain('falling back');

    const modelRow = body.keys.find((k) => k.key === 'lane.verify_solve.model');
    if (!modelRow) throw new Error('missing lane.verify_solve.model row');
    expect(modelRow.value).toBe('claude-opus-4-8');
    // model 随 provider 一起被降级丢弃（reader 返回 {}，model 是为该 provider 选的）。
    expect(modelRow.effective).toBeNull();
    expect(modelRow.effective_note).toBeTruthy();
  });

  it('vision model rejected with its provider reports effective=null rather than configured pass-through', async () => {
    vi.stubEnv('VISION_JUDGE_PROVIDER', 'anthropic-sub');
    vi.stubEnv('VISION_JUDGE_MODEL', 'claude-opus-4-8');
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', '');
    const response = await get();
    expect(response.status).toBe(200);
    const body = AdminConfigResponseSchema.parse(await response.json());
    const model = body.keys.find((row) => row.key === 'lane.vision_judge.model');
    expect(model).toMatchObject({ value: 'claude-opus-4-8', source: 'env', effective: null });
  });

  it.each(['unregistered-lane', 'constructor', 'toString'])(
    'does not advertise invalid global provider %s as an active task pin',
    async (provider) => {
      vi.stubEnv('AI_PROVIDER_OVERRIDE', provider);
      const res = await get();
      expect(res.status).toBe(200);
      const body = AdminConfigResponseSchema.parse(await res.json());
      expect(body.keys.find((row) => row.key === 'lane.global.provider')).toMatchObject({
        value: provider,
        effective: null,
      });
      for (const task of body.tasks) expect(task.global_pin).toBeNull();
      expect(
        body.tasks.find((task) => task.kind === 'StepsJudgeTask')?.effective_binding?.error,
      ).toBeTruthy();
    },
  );

  it.each([
    ['unregistered-lane', 'mimo-v2.5'],
    ['xiaomi', 'mimo-v2.5'],
    ['openrouter', 'mimo-v2.5'],
  ])(
    'reports unusable vision override %s without claiming it is effective',
    async (provider, model) => {
      vi.stubEnv('VISION_JUDGE_PROVIDER', provider);
      vi.stubEnv('VISION_JUDGE_MODEL', model);
      vi.stubEnv('XIAOMI_API_KEY', '');
      vi.stubEnv('OPENROUTER_API_KEY', 'presence-only-openrouter-canary');
      const res = await get();
      expect(res.status).toBe(200);
      const body = AdminConfigResponseSchema.parse(await res.json());
      for (const key of ['lane.vision_judge.provider', 'lane.vision_judge.model']) {
        const row = body.keys.find((item) => item.key === key);
        expect(row?.effective).toBeNull();
        expect(row?.effective_note).toContain('解析失败');
      }
      const diagnostic = body.keys.find(
        (item) => item.key === 'lane.vision_judge.model',
      )?.effective_note;
      for (const kind of [
        'StepsJudgeTask',
        'MultimodalDirectJudgeTask',
        'SourceGroundingVerifyTask',
      ]) {
        expect(diagnostic).toContain(`${kind}: 解析失败`);
      }
      expect(JSON.stringify(body)).not.toContain('presence-only-openrouter-canary');
    },
  );

  it('resolves the active vision model through the real provider fallback', async () => {
    vi.stubEnv('VISION_JUDGE_PROVIDER', 'anthropic-sub');
    vi.stubEnv('VISION_JUDGE_MODEL', '');
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'presence-only-oauth-canary');
    const body = AdminConfigResponseSchema.parse(await (await get()).json());
    expect(body.keys.find((row) => row.key === 'lane.vision_judge.model')?.effective).toBe(
      'claude-opus-4-8',
    );
    expect(JSON.stringify(body)).not.toContain('presence-only-oauth-canary');
  });

  it('rejects native model mismatch in the source-grounding vision consumer read face', async () => {
    await setConfigs(
      [
        { key: 'task.SourceGroundingVerifyTask.provider', value: 'anthropic-sub' },
        { key: 'task.SourceGroundingVerifyTask.model', value: 'claude-opus-4-8' },
      ],
      { actor: 'cli' },
      testDb(),
    );
    vi.stubEnv('VISION_JUDGE_PROVIDER', 'xiaomi');
    vi.stubEnv('VISION_JUDGE_MODEL', '');
    vi.stubEnv('XIAOMI_API_KEY', 'presence-only-xiaomi-canary');
    const body = AdminConfigResponseSchema.parse(await (await get()).json());
    expect(body.keys.find((row) => row.key === 'lane.vision_judge.provider')?.effective).toBeNull();
    expect(
      body.keys.find((row) => row.key === 'lane.vision_judge.model')?.effective_note,
    ).toContain('解析失败');
    const diagnostic = body.keys.find(
      (row) => row.key === 'lane.vision_judge.model',
    )?.effective_note;
    expect(diagnostic).toContain('StepsJudgeTask: 可用（xiaomi / mimo-v2.5）');
    expect(diagnostic).toContain('MultimodalDirectJudgeTask: 可用（xiaomi / mimo-v2.5）');
    expect(diagnostic).toContain('SourceGroundingVerifyTask: 解析失败');
    expect(JSON.stringify(body)).not.toContain('presence-only-xiaomi-canary');
  });

  it('includes conditional subscription dispatch with its actual cron and timezone', async () => {
    const body = AdminConfigResponseSchema.parse(await (await get()).json());
    expect(
      body.schedules.rows.find((row) => row.name === 'event_subscription_dispatch'),
    ).toMatchObject({
      queue: 'event_subscription_dispatch',
      cron: '* * * * *',
      tz: 'Asia/Shanghai',
      owner: 'server/event-subscriptions',
      source: 'server-event-subscriptions',
      note: expect.stringContaining('订阅'),
    });
  });

  it('REGRESSION: model-only lane.global row is runtime-inert — effective=null with the inert note, while tasks[].global_pin stays null', async () => {
    vi.stubEnv('AI_PROVIDER_MODEL', 'claude-opus-4-8');
    vi.stubEnv('AI_PROVIDER_OVERRIDE', '');

    const body = AdminConfigResponseSchema.parse(await (await get()).json());
    const modelRow = body.keys.find((k) => k.key === 'lane.global.model');
    if (!modelRow) throw new Error('missing lane.global.model row');
    expect(modelRow.value).toBe('claude-opus-4-8');
    expect(modelRow.source).toBe('env');
    // readGlobalProviderSwitch 的 provider 门：model-only 配置 runtime 不消费。
    expect(modelRow.effective).toBeNull();
    expect(modelRow.effective_note).toBeTruthy();
    const providerRow = body.keys.find((k) => k.key === 'lane.global.provider');
    if (!providerRow) throw new Error('missing lane.global.provider row');
    expect(providerRow.effective).toBeNull();
    // 任务面一致：无 pin。
    for (const task of body.tasks) {
      expect(task.global_pin).toBeNull();
    }
  });

  it('valid active scenarios: ready provider pair reports effective from the real readers', async () => {
    // 全局 pin：xiaomi + 在场凭据（key canary 值，不触网）。
    vi.stubEnv('AI_PROVIDER_OVERRIDE', 'xiaomi');
    vi.stubEnv('AI_PROVIDER_MODEL', 'mimo-v2.5-pro');
    vi.stubEnv('XIAOMI_API_KEY', 'sk-p1-regression-presence-only');
    // solve-lane 覆盖：xiaomi（凭据同上在场、自带可跑默认 model 的 provider）+ 显式 model。
    vi.stubEnv('VERIFY_SOLVE_PROVIDER_OVERRIDE', 'xiaomi');
    vi.stubEnv('VERIFY_SOLVE_MODEL_OVERRIDE', 'mimo-v2.5-pro');

    const body = AdminConfigResponseSchema.parse(await (await get()).json());
    const globalProvider = body.keys.find((k) => k.key === 'lane.global.provider');
    const globalModel = body.keys.find((k) => k.key === 'lane.global.model');
    expect(globalProvider?.effective).toBe('xiaomi');
    expect(globalModel?.effective).toBe('mimo-v2.5-pro');
    const solveProvider = body.keys.find((k) => k.key === 'lane.verify_solve.provider');
    const solveModel = body.keys.find((k) => k.key === 'lane.verify_solve.model');
    expect(solveProvider?.effective).toBe('xiaomi');
    expect(solveModel?.effective).toBe('mimo-v2.5-pro');
    for (const task of body.tasks) {
      expect(task.global_pin).toEqual(
        task.kind === 'JevScoringDecisionTask'
          ? null
          : { provider: 'xiaomi', model: 'mimo-v2.5-pro' },
      );
    }
  });
});

describe('learner locale — write, runtime consumer and HTTP facts', () => {
  it('hot-reloads English and restores the exact default prompt after clear', async () => {
    const { buildAdminConfigRuntimeFacts } = await import('@/server/config/admin-config-facts');
    setAdminConfigRuntimeFacts(buildAdminConfigRuntimeFacts);
    const original = getTaskSystemPrompt('NoteGenerateTask');
    expect(original.endsWith(LEARNER_LOCALE_PIN)).toBe(true);

    await setConfig('locale.learner', 'en', { actor: 'cli' }, testDb());
    expect(getTaskSystemPrompt('NoteGenerateTask')).toContain('[Output language]');
    const english = AdminConfigResponseSchema.parse(await (await get()).json());
    expect(english.keys.find((row) => row.key === 'locale.learner')).toMatchObject({
      value: 'en',
      effective: 'en',
      source: 'db',
      wired: true,
      consumer: 'src/ai/task-prompts.ts',
    });

    await expect(setConfig('locale.learner', 'fr', { actor: 'cli' }, testDb())).rejects.toThrow();
    expect(getTaskSystemPrompt('NoteGenerateTask')).toContain('[Output language]');
    const afterRejected = AdminConfigResponseSchema.parse(await (await get()).json());
    expect(afterRejected.snapshot.epoch).toBe(english.snapshot.epoch);

    await clearConfig('locale.learner', { actor: 'cli' }, testDb());
    expect(getTaskSystemPrompt('NoteGenerateTask')).toBe(original);
    const cleared = AdminConfigResponseSchema.parse(await (await get()).json());
    expect(cleared.keys.find((row) => row.key === 'locale.learner')).toMatchObject({
      value: 'zh-CN',
      effective: 'zh-CN',
      source: 'code-default',
      wired: true,
    });
  });
});

describe('GET /api/admin/config — runtime budget facts', () => {
  it('reports the same real DB budget consumed by each execution lane, with unsupported fields null', async () => {
    await setConfigs(
      [
        {
          key: 'task.AttributionTask.budget',
          value: { maxIterations: 12, maxCost: 0.25, transientRetries: 2, timeout: 123_456 },
        },
        {
          key: 'task.JevScoringDecisionTask.budget',
          value: { maxIterations: 8, maxCost: 0.03, transientRetries: 0, timeout: 234_567 },
        },
      ],
      { actor: 'cli' },
      testDb(),
    );
    const frozen = resolveTaskBudget('AttributionTask');
    const body = AdminConfigResponseSchema.parse(await (await get()).json());
    expect(body.tasks.find((row) => row.kind === 'AttributionTask')).toMatchObject({
      effective_budget: { ...frozen, maxCost: null },
      budget_wiring: { maxIterations: true, maxCost: false, transientRetries: true, timeout: true },
    });
    expect(body.tasks.find((row) => row.kind === 'JevScoringDecisionTask')).toMatchObject({
      effective_budget: { ...resolveTaskBudget('JevScoringDecisionTask'), maxIterations: null },
      budget_wiring: { maxIterations: false, maxCost: true, transientRetries: true, timeout: true },
      override_wired: { provider: false, model: false, budget: false },
      global_pin: null,
    });
    await setConfig(
      'task.AttributionTask.budget',
      { timeout: 345_678 },
      { actor: 'cli' },
      testDb(),
    );
    expect(frozen.timeout).toBe(123_456);
    expect(resolveTaskBudget('AttributionTask').timeout).toBe(345_678);
    await clearConfig('task.AttributionTask.budget', { actor: 'cli' }, testDb());
    const cleared = AdminConfigResponseSchema.parse(await (await get()).json()).tasks.find(
      (row) => row.kind === 'AttributionTask',
    );
    expect(cleared?.effective_budget.timeout).toBe(cleared?.default_budget.timeout);
  });
});
