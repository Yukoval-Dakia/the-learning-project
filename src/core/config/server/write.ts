// YUK-1007 — 配置写面（配置 owner，core/config/server）。grounding §1.4/§6.3：
// provider 注册表/catalog/任务 catalog/推理档属于 AI 与任务 owner，经
// ConfigWritePorts 在组合根注入；本模块只拥有校验、事务、epoch/journal 与并发语义。
//
//   setConfig(key, value, {actor, note?})  — 单 key upsert + journal + epoch 同 tx，
//                                            commit 后即时 hydrate（本进程 0 延迟）。
//   clearConfig(key, {actor, note?})       — 删行（=「恢复默认」按钮落点），
//                                            journal action='clear'。
//   setConfigs(entries, {actor, note?})    — 多 key 原子写（同 tx 多行 upsert +
//                                            一次 epoch bump）——task.<kind> 组写
//                                            provider+model 需要它。
//
// 校验分两段（review P1-5）：
//   - tx 外（读空气即可判）：未登记 key → 400；pinned（compose 强制）→ 409；zod
//     schema 拒绝 → 422 + issues；provider 存在性/implemented/judge-fallback 特例。
//   - tx 内（必须在写后快照上判）：provider/model 组合终态校验——set、batch set、
//     clear 全路径都验「最终 provider+model 组合」，兄弟键读 tx 内的 DB 行（不是
//     可能已过期的内存快照），免得 `.model` 清空绕过 `.provider` 的写时校验、
//     留下 openai×mimo-id 这类不可跑组合。
//
// 并发（§6.3）：行级 upsert + journal + epoch 同 tx；两进程同 key 写 = 最后一次
// 赢，journal 双方都在。revision 轴取 journal max(revision)+1（review P1-2——
// journal 是 append-only 的真持久轴；取 system_config 行 revision 会在
// clear 删行后倒回 1，撞上 journal 的 (key,revision) PK）。

import { eq, inArray, sql } from 'drizzle-orm';
import { selectPairModel, selectPairProvider } from '@/core/config/model-overrides';
import type { ConfigMutation, ConfigMutationResult } from '@/core/config/mutations';
import { hydrateConfigFromDb } from '@/core/config/server/hydrate';
import type { ConfigValue } from '@/core/config/store';
import { matchDynamicConfigKey, resolveKeyDef } from '@/core/config/store';
import { type Db, type Tx, db as defaultDb } from '@/db/client';
import { system_config, system_config_journal } from '@/db/schema';
import { ApiError } from '@/kernel/http';

export type ConfigActor = 'owner' | 'panel:admin' | 'migrate' | 'cli';

const EPOCH_ROW_ID = 'global';

/** 任务 catalog 的写面事实：只含序列化字段，不把 TaskDefinition 行为带进 core。 */
export interface ConfigWriteTaskFacts {
  readonly execution?: string;
  readonly ignoreGlobalPin?: boolean;
  readonly defaultProvider: string;
  readonly defaultModel: string;
}

/** tx 内终态校验用的成对模型查找（pi adapter 的真实实现）。 */
export interface ConfigWritePairModels {
  getModel(providerId: string, model: string): unknown;
}

/**
 * 写面需要的 AI 事实与已声明验证接口。配置 owner 不认识 provider 注册表、
 * catalog 或 pi SDK；组合根在 boot 时绑定真实实现
 * （src/server/ai/config-write-ports.ts）。
 */
export interface ConfigWritePorts {
  /** Registry order; iteration order is observable in lane/global validation. */
  readonly tasks: Readonly<Record<string, ConfigWriteTaskFacts>>;
  readonly solveLaneTaskKinds: readonly string[];
  readonly visionJudgeTaskKinds: readonly string[];
  readonly providerAttemptAdmissionLanes: readonly string[];
  readonly anthropicSubDefaultModel: string;
  readonly readProviderId: (raw: string) => string | undefined;
  readonly isProviderImplemented: (provider: string) => boolean;
  readonly isProviderImplementedForTask: (provider: string, taskKind: string) => boolean;
  readonly providerRequiresExplicitModel: (provider: string) => boolean;
  readonly resolveGlobalProviderSwitch: (
    env: NodeJS.ProcessEnv,
    db: { provider?: string; model?: string } | undefined,
  ) => { provider: string; model?: string } | undefined;
  /** Throws the resolver's readable config error; the return value is unused here. */
  readonly resolveTaskReasoning: (
    kind: string,
    provider: string,
    model: string,
    stored: unknown,
  ) => unknown;
  /** Throws the same readable config error the execution path would. */
  readonly assertModelProfileCapabilityFit: (kind: string, provider: string, model: string) => void;
  readonly createPairModels: () => Promise<ConfigWritePairModels>;
  readonly piProviderId: (provider: string) => string;
}

let writePorts: ConfigWritePorts | undefined;

/** Bound by the composition root before any config write. */
export function installConfigWritePorts(ports: ConfigWritePorts): void {
  writePorts = ports;
}

function ports(): ConfigWritePorts {
  if (!writePorts)
    throw new Error(
      'config write ports are not installed — the composition root must call installConfigWritePorts() before any config write',
    );
  return writePorts;
}

/** Port surface under the names the validation code already uses. */
function writeFacts() {
  const p = ports();
  return {
    tasks: p.tasks,
    solveLaneTaskKinds: p.solveLaneTaskKinds,
    visionJudgeTaskKinds: p.visionJudgeTaskKinds,
    providerAttemptAdmissionLanes: p.providerAttemptAdmissionLanes,
    anthropicSubDefaultModel: p.anthropicSubDefaultModel,
    readProviderId: p.readProviderId,
    isProviderImplemented: p.isProviderImplemented,
    isProviderImplementedForTask: p.isProviderImplementedForTask,
    providerRequiresExplicitModel: p.providerRequiresExplicitModel,
    resolveGlobalProviderSwitch: p.resolveGlobalProviderSwitch,
    resolveTaskReasoning: p.resolveTaskReasoning,
    assertModelProfileCapabilityFit: (kind: string, provider: string, model: string) =>
      p.assertModelProfileCapabilityFit(kind, provider, model),
    createPairModels: p.createPairModels,
    piProviderId: p.piProviderId,
  };
}

export interface ConfigWriteResult {
  key: string;
  revision: number;
  epoch: number;
}

/** tx 外校验：登记性 / pinned / zod / 纯值谓词（不需要读兄弟行）。never-throws 不适用。 */
function validateEntryBasics(key: string, value: ConfigValue): void {
  const def = validateWritableKey(key);
  const parsed = def.schema.safeParse(value);
  if (!parsed.success) {
    throw new ApiError(
      'invalid_config_value',
      `config key '${key}' failed schema validation: ${JSON.stringify(parsed.error.issues.slice(0, 5))}`,
      422,
    );
  }
  validateStaticSemantics(key, parsed.data as ConfigValue);
}

/** YUK-1557 — undefined preserves an existing expiry; null clears it; a string sets a future stop. */
function parseExpiresAt(expiresAt: string | null | undefined): Date | null | undefined {
  if (expiresAt === undefined) return undefined;
  if (expiresAt === null) return null;
  const parsed = new Date(expiresAt);
  if (!Number.isFinite(parsed.getTime())) {
    throw new ApiError('invalid_config_expiry', `invalid expires_at '${expiresAt}'`, 422);
  }
  if (parsed.getTime() <= Date.now()) {
    throw new ApiError('invalid_config_expiry', 'expires_at must be in the future', 422);
  }
  return parsed;
}

/** Set and reset share the same registered, live keyspace. */
function validateWritableKey(key: string) {
  const { tasks } = writeFacts();
  const def = resolveKeyDef(key);
  const dynamic = matchDynamicConfigKey(key);
  if (dynamic?.kind === 'task' && !Object.hasOwn(tasks, dynamic.scope)) {
    throw new ApiError('unknown_config_key', `unknown task '${dynamic.scope}'`, 400);
  }
  if (!def) {
    throw new ApiError(
      'unknown_config_key',
      `config key '${key}' is not registered in CONFIG_REGISTRY (and does not match task.*/lane.* patterns)`,
      400,
    );
  }
  if ((def.envMode ?? 'fallback') === 'pinned') {
    throw new ApiError(
      'config_key_compose_pinned',
      `config key '${key}' is compose-forced (envPinned): ${def.envName} must be set at deploy level — DB writes would silently lose to the pin`,
      409,
    );
  }
  return def;
}

/** tx 外的纯值谓词（不读兄弟行）：JUDGE_FALLBACK / task-kind 存在性 / provider 已知+已实现。 */
function validateStaticSemantics(key: string, value: ConfigValue): void {
  const {
    tasks,
    providerAttemptAdmissionLanes,
    readProviderId,
    isProviderImplemented,
    isProviderImplementedForTask,
    providerRequiresExplicitModel,
  } = writeFacts();
  // JUDGE_FALLBACK_PROVIDER：'' = 显式关（合法）；非空必须是已知 + implemented
  // + 可裸跑（该 lane 不递 model）。
  if (key === 'JUDGE_FALLBACK_PROVIDER') {
    if (typeof value !== 'string' || value === '') return;
    const provider = readProviderId(value);
    if (!provider || !isProviderImplemented(provider)) {
      throw new ApiError(
        'invalid_config_value',
        `JUDGE_FALLBACK_PROVIDER='${value}' is not a wired provider`,
        422,
      );
    }
    if (providerRequiresExplicitModel(provider)) {
      throw new ApiError(
        'invalid_config_value',
        `JUDGE_FALLBACK_PROVIDER='${value}' requires an explicit model which the fallback lane never supplies — it would borrow the task's registry model and fail`,
        422,
      );
    }
    return;
  }

  // task.<kind>.provider：kind 存在性 + provider 已知 + implemented。
  const m = /^task\.([^.]+)\.provider$/.exec(key);
  if (m && typeof value === 'string' && value !== '') {
    const scope = m[1];
    if (!Object.hasOwn(tasks, scope)) {
      throw new ApiError(
        'unknown_config_key',
        `task kind '${scope}' is not in the TaskSpec registry`,
        400,
      );
    }
    const provider = readProviderId(value);
    if (!provider) {
      throw new ApiError('invalid_config_value', `${key}='${value}' is not a known provider`, 422);
    }
    if (!isProviderImplementedForTask(provider, scope)) {
      throw new ApiError(
        'invalid_config_value',
        `${key}='${provider}' is reserved but not implemented for task '${scope}'`,
        422,
      );
    }
    return;
  }

  const l = /^lane\.([^.]+)\.provider$/.exec(key);
  if (l && typeof value === 'string' && value !== '') {
    const provider = readProviderId(value);
    if (!provider) {
      throw new ApiError('invalid_config_value', `${key}='${value}' is not a known provider`, 422);
    }
    if (!isProviderImplemented(provider)) {
      throw new ApiError(
        'invalid_config_value',
        `${key}='${provider}' is reserved but not implemented for lane '${l[1]}'`,
        422,
      );
    }
    return;
  }

  // admission policies JSON：DB 层存解析后的 object；registry schema 验形状，
  // 这里拦 key 名——attempt 侧限 PROVIDER_ATTEMPT_ADMISSION_LANES 白名单（consumer
  // PoliciesSchema.strict 同款语义），session 侧限已知 provider（consumer
  // isKnownProvider throw 同款语义）。写端 fail-closed，脏值不落地。
  if (key === 'AI_PROVIDER_ATTEMPT_ADMISSION_POLICIES_JSON') {
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      for (const lane of Object.keys(value)) {
        if (!(providerAttemptAdmissionLanes as readonly string[]).includes(lane)) {
          throw new ApiError(
            'invalid_config_value',
            `${key} contains unknown lane '${lane}' (allowed: ${providerAttemptAdmissionLanes.join(', ')})`,
            422,
          );
        }
      }
    }
    return;
  }
  if (key === 'AI_PROVIDER_SESSION_ADMISSION_POLICIES_JSON') {
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const seen = new Set<string>();
      for (const lane of Object.keys(value)) {
        const provider = readProviderId(lane);
        if (!provider) {
          throw new ApiError(
            'invalid_config_value',
            `${key} contains unknown provider lane '${lane}'`,
            422,
          );
        }
        if (seen.has(provider)) {
          throw new ApiError(
            'invalid_config_value',
            `${key} contains both '${lane}' and another id for provider '${provider}'`,
            422,
          );
        }
        seen.add(provider);
      }
    }
    return;
  }

  // JUDGE_CALIBRATION_REJUDGE_PROVIDER：已知 + implemented（rejudge 有内置默认
  // model，providerRequiresExplicitModel 终态校验在 tx 内做）。
  if (key === 'JUDGE_CALIBRATION_REJUDGE_PROVIDER' && typeof value === 'string' && value !== '') {
    const provider = readProviderId(value);
    if (!provider || !isProviderImplemented(provider)) {
      throw new ApiError(
        'invalid_config_value',
        `JUDGE_CALIBRATION_REJUDGE_PROVIDER='${value}' is not a wired provider`,
        422,
      );
    }
  }
}

// ── provider/model 对的终态校验（P1-5）──────────────────────────────────────

interface PairScope {
  /** provider 键。 */
  providerKey: string;
  /** model 键（rejudge 对是它的静态 key）。 */
  modelKey: string;
  /** 展示名（报错文案）。 */
  label: string;
}

/** 一个被写/被清的 key 属于哪对 provider/model 组；非对键 → null。
 * `task.<kind>.override_global_pin`（YUK-1547）与 `task.<kind>.reasoning`
 * （YUK-1808）挂在同一组上：flag/level 写清都要重算该 task 的 pair 终态——
 * flag 免得逐字段变更绕过 pair 校验，level 必须按终态 provider+model 校验。 */
function pairScopeFor(key: string): PairScope | null {
  const t = /^task\.([^.]+)\.(provider|model|override_global_pin|reasoning)$/.exec(key);
  if (t) {
    const scope = t[1];
    return {
      providerKey: `task.${scope}.provider`,
      modelKey: `task.${scope}.model`,
      label: `task '${scope}'`,
    };
  }
  const l = /^lane\.([^.]+)\.(provider|model|reasoning)$/.exec(key);
  if (l) {
    const scope = l[1];
    return {
      providerKey: `lane.${scope}.provider`,
      modelKey: `lane.${scope}.model`,
      label: `lane '${scope}'`,
    };
  }
  if (key === 'JUDGE_CALIBRATION_REJUDGE_PROVIDER' || key === 'JUDGE_CALIBRATION_REJUDGE_MODEL') {
    return {
      providerKey: 'JUDGE_CALIBRATION_REJUDGE_PROVIDER',
      modelKey: 'JUDGE_CALIBRATION_REJUDGE_MODEL',
      label: 'JUDGE_CALIBRATION_REJUDGE pair',
    };
  }
  return null;
}

function valueAsNonEmptyString(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

/** The resolver throws plain config errors on stale/invalid pins; the write
 * API surfaces them as its usual readable 422 instead of an opaque 500. */
function resolveGlobalSwitch422(db: { provider?: string; model?: string } | undefined) {
  try {
    return writeFacts().resolveGlobalProviderSwitch(process.env, db);
  } catch (error) {
    throw new ApiError(
      'invalid_config_value',
      error instanceof Error ? error.message : 'the global provider pin is not resolvable',
      422,
    );
  }
}

/** YUK-1658 — prebuilt outside the write tx so the epoch row lock never waits on registry assembly. */
type ConfigPairModels = ConfigWritePairModels;

/**
 * YUK-1808 — a stored task.<kind>.reasoning row resolves against the FINAL
 * effective pair (the same input resolveTaskReasoning sees at run time), so a
 * level the effective model cannot honor fails the write instead of the next
 * paid call. Valid unlisted levels pass — the resolver rounds them up. A row
 * getTaskOverride would not surface (non-object) is skipped the same way.
 */
function validateTaskReasoning(
  label: string,
  kind: string,
  provider: string,
  model: string,
  stored: unknown,
): void {
  if (typeof stored !== 'object' || stored === null) return;
  try {
    writeFacts().resolveTaskReasoning(kind, provider, model, stored);
  } catch (error) {
    throw new ApiError(
      'invalid_config_value',
      `${label}: ${error instanceof Error ? error.message : 'reasoning level is not servable'}`,
      422,
    );
  }
}

/**
 * 终态校验：写面触碰到的每个 provider/model 对，按 tx 内 DB 终态行（刚写的值也在
 * 其中）求 effective provider + effective model；providerRequiresExplicitModel 时
 * 缺显式 model → 422（整 tx 回滚）。
 *
 * `models` 由调用方在开 tx 前构建（YUK-1658）：它只含进程内事实（getModel 每次
 * 查找现读目录），持 epoch 行锁构建它会把所有 config 写串行在 import + 注册表
 * 装配后面。
 *
 * 生效层序与读面一致：priority 键 env 显式 > DB > default；fallback 键 DB > env >
 * codeDefault。rejudge 的 model codeDefault（'claude-opus-4-8'）不算「显式」——
 * providerRequiresExplicitModel 的 provider（openai/anthropic/…）上 default 是
 * mimo id，跑不了。
 */
async function validateFinalProviderPairs(
  tx: Tx,
  touchedScopes: ReadonlyMap<string, PairScope>,
  models: ConfigPairModels,
  mutatedKeys: ReadonlySet<string>,
  setKeys: ReadonlySet<string>,
): Promise<void> {
  const {
    tasks,
    solveLaneTaskKinds: solveTasks,
    visionJudgeTaskKinds: visionTasks,
    anthropicSubDefaultModel,
    readProviderId,
    isProviderImplemented,
    isProviderImplementedForTask,
    providerRequiresExplicitModel,
    assertModelProfileCapabilityFit,
    piProviderId,
  } = writeFacts();
  const scopes = new Map(touchedScopes);
  // A global reset exposes task-level configuration previously hidden by the pin.
  // Validate every resulting chat binding, including when the global pair dissolves.
  if (scopes.has('lane.global.provider')) {
    for (const [kind, task] of Object.entries(tasks)) {
      if (task.execution === 'typed') continue;
      const scope = pairScopeFor(`task.${kind}.provider`);
      if (scope) scopes.set(scope.providerKey, scope);
    }
  }
  if (scopes.size === 0) return;

  // A write validates only what it changes: a pair the batch never touches
  // that cannot resolve is stale state the read side already fails closed on
  // (TaskConfigError at binding resolution), not something this batch
  // introduced — skipping it keeps a reasoning write + targeted clears from
  // being held hostage by an unrelated stale row.
  const globalPairMutated =
    mutatedKeys.has('lane.global.provider') || mutatedKeys.has('lane.global.model');
  const globalReasoningMutated = mutatedKeys.has('lane.global.reasoning');
  const lanePairMutated = (providerKey: string, modelKey: string): boolean =>
    mutatedKeys.has(providerKey) || mutatedKeys.has(modelKey) || globalPairMutated;
  const pairChanged = (kind: string): boolean =>
    globalPairMutated ||
    lanePairMutated(`task.${kind}.provider`, `task.${kind}.model`) ||
    mutatedKeys.has(`task.${kind}.override_global_pin`) ||
    (lanePairMutated('lane.verify_solve.provider', 'lane.verify_solve.model') &&
      (solveTasks as readonly string[]).includes(kind)) ||
    (lanePairMutated('lane.vision_judge.provider', 'lane.vision_judge.model') &&
      (visionTasks as readonly string[]).includes(kind));
  // A stored task level outranks the global one — a global reasoning write
  // does not change the level of kinds that carry their own row (rowByKey is
  // populated before any of these predicates run).
  const reasoningChanged = (kind: string): boolean =>
    mutatedKeys.has(`task.${kind}.reasoning`) ||
    (globalReasoningMutated && rowByKey.get(`task.${kind}.reasoning`) === undefined);
  const pairBroken = (provider: string, model: string | undefined, kind?: string): boolean => {
    if (!model || !models.getModel(piProviderId(provider), model)) return true;
    if (kind) {
      try {
        assertModelProfileCapabilityFit(kind, provider, model);
      } catch {
        return true;
      }
    }
    return false;
  };
  function validateNativeModel(
    label: string,
    provider: string,
    model: string,
    taskKind?: string,
  ): void {
    // The adapter uses this same lookup, including template presence and required catalog facts.
    if (!models.getModel(piProviderId(provider), model)) {
      throw new ApiError(
        'invalid_config_value',
        `${label}: model '${model}' is not executable in native pi provider '${piProviderId(provider)}': protocol or required catalog facts are unavailable`,
        422,
      );
    }
    if (taskKind) {
      try {
        assertModelProfileCapabilityFit(taskKind, provider, model);
      } catch (error) {
        throw new ApiError(
          'invalid_config_value',
          error instanceof Error ? error.message : 'Incompatible task/model',
          422,
        );
      }
    }
  }
  if (
    scopes.has('lane.global.provider') ||
    [...solveTasks, ...visionTasks].some((kind) => scopes.has(`task.${kind}.provider`))
  ) {
    for (const key of ['lane.verify_solve.provider', 'lane.vision_judge.provider']) {
      const scope = pairScopeFor(key);
      if (scope) scopes.set(scope.providerKey, scope);
    }
  }
  const keys = [
    ...new Set(
      [...scopes.values()].flatMap((s) => {
        const taskScope = /^task\.([^.]+)\.provider$/.exec(s.providerKey);
        return taskScope
          ? [
              s.providerKey,
              s.modelKey,
              `task.${taskScope[1]}.override_global_pin`,
              `task.${taskScope[1]}.reasoning`,
            ]
          : [s.providerKey, s.modelKey];
      }),
    ),
    'lane.global.provider',
    'lane.global.model',
    'lane.global.reasoning',
    ...[...solveTasks, ...visionTasks].flatMap((kind) => [
      `task.${kind}.provider`,
      `task.${kind}.model`,
      `task.${kind}.override_global_pin`,
      `task.${kind}.reasoning`,
    ]),
    ...([...scopes.values()].some((scope) => scope.providerKey === 'lane.global.provider')
      ? Object.keys(tasks).flatMap((kind) => [`task.${kind}.model`, `task.${kind}.reasoning`])
      : []),
  ].sort();
  const rows = await tx
    .select({ key: system_config.key, value: system_config.value })
    .from(system_config)
    .where(inArray(system_config.key, keys))
    .for('update');
  const rowByKey = new Map(rows.map((r) => [r.key, r.value]));
  const env = process.env;

  // Lane-only kinds (vision judges: every call path threads the override) —
  // their stored reasoning level must validate against the LANE pair, not the
  // task's standard-chain pair. Shared kinds (solve legs: some callers run
  // them without the override) keep the standard-pair validation AND get the
  // lane-pair check in the scoped branch below. Model-only counts for
  // verify_solve (same-provider model swap), while vision_judge needs a
  // provider to activate.
  const scopedServedKinds = new Set<string>();
  {
    const configuredLaneValue = (key: string): string | undefined => {
      const def = resolveKeyDef(key);
      const envValue = def?.envName !== undefined ? env[def.envName] : undefined;
      const dbValue = valueAsNonEmptyString(rowByKey.get(key));
      return (def?.envMode ?? 'fallback') === 'priority'
        ? (valueAsNonEmptyString(envValue) ?? dbValue)
        : (dbValue ?? valueAsNonEmptyString(envValue));
    };
    if (configuredLaneValue('lane.vision_judge.provider') !== undefined) {
      for (const kind of visionTasks) scopedServedKinds.add(kind);
    }
  }

  for (const scope of scopes.values()) {
    const providerDef = resolveKeyDef(scope.providerKey);
    const modelDef = resolveKeyDef(scope.modelKey);

    const envProvider = providerDef?.envName !== undefined ? env[providerDef.envName] : undefined;
    const envModel = modelDef?.envName !== undefined ? env[modelDef.envName] : undefined;

    const dbProvider = valueAsNonEmptyString(rowByKey.get(scope.providerKey));
    const dbModel = valueAsNonEmptyString(rowByKey.get(scope.modelKey));

    const providerPriority = (providerDef?.envMode ?? 'fallback') === 'priority';
    const modelPriority = (modelDef?.envMode ?? 'fallback') === 'priority';

    const taskKind = /^task\.([^.]+)\.provider$/.exec(scope.providerKey)?.[1] as string | undefined;
    const configuredProvider = providerPriority
      ? (valueAsNonEmptyString(envProvider) ?? dbProvider)
      : (dbProvider ?? valueAsNonEmptyString(envProvider));
    const configuredModel = modelPriority
      ? (valueAsNonEmptyString(envModel) ?? dbModel)
      : (dbModel ?? valueAsNonEmptyString(envModel));

    // Scoped overrides are per-call arguments: model-only solve follows the task/global
    // provider, while a vision model without a provider remains dormant in its reader.
    const scopedTasks =
      scope.providerKey === 'lane.verify_solve.provider'
        ? solveTasks
        : scope.providerKey === 'lane.vision_judge.provider'
          ? visionTasks
          : undefined;
    if (scopedTasks) {
      if (
        !configuredProvider &&
        (!configuredModel || scope.providerKey === 'lane.vision_judge.provider')
      )
        continue;
      const global = resolveGlobalSwitch422({
        provider: valueAsNonEmptyString(rowByKey.get('lane.global.provider')),
        model:
          valueAsNonEmptyString(env.AI_PROVIDER_MODEL) ??
          valueAsNonEmptyString(rowByKey.get('lane.global.model')),
      });
      for (const kind of scopedTasks) {
        // YUK-1658 — an opted-out task runs its own pair under a scoped lane
        // (read side: call arg > task pair > registry, global pin skipped), so
        // the global switch must not leak into its lane resolution here.
        const followsGlobal = rowByKey.get(`task.${kind}.override_global_pin`) !== true;
        // Final pair composition uses the same per-field chain as the runtime
        // selector: lane call values > global pin > task rows > task defaults.
        const rawProvider = selectPairProvider({
          call: { provider: configuredProvider },
          global: followsGlobal ? global : undefined,
          task: { provider: valueAsNonEmptyString(rowByKey.get(`task.${kind}.provider`)) },
          defaults: { provider: tasks[kind].defaultProvider },
        }).value;
        const provider = rawProvider ? readProviderId(rawProvider) : undefined;
        const model = selectPairModel({
          call: { model: configuredModel },
          global: followsGlobal ? global : undefined,
          task: { model: valueAsNonEmptyString(rowByKey.get(`task.${kind}.model`)) },
          defaults: {
            model:
              provider === 'anthropic-sub' ? anthropicSubDefaultModel : tasks[kind].defaultModel,
          },
        }).value;
        // The pair this kind rides ON the lane changed only if the lane keys
        // (or, for verify_solve's model-only chain, its task/global fallbacks)
        // were written — a stale vision lane pair does not follow the global
        // pin and must not hold a global write hostage.
        const laneChanged =
          scope.providerKey === 'lane.verify_solve.provider'
            ? pairChanged(kind)
            : mutatedKeys.has(scope.providerKey) || mutatedKeys.has(scope.modelKey);
        if (!laneChanged) {
          // The lane pair this kind rides is unchanged — pre-existing breakage
          // fails closed at run time; only a level the batch actually changed
          // is checked, and only when the pair resolves.
          if (!provider || !isProviderImplemented(provider) || pairBroken(provider, model, kind))
            continue;
          if (reasoningChanged(kind))
            validateTaskReasoning(
              scope.label,
              kind,
              provider,
              model,
              rowByKey.get(`task.${kind}.reasoning`) ??
                rowByKey.get('lane.global.reasoning') ??
                resolveKeyDef('lane.global.reasoning')?.codeDefault,
            );
          continue;
        }
        if (!provider || !isProviderImplemented(provider)) {
          throw new ApiError(
            'invalid_config_value',
            `${scope.label} resolves to an unavailable provider '${rawProvider}'`,
            422,
          );
        }
        validateNativeModel(scope.label, provider, model, kind);
        // YUK-1808 — the task rides this lane as a call override, so its stored
        // level resolves against the lane pair the run will actually use.
        validateTaskReasoning(
          scope.label,
          kind,
          provider,
          model,
          rowByKey.get(`task.${kind}.reasoning`) ??
            rowByKey.get('lane.global.reasoning') ??
            resolveKeyDef('lane.global.reasoning')?.codeDefault,
        );
      }
      continue;
    }
    if (scope.providerKey === 'JUDGE_CALIBRATION_REJUDGE_PROVIDER') {
      const rawProvider = selectPairProvider({
        task: { provider: configuredProvider },
        defaults: { provider: valueAsNonEmptyString(providerDef?.codeDefault) },
      }).value;
      const provider = rawProvider ? readProviderId(rawProvider) : undefined;
      const model = selectPairModel({
        task: { model: configuredModel },
        defaults: { model: valueAsNonEmptyString(modelDef?.codeDefault) },
      }).value;
      if (
        provider &&
        model &&
        isProviderImplemented(provider) &&
        (lanePairMutated(scope.providerKey, scope.modelKey) ||
          !pairBroken(provider, model, 'SemanticJudgeTask'))
      ) {
        validateNativeModel(scope.label, provider, model, 'SemanticJudgeTask');
      }
      continue;
    }

    const isGlobal = scope.providerKey === 'lane.global.provider';
    const typed = taskKind && tasks[taskKind]?.execution === 'typed';
    // Typed kinds run their own wire contract — stored provider/model rows and
    // the global pair never reach it (the binding mirrors def.default*), so a
    // chat-pair assertion on this scope can only 422 a legitimate write — e.g.
    // clearing a stale override_global_pin row — because the typed default is
    // not a catalog chat model. Setting the flag on one stays a write-time
    // error (otherwise the row would be a poison pill only raw SQL removes).
    if (typed) {
      // The typed runner builds its wire body from the definition's pinned
      // defaultProvider/defaultModel and never resolves a task reasoning row.
      // A stored set is therefore a dead config row the runtime cannot consume;
      // clear remains legal so stale rows from earlier versions can be removed.
      for (const deadKey of [
        `task.${taskKind}.provider`,
        `task.${taskKind}.model`,
        `task.${taskKind}.reasoning`,
      ]) {
        if (setKeys.has(deadKey)) {
          throw new ApiError(
            'invalid_config_value',
            `${scope.label}: ${deadKey} is never consumed by the typed-execution lane — its provider, model and reasoning are fixed by the wire contract; clear the row instead`,
            422,
          );
        }
      }
      if (
        mutatedKeys.has(`task.${taskKind}.override_global_pin`) &&
        rowByKey.get(`task.${taskKind}.override_global_pin`) === true
      ) {
        throw new ApiError(
          'invalid_config_value',
          `${scope.label}: task.${taskKind}.override_global_pin=true is meaningless on a typed-execution task — there is no chat lane to repoint`,
          422,
        );
      }
      continue;
    }
    // YUK-1547 — explicit per-task opt-in: task.<kind>.override_global_pin=true
    // requires the task's OWN provider+model rows complete+servable — checked
    // on the tx-final rows so field-by-field writes cannot leave a half pair
    // behind (a global reset exposing it is validated the same way).
    if (taskKind && rowByKey.get(`task.${taskKind}.override_global_pin`) === true) {
      const rawProvider = configuredProvider;
      const model = configuredModel;
      if (!pairChanged(taskKind)) {
        // The opted pair is untouched — pre-existing breakage fails closed at
        // binding resolution, so only a changed level needs re-checking.
        const provider = rawProvider ? readProviderId(rawProvider) : undefined;
        if (
          provider &&
          isProviderImplementedForTask(provider, taskKind) &&
          !pairBroken(provider, model, taskKind) &&
          reasoningChanged(taskKind) &&
          !scopedServedKinds.has(taskKind)
        )
          validateTaskReasoning(
            scope.label,
            taskKind,
            provider,
            model as string,
            rowByKey.get(`task.${taskKind}.reasoning`) ??
              rowByKey.get('lane.global.reasoning') ??
              resolveKeyDef('lane.global.reasoning')?.codeDefault,
          );
        continue;
      }
      if (!rawProvider || !model) {
        throw new ApiError(
          'invalid_config_value',
          `${scope.label}: task.${taskKind}.override_global_pin=true requires complete task.${taskKind}.provider + .model rows (provider='${rawProvider ?? '∅'}', model='${model ?? '∅'}') — the opt-in never falls through to the global pin`,
          422,
        );
      }
      const provider = readProviderId(rawProvider);
      if (!provider || !isProviderImplementedForTask(provider, taskKind)) {
        throw new ApiError(
          'invalid_config_value',
          `${scope.label}: task.${taskKind}.override_global_pin=true resolves to provider '${rawProvider}' not implemented for task '${taskKind}'`,
          422,
        );
      }
      validateNativeModel(scope.label, provider, model, taskKind);
      // The opted-out task runs its own pair; its stored level resolves against
      // it — unless a scoped lane drives this kind (a call override outranks
      // the opted pair at run time; the lane scope validates that pair).
      if (!scopedServedKinds.has(taskKind))
        validateTaskReasoning(
          scope.label,
          taskKind,
          provider,
          model,
          rowByKey.get(`task.${taskKind}.reasoning`) ??
            rowByKey.get('lane.global.reasoning') ??
            resolveKeyDef('lane.global.reasoning')?.codeDefault,
        );
      continue;
    }
    const globalSwitch =
      (taskKind && !typed) || isGlobal
        ? resolveGlobalSwitch422({
            provider: valueAsNonEmptyString(rowByKey.get('lane.global.provider')),
            model:
              valueAsNonEmptyString(env.AI_PROVIDER_MODEL) ??
              valueAsNonEmptyString(rowByKey.get('lane.global.model')),
          })
        : undefined;
    // A task declared ignoreGlobalPin never runs on the global pair: its
    // effective pair is its own stored/default rows, so the pin must not
    // shadow them here either.
    const dedicated = taskKind != null && tasks[taskKind]?.ignoreGlobalPin === true;
    // Same per-field chain as the runtime binding: global pin > configured
    // task/lane rows > registry default. `ignoreGlobalPin` and the global scope
    // opt out of the global layer; defaults remain the task's own pair.
    const globalLayer = dedicated ? undefined : globalSwitch;
    const effProvider = selectPairProvider({
      global: globalLayer,
      task: isGlobal ? undefined : { provider: configuredProvider },
      defaults: isGlobal
        ? undefined
        : taskKind
          ? { provider: tasks[taskKind].defaultProvider }
          : undefined,
    }).value;
    const effModel = selectPairModel({
      global: globalLayer,
      task: isGlobal ? undefined : { model: configuredModel },
    }).value;
    if (effProvider === undefined) continue; // 对解散 → 无事可验
    if (typeof effProvider === 'string') {
      const provider = readProviderId(effProvider);
      if (!provider) continue;
      const changed = taskKind === undefined ? globalPairMutated : pairChanged(taskKind);
      const model =
        effModel ??
        (provider === 'anthropic-sub'
          ? anthropicSubDefaultModel
          : taskKind
            ? tasks[taskKind].defaultModel
            : undefined);
      if (!changed) {
        // The pair is pre-existing, not produced by this write — stale rows it
        // cannot resolve already fail closed at run time, so they are skipped
        // here rather than blocking an unrelated write or clear.
        if (pairBroken(provider, model, taskKind)) continue;
        if (taskKind && reasoningChanged(taskKind) && !scopedServedKinds.has(taskKind))
          validateTaskReasoning(
            scope.label,
            taskKind,
            provider,
            model as string,
            rowByKey.get(`task.${taskKind}.reasoning`) ??
              rowByKey.get('lane.global.reasoning') ??
              resolveKeyDef('lane.global.reasoning')?.codeDefault,
          );
        continue;
      }
      if (
        providerRequiresExplicitModel(provider) &&
        effModel === undefined &&
        (!taskKind || tasks[taskKind].defaultProvider !== provider)
      ) {
        throw new ApiError(
          'invalid_config_value',
          `${scope.label} resolves to provider '${provider}' with no explicit model — set '${scope.modelKey}' in the same write, or clear '${scope.providerKey}' to dissolve the pair`,
          422,
        );
      }
      if (model && isProviderImplemented(provider))
        validateNativeModel(scope.label, provider, model, taskKind);
      // A task scope's stored level resolves against this same final pair —
      // unless a scoped lane drives the kind (the lane scope validates the
      // level against the lane pair the run will actually use).
      if (taskKind && model && isProviderImplemented(provider) && !scopedServedKinds.has(taskKind))
        validateTaskReasoning(
          scope.label,
          taskKind,
          provider,
          model,
          rowByKey.get(`task.${taskKind}.reasoning`) ??
            rowByKey.get('lane.global.reasoning') ??
            resolveKeyDef('lane.global.reasoning')?.codeDefault,
        );
      if (model && scope.providerKey === 'lane.vision_judge.provider') {
        validateNativeModel(scope.label, provider, model, 'StepsJudgeTask');
        validateNativeModel(scope.label, provider, model, 'MultimodalDirectJudgeTask');
      }
      if (isGlobal && isProviderImplemented(provider)) {
        for (const [kind, definition] of Object.entries(tasks)) {
          if (definition.execution === 'typed') continue;
          // YUK-1658 — an opted-out task never runs on the global pair (its own
          // pair is validated in its task scope above, including when a global
          // reset exposes it), so validating it here 422'd global saves on
          // bindings that will never execute. A declared ignoreGlobalPin task
          // has the same property by definition.
          if (
            rowByKey.get(`task.${kind}.override_global_pin`) === true ||
            definition.ignoreGlobalPin === true
          )
            continue;
          const effectiveModel = selectPairModel({
            call: { model: effModel },
            task: { model: valueAsNonEmptyString(rowByKey.get(`task.${kind}.model`)) },
            defaults: {
              model:
                provider === 'anthropic-sub' ? anthropicSubDefaultModel : definition.defaultModel,
            },
          }).value;
          if (pairChanged(kind)) {
            validateNativeModel(scope.label, provider, effectiveModel, kind);
          } else if (pairBroken(provider, effectiveModel, kind)) {
            continue;
          }
          // The pin becomes this task's effective pair; its stored level must
          // survive it — unless a scoped lane drives the kind (the lane
          // overrides the pin for it, and the lane scope validates that pair).
          if (!scopedServedKinds.has(kind))
            validateTaskReasoning(
              scope.label,
              kind,
              provider,
              effectiveModel,
              rowByKey.get(`task.${kind}.reasoning`) ??
                rowByKey.get('lane.global.reasoning') ??
                resolveKeyDef('lane.global.reasoning')?.codeDefault,
            );
        }
      }
    }
    // 未知 provider 不在此拦（写 provider 键本身由 tx 外谓词拦；model-only 写下
    // provider 脏值是读端 fail-open 的既有面）。
  }
}

export interface ConfigWriteOptions {
  actor: ConfigActor;
  note?: string;
}

async function bumpEpoch(tx: Tx): Promise<number> {
  // INSERT … ON CONFLICT 幂等首行；每次写 nextval(config_change_seq)——与
  // journal.change_seq 同序列（§1.2「config_change_seq 同序列」）。
  //
  // 第二轮 review P1（两轴去重）自愈：序列位可能落后于 epoch 行（restore 把
  // epoch 抬到恢复前高水位之上、但序列停在归档位；或任何手工/历史漂移）。
  // 裸 nextval 会让 epoch 倒退——hydrate 的 stale 守卫随后拒绝发布，writer
  // 却返回成功 → DB 新值 / runtime 旧值永久分叉。conflict 分支取
  // greatest(nextval, epoch 行+1) 并用 setval 把序列同步到最终值：epoch 行锁
  // 串行化并发写 tx（各自等前一个 tx commit），保证严格递增；正常路径
  // nextval > epoch 行时 greatest 退化为 nextval，setval 重设同值无漂移
  // （is_called=true → 下一次 nextval = 值+1，与直接 nextval 等价）。
  const rows = await tx.execute<{ epoch: number | string; seq_synced: number | string }>(sql`
    with bumped as (
      insert into system_config_epoch (id, epoch, updated_at)
      values (${EPOCH_ROW_ID}, nextval('config_change_seq'), now())
      on conflict (id) do update
        set epoch = greatest(nextval('config_change_seq'), system_config_epoch.epoch + 1),
            updated_at = now()
      returning epoch
    )
    select epoch, setval('config_change_seq', epoch) as seq_synced from bumped
  `);
  const row = rows[0];
  return typeof row.epoch === 'string' ? Number(row.epoch) : row.epoch;
}

/**
 * 单 key 写。commit 后即时 hydrate（写进程 0 延迟生效，§6.2 self-read）。
 * revision 轴 = journal max(revision)+1（P1-2：journal 是 append-only 持久轴；
 * 被 clear 删掉行的 value-row revision 倒回会撞 (key,revision) PK）。
 */
export async function setConfig(
  key: string,
  value: ConfigValue,
  opts: ConfigWriteOptions,
  db: Db = defaultDb,
): Promise<ConfigWriteResult> {
  const results = await setConfigs([{ key, value }], opts, db);
  // entries 非空已在上游 gate；results[0] 恒在。
  const first = results[0];
  if (!first) throw new Error('setConfig: empty result for non-empty write');
  return first;
}

export async function mutateConfigs(
  mutations: readonly ConfigMutation[],
  opts: ConfigWriteOptions,
  db: Db = defaultDb,
): Promise<ConfigMutationResult[]> {
  if (mutations.length === 0) return [];
  const seen = new Set<string>();
  const setKeys = new Set<string>();
  const touchedPairs = new Map<string, PairScope>();
  const parsedExpiry = new Map<string, Date | null | undefined>();
  for (const mutation of mutations) {
    if (seen.has(mutation.key)) {
      throw new ApiError('duplicate_config_key', `duplicate config key '${mutation.key}'`, 400);
    }
    seen.add(mutation.key);
    if (mutation.action === 'set') {
      setKeys.add(mutation.key);
      validateEntryBasics(mutation.key, mutation.value);
      parsedExpiry.set(mutation.key, parseExpiresAt(mutation.expiresAt));
    } else {
      validateWritableKey(mutation.key);
      parsedExpiry.set(mutation.key, null);
    }
    const scope = pairScopeFor(mutation.key);
    if (scope) touchedPairs.set(scope.providerKey, scope);
  }

  const now = new Date();
  // YUK-1658 — the executable-model registry is pure in-process state (getModel
  // re-reads catalog facts on every lookup), so build it BEFORE the transaction:
  // assembling it inside held the epoch row lock — which serializes every config
  // batch — hostage to a dynamic import + provider-registry construction.
  const models = touchedPairs.size > 0 ? await writeFacts().createPairModels() : undefined;
  const results = await db.transaction(async (tx) => {
    // This epoch row lock serializes all config batches before any key or journal write.
    const epoch = await bumpEpoch(tx);
    const out: ConfigMutationResult[] = [];
    for (const mutation of mutations) {
      const { key, action } = mutation;
      const [prevRow] = await tx
        .select()
        .from(system_config)
        .where(eq(system_config.key, key))
        .for('update')
        .limit(1);
      const maxRows = await tx.execute<{ revision: number | string }>(
        sql`select revision from ${system_config_journal} where ${system_config_journal.key} = ${key} order by revision desc limit 1 for update`,
      );
      const maxRevision = Number(maxRows[0]?.revision ?? 0);
      const revision =
        Math.max(Number.isFinite(maxRevision) ? maxRevision : 0, prevRow?.revision ?? 0) + 1;
      const expiry = parsedExpiry.get(key);
      const nextExpiresAt = expiry === undefined ? (prevRow?.expires_at ?? null) : expiry;
      if (mutation.action === 'clear') {
        if (prevRow) await tx.delete(system_config).where(eq(system_config.key, key));
      } else if (prevRow) {
        await tx
          .update(system_config)
          .set({
            value: mutation.value,
            revision,
            source_note: opts.note ?? prevRow.source_note,
            expires_at: nextExpiresAt,
            updated_by: opts.actor,
            updated_at: now,
          })
          .where(eq(system_config.key, key));
      } else {
        await tx.insert(system_config).values({
          key,
          value: mutation.value,
          revision,
          source_note: opts.note ?? null,
          expires_at: nextExpiresAt,
          updated_by: opts.actor,
          created_at: now,
          updated_at: now,
        });
      }
      await tx.insert(system_config_journal).values({
        key,
        revision,
        action,
        actor: opts.actor,
        created_at: now,
        payload: {
          prev: prevRow?.value ?? null,
          next: mutation.action === 'set' ? mutation.value : null,
          prev_expires_at: prevRow?.expires_at?.toISOString() ?? null,
          next_expires_at:
            mutation.action === 'set' ? (nextExpiresAt?.toISOString() ?? null) : null,
          note: opts.note ?? null,
        },
      });
      out.push({
        key,
        revision,
        epoch,
        action,
        ...(action === 'clear' ? { cleared: Boolean(prevRow) } : {}),
      });
    }
    if (models) await validateFinalProviderPairs(tx, touchedPairs, models, seen, setKeys);
    return out;
  });
  // Hydration is best-effort. HTTP reports both committed and observed epochs separately.
  await hydrateConfigFromDb(db);
  return results;
}

/** Preserve the existing service contract while sharing atomic mutation semantics. */
export async function setConfigs(
  entries: ReadonlyArray<{ key: string; value: ConfigValue }>,
  opts: ConfigWriteOptions,
  db: Db = defaultDb,
): Promise<ConfigWriteResult[]> {
  const results = await mutateConfigs(
    entries.map((entry) => ({ ...entry, action: 'set' })),
    opts,
    db,
  );
  return results.map(({ key, revision, epoch }) => ({ key, revision, epoch }));
}

/** Reset a group only after its final native provider/model bindings have been validated. */
export async function clearConfigs(
  keys: readonly string[],
  opts: ConfigWriteOptions,
  db: Db = defaultDb,
): Promise<Array<ConfigWriteResult & { cleared: boolean }>> {
  const results = await mutateConfigs(
    keys.map((key) => ({ key, action: 'clear' })),
    opts,
    db,
  );
  return results.map(({ key, revision, epoch, cleared }) => ({
    key,
    revision,
    epoch,
    cleared: cleared === true,
  }));
}

export async function clearConfig(
  key: string,
  opts: ConfigWriteOptions,
  db: Db = defaultDb,
): Promise<ConfigWriteResult & { cleared: boolean }> {
  const [result] = await clearConfigs([key], opts, db);
  if (!result) throw new Error('clearConfig: empty result for non-empty reset');
  return result;
}
