// YUK-1007 — 配置读模型单测（无 DB；快照/env 直接注入）。
//
// 覆盖面（lane 验收矩阵）：
//   - 分层四态：code-default / env / db / compose-forced（pinned）
//   - priority 键的 env pin > DB（lane.global.*）
//   - fallback 键的 DB > env
//   - pinned 键 DB 层跳过（compose 强制）
//   - NaN env 字面量归 null（不进 JSON）
//   - wiring 分类完整性（KEY_CONSUMERS ↔ CONFIG_REGISTRY 集合相等 + consumer
//     文件真实存在）+ locale.learner 未接线 + task budget 字段未接线
//   - tasks 物化：kind 集合 = catalog；静态默认与 override 分列；global_pin
//   - 快照块 epoch/hydrated_at
//   - secret 不进响应（结构保证 + 实测 marker 不出现）
//   - 契约等价：装配产物过 AdminConfigResponseSchema.safeParse
import { existsSync } from 'node:fs';

import { afterEach, describe, expect, it } from 'vitest';

import { tasks } from '@/ai/registry';
import { CONFIG_REGISTRY, replaceConfigSnapshot, resetTestConfig } from '@/core/config/store';

import { AdminConfigResponseSchema } from '../api/admin-config-contracts';
import {
  type AdminConfigKeyRow,
  KEY_CONSUMERS,
  buildAdminConfigReadModel,
} from './config-read-model';

const EMPTY_SNAPSHOT = { epoch: 0, entries: new Map(), hydratedAt: '' };

afterEach(() => {
  resetTestConfig();
  replaceConfigSnapshot(EMPTY_SNAPSHOT);
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

  it('reports locale.learner as registered but unwired (prompt builder not migrated)', () => {
    const model = buildAdminConfigReadModel({});
    expect(keyRow(model, 'locale.learner')).toMatchObject({
      wired: false,
      consumer: null,
      value: 'zh-CN',
      source: 'code-default',
    });
  });

  it('marks task override budget as unwired while provider/model are wired', () => {
    const model = buildAdminConfigReadModel({});
    const attribution = model.tasks.find((row) => row.kind === 'AttributionTask');
    if (!attribution) throw new Error('missing AttributionTask row');
    expect(attribution.override_wired).toEqual({ provider: true, model: true, budget: false });
  });
});

describe('config read model — task materialization', () => {
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
    // 静态默认不动——budget 覆盖存而不读（未接线）由 override_wired 单独标注。
    expect(attribution.default_provider).toBe(tasks.AttributionTask.defaultProvider);
    expect(attribution.override_wired.budget).toBe(false);
  });

  it('surfaces the global pin (env > DB) on every task row when set', () => {
    const model = buildAdminConfigReadModel({ AI_PROVIDER_OVERRIDE: 'anthropic-sub' });
    for (const row of model.tasks) {
      expect(row.global_pin).toEqual({ provider: 'anthropic-sub' });
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
      expect(row.global_pin).toEqual({ provider: 'anthropic-sub' });
    }
    // 同一 DB model 行在 env pin 缺席时进入 pin（混合对 = getLaneOverride 语义）。
    const unpinned = buildAdminConfigReadModel({});
    for (const row of unpinned.tasks) {
      expect(row.global_pin).toEqual({ model: 'gpt-6-astra' });
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
