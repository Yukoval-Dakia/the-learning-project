// YUK-1007 — 配置读模型单测（无 DB；快照/env 直接注入）。
//
// 覆盖面（lane 验收矩阵）：
//   - 分层四态：code-default / env / db / compose-forced（pinned）
//   - priority 键的 env pin > DB（lane.global.*）
//   - fallback 键的 DB > env
//   - pinned 键 DB 层跳过（compose 强制）
//   - NaN env 字面量归 null（不进 JSON）
//   - wiring 分类完整性（KEY_CONSUMERS ↔ CONFIG_REGISTRY 集合相等 + consumer
//     文件真实存在）+ locale.learner 已接线 + task budget 逐字段接线
//   - tasks 物化：kind 集合 = catalog；静态默认与 override 分列；global_pin
//   - 快照块 epoch/hydrated_at
//   - secret 不进响应（结构保证 + 实测 marker 不出现）
//   - 契约等价：装配产物过 AdminConfigResponseSchema.safeParse
import { existsSync } from 'node:fs';

// db/r2 mock：observabilityConfigEffectiveFacts → backup-import → db/client +
// r2 的模块链不能进 unit 分区（db/client 顶层校验 DATABASE_URL；先例：
// api/backup-import.unit.test.ts 同样 mock）。maxBackupUploadBytes 本身零 DB/r2
// 触碰——mock 只为模块可加载。
vi.mock('@/db/client', () => ({ db: {} }));
vi.mock('@/server/r2', () => ({
  getR2: () => {
    throw new Error('unused in unit test');
  },
  createR2Client: () => {
    throw new Error('unused in unit test');
  },
}));

import { afterEach, describe, expect, it, vi } from 'vitest';
import { tasks } from '@/ai/registry';
import { capabilities } from '@/capabilities';
import { CONFIG_REGISTRY, replaceConfigSnapshot, resetTestConfig } from '@/core/config/store';
import { projectDagMembers } from '@/kernel/manifest';
import { hasGlobalProviderOverride, resolveTaskProvider } from '@/server/ai/providers';

import { AdminConfigResponseSchema } from '../api/admin-config-contracts';
import type { AdminConfigRuntimeFacts } from './admin-config-facts';
import { observabilityConfigEffectiveFacts } from './config-effective-facts';
import {
  type AdminConfigKeyRow,
  KEY_CONSUMERS,
  buildAdminConfigReadModel,
} from './config-read-model';

const EMPTY_SNAPSHOT = { epoch: 0, entries: new Map(), hydratedAt: '' };

afterEach(() => {
  resetTestConfig();
  replaceConfigSnapshot(EMPTY_SNAPSHOT);
  vi.unstubAllEnvs();
});

function keyRow(
  model: ReturnType<typeof buildAdminConfigReadModel>,
  key: string,
): AdminConfigKeyRow {
  const row = model.keys.find((candidate) => candidate.key === key);
  if (!row) throw new Error(`missing key row: ${key}`);
  return row;
}

describe('config read model — layering', () => {
  it('resolves to code-default with classified metadata when env and DB are absent', () => {
    const model = buildAdminConfigReadModel({});
    const row = keyRow(model, 'JUDGE_DURABLE_ENABLED');
    expect(row).toMatchObject({
      value: false,
      source: 'code-default',
      default: false,
      env_name: 'JUDGE_DURABLE_ENABLED',
      env_mode: 'fallback',
      tier: 'A',
      read_only: false,
      wired: true,
      revision: null,
      updated_at: null,
    });
    expect(typeof row.consumer).toBe('string');
  });

  it('resolves the env fallback layer for a fallback-mode key', () => {
    const model = buildAdminConfigReadModel({ SELECTION_POLICY: 'legacy' });
    expect(keyRow(model, 'SELECTION_POLICY')).toMatchObject({ value: 'legacy', source: 'env' });
  });

  it('keeps the original bare-literal env semantics: unrecognized value falls to code-default', () => {
    const model = buildAdminConfigReadModel({ SELECTION_POLICY: ' legacy ' });
    expect(keyRow(model, 'SELECTION_POLICY')).toMatchObject({
      value: 'softmax_mfi',
      source: 'code-default',
    });
  });

  it('DB row beats env for a fallback-mode key and surfaces revision/updated_at', () => {
    replaceConfigSnapshot({
      epoch: 7,
      entries: new Map([
        ['JUDGE_DURABLE_ENABLED', { value: true, revision: 3, updatedAt: '2026-09-29T00:00:00Z' }],
      ]),
      hydratedAt: '2026-09-29T00:00:01Z',
    });
    const model = buildAdminConfigReadModel({ JUDGE_DURABLE_ENABLED: 'false' });
    expect(keyRow(model, 'JUDGE_DURABLE_ENABLED')).toMatchObject({
      value: true,
      source: 'db',
      revision: 3,
      updated_at: '2026-09-29T00:00:00Z',
    });
  });

  it('env pin beats DB row for a priority-mode key (operator kill-switch)', () => {
    replaceConfigSnapshot({
      epoch: 7,
      entries: new Map([
        ['lane.global.provider', { value: 'openai', revision: 1, updatedAt: null }],
      ]),
      hydratedAt: '2026-09-29T00:00:01Z',
    });
    const model = buildAdminConfigReadModel({ AI_PROVIDER_OVERRIDE: 'anthropic-sub' });
    expect(keyRow(model, 'lane.global.provider')).toMatchObject({
      value: 'anthropic-sub',
      source: 'env',
      env_mode: 'priority',
    });
    // 同一 DB 行在 env pin 缺席时生效（DB 全局位）。
    const unpinned = buildAdminConfigReadModel({});
    expect(keyRow(unpinned, 'lane.global.provider')).toMatchObject({
      value: 'openai',
      source: 'db',
      revision: 1,
    });
  });

  it('pinned (compose-forced) keys read env only — DB rows are skipped, read_only is true', () => {
    replaceConfigSnapshot({
      epoch: 7,
      entries: new Map([
        ['PLACEMENT_PROBE_ENABLED', { value: false, revision: 9, updatedAt: null }],
      ]),
      hydratedAt: '2026-09-29T00:00:01Z',
    });
    const model = buildAdminConfigReadModel({ PLACEMENT_PROBE_ENABLED: 'true' });
    expect(keyRow(model, 'PLACEMENT_PROBE_ENABLED')).toMatchObject({
      value: true,
      source: 'compose-forced',
      env_mode: 'pinned',
      read_only: true,
      revision: null,
    });
  });

  it('normalizes non-finite env literals (NaN) to null instead of leaking them into JSON', () => {
    const model = buildAdminConfigReadModel({ BACKUP_IMPORT_MAX_BYTES: 'not-a-number' });
    const row = keyRow(model, 'BACKUP_IMPORT_MAX_BYTES');
    expect(row.value).toBeNull();
    expect(row.source).toBe('env');
    expect(JSON.parse(JSON.stringify(row)).value).toBeNull();
  });

  it('exposes registry notes (P2 risk annotations) on the rows that carry them', () => {
    const model = buildAdminConfigReadModel({});
    expect(keyRow(model, 'HUB_SYNC_MODE').note).toContain('kill switch');
  });
});

describe('config read model — wiring census', () => {
  it('classifies every CONFIG_REGISTRY key exactly once (no unclassified, no stale entries)', () => {
    const registryKeys = new Set(Object.keys(CONFIG_REGISTRY));
    const wiringKeys = new Set(Object.keys(KEY_CONSUMERS));
    expect([...registryKeys].filter((k) => !wiringKeys.has(k))).toEqual([]);
    expect([...wiringKeys].filter((k) => !registryKeys.has(k))).toEqual([]);
  });

  it('declares only real consumer files (wired rows point at existing sources)', () => {
    for (const [key, consumer] of Object.entries(KEY_CONSUMERS)) {
      if (consumer === null) continue;
      // cwd = 仓库根（vitest project root）；路径错 = reader 挪位后未更新 census。
      expect(existsSync(consumer), `${key} -> ${consumer}`).toBe(true);
    }
  });

  it('reports locale.learner as wired to the prompt builder', () => {
    const model = buildAdminConfigReadModel({});
    expect(keyRow(model, 'locale.learner')).toMatchObject({
      wired: true,
      consumer: 'src/ai/task-prompts.ts',
      value: 'zh-CN',
      source: 'code-default',
    });
  });

  it('keeps the whole-budget flag conservative and reports individual consumers', () => {
    const model = buildAdminConfigReadModel({});
    const attribution = model.tasks.find((row) => row.kind === 'AttributionTask');
    if (!attribution) throw new Error('missing AttributionTask row');
    expect(attribution.override_wired).toEqual({ provider: true, model: true, budget: false });
    expect(attribution.budget_wiring).toEqual({
      maxIterations: true,
      maxCost: false,
      transientRetries: true,
      timeout: true,
    });
    expect(attribution.effective_budget).toEqual({
      ...tasks.AttributionTask.budget,
      maxCost: null,
    });
  });
});

describe('config read model — task materialization', () => {
  it('typed tasks retain their fixed binding and do not claim global or per-task override wiring', () => {
    replaceConfigSnapshot({
      epoch: 4,
      hydratedAt: '2026-09-30T00:00:00Z',
      entries: new Map([
        ['task.JevScoringDecisionTask.provider', { value: 'openai', revision: 1, updatedAt: null }],
        [
          'task.JevScoringDecisionTask.model',
          { value: 'gpt-6-astra', revision: 1, updatedAt: null },
        ],
      ]),
    });
    const model = buildAdminConfigReadModel({
      AI_PROVIDER_OVERRIDE: 'xiaomi',
      AI_PROVIDER_MODEL: 'mimo-v2.5-pro',
    });
    const typed = model.tasks.find((row) => row.kind === 'JevScoringDecisionTask');
    expect(typed).toMatchObject({
      default_provider: 'openrouter',
      default_model: 'typesafe/jev-1.13',
      global_pin: null,
      override_wired: { provider: false, model: false, budget: false },
      override: { provider: 'openai', model: 'gpt-6-astra' },
      budget_wiring: { maxIterations: false, maxCost: true, transientRetries: true, timeout: true },
      effective_budget: { ...tasks.JevScoringDecisionTask.budget, maxIterations: null },
    });
  });

  it('materializes one row per catalog TaskSpec with static defaults kept separate from overrides', () => {
    const model = buildAdminConfigReadModel({});
    expect(model.tasks.map((row) => row.kind).sort()).toEqual(Object.keys(tasks).sort());

    const attribution = model.tasks.find((row) => row.kind === 'AttributionTask');
    if (!attribution) throw new Error('missing AttributionTask row');
    expect(attribution.default_provider).toBe(tasks.AttributionTask.defaultProvider);
    expect(attribution.default_model).toBe(tasks.AttributionTask.defaultModel);
    expect(attribution.default_budget).toEqual(tasks.AttributionTask.budget);
    // 无 DB 覆盖时 override 如实为 null，不虚造行。
    expect(attribution.override).toBeNull();
    expect(attribution.global_pin).toBeNull();
  });

  it('surfaces DB per-task overrides (provider/model/budget presence) without claiming defaults changed', () => {
    replaceConfigSnapshot({
      epoch: 4,
      entries: new Map([
        ['task.AttributionTask.provider', { value: 'openai', revision: 1, updatedAt: null }],
        [
          'task.AttributionTask.budget',
          { value: { maxIterations: 2 }, revision: 1, updatedAt: null },
        ],
      ]),
      hydratedAt: '2026-09-29T00:00:01Z',
    });
    const model = buildAdminConfigReadModel({});
    const attribution = model.tasks.find((row) => row.kind === 'AttributionTask');
    if (!attribution) throw new Error('missing AttributionTask row');
    expect(attribution.override).toEqual({
      provider: 'openai',
      budget: { maxIterations: 2 },
    });
    // 静态默认不动；maxCost未消费，whole-budget标志仍保守为false。
    expect(attribution.default_provider).toBe(tasks.AttributionTask.defaultProvider);
    expect(attribution.override_wired.budget).toBe(false);
    expect(attribution.effective_budget.maxIterations).toBe(2);
    expect(attribution.effective_budget.maxCost).toBeNull();
  });

  it('surfaces the global pin (env > DB) on every task row when set', () => {
    const model = buildAdminConfigReadModel({ AI_PROVIDER_OVERRIDE: 'anthropic-sub' });
    for (const row of model.tasks) {
      expect(row.global_pin).toEqual(
        row.kind === 'JevScoringDecisionTask' ? null : { provider: 'anthropic-sub' },
      );
    }
  });

  it('mirrors the caller all-or-nothing env pin: DB model is NOT reported under an env provider pin', () => {
    // readGlobalProviderSwitch 语义：operator 钉了 env provider 就整体返回 env
    // 对——DB lane.global.model 行在场也不进入 pin（runtime 不消费它）。
    replaceConfigSnapshot({
      epoch: 5,
      entries: new Map([
        ['lane.global.model', { value: 'gpt-6-astra', revision: 1, updatedAt: null }],
      ]),
      hydratedAt: '2026-09-29T00:00:01Z',
    });
    const pinned = buildAdminConfigReadModel({ AI_PROVIDER_OVERRIDE: 'anthropic-sub' });
    for (const row of pinned.tasks) {
      expect(row.global_pin).toEqual(
        row.kind === 'JevScoringDecisionTask' ? null : { provider: 'anthropic-sub' },
      );
    }
    // 同一 DB model 行在 env pin 缺席时同样是惰性的（见下一个真实 resolver 对照测试）。
  });

  it('REGRESSION (real-resolver cross-check): a model-only DB lane.global row is inert at runtime — global_pin must be null', () => {
    // P1 (review + OCR + Standards)：readGlobalProviderSwitch 的 DB 支路以
    // provider 在场为门（providers.ts `if (!db?.provider) return undefined`）——
    // 只有 lane.global.model 而无 lane.global.provider 的 DB 行在运行时**不生效**。
    // 本测试用真实 resolver（providers.ts 导出面）钉住运行时真相，再要求读面
    // 与之一致；旧的读面实现把 { model } 报成生效中的 global_pin（虚报），
    // 原单测 243-247 行钉死了该错误形状。
    replaceConfigSnapshot({
      epoch: 5,
      entries: new Map([
        ['lane.global.model', { value: 'gpt-6-astra', revision: 1, updatedAt: null }],
      ]),
      hydratedAt: '2026-09-29T00:00:01Z',
    });
    // 运行时真相 #1：无 provider ⇒ 无任何 override（hasGlobalProviderOverride=false）。
    vi.stubEnv('AI_PROVIDER_OVERRIDE', '');
    vi.stubEnv('AI_PROVIDER_MODEL', '');
    expect(hasGlobalProviderOverride()).toBe(false);
    // 运行时真相 #2：AttributionTask 仍解析到 registry 默认 xiaomi/mimo-v2.5-pro，
    // 而非孤儿 DB model gpt-6-astra。
    vi.stubEnv('XIAOMI_API_KEY', 'unit-test-presence-only-key');
    const resolved = resolveTaskProvider('AttributionTask');
    expect(resolved.provider).toBe('xiaomi');
    expect(resolved.model).toBe('mimo-v2.5-pro');
    // 读面必须与 resolver 一致：global_pin=null（而不是 { model: 'gpt-6-astra' }）。
    const model = buildAdminConfigReadModel({ XIAOMI_API_KEY: 'unit-test-presence-only-key' });
    for (const row of model.tasks) {
      expect(row.global_pin).toBeNull();
    }
  });

  it('reports a DB provider+model pair as the global pin, and a provider-only pair without model', () => {
    replaceConfigSnapshot({
      epoch: 5,
      entries: new Map([
        ['lane.global.provider', { value: 'openai', revision: 1, updatedAt: null }],
        ['lane.global.model', { value: 'gpt-6-astra', revision: 1, updatedAt: null }],
      ]),
      hydratedAt: '2026-09-29T00:00:01Z',
    });
    const pair = buildAdminConfigReadModel({});
    for (const row of pair.tasks) {
      expect(row.global_pin).toEqual(
        row.kind === 'JevScoringDecisionTask' ? null : { provider: 'openai', model: 'gpt-6-astra' },
      );
    }

    replaceConfigSnapshot({
      epoch: 6,
      entries: new Map([
        ['lane.global.provider', { value: 'openai', revision: 1, updatedAt: null }],
      ]),
      hydratedAt: '2026-09-29T00:00:01Z',
    });
    const providerOnly = buildAdminConfigReadModel({});
    for (const row of providerOnly.tasks) {
      expect(row.global_pin).toEqual(
        row.kind === 'JevScoringDecisionTask' ? null : { provider: 'openai' },
      );
    }
  });
});

describe('config read model — snapshot + honesty blocks', () => {
  it('reports snapshot epoch and hydrated_at; empty snapshot reads epoch 0 / null', () => {
    expect(buildAdminConfigReadModel({}).snapshot).toEqual({ epoch: 0, hydrated_at: null });

    replaceConfigSnapshot({ epoch: 12, entries: new Map(), hydratedAt: '2026-09-29T01:02:03Z' });
    expect(buildAdminConfigReadModel({}).snapshot).toEqual({
      epoch: 12,
      hydrated_at: '2026-09-29T01:02:03Z',
    });
  });

  it('never leaks secret env material: markers set in env do not appear anywhere in the payload', () => {
    const env = {
      INTERNAL_TOKEN: 'smoke-secret-token-marker-9f1a',
      DATABASE_URL: 'postgres://smoke-secret-user:smoke-secret-pass@127.0.0.1:5432/nope',
      XIAOMI_API_KEY: 'sk-smoke-secret-xiaomi',
      ANTHROPIC_API_KEY: 'sk-ant-smoke-secret',
      OPENAI_API_KEY: 'sk-smoke-secret-openai',
    };
    const serialized = JSON.stringify(buildAdminConfigReadModel(env));
    for (const marker of [
      'smoke-secret-token-marker-9f1a',
      'smoke-secret-user',
      'smoke-secret-pass',
      'sk-smoke-secret-xiaomi',
      'sk-ant-smoke-secret',
      'sk-smoke-secret-openai',
    ]) {
      expect(serialized.includes(marker), marker).toBe(false);
    }
  });

  it('only enumerates registered env names — the payload carries no process.env dump', () => {
    const env = { TOTALLY_UNRELATED_SECRETISH_KEY: 'leak-canary-value-7742' };
    expect(JSON.stringify(buildAdminConfigReadModel(env)).includes('leak-canary-value-7742')).toBe(
      false,
    );
  });
});

describe('config read model — schedules (real declaration sources)', () => {
  it('projects manifest cron rows from capabilities[] (no hand-copied list) and never includes DAG members', () => {
    const expected = capabilities
      .flatMap((cap) => (cap.jobs?.handlers ?? []).map((job) => ({ cap, job })))
      .filter(({ job }) => job.schedule !== undefined)
      .map(({ cap, job }) => `${job.name}|${job.schedule?.cron}|${job.schedule?.tz}|${cap.name}`)
      .sort();
    const model = buildAdminConfigReadModel({});
    expect(model.facts_injected).toBe(false);
    const manifestRows = model.schedules.rows.filter((row) => row.source === 'capability-manifest');
    expect(manifestRows.map((row) => `${row.name}|${row.cron}|${row.tz}|${row.owner}`)).toEqual(
      expected,
    );
    // DAG 成员（dependsOn 存在）无 cron——由 orchestrator 触发，绝不能出现在 cron 表。
    const dagNames = new Set(projectDagMembers(capabilities).map((member) => member.name));
    for (const row of manifestRows) {
      expect(
        dagNames.has(row.name),
        `${row.name} is a DAG member and must not carry a cron row`,
      ).toBe(false);
    }
    expect(model.schedules.read_only_note).toContain('只读');
    expect(model.schedules.read_only_note).toContain('不触发');
  });
});

/** 注入 facts 的共享 fixture（divergence 用例复用 runtime 块）。 */
const FACTS: AdminConfigRuntimeFacts = {
  providers: [
    {
      name: 'xiaomi',
      auth_mode: 'key',
      credential_env: 'XIAOMI_API_KEY',
      key_present: true,
      implemented: true,
    },
    {
      name: 'openrouter',
      auth_mode: 'key',
      credential_env: 'OPENROUTER_API_KEY',
      key_present: false,
      implemented: false,
    },
  ],
  infra_schedules: [
    {
      name: 'prune_job_events',
      cron: '0 4 * * *',
      tz: 'Asia/Shanghai',
      owner: 'server/boss',
      queue: 'fast',
      source: 'server-boss-infra',
    },
  ],
  runtime: {
    port: 8787,
    db_pool_max: 10,
    queue_tiers: {
      expire_seconds: { fast: 3600, llm: 3600, agent: 7200 },
      retention_seconds: 604_800,
    },
    orchestration: {
      anchor_cron: '30 2 * * *',
      tz: 'Asia/Shanghai',
      queue: 'nightly_orchestrator',
      catchup_window_seconds: 18_000,
      tick_interval_seconds: 60,
      node_timeout_seconds: 25_200,
      layer_stagger_seconds: 120,
      dag_members: ['answer_class_materialize'],
    },
  },
  effective_values: {
    WORKFLOW_JUDGE_AUTO_ENROLL_THRESHOLD: { value: 1 },
    AI_PROVIDER_ATTEMPT_ADMISSION_MODE: {
      note: '按 lane 在读取时解析；无单一标量 effective',
    },
  },
};

describe('config read model — injected runtime facts (providers / runtime / effective)', () => {
  it('surfaces providers (presence booleans only), infra schedule rows, and runtime when injected', () => {
    const model = buildAdminConfigReadModel({}, FACTS);
    expect(model.facts_injected).toBe(true);
    expect(model.providers.map((row) => row.name)).toEqual(['openrouter', 'xiaomi']); // 排序稳定
    expect(model.providers[1]).toEqual({
      name: 'xiaomi',
      auth_mode: 'key',
      credential_env: 'XIAOMI_API_KEY',
      key_present: true,
      implemented: true,
    });
    const infra = model.schedules.rows.filter((row) => row.source === 'server-boss-infra');
    expect(infra.map((row) => row.name)).toEqual(['prune_job_events']);
    expect(model.runtime?.port).toBe(8787);
    expect(model.runtime?.orchestration.dag_members).toEqual(['answer_class_materialize']);
    // effective：值型上列 value，note 型只给 note（不伪造标量）。
    expect(keyRow(model, 'WORKFLOW_JUDGE_AUTO_ENROLL_THRESHOLD').effective).toBe(1);
    expect(keyRow(model, 'AI_PROVIDER_ATTEMPT_ADMISSION_MODE').effective).toBeUndefined();
    expect(keyRow(model, 'AI_PROVIDER_ATTEMPT_ADMISSION_MODE').effective_note).toContain('lane');
  });

  it('reports uninjected honestly: facts_injected=false, empty providers, manifest-only schedules, runtime null, no effective', () => {
    const model = buildAdminConfigReadModel({});
    expect(model.facts_injected).toBe(false);
    expect(model.providers).toEqual([]);
    expect(model.schedules.rows.every((row) => row.source === 'capability-manifest')).toBe(true);
    expect(model.runtime).toBeNull();
    for (const row of model.keys) {
      expect(row.effective, row.key).toBeUndefined();
      expect(row.effective_note, row.key).toBeUndefined();
    }
  });

  it('never serializes credential VALUES: provider rows carry env names and booleans only', () => {
    const env = { XIAOMI_API_KEY: 'sk-provider-canary-secret-value-7742' };
    const model = buildAdminConfigReadModel(env, {
      ...FACTS,
      effective_values: {},
    });
    const serialized = JSON.stringify(model);
    expect(serialized.includes('sk-provider-canary-secret-value-7742')).toBe(false);
    // env 名字（非值）允许且必须在场，供 operator 自查。
    expect(serialized.includes('XIAOMI_API_KEY')).toBe(true);
  });
});

describe('config read model — consumer-effective divergence (real reader)', () => {
  it('BACKUP_IMPORT_MAX_BYTES: configured 1 vs effective 1_000_000_000 via the real reader (floor fallback)', () => {
    vi.stubEnv('BACKUP_IMPORT_MAX_BYTES', '1');
    const facts: AdminConfigRuntimeFacts = {
      ...FACTS,
      providers: [],
      infra_schedules: [],
      effective_values: observabilityConfigEffectiveFacts(),
    };
    const model = buildAdminConfigReadModel({ BACKUP_IMPORT_MAX_BYTES: '1' }, facts);
    const row = keyRow(model, 'BACKUP_IMPORT_MAX_BYTES');
    // configured/resolved 值如实报 1（env 层）……
    expect(row.value).toBe(1);
    expect(row.source).toBe('env');
    // ……但真实 reader 因 1MB 地板回退 1GB——effective 必须分列，不再虚报。
    expect(row.effective).toBe(1_000_000_000);
    expect(row.effective_note).toContain('1GB');
  });

  it('BACKUP_IMPORT_MAX_BYTES: NaN env literal resolves to null while the reader still falls back to 1GB', () => {
    vi.stubEnv('BACKUP_IMPORT_MAX_BYTES', 'not-a-number');
    const facts: AdminConfigRuntimeFacts = {
      ...FACTS,
      providers: [],
      infra_schedules: [],
      effective_values: observabilityConfigEffectiveFacts(),
    };
    const row = keyRow(
      buildAdminConfigReadModel({ BACKUP_IMPORT_MAX_BYTES: 'not-a-number' }, facts),
      'BACKUP_IMPORT_MAX_BYTES',
    );
    expect(row.value).toBeNull();
    expect(row.effective).toBe(1_000_000_000);
  });
});

describe('config read model — contract equivalence', () => {
  it('produces payloads that satisfy the manifest response schema', () => {
    replaceConfigSnapshot({
      epoch: 3,
      entries: new Map([
        ['task.AttributionTask.model', { value: 'gpt-6-astra', revision: 2, updatedAt: null }],
        ['locale.learner', { value: 'en', revision: 1, updatedAt: null }],
      ]),
      hydratedAt: '2026-09-29T00:00:00Z',
    });
    const model = buildAdminConfigReadModel({
      AI_PROVIDER_OVERRIDE: 'anthropic-sub',
      AI_PROVIDER_MODEL: 'claude-opus-4-8',
      INTERVENTION_DISABLED_METHOD_IDS: 'm1,m2',
      HUB_SYNC_MODE: 'apply',
    });
    const parsed = AdminConfigResponseSchema.safeParse(JSON.parse(JSON.stringify(model)));
    if (!parsed.success) throw new Error(JSON.stringify(parsed.error.issues, null, 2));
    expect(parsed.data.keys.length).toBe(Object.keys(CONFIG_REGISTRY).length);
    expect(parsed.data.tasks.length).toBe(Object.keys(tasks).length);
  });
});
