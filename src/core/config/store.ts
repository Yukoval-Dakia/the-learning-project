// YUK-1007 — 热加载配置的同步读面（grounding §1.3/§2.1）。
//
// 架构：模块级 in-memory 快照 + 周期 refresh（subject hydrate 先例）。
//   - 快照由 src/server/config/hydrate.ts 的 hydrateConfigFromDb 整块替换
//     （atomic swap，= replaceSubjectTraitResolutions 先例）；DB 缺席/坏行 →
//     保留 last-good / 空快照（纯 env 行为 = 迁移前 byte-identical 回滚位）。
//   - 读值 = Map.get + env fallback——零 DB、同步、可在构造函数/hot path 调用
//     （resolveTaskProvider 在 AiRunLifecycle 构造器内同步调用）。
//   - 测试注入：`setTestConfig` / `resetTestConfig` 写内存 overlay（不进 DB），
//     overlay 压过所有层（含 env pin）——fixture 语义 = 「观测解析后的生效值」，
//     与 vi.stubEnv 的 describe/set + afterEach/reset 用法对齐（§6.4）。
//
// 分层（每 key，见 registry.ts 注释）：
//   envMode='priority' → env 显式 > DB > codeDefault（AI_PROVIDER_OVERRIDE pin）
//   envMode='pinned'   → env > codeDefault，DB 层跳过（compose 强制三键）
//   其余               → DB > env > codeDefault

import { type ConfigKeyDef, type ConfigSource, type ConfigValue, resolveKeyDef } from './registry';

export type { ConfigOverride, ConfigSource, ConfigValue } from './registry';
export { CONFIG_REGISTRY, matchDynamicConfigKey, resolveKeyDef } from './registry';

/** 快照里一行：DB 层生效值 + 溯源列。 */
export interface ConfigSnapshotEntry {
  value: ConfigValue;
  revision: number;
  updatedAt: string | null;
}

export interface ConfigSnapshot {
  /** 本快照对应的 DB epoch（system_config_epoch.epoch；缺表/未写 = 0）。 */
  epoch: number;
  entries: ReadonlyMap<string, ConfigSnapshotEntry>;
  hydratedAt: string;
}

let snapshot: ConfigSnapshot = { epoch: 0, entries: new Map(), hydratedAt: '' };

/** 测试 overlay：直接写快照层（幂等覆盖 DB 值）。 */
const testOverlay = new Map<string, ConfigValue>();

/** hydrateConfigFromDb 调用：整块替换快照引用（读侧无锁安全）。 */
export function replaceConfigSnapshot(next: ConfigSnapshot): void {
  snapshot = next;
}

export function getConfigSnapshot(): ConfigSnapshot {
  return snapshot;
}

export function getConfigSnapshotEpoch(): number {
  return snapshot.epoch;
}

/**
 * 注入测试配置值（写内存快照 overlay，不进 DB）。overlay 压过所有层——
 * 测试用它断言「读侧看到 resolved 值」，env 层测试仍可另设 env。
 */
export function setTestConfig(values: Record<string, ConfigValue | undefined>): void {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) testOverlay.delete(key);
    else testOverlay.set(key, value);
  }
}

export function resetTestConfig(): void {
  testOverlay.clear();
}

// ─── 读面 ──────────────────────────────────────────────────────────────────

export interface ResolvedConfig {
  value: ConfigValue | undefined;
  source: ConfigSource;
  /** DB 层命中时的行溯源（读面徽标直供）。 */
  revision?: number;
  updatedAt?: string | null;
}

function envValueFor(
  def: ConfigKeyDef,
  _key: string,
  env: NodeJS.ProcessEnv,
): { raw: string | undefined; parsed: ConfigValue | undefined; expressed: boolean } {
  const envName = def.envName;
  if (!envName) return { raw: undefined, parsed: undefined, expressed: false };
  const raw = env[envName];
  if (raw === undefined) return { raw, parsed: undefined, expressed: false };
  const parsed = def.envParse ? def.envParse(raw) : raw;
  return { raw, parsed, expressed: parsed !== undefined };
}

function dbValueFor(key: string): { entry?: ConfigSnapshotEntry; test: boolean } {
  if (testOverlay.has(key)) {
    return {
      entry: { value: testOverlay.get(key) as ConfigValue, revision: -1, updatedAt: null },
      test: true,
    };
  }
  const entry = snapshot.entries.get(key);
  return entry ? { entry, test: false } : { test: false };
}

/**
 * 解析单 key 的生效值 + 来源（never-throws：未登记 key → env 原文直读 /
 * code-default=undefined，不炸调用点）。
 *
 * `env` 参数是给既有「env 形参注入」reader 的迁移 seam（默认 process.env）；
 * 传入 custom env 不改变分层顺序（DB 层依旧压过它）——fixture 断言 DB 值生效时
 * 用 `setTestConfig`（overlay 恒最上层）。
 */
export function resolveConfigValue(
  key: string,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedConfig {
  const def = resolveKeyDef(key);
  if (!def) {
    const raw = env[key];
    return raw !== undefined
      ? { value: raw, source: 'env' }
      : { value: undefined, source: 'code-default' };
  }
  const mode = def.envMode ?? 'fallback';
  const envResult = envValueFor(def, key, env);

  // pinned（compose-forced）：直读 env > code-default；DB 行存在也不生效（写端 409 拦下）。
  if (mode === 'pinned') {
    if (envResult.expressed) return { value: envResult.parsed, source: 'compose-forced' };
    return { value: def.codeDefault, source: 'code-default' };
  }

  // priority（operator pin）：env 显式 > DB > code-default。
  if (mode === 'priority' && envResult.expressed) {
    return { value: envResult.parsed, source: 'env' };
  }

  const db = dbValueFor(key);
  if (db.entry) {
    return {
      value: db.entry.value,
      source: 'db',
      revision: db.entry.revision,
      updatedAt: db.entry.updatedAt,
    };
  }
  if (envResult.expressed) return { value: envResult.parsed, source: 'env' };
  return { value: def.codeDefault, source: 'code-default' };
}

/** 规范读点：DB > env > code-default（priority/pinned 例外见 resolveConfigValue）。 */
export function getConfig(
  key: string,
  env: NodeJS.ProcessEnv = process.env,
): ConfigValue | undefined {
  return resolveConfigValue(key, env).value;
}

/** flag 专用糖：非 boolean 的 resolved 值（脏 overlay / 畸形手工行）按 false 兜底，防 Boolean('false')=true 事故。 */
export function getConfigFlag(key: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveConfigValue(key, env).value === true;
}

/** 读面溯源列（'db' | 'env' | 'code-default' | 'compose-forced'）。 */
export function getConfigSource(key: string, env: NodeJS.ProcessEnv = process.env): ConfigSource {
  return resolveConfigValue(key, env).source;
}

/** 同批多 key（rate-limit resolveConfig 那类一把抓）。 */
export function getConfigMany(
  keys: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Record<string, ConfigValue | undefined> {
  const out: Record<string, ConfigValue | undefined> = {};
  for (const key of keys) out[key] = resolveConfigValue(key, env).value;
  return out;
}

/** task.<kind>.provider / .model / .budget 三键合取（DB-only 层，§1.5）。 */
export function getTaskOverride(kind: string):
  | {
      provider?: string;
      model?: string;
      budget?: {
        maxIterations?: number;
        maxCost?: number;
        transientRetries?: number;
        timeout?: number;
      };
    }
  | undefined {
  const provider = dbValueFor(`task.${kind}.provider`)?.entry?.value;
  const model = dbValueFor(`task.${kind}.model`)?.entry?.value;
  const budget = dbValueFor(`task.${kind}.budget`)?.entry?.value;
  if (provider === undefined && model === undefined && budget === undefined) return undefined;
  return {
    ...(typeof provider === 'string' ? { provider } : {}),
    ...(typeof model === 'string' ? { model } : {}),
    ...(budget !== undefined
      ? {
          budget: budget as {
            maxIterations?: number;
            maxCost?: number;
            transientRetries?: number;
            timeout?: number;
          },
        }
      : {}),
  };
}

/** lane.<lane>.provider / .model 合取（env fallback 层经 registry envName 每 key 各读）。 */
export function getLaneOverride(
  lane: string,
  env: NodeJS.ProcessEnv = process.env,
): { provider?: string; model?: string } | undefined {
  const provider = resolveConfigValue(`lane.${lane}.provider`, env).value;
  const model = resolveConfigValue(`lane.${lane}.model`, env).value;
  if (provider === undefined && model === undefined) return undefined;
  return {
    ...(typeof provider === 'string' ? { provider } : {}),
    ...(typeof model === 'string' ? { model } : {}),
  };
}
