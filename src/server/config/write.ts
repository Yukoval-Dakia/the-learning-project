// YUK-1007 — 配置写面（server-only）。grounding §1.4/§6.3：
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
import type { TaskKind } from '@/ai/registry';
import { tasks } from '@/ai/registry';
import type { ConfigValue } from '@/core/config/store';
import { resolveKeyDef } from '@/core/config/store';
import { type Db, type Tx, db as defaultDb } from '@/db/client';
import { system_config, system_config_journal } from '@/db/schema';
import { ApiError } from '@/kernel/http';
import { PROVIDER_ATTEMPT_ADMISSION_LANES } from '@/server/ai/provider-attempt-admission-config';
import {
  type Provider,
  isKnownProvider,
  isProviderImplemented,
  isProviderImplementedForTask,
  providerRequiresExplicitModel,
} from '@/server/ai/providers';
import { hydrateConfigFromDb } from './hydrate';

export type ConfigActor = 'owner' | 'panel:admin' | 'migrate' | 'cli';

const EPOCH_ROW_ID = 'global';

export interface ConfigWriteResult {
  key: string;
  revision: number;
  epoch: number;
}

/** tx 外校验：登记性 / pinned / zod / 纯值谓词（不需要读兄弟行）。never-throws 不适用。 */
function validateEntryBasics(key: string, value: ConfigValue): void {
  const def = resolveKeyDef(key);
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

/** tx 外的纯值谓词（不读兄弟行）：JUDGE_FALLBACK / task-kind 存在性 / provider 已知+已实现。 */
function validateStaticSemantics(key: string, value: ConfigValue): void {
  // JUDGE_FALLBACK_PROVIDER：'' = 显式关（合法）；非空必须是已知 + implemented
  // + 可裸跑（该 lane 不递 model）。
  if (key === 'JUDGE_FALLBACK_PROVIDER') {
    if (typeof value !== 'string' || value === '') return;
    if (!isKnownProvider(value) || !isProviderImplemented(value)) {
      throw new ApiError(
        'invalid_config_value',
        `JUDGE_FALLBACK_PROVIDER='${value}' is not a wired provider`,
        422,
      );
    }
    if (providerRequiresExplicitModel(value)) {
      throw new ApiError(
        'invalid_config_value',
        `JUDGE_FALLBACK_PROVIDER='${value}' requires an explicit model which the fallback lane never supplies — it would resolve to the registry mimo id and 404`,
        422,
      );
    }
    return;
  }

  // task.<kind>.provider：kind 存在性 + provider 已知 + implemented。
  const m = /^task\.([^.]+)\.provider$/.exec(key);
  if (m && typeof value === 'string' && value !== '') {
    const scope = m[1];
    if (!(scope in tasks)) {
      throw new ApiError(
        'unknown_config_key',
        `task kind '${scope}' is not in the TaskSpec registry`,
        400,
      );
    }
    if (!isKnownProvider(value)) {
      throw new ApiError('invalid_config_value', `${key}='${value}' is not a known provider`, 422);
    }
    const provider = value as Provider;
    if (!isProviderImplementedForTask(provider, scope as TaskKind)) {
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
    if (!isKnownProvider(value)) {
      throw new ApiError('invalid_config_value', `${key}='${value}' is not a known provider`, 422);
    }
    const provider = value as Provider;
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
        if (!(PROVIDER_ATTEMPT_ADMISSION_LANES as readonly string[]).includes(lane)) {
          throw new ApiError(
            'invalid_config_value',
            `${key} contains unknown lane '${lane}' (allowed: ${PROVIDER_ATTEMPT_ADMISSION_LANES.join(', ')})`,
            422,
          );
        }
      }
    }
    return;
  }
  if (key === 'AI_PROVIDER_SESSION_ADMISSION_POLICIES_JSON') {
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      for (const lane of Object.keys(value)) {
        if (!isKnownProvider(lane)) {
          throw new ApiError(
            'invalid_config_value',
            `${key} contains unknown provider lane '${lane}'`,
            422,
          );
        }
      }
    }
    return;
  }

  // JUDGE_CALIBRATION_REJUDGE_PROVIDER：已知 + implemented（rejudge 有内置默认
  // model，providerRequiresExplicitModel 终态校验在 tx 内做）。
  if (key === 'JUDGE_CALIBRATION_REJUDGE_PROVIDER' && typeof value === 'string' && value !== '') {
    if (!isKnownProvider(value) || !isProviderImplemented(value)) {
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

/** 一个被写/被清的 key 属于哪对 provider/model 组；非对键 → null。 */
function pairScopeFor(key: string): PairScope | null {
  const t = /^task\.([^.]+)\.(provider|model)$/.exec(key);
  if (t) {
    const scope = t[1];
    return {
      providerKey: `task.${scope}.provider`,
      modelKey: `task.${scope}.model`,
      label: `task '${scope}'`,
    };
  }
  const l = /^lane\.([^.]+)\.(provider|model)$/.exec(key);
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

/**
 * 终态校验：写面触碰到的每个 provider/model 对，按 tx 内 DB 终态行（刚写的值也在
 * 其中）求 effective provider + effective model；providerRequiresExplicitModel 时
 * 缺显式 model → 422（整 tx 回滚）。
 *
 * 生效层序与读面一致：priority 键 env 显式 > DB > default；fallback 键 DB > env >
 * codeDefault。rejudge 的 model codeDefault（'claude-opus-4-8'）不算「显式」——
 * providerRequiresExplicitModel 的 provider（openai/anthropic/…）上 default 是
 * mimo id，跑不了。
 */
async function validateFinalProviderPairs(
  tx: Tx,
  scopes: ReadonlyMap<string, PairScope>,
): Promise<void> {
  if (scopes.size === 0) return;
  const keys = [
    ...new Set([...scopes.values()].flatMap((s) => [s.providerKey, s.modelKey])),
  ].sort();
  const rows = await tx
    .select({ key: system_config.key, value: system_config.value })
    .from(system_config)
    .where(inArray(system_config.key, keys))
    .for('update');
  const rowByKey = new Map(rows.map((r) => [r.key, r.value]));

  for (const scope of scopes.values()) {
    const providerDef = resolveKeyDef(scope.providerKey);
    const modelDef = resolveKeyDef(scope.modelKey);
    const env = process.env;

    const envProvider = providerDef?.envName !== undefined ? env[providerDef.envName] : undefined;
    const envModel = modelDef?.envName !== undefined ? env[modelDef.envName] : undefined;

    const dbProvider = valueAsNonEmptyString(rowByKey.get(scope.providerKey));
    const dbModel = valueAsNonEmptyString(rowByKey.get(scope.modelKey));

    const providerPriority = (providerDef?.envMode ?? 'fallback') === 'priority';
    const modelPriority = (modelDef?.envMode ?? 'fallback') === 'priority';

    const effProvider = providerPriority
      ? (valueAsNonEmptyString(envProvider) ?? dbProvider)
      : (dbProvider ?? valueAsNonEmptyString(envProvider));
    const effModel = modelPriority
      ? (valueAsNonEmptyString(envModel) ?? dbModel)
      : (dbModel ?? valueAsNonEmptyString(envModel));

    if (effProvider === undefined) continue; // 对解散 → 无事可验
    if (typeof effProvider === 'string' && isKnownProvider(effProvider)) {
      const provider = effProvider as Provider;
      if (providerRequiresExplicitModel(provider) && effModel === undefined) {
        throw new ApiError(
          'invalid_config_value',
          `${scope.label} resolves to provider '${provider}' with no explicit model — set '${scope.modelKey}' in the same write, or clear '${scope.providerKey}' to dissolve the pair`,
          422,
        );
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
  const rows = await tx.execute(sql`
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
  const row = (rows as unknown as Array<{ epoch: number | string }>)[0];
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

/** 多 key 原子写（同 tx 行级 upsert + journal + 一次 epoch bump + 终态对校验）。 */
export async function setConfigs(
  entries: ReadonlyArray<{ key: string; value: ConfigValue }>,
  opts: ConfigWriteOptions,
  db: Db = defaultDb,
): Promise<ConfigWriteResult[]> {
  if (entries.length === 0) return [];
  for (const { key, value } of entries) validateEntryBasics(key, value);

  const touchedPairs = new Map<string, PairScope>();
  for (const { key } of entries) {
    const scope = pairScopeFor(key);
    if (scope) touchedPairs.set(scope.providerKey, scope);
  }

  const now = new Date();
  const results = await db.transaction(async (tx) => {
    const epoch = await bumpEpoch(tx);
    const out: ConfigWriteResult[] = [];
    for (const { key, value } of entries) {
      const prev = await tx
        .select()
        .from(system_config)
        .where(eq(system_config.key, key))
        .for('update')
        .limit(1);
      const prevRow = prev[0];
      // P1-2：下一段 revision 从 append-only journal 的最新行取——clear 删掉
      // value 行后 revision 不倒回，set→clear→set 不再撞 (key,revision) PK。
      // 锁最新 journal 行（FOR UPDATE 不能打在聚合上——锁定最新行即可串行同 key 写）。
      const maxRows = (await tx.execute(
        sql`select revision from ${system_config_journal} where ${system_config_journal.key} = ${key} order by revision desc limit 1 for update`,
      )) as unknown as Array<{ revision: number | string }>;
      const maxRevision = Number(maxRows[0]?.revision ?? 0);
      const revision =
        Math.max(Number.isFinite(maxRevision) ? maxRevision : 0, prevRow?.revision ?? 0) + 1;
      if (prevRow) {
        await tx
          .update(system_config)
          .set({
            value,
            revision,
            source_note: opts.note ?? prevRow.source_note,
            updated_by: opts.actor,
            updated_at: now,
          })
          .where(eq(system_config.key, key));
      } else {
        await tx.insert(system_config).values({
          key,
          value,
          revision,
          source_note: opts.note ?? null,
          updated_by: opts.actor,
          created_at: now,
          updated_at: now,
        });
      }
      await tx.insert(system_config_journal).values({
        key,
        revision,
        payload: { prev: prevRow?.value ?? null, next: value, note: opts.note ?? null },
        action: 'set',
        actor: opts.actor,
        created_at: now,
      });
      out.push({ key, revision, epoch });
    }
    // P1-5：写全部落库后按 tx 内终态校验 provider/model 对（model-only 写、
    // clear-only 批、多 key 原子批都在这层）。失败 → 整 tx 回滚。
    await validateFinalProviderPairs(tx, touchedPairs);
    return out;
  });

  await hydrateConfigFromDb(db); // 本进程即时生效；他进程 ≤15s 经 refresh 收敛
  return results;
}

/** 删除行 = 回退 env/default。journal 留 clear 快照（prev + note）。 */
export async function clearConfig(
  key: string,
  opts: ConfigWriteOptions,
  db: Db = defaultDb,
): Promise<{ key: string; cleared: boolean; epoch: number; revision: number }> {
  const def = resolveKeyDef(key);
  if (!def) {
    throw new ApiError('unknown_config_key', `config key '${key}' is not registered`, 400);
  }
  if ((def.envMode ?? 'fallback') === 'pinned') {
    throw new ApiError(
      'config_key_compose_pinned',
      `config key '${key}' is compose-forced — nothing to clear (DB writes never take effect)`,
      409,
    );
  }

  const touchedPairs = new Map<string, PairScope>();
  const scope = pairScopeFor(key);
  if (scope) touchedPairs.set(scope.providerKey, scope);

  const now = new Date();
  const result = await db.transaction(async (tx) => {
    const epoch = await bumpEpoch(tx);
    const prev = await tx
      .select()
      .from(system_config)
      .where(eq(system_config.key, key))
      .for('update')
      .limit(1);
    const prevRow = prev[0];
    if (prevRow) {
      await tx.delete(system_config).where(eq(system_config.key, key));
    }
    const maxRows = (await tx.execute(
      sql`select revision from ${system_config_journal} where ${system_config_journal.key} = ${key} order by revision desc limit 1 for update`,
    )) as unknown as Array<{ revision: number | string }>;
    const maxRevision = Number(maxRows[0]?.revision ?? 0);
    const revision =
      Math.max(Number.isFinite(maxRevision) ? maxRevision : 0, prevRow?.revision ?? 0) + 1;
    await tx.insert(system_config_journal).values({
      key,
      revision,
      payload: { prev: prevRow?.value ?? null, next: null, note: opts.note ?? null },
      action: 'clear',
      actor: opts.actor,
      created_at: now,
    });
    // P1-5：clear 也走终态校验——例如 provider 行还在但 model 被清。
    await validateFinalProviderPairs(tx, touchedPairs);
    return { key, cleared: Boolean(prevRow), epoch, revision };
  });

  await hydrateConfigFromDb(db);
  return result;
}
